---
name: read-safe-state
description: Read a Safe from the Safe Transaction Service (owners, threshold, nonce, version, native and token balances, executed history, the pending queue, and the Safes of an owner). Use it before any proposal and to answer questions about a Safe. Read only.
---

# Read Safe state

This skill only reads. It cannot sign, propose, confirm, execute or broadcast a transaction.

- Install first: clone https://github.com/safe-global/safe-agent-skills and run the commands
  from its root (README). The scripts are not in this file.
- Make every call through `scripts/safe-api.sh <chain> GET <path>`. The chain slug (`sep`,
  `eth`, `gno`, see the README) is part of the URL. There is no default chain.
- Ask the user for the chain; never assume one. A Safe can have the same address on two chains
  (common with counterfactual deployment), and a wrong slug then answers HTTP 200 with the
  owners, nonce and queue of the other Safe, not a 404.
- Reads need `SAFE_API_KEY` only. They need no delegate and no owner signature: do not run the
  register-delegate skill to read.
- Export `SAFE_API_KEY` first. The script prints the response body on stdout and the status on
  stderr. Exit codes are in the README.
- Use EIP-55 checksummed addresses. The service rejects other forms with HTTP 422.
- The service shows indexed data. It can lag the chain by some blocks.

The examples use `SAFE=0x…` (the Safe), `SAFE2=0x…` (a second Safe), `OWNER=0x…` (an owner
address) and the chain `sep`.

## Safe info

```sh
scripts/safe-api.sh sep GET "/api/v1/safes/$SAFE/"
```

The fields are `address`, `nonce` (a string), `threshold`, `owners`, `modules`,
`fallbackHandler`, `guard` and `version`. HTTP 404 means that the service does not know this
Safe on this chain: check the chain slug.

## Balances

```sh
scripts/safe-api.sh sep GET "/api/v2/safes/$SAFE/balances/?exclude_spam=true&limit=100"
```

- The page is `{count, next, previous, results}`. The limit is at most 200. Follow `next` to
  read the remaining pages.
- The first result is the native coin: `tokenAddress` and `token` are `null`.
- `balance` is a string in the smallest unit. Divide it by `10^token.decimals` (18 for the
  native coin) before you show it.
- The service skips tokens with a zero balance. `exclude_spam=true` hides tokens that the
  service marks as spam. `trusted=true` shows only tokens that the service trusts.

## History

```sh
scripts/safe-api.sh sep GET "/api/v2/safes/$SAFE/all-transactions/?limit=20"
```

- Executed transactions only, newest first. The limit is at most 100.
- `txType` is `MULTISIG_TRANSACTION`, `MODULE_TRANSACTION` or `ETHEREUM_TRANSACTION`
  (an incoming transfer).

## Pending queue

There is no queue endpoint. Use two calls. The second call runs only when the first one gives a
nonce; after a failed read, `NONCE` is empty or `null`:

```sh
NONCE=$(scripts/safe-api.sh sep GET "/api/v1/safes/$SAFE/" | jq -r .nonce)
[[ $NONCE =~ ^[0-9]+$ ]] && scripts/safe-api.sh sep GET \
  "/api/v2/safes/$SAFE/multisig-transactions/?executed=false&nonce__gte=$NONCE&ordering=nonce"
```

- The result is the queue in execution order. Each item has `safeTxHash`, `nonce`, `to`,
  `value`, `data`, `dataDecoded`, `confirmations`, `confirmationsRequired`, `proposer`,
  `proposedByDelegate` and `origin`.
- Two items can have the same nonce. Only one of them can execute; the other is a replacement.
- The list has a default filter `trusted=true`. It hides proposals that carry no valid owner or
  delegate signature. Add `&trusted=false` to see them too. The service deletes them after
  30 days.
- An item is ready when `confirmations` has `confirmationsRequired` entries.

## Safes of an owner

```sh
scripts/safe-api.sh sep GET "/api/v2/owners/$OWNER/safes/"
```

The page lists the Safes with `address`, `owners`, `threshold` and `nonce`.

## Several Safes in one call

```sh
scripts/safe-api.sh sep GET '/api/v1/safes/{safe}/' --each "$SAFE" "$SAFE2"
```

The script prints one JSON line per Safe: `{"safe", "status", "body"}`. It sends at most
5 requests per second.
