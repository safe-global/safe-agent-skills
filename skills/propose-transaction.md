---
name: propose-transaction
description: Propose a Safe transaction as a registered delegate. The proposal appears in the Safe{Wallet} queue with a one-line note; owners confirm and execute it there. Proposal only; the agent cannot sign as an owner, confirm, execute or broadcast.
---

# Propose a transaction

The agent proposes; the owners decide. `propose.ts` signs the transaction hash with the delegate
key. The service stores that signature as the proposer's, not as a confirmation: the proposal
starts with 0 confirmations. Owners confirm and execute it in Safe{Wallet}.

- Install first: clone https://github.com/safe-global/safe-agent-skills, run `npm ci`, and run
  the commands from its root (README). The scripts are not in this file.
- The script makes every API call through `scripts/safe-api.sh`. The chain slug (`sep`, `eth`,
  `gno`, see the README) is part of the URL. Export `SAFE_API_KEY` first.
- You need a delegate registered for this Safe (the register-delegate skill). The key comes from
  `SAFE_DELEGATE_PRIVATE_KEY` or `--key-file <path>`, never from an argument.
- Before you propose, decode and explain the call (the decode-and-explain skill) and tell the
  user what the owners will see.

```sh
node scripts/propose.ts --chain sep --safe "$SAFE" --to "$TO" --value 1000000000000000 \
  --note "Pay 0.001 ETH to Alice for invoice 42" --key-file ~/.safe-agent/delegate.key --dry-run
```

Run it again without `--dry-run` to send it.

## What the script does

- It reads the Safe and refuses when the key is an owner key: owners use Safe{Wallet}.
- Nonce: the next free nonce after the pending queue, that is the maximum of the Safe nonce and
  the highest pending nonce + 1. `--nonce <n>` proposes a replacement for pending nonce `n`;
  only one transaction per nonce can execute.
- `safeTxGas`, `baseGas` and `gasPrice` are 0; `gasToken` and `refundReceiver` are the zero
  address. The owner who executes pays the gas.
- It computes the `safeTxHash` (EIP-712; the domain has the chain ID from Safe 1.3.0). The
  service computes it again and refuses a different value.
- `origin` is the JSON string
  `{"name":"safe-agent-skill/1.0","url":"https://github.com/safe-global/safe-agent-skills","note":"…"}`,
  at most 200 characters. Safe{Wallet} shows the note to the owners. `--note` is required; the
  script shortens a long note and ends it with `…`.
- `--value` is in wei; `--data` is the calldata (default `0x`).
- `--delegatecall` sets operation 1 and prints a warning: the target code then runs with the
  Safe's storage and funds. Use it only when the user asks for it and trusts the target.
- `--dry-run` prints the payload and the hash and sends nothing.
- After the proposal it reads the transaction back and prints `safeTxHash`, `nonce`, `proposer`
  (the owner who registered the delegate), `proposedByDelegate`, `origin`, `confirmations` (0)
  and `confirmationsRequired`.

## Refusals

| Exit code | Cause | Next step |
|---|---|---|
| 2 | Bad input, an empty note, an owner key, no key | Fix the input. |
| 3 | The API quota is used up | Wait until the printed retry time. |
| 4 | The delegate is not registered, expired, registered for another Safe, or its owner left the Safe | Register again (register-delegate). |
| 4 | Another refusal, for example `Tx with nonce=… already executed` | Read the message; it quotes the service. |
| 5 | Server or network error | Retry later. |

When the registration expires within 24 hours, the script prints a renewal notice. Renewal needs
the owner.
