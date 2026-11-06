---
name: decode-and-explain
description: Decode Safe transaction calldata into a method and parameters with the Safe Decoder Service, explain its effect in plain words, and estimate safeTxGas. Use it before a proposal and for any queued transaction. Read only; says "unknown" when calldata cannot be decoded.
---

# Decode and explain

This skill only reads. It cannot sign, propose, confirm, execute or broadcast a transaction.

- The scripts and the README ship in this skill package. Run the commands from its root.
- Make every call through `scripts/safe-api.sh`. Export `SAFE_API_KEY` first. Exit codes are
  in the README.
- For the Transaction Service, the chain slug (`sep`, `eth`, `gno`, see the README) is part of
  the URL. There is no default chain.
- The Safe Decoder Service is one service for all chains: put the numeric chain ID in the body
  as `chainId` (the README lists the slugs with their chain IDs). Give the same chain slug as
  the first argument; the script uses it in its messages.

The examples use `SAFE=0x…` (the Safe), `TO=0x…` (the called contract), `DATA=0x…` (the
calldata) on `sep` (chain ID 11155111).

## Decode calldata

```sh
scripts/safe-api.sh sep POST /decoder/api/v1/data-decoder \
  "{\"data\":\"$DATA\",\"to\":\"$TO\",\"chainId\":11155111}"
```

The response has `method`, `parameters` (`name`, `type`, `value`, `valueDecoded`) and
`accuracy`:

| `accuracy` | The decoder used | What to say |
|---|---|---|
| `FULL_MATCH` | the ABI of `to` on this chain | Report the method and names. |
| `PARTIAL_MATCH` | the ABI of the address `to` on another chain | Say that the ABI is from another chain. |
| `ONLY_FUNCTION_MATCH` | a function of another contract with the same selector | `to` has no known ABI (for example, it is not verified). Say that the names can be wrong. |

- HTTP 404 with `{"detail":"Cannot find function selector to decode data"}` (exit code 4)
  means the selector is unknown. Say "unknown". Never guess a method from the selector.
- For a `multiSend`, `valueDecoded` lists the inner calls with `operation`, `to`, `value`,
  `data` and `dataDecoded`. Explain each inner call.
- The Transaction Service `POST /api/v1/data-decoder/` is deprecated in favour of this service
  (its OpenAPI spec: "Please migrate to the new safe-decoder-service"). Do not use it. The
  [decoder reference](https://docs.safe.global/core-api/safe-decoder-service-reference) gives
  the base URL `https://api.safe.global/decoder`.

A transaction from the queue already has `dataDecoded` (see the read-safe-state skill). Use it,
and call the decoder only for raw calldata.

## Explain

- Say who receives what: the target `to`, the native `value` (convert wei with 18 decimals),
  and for a token call the token, the recipient and the amount in token units.
- `operation` 1 is a delegatecall: the target code runs with the Safe's storage and funds. Say
  so in plain words, and name the target.
- A top-level delegatecall is a red flag unless the method is `multiSend` and `to` is a Safe
  MultiSend contract. Any other target can change the owners or move every asset. Say this
  first, before the rest of the explanation.
- Say when a call changes the Safe itself: owners, threshold, modules, guard or fallback
  handler.
- Keep the facts from the decoder apart from your reading of them.

## Estimate safeTxGas

```sh
scripts/safe-api.sh sep POST "/api/v1/safes/$SAFE/multisig-transactions/estimations/" \
  "{\"to\":\"$TO\",\"value\":\"0\",\"data\":\"$DATA\",\"operation\":0}"
```

- The response is `{"safeTxGas": "<number as a string>"}`. This is the gas of the inner call,
  not the fee of the execution. The wallet of the executing owner estimates that.
- On a chain that the service runs in L2 mode, the result is always `"0"`: the service does not
  estimate there, because only Safes before version 1.3.0 need `safeTxGas`. `pol` returns
  `"0"`; `sep` and `gno` return estimates. Treat `"0"` as "not estimated", never as "free".
- HTTP 422 with `"code": 30` (`Gas estimation failed`) means the call reverts when the Safe
  makes it. Say so, and quote the first part of `arguments`.
- HTTP 404 means that the service does not know this Safe on this chain.
