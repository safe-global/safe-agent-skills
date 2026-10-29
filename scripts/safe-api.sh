#!/usr/bin/env bash
set -euo pipefail

readonly UA='safe-agent-skill/1.0 (+https://github.com/safe-global/safe-agent-skills)'
readonly API='https://api.safe.global'
readonly EX_USAGE=2 EX_QUOTA=3 EX_CLIENT=4 EX_SERVER=5
readonly MAX_ATTEMPTS=3 MAX_RETRY_AFTER=30
readonly TOKEN_RE='^[A-Za-z0-9._~+/=-]+$'

note() { printf 'safe-api: %s\n' "$*" >&2; }
die() { note "$*"; exit "$EX_USAGE"; }

usage() {
  cat >&2 <<'EOF'
usage: safe-api.sh <chain> <METHOD> <path> [body] [--each <address>...]
  chain   chain slug, for example sep or eth (see README)
  path    /api/v1/... or /api/v2/...; /decoder/api/v1/... for the Safe Decoder Service;
          with --each, {safe} is replaced by each address
  body    JSON string, @file, or - for stdin
EOF
  exit "$EX_USAGE"
}

missing_key() {
  die "SAFE_API_KEY is not set. The hosted Safe Transaction Service needs an API key.
  1. Create a key at https://developer.safe.global (API Keys section).
  2. Export it in the environment, never as an argument: export SAFE_API_KEY=<your key>
  For a self-hosted service, set SAFE_TX_SERVICE_URL instead."
}

[ $# -ge 3 ] || usage
chain=$1 method=$2 path=$3
shift 3
body="" each=0
if [ $# -gt 0 ] && [ "$1" != --each ]; then body=$1; shift; fi
if [ $# -gt 0 ]; then
  [ "$1" = --each ] || usage
  shift
  [ $# -gt 0 ] || die "--each needs at least one address"
  each=1
fi

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"
[[ $chain =~ ^[a-z0-9_-]+$ ]] || die "invalid chain slug: $chain"
case $method in GET | POST | PUT | PATCH | DELETE) ;; *) die "invalid method: $method" ;; esac
[[ $path =~ ^(/decoder)?/api/v[0-9]+/[^[:space:]]*$ ]] || die "invalid path: $path"
[ "$method" != GET ] || [ -z "$body" ] || die "GET takes no body"
if [ "$each" = 1 ]; then
  case $path in *'{safe}'*) ;; *) die "--each needs {safe} in the path" ;; esac
  for safe in "$@"; do
    [[ $safe =~ ^0x[0-9a-fA-F]{40}$ ]] || die "invalid address: $safe"
  done
fi

key=""
if [ -n "${SAFE_TX_SERVICE_URL:-}" ]; then
  [[ $path != /decoder/* ]] || die "The decoder is hosted only: unset SAFE_TX_SERVICE_URL."
  [[ $SAFE_TX_SERVICE_URL =~ ^https?:// ]] || die "SAFE_TX_SERVICE_URL must start with http(s)://"
  base=${SAFE_TX_SERVICE_URL%/}
  [ -z "${SAFE_API_KEY:-}" ] || note "SAFE_TX_SERVICE_URL is set: SAFE_API_KEY is not sent."
else
  key=${SAFE_API_KEY:-}
  [ -n "$key" ] || missing_key
  [[ $key =~ $TOKEN_RE ]] || die "SAFE_API_KEY is not a valid bearer token"
  case $path in /decoder/*) base=$API ;; *) base="$API/tx-service/$chain" ;; esac
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bodyfile=""
if [ -n "$body" ]; then
  bodyfile="$tmp/request"
  case $body in
    -) cat >"$bodyfile" ;;
    @*) cat -- "${body#@}" >"$bodyfile" 2>/dev/null || die "cannot read body file: ${body#@}" ;;
    *) printf '%s' "$body" >"$bodyfile" ;;
  esac
  jq empty "$bodyfile" 2>/dev/null || die "body is not valid JSON"
fi

header() {
  awk -v k="$1" '{ sub(/\r$/, ""); i = index($0, ":")
    if (i && tolower(substr($0, 1, i - 1)) == k) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v) } }
    END { print v }' "$tmp/headers"
}

retry_after() {
  local v
  v=$(header retry-after)
  if [[ $v =~ ^[0-9]+$ ]]; then printf '%s' "$v"; return 0; fi
  [ -n "$v" ] || return 1
  jq -rn --arg d "$v" '[($d | strptime("%a, %d %b %Y %H:%M:%S GMT") | mktime) - now, 0]
    | max | floor' 2>/dev/null
}

utc_in() { jq -rn --argjson s "$1" '(now + $s) | floor | todate'; }

first_request=1
pace() {
  if [ "$first_request" = 1 ]; then first_request=0; else sleep 0.2; fi
}

send() {
  local args=(-q -sS -g -X "$method" -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}'
    -A "$UA" -H 'Accept: application/json' --connect-timeout 10 --max-time 60)
  [ -z "$bodyfile" ] || args+=(-H 'Content-Type: application/json' --data-binary "@$bodyfile")
  : >"$tmp/body"
  : >"$tmp/headers"
  curl_rc=0
  if [ -n "$key" ]; then
    status=$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$key") "$1" \
      2>"$tmp/err") || curl_rc=$?
  else
    status=$(curl "${args[@]}" "$1" 2>"$tmp/err") || curl_rc=$?
  fi
}

retryable() {
  if [ "$curl_rc" != 0 ]; then [ "$method" = GET ]; return; fi
  case $status in
    429) return 0 ;;
    502 | 503 | 504) [ "$method" = GET ] ;;
    *) return 1 ;;
  esac
}

request() {
  local attempt=1 delay
  while :; do
    pace
    send "$base$1"
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ] || ! retryable; then break; fi
    if delay=$(retry_after); then
      [ "$delay" -le "$MAX_RETRY_AFTER" ] || break
    else
      delay=$(printf '%d.%03d' $((1 << (attempt - 1))) $((RANDOM % 1000)))
    fi
    note "$chain $method $1 -> ${status/#000/network error}; retry in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  attempts=$attempt
}

quota_message() {
  local ra reset
  ra=$(retry_after) || ra=""
  reset=$(header x-ratelimit-reset)
  note "429 Too Many Requests after $attempts attempt(s): the Safe API account quota is used up" \
    "(requests per second or monthly calls). The response body is on stdout."
  if [ -n "$ra" ]; then note "Retry after ${ra}s ($(utc_in "$ra"))."; fi
  if [[ $reset =~ ^[0-9]+$ ]]; then
    note "The rate limit resets in ${reset}s ($(utc_in "$reset"))."
  fi
  if [ -z "$ra" ] && ! [[ $reset =~ ^[0-9]+$ ]]; then note "The response gives no reset time."; fi
  note "Still works: Safe{Wallet}, where owners review, confirm and execute;" \
    "commands that make no API call. Do not retry in a loop."
}

outcome() {
  if [ "$curl_rc" != 0 ]; then
    note "$chain $method $1 -> network error after $attempts attempt(s):" "$(cat "$tmp/err")"
    return "$EX_SERVER"
  fi
  local left limit
  left=$(header x-ratelimit-remaining)
  limit=$(header x-ratelimit-limit)
  note "$chain $method $1 -> $status${left:+ (rate limit: $left of $limit left)}"
  case $status in
    2??) return 0 ;;
    429) quota_message; return "$EX_QUOTA" ;;
    3??) note "Redirected: add the trailing slash to the path."; return "$EX_CLIENT" ;;
    401 | 403) note "Check SAFE_API_KEY and the chain slug."; return "$EX_CLIENT" ;;
    404) note "Not found: unknown address, chain slug or selector."; return "$EX_CLIENT" ;;
    4??) note "Rejected: the body on stdout says why."; return "$EX_CLIENT" ;;
    *) return "$EX_SERVER" ;;
  esac
}

emit_line() {
  local code=$((10#$status))
  if [ -s "$tmp/body" ] && jq empty "$tmp/body" 2>/dev/null; then
    jq -c --arg safe "$1" --argjson status "$code" \
      '{safe: $safe, status: $status, body: .}' "$tmp/body"
  else
    jq -cn --arg safe "$1" --argjson status "$code" --rawfile body "$tmp/body" \
      '{safe: $safe, status: $status, body: (if $body == "" then null else $body end)}'
  fi
}

if [ "$each" = 0 ]; then
  request "$path"
  rc=0
  outcome "$path" || rc=$?
  cat "$tmp/body"
  exit "$rc"
fi

final=0
for safe in "$@"; do
  p=${path//\{safe\}/$safe}
  request "$p"
  rc=0
  outcome "$p" || rc=$?
  emit_line "$safe"
  if [ "$rc" = "$EX_QUOTA" ]; then note "Stopped: Safes after $safe not read."; exit "$rc"; fi
  if [ "$final" = 0 ]; then final=$rc; fi
done
exit "$final"
