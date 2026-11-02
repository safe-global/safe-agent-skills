---
name: register-delegate
description: Register a local delegate key for one Safe, so that an agent can propose transactions to that Safe. An owner signs once; the registration expires after 7 days by default, and renewal needs the owner again. The delegate can only propose; it cannot confirm, execute or change the Safe.
---

# Register a delegate

A delegate is an address that the Transaction Service accepts as a proposer for one Safe. It
cannot sign as an owner, confirm, execute or broadcast. A leaked delegate key lets someone post
spam proposals; no owner has to approve them.

- Install first: clone https://github.com/safe-global/safe-agent-skills, run `npm ci`, and run
  the commands from its root (README). The scripts are not in this file.
- The scripts make every API call through `scripts/safe-api.sh`. The chain slug (`sep`, `eth`,
  `gno`, see the README) is part of the URL. Export `SAFE_API_KEY` first.
- The script always registers for one Safe. Never register a delegate without a Safe: that
  gives the delegate every Safe of the owner, with no ownership check.
- The owner must be an owner account with a private key (EOA). A contract owner cannot sign
  here.
- Give addresses with the EIP-55 checksum or in all lowercase. The script refuses a mixed-case
  address with a wrong checksum (exit code 2): it is often a typo.

The examples use `SAFE=0x…`, `OWNER=0x…` (an owner of the Safe) and the chain `sep`.

## 1. Create the delegate key (once)

```sh
node scripts/sign-delegate.ts new-key --out ~/.safe-agent/delegate.key
```

The script creates a missing parent directory with mode 0700, writes the key with file mode
0600, never replaces a file, and prints only the address. Set `DELEGATE` to that address. Never
print, paste or commit the key.

## 2. Get the owner's signature and register

Do step 2 in one sitting, with the owner present: `submit` must run before the signature
deadline that `typed-data` prints (see below).

With the owner's wallet:

```sh
node scripts/sign-delegate.ts typed-data --chain sep --delegate "$DELEGATE" > delegate.json
node scripts/sign-delegate.ts submit --chain sep --safe "$SAFE" --delegate "$DELEGATE" \
  --delegator "$OWNER" --signature "$SIGNATURE"
```

Give `delegate.json` to the owner. The owner signs it with `eth_signTypedData_v4` and gives you
the signature. The service accepts the signature until the end of the next whole UTC hour after
the hour in the typed data: `typed-data` prints that deadline in UTC on stderr. Some wallets
return the signature with v = 0 or 1; `submit` changes it to 27 or 28 before the check and the
request, because the service reads only those values as an owner signature.

For development, with a local owner key in an environment variable:

```sh
node scripts/sign-delegate.ts submit --chain sep --safe "$SAFE" --delegate "$DELEGATE" \
  --owner-key-env OWNER_PRIVATE_KEY
```

Never pass a private key as an argument: `--owner-key-env` takes the name of the variable.

Before it sends anything, `submit` checks that the signature recovers to the owner for the
current or the previous UTC hour. An older signature gets "the signature expired at …" and no
request. A signature for the next UTC hour means that the clocks differ: check the system clock,
and sign again after the hour starts. Then `submit` prints the delegate row with its `expiryDate`.

Only an HTTP 4xx is a refusal. After a server or network error (exit code 5) the outcome is
unknown: `submit` prints the command that reads the row back. Run it before you try again.

Options: `--label <text>` (at most 50 characters, default `safe-agent-skill`) and
`--expires-in <seconds>` (default 604800, which is 7 days).

## Check and renew

```sh
scripts/safe-api.sh sep GET "/api/v2/delegates/?delegate=$DELEGATE&safe=$SAFE"
```

The service keeps an expired row until an hourly cleanup. Compare `expiryDate` with the current
time. To renew, do step 2 again: the same Safe, delegate and owner update the row. A delegate
cannot renew itself, because the service needs a new owner signature. `propose.ts` prints a
notice when less than 24 hours remain.

## Refusals (HTTP 400, exit code 4)

| Message from the service | Meaning |
|---|---|
| `Safe=… does not exist or it's still not indexed` | Wrong chain, or the Safe is not indexed yet. |
| `Provided delegator=… is not an owner of Safe=…` | The signer is not a current owner. |
| `Signature does not match provided delegator=…` | `submit` already checked the owner, the chain and the hour, so the clocks differ. Check the system clock, and sign again after the hour starts. |
