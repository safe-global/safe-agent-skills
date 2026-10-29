import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getAddress, hashTypedData, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { api, chainIdOf } from './sign-delegate.ts';

const NAME = 'safe-agent-skill/1.0';
const URL_ = 'https://github.com/safe-global/safe-agent-skills';
const DAY_MS = 24 * 3600 * 1000;
const USAGE = `usage: propose.ts --chain <slug> --safe <address> --to <address> --note <one line>
    [--value <wei>] [--data 0x...] [--delegatecall] [--nonce <n>] [--key-file <path>] [--dry-run]
  The delegate key comes from SAFE_DELEGATE_PRIVATE_KEY or --key-file.`;

export type SafeTx = { to: Address; value: bigint; data: Hex; operation: 0 | 1; nonce: bigint };
export type DelegateRow = { safe: string | null; delegator: string; expiryDate: string | null };
export type Refusal = { kind: string; message: string };

/** EIP-712 SafeTx; the domain has chainId from Safe 1.3.0, and baseGas was dataGas before 1.0.0. */
export function safeTxHash(tx: SafeTx, safe: Address, chainId: number, version: string): Hex {
  const [major, minor] = version.split(/[.+]/).map(Number);
  const gasField = major >= 1 ? 'baseGas' : 'dataGas';
  const withChainId = major > 1 || (major === 1 && minor >= 3);
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' }, { name: gasField, type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
    ],
  };
  const message = { ...tx, safeTxGas: 0n, [gasField]: 0n, gasPrice: 0n,
    gasToken: zeroAddress, refundReceiver: zeroAddress };
  const domain = withChainId ? { chainId, verifyingContract: safe } : { verifyingContract: safe };
  return hashTypedData({ domain, types, primaryType: 'SafeTx', message });
}

export const nextNonce = (safeNonce: number, highestPending: number | null) =>
  Math.max(safeNonce, highestPending === null ? 0 : highestPending + 1);

/** The origin JSON that Safe{Wallet} shows; the service stores at most 200 characters. */
export function buildOrigin(note: string): string {
  const chars = Array.from(note.replace(/\s+/g, ' ').trim());
  if (chars.length === 0) throw new Error('--note is empty: describe the transaction in one line');
  const origin = (text: string) => JSON.stringify({ name: NAME, url: URL_, note: text });
  let n = chars.length;
  while (origin(chars.slice(0, n).join('') + (n < chars.length ? '…' : '')).length > 200) n--;
  return origin(chars.slice(0, n).join('') + (n < chars.length ? '…' : ''));
}

export function renewalNotice(row: DelegateRow | undefined, now: number): string | null {
  const expiry = row?.expiryDate ? Date.parse(row.expiryDate) : NaN;
  if (!(expiry > now && expiry - now < DAY_MS)) return null;
  return `The delegate registration expires at ${row?.expiryDate}. Renewal needs the owner to ` +
    'sign again (skills/register-delegate.md).';
}

/** Explains a refused proposal; rows are all registrations of the delegate. */
export function explainRefusal(
  exit: number, body: unknown, rows: DelegateRow[], safe: Address, now: number,
): Refusal {
  const again = 'An owner must register it again: skills/register-delegate.md.';
  if (exit === 3) return { kind: 'quota', message: 'The API quota is used up (see above).' };
  const text = JSON.stringify(body);
  if (!text.includes('is not an owner or delegate')) {
    return { kind: 'rejected', message: `The service refused the proposal: ${text}` };
  }
  const own = rows.filter((r) => r.safe === null || r.safe.toLowerCase() === safe.toLowerCase());
  const live = own.find((r) => r.expiryDate === null || Date.parse(r.expiryDate) > now);
  if (live) {
    const message = `The delegator ${live.delegator} is no longer an owner of ${safe}. ${again}`;
    return { kind: 'delegator-not-owner', message };
  }
  if (own.length > 0) {
    const message = `The delegate registration expired at ${own[0].expiryDate}. ${again}`;
    return { kind: 'expired', message };
  }
  if (rows.length > 0) {
    const others = rows.map((r) => r.safe).join(', ');
    const message = `The delegate is registered for ${others}, not for ${safe}. ${again}`;
    return { kind: 'other-safe', message };
  }
  const message = 'The delegate is not registered, or an expired registration was already ' +
    `cleaned up. ${again}`;
  return { kind: 'not-registered', message };
}

function die(message: string, code = 2): never {
  process.stderr.write(`propose: ${message}\n`);
  process.exit(code);
}

function loadKey(file: string | undefined): Hex {
  if (file && (statSync(file).mode & 0o077) !== 0) die(`${file} is readable by others: chmod 600`);
  const raw = file ? readFileSync(file, 'utf8') : process.env.SAFE_DELEGATE_PRIVATE_KEY ?? '';
  const key = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    die('set SAFE_DELEGATE_PRIVATE_KEY or pass --key-file <path> (from sign-delegate.ts new-key)');
  }
  return key as Hex;
}

type SafeInfo = { nonce: string; owners: string[]; version: string | null };

function read<T>(chain: string, path: string): T {
  const r = api(chain, 'GET', path);
  if (r.exit !== 0) process.exit(r.exit);
  return r.body as T;
}

function pickNonce(chain: string, safe: Address, safeNonce: number, wanted?: string): number {
  if (wanted !== undefined) {
    if (!/^\d+$/.test(wanted) || Number(wanted) < safeNonce) die(`--nonce must be >= ${safeNonce}`);
    return Number(wanted);
  }
  const queue = read<{ results: { nonce: string }[] }>(chain, `/api/v2/safes/${safe}/` +
    `multisig-transactions/?executed=false&nonce__gte=${safeNonce}&ordering=-nonce&limit=1`);
  return nextNonce(safeNonce, queue.results.length ? Number(queue.results[0].nonce) : null);
}

function parse(argv: string[]) {
  const options = {
    chain: { type: 'string' }, safe: { type: 'string' }, to: { type: 'string' },
    value: { type: 'string', default: '0' }, data: { type: 'string', default: '0x' },
    note: { type: 'string', default: '' }, nonce: { type: 'string' },
    'key-file': { type: 'string' }, delegatecall: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  } as const;
  const { values: o } = parseArgs({ args: argv, options, strict: true });
  if (!o.chain || !o.safe || !o.to) die(USAGE);
  if (!/^\d+$/.test(o.value)) die('--value is a whole number of wei');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(o.data)) die('--data is 0x-prefixed hex bytes');
  return { ...o, chain: o.chain, safe: getAddress(o.safe), to: getAddress(o.to) };
}

type Options = ReturnType<typeof parse>;

async function build(o: Options, delegate: PrivateKeyAccount, info: SafeInfo, origin: string) {
  if (o.delegatecall) {
    process.stderr.write(`propose: WARNING operation 1 (delegatecall): ${o.to} runs with the ` +
      "Safe's storage and funds. Owners must trust that contract.\n");
  }
  const nonce = pickNonce(o.chain, o.safe, Number(info.nonce), o.nonce);
  const tx: SafeTx = { to: o.to, value: BigInt(o.value), data: o.data as Hex,
    operation: o.delegatecall ? 1 : 0, nonce: BigInt(nonce) };
  const hash = safeTxHash(tx, o.safe, chainIdOf(o.chain), info.version ?? '');
  const payload = { to: tx.to, value: o.value, data: tx.data, operation: tx.operation, safeTxGas: 0,
    baseGas: 0, gasPrice: 0, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce,
    contractTransactionHash: hash, sender: delegate.address,
    signature: await delegate.sign({ hash }), origin };
  return { hash, payload };
}

function send(o: Options, delegate: Address, hash: Hex, payload: object) {
  const posted = api(o.chain, 'POST', `/api/v2/safes/${o.safe}/multisig-transactions/`, payload);
  if (posted.exit !== 0) {
    const all = posted.exit === 4 ? read<{ results: DelegateRow[] }>(o.chain,
      `/api/v2/delegates/?delegate=${delegate}`).results : [];
    die(explainRefusal(posted.exit, posted.body, all, o.safe, Date.now()).message, posted.exit);
  }
  const t = read<Record<string, unknown>>(o.chain, `/api/v2/multisig-transactions/${hash}/`);
  const { safeTxHash: h, nonce, proposer, proposedByDelegate, origin, confirmationsRequired } = t;
  const confirmations = (t.confirmations as unknown[] | null)?.length ?? 0;
  console.log(JSON.stringify({ safeTxHash: h, nonce, proposer, proposedByDelegate, origin,
    confirmations, confirmationsRequired }));
  process.stderr.write('propose: proposed. Owners confirm and execute it in Safe{Wallet}.\n');
}

async function main(argv: string[]) {
  const o = parse(argv);
  const origin = buildOrigin(o.note);
  const delegate = privateKeyToAccount(loadKey(o['key-file']));
  const info = read<SafeInfo>(o.chain, `/api/v1/safes/${o.safe}/`);
  if (info.owners.some((owner) => getAddress(owner) === delegate.address)) {
    die('this key is an owner of the Safe. propose.ts signs only as a delegate; owners use ' +
      'Safe{Wallet}.');
  }
  if (!info.version) die('the service does not know the Safe version: no hash can be computed');
  const { hash, payload } = await build(o, delegate, info, origin);
  const mine = read<{ results: DelegateRow[] }>(o.chain,
    `/api/v2/delegates/?delegate=${delegate.address}&safe=${o.safe}`);
  const notice = renewalNotice(mine.results[0], Date.now());
  if (notice) process.stderr.write(`propose: ${notice}\n`);
  if (o['dry-run']) return console.log(JSON.stringify({ safeTxHash: hash, payload }, null, 2));
  send(o, delegate.address, hash, payload);
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: Error) => die(error.message));
}
