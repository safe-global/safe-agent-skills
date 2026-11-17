# safe-agent-skills

Agent skills for the [Safe Transaction Service API](https://docs.safe.global/core-api/transaction-service-overview).
An agent reads Safe state, explains calldata and proposes transactions.

## Boundary

- The agent cannot sign as an owner, execute or broadcast a transaction.
- Owners confirm and execute in Safe{Wallet}.
- The API holds no keys. Your API key stays in an environment variable. The delegate key stays
  on your machine.
- A leaked delegate key lets someone post spam proposals. Nobody has to approve them.

## Setup

1. Install Node.js 24 or later (CI runs the latest 24.x and 26.x), bash, curl and jq. The specs
   (`npm test`) also need openssl.
2. Run `npm ci` in this directory.
3. Create an API key in the [Safe developer dashboard](https://developer.safe.global) and
   export it:

   ```sh
   export SAFE_API_KEY=<your key>
   ```

   Never pass the key as an argument and never write it to a file in this repository. The
   script sends the key only to `https://api.safe.global`.

For a self-hosted Transaction Service, set `SAFE_TX_SERVICE_URL` to its base URL, including any
chain path (for example `http://127.0.0.1:8000`). The script then never sends `SAFE_API_KEY`,
because that URL can point at any host. The chain argument then names the chain only in
messages.

## Skills

| Skill | Use it to |
|---|---|
| [read-safe-state](skills/read-safe-state.md) | Read owners, threshold, nonce, balances, history, the pending queue and the Safes of an owner. |
| [decode-and-explain](skills/decode-and-explain.md) | Decode calldata, explain its effect and estimate `safeTxGas`. |
| [register-delegate](skills/register-delegate.md) | Create a local delegate key and have an owner register it for one Safe. |
| [propose-transaction](skills/propose-transaction.md) | Propose a transaction as the delegate; owners confirm and execute it in Safe{Wallet}. |

[`.well-known/agent-skills/index.json`](.well-known/agent-skills/index.json) lists the skills in
the [Agent Skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc) format
(v0.2.0, the format of `https://agents.ramp.com/.well-known/agent-skills/index.json`). Each skill
ships as a `.tar.gz` archive with its file as `SKILL.md`, the scripts, `package.json`,
`package-lock.json`, this README and the license. The `url` values are absolute links to the
archives of the GitHub release `v<version>` (`version` from `package.json`), so the index stays
valid when it is hosted alone. `node scripts/pack.ts` builds the same bytes on every run into
`dist/` and prints the digests; `npm test` checks them against the index. After you change a
shipped file, bump `version`, update the URLs and digests, and push the tag: the release workflow
builds the archives into a draft release, which a maintainer then publishes.

## Calling the API

`scripts/safe-api.sh` is the single entry point for API calls. Every request sends the
User-Agent `safe-agent-skill/1.0 (+https://github.com/safe-global/safe-agent-skills)`. Safe
counts agent adoption by this string: do not change it, and do not rename this repository.

```sh
scripts/safe-api.sh <chain> <METHOD> <path> [body] [--each <address>...]
scripts/safe-api.sh sep GET /api/v1/safes/0xSafe/
scripts/safe-api.sh sep GET '/api/v1/safes/{safe}/' --each 0xSafeA 0xSafeB
```

- The chain slug is part of the URL: `https://api.safe.global/tx-service/<chain>/api/...`.
  There is no default chain.
- A path that starts with `/decoder/` goes to the Safe Decoder Service at
  `https://api.safe.global/decoder`. It serves all chains: the chain ID is in the request body.
  It has no self-hosted form here, so the script refuses it while `SAFE_TX_SERVICE_URL` is set.
- The body is a JSON string, `@file`, or `-` for stdin.
- The script refuses a path with spaces, control characters, a `.` or `..` segment (also
  `%2e`), or an encoded slash or backslash (`%2f`, `%5c`, `\`) before the `?`. It also refuses
  a `SAFE_TX_SERVICE_URL` with spaces or control characters. It sends nothing.
- The response body goes to stdout. Statuses and explanations go to stderr.
- `--each` replaces `{safe}` in the path and prints one JSON line per Safe:
  `{"safe": ..., "status": ..., "body": ...}`.
- Within one process, requests are serial and never faster than 5 per second. Separate
  processes do not share this pacing, and parallel `propose.ts` runs can pick the same nonce.
- GET retries on 429, 502, 503, 504 and connection errors. Other methods retry only on 429.
  A 429 whose body names the monthly quota is never retried: the quota resets only on the date
  in the body. A request makes at most 3 attempts, with exponential backoff and jitter. The
  script waits for `Retry-After` up to 30 seconds. A longer one ends the retries: a 429 then
  exits 3, and a 502, 503 or 504 exits 5.

| Exit code | Meaning |
|---|---|
| 0 | Success (HTTP 2xx) |
| 2 | Usage or configuration error; no request was sent |
| 3 | HTTP 429 after the last attempt. The message names the monthly quota of the Safe API account only when the hosted API answers with a body that contains `monthly quota` (any case), for example `The monthly quota of 50000 requests on the Builder plan is used`. Otherwise it says "rate limited". Both print the `Retry-After` and `X-RateLimit-*` headers. |
| 4 | Redirect (HTTP 3xx), for example a self-hosted service that wants a trailing slash, or other client error (HTTP 4xx) |
| 5 | Server error (HTTP 5xx) or network error |

With `--each`, the exit code is the code of the first failed Safe. A 429 stops the run.

## Chains

Source: [Safe docs, Supported Networks, Transaction Service](https://docs.safe.global/advanced/smart-account-supported-networks?service=Transaction+Service).
Slugs with chain IDs:

`eth` (1), `oeth` (10), `xdc` (50), `bnb` (56), `gno` (100), `unichain` (130), `pol` (137),
`monad` (143), `sonic` (146), `okb` (196), `opbnb` (204), `lens` (232), `zksync` (324), `wc`
(480), `bot` (677), `stable` (988), `hyper` (999), `kairos` (1001), `pharos` (1672), `peaq`
(3338), `tempo` (4217), `mega` (4326), `robinhood` (4663), `mantle` (5000), `mnt-sep` (5003),
`arc` (5042), `kaia` (8217), `base` (8453), `plasma` (9745), `monad-testnet` (10143), `chi`
(10200), `0g` (16661), `fluent` (25363), `arb1` (42161), `celo` (42220), `tempo-moderato` (42431),
`hemi` (43111), `avax` (43114), `robinhood-testnet` (46630), `ink` (57073), `linea` (59144), `bep`
(80069), `berachain` (80094), `basesep` (84532), `ctc` (102030), `scr` (534352), `katana`
(747474), `arc-testnet` (5042002), `celo-sep` (11142220), `sep` (11155111), `aurora` (1313161554)

An unknown slug gets HTTP 404. The OpenAPI spec of a chain is at
`https://api.safe.global/tx-service/<chain>/schema/`.

## Quotas

One HTTP request is one API unit. All keys of an account share its quota. The Builder plan
allows 5 requests per second and 50,000 calls per month
([plans](https://safe.global/api), [Quotas & Limits](https://docs.safe.global/core-api/api-authentication)).
The response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
(seconds) report a per-IP counter that keyed and anonymous calls share. They do not show the
account quota. The script prints them on its status line as "rate limit". When a response
has the header `X-RateLimit-Warning`, the script prints it on stderr, also for a 2xx.

## Two different "origin" fields

- The gateway log field `http_origin` is the browser `Origin` request header.
- The transaction `origin` is a field in the body of a proposed transaction. Safe{Wallet} reads
  it as JSON: it shows `note` to the owners, and it shows `url` as the Safe App only when the URL
  matches a registered Safe App.

## License

[MIT](LICENSE)
