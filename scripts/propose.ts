import { parseArgs } from 'node:util';
import {
  decodeAbiParameters, encodeAbiParameters, formatEther, getAddress, hashTypedData, zeroAddress,
} from 'viem';
import type { AbiParameter, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { addressArg, api, chainIdOf, isEntry, loadKey } from './lib.ts';

const NAME = 'safe-agent-skill/1.0';
const URL_ = 'https://github.com/safe-global/safe-agent-skills';
const DAY_MS = 24 * 3600 * 1000;
const USAGE = `usage: propose.ts --chain <slug> --safe <address> --to <address> --note <one line>
    [--value <wei>] [--data 0x...] [--delegatecall] [--nonce <n>] [--key-file <path>] [--dry-run]
    [--expect-hash <safeTxHash>] [--accept-risk <kind[,kind]>]
  --dry-run prints what would be proposed and signs and sends nothing.
  --expect-hash stops unless the transaction hashes to this safeTxHash of the dry run.
  --accept-risk lets self-call, delegatecall or batch-delegatecall be sent, after the user's yes.
  --note is public: anyone who knows the Safe address can read it.
  The delegate key comes from SAFE_DELEGATE_PRIVATE_KEY or --key-file.`;
// Tab, newline and carriage return fold into spaces. Other control and format characters
// (bidi, zero-width, tags), private-use and unassigned code points are refused.
const CONTROL_RE = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;
// Variation selectors and characters that render blank: Hangul fillers, braille blank, CGJ.
const BLANK_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u3164\u115F\u1160\u2800\u034F\uFFA0]/u;
const INVISIBLE_RE = new RegExp(`${CONTROL_RE.source}|${BLANK_RE.source}`, 'u');
const MULTI_SEND = '0x8d80ff0a';
const APPROVE = '0x095ea7b3';
const INCREASE_ALLOWANCE = '0x39509351';
const SET_APPROVAL_FOR_ALL = '0xa22cb465';
// approve(address token, address spender, uint160 amount, uint48 expiration), as in Permit2.
const PERMIT2_APPROVE = '0x87517c45';
// Tokens with 96-bit balances (UNI, COMP) treat 2^96 - 1 as their unlimited allowance.
const UNLIMITED = 2n ** 96n - 1n;
const SERVICE_UNREADABLE = '(not shown: not an http(s) URL)';
const MAX_BATCH = 256;
// 1 byte operation, 20 bytes to, 32 bytes value, 32 bytes data length; in hex characters.
const ENTRY_HEAD = 2 * (1 + 20 + 32 + 32);
// MultiSend and MultiSendCallOnly from github.com/safe-global/safe-deployments 1.3.0, 1.4.1, 1.5.0.
export const KNOWN_MULTI_SEND: ReadonlySet<string> = new Set([
  '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761', '0x998739bfdaadde7c933b942a68053933098f9eda',
  '0x0dfcccb95225ffb03c6fbb2559b530c2b7c8a912', '0x40a2accbd92bca938b02010e17a5b8929b49130d',
  '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b', '0xf220d3b4dfb23c4ade8c88e526c1353abacbc38f',
  '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526', '0x309d0b190fecca8e1d5d8309a16f7e3cb133e885',
  '0x9641d764fc13c8b624c04430c7356c1c7c8102e2', '0x0408ef011960d02349d50286d20531229bcef773',
  '0x218543288004cd07832472d464648173c77d7eb7', '0xa83c336b20401af773b6219ba5027174338d1836',
]);

export type SafeTx = { to: Address; value: bigint; data: Hex; operation: 0 | 1; nonce: bigint };
export type Call = { operation: 0 | 1; to: Address; value: bigint; data: Hex };
export type DelegateRow = { safe: string | null; delegator: string; expiryDate: string | null };
export type Refusal = { kind: string; message: string };
export type DelegateStatus = { kind: 'registered' | 'expiring' | 'expired' | 'not-registered';
  message: string };
export const RISKS = ['delegatecall', 'batch-delegatecall', 'batch-undecoded', 'self-call',
  'unlimited-approval', 'approval-undecoded'] as const;
export type Risk = (typeof RISKS)[number];
/** The risk kinds that a sending run proposes only when --accept-risk lists them. */
export const GATED_RISKS = ['self-call', 'delegatecall', 'batch-delegatecall'] as const satisfies
  readonly Risk[];
export type GatedRisk = (typeof GATED_RISKS)[number];
export const UNREADABLE_BATCH = 'the multiSend batch cannot be read, so its calls cannot be ' +
  'checked. Nothing was signed or sent. Encode the batch in the standard form.';
/** What a dry run says about the run that would send it. */
export type Next = { expectHash: Hex; acceptRisk: GatedRisk[]; refused: string | null };
export type Approval = { token: Address } & (
  | { kind: 'allowance'; spender: Address; amount: bigint; increase: boolean }
  | { kind: 'permit2'; spender: Address; amount: bigint; expiration: number; via: Address }
  | { kind: 'operator'; operator: Address; approved: boolean }
  | { kind: 'undecoded' });
export type Finding = { risk: Risk; line: string };
/** What the checks read from a transaction: the batch, if any, its approvals and its risks. */
export type Review = { batch: Call[] | null; approvals: Approval[]; findings: Finding[] };
export type NonceKind = 'next' | 'given' | 'replaces';
export type Summary = { chain: string; chainId: number; safe: Address; tx: SafeTx; review: Review;
  nonceKind: NonceKind; note: string; hash: Hex; service?: string; delegate: string };

const VERSION_RE = /^(\d+)\.(\d+)\.\d+(\+[0-9A-Za-z.]+)?$/;

/** EIP-712 SafeTx; the domain has chainId from Safe 1.3.0, and baseGas was dataGas before 1.0.0. */
export function safeTxHash(
  tx: SafeTx, safe: Address, chainId: number, version: string | null,
): Hex {
  const parts = VERSION_RE.exec(version ?? '');
  if (!parts) throw new Error(`unknown Safe version ${JSON.stringify(version)}: no hash computed`);
  const [major, minor] = [Number(parts[1]), Number(parts[2])];
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

export function wantedNonce(wanted: string, safeNonce: number): number {
  const nonce = Number(wanted);
  if (!/^\d+$/.test(wanted) || !Number.isSafeInteger(nonce) || nonce < safeNonce) {
    throw new Error(`--nonce must be a whole number from ${safeNonce} to 2^53 - 1`);
  }
  return nonce;
}

/** The origin JSON that Safe{Wallet} shows; the service stores at most 200 characters. */
export function buildOrigin(note: string): string {
  const control = INVISIBLE_RE.exec(note)?.[0];
  if (control !== undefined) {
    const code = (control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`--note has an invisible or control character (U+${code}): write plain text`);
  }
  const chars = Array.from(note.replace(/\s+/g, ' ').trim());
  if (chars.length === 0) throw new Error('--note is empty: describe the transaction in one line');
  const origin = (text: string) => JSON.stringify({ name: NAME, url: URL_, note: text });
  let n = chars.length;
  while (origin(chars.slice(0, n).join('') + (n < chars.length ? '…' : '')).length > 200) n--;
  return origin(chars.slice(0, n).join('') + (n < chars.length ? '…' : ''));
}

/** Origin and path of the service URL, without credentials, query or fragment. */
export function serviceName(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return SERVICE_UNREADABLE;
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return SERVICE_UNREADABLE;
  }
}

const expiryOf = (row: DelegateRow) => (row.expiryDate ? Date.parse(row.expiryDate) : Infinity);

/** The rows the service checks for this Safe: its own, and those for every Safe (safe null). */
export const rowsForSafe = (rows: DelegateRow[], safe: Address) =>
  rows.filter((r) => r.safe === null || r.safe.toLowerCase() === safe.toLowerCase());

/** The rows whose delegator is an owner; the service ignores the others. */
export const rowsByOwners = (rows: DelegateRow[], owners: string[]) =>
  rows.filter((r) => owners.some((owner) => owner.toLowerCase() === r.delegator.toLowerCase()));

/** The status of the registration for this Safe that lasts longest. */
export function delegateStatus(rows: DelegateRow[], now: number): DelegateStatus {
  const register = 'An owner must register it (the register-delegate skill).';
  const row = [...rows].sort((a, b) => expiryOf(b) - expiryOf(a))[0];
  if (!row) {
    const message = 'The delegate is not registered for this Safe, and the service refuses its ' +
      `proposals. ${register}`;
    return { kind: 'not-registered', message };
  }
  const expiry = expiryOf(row);
  if (expiry <= now) {
    const message = `The delegate registration expired at ${row.expiryDate}. ${register}`;
    return { kind: 'expired', message };
  }
  if (expiry - now < DAY_MS) {
    const message = `The delegate registration expires at ${row.expiryDate}. Renewal needs the ` +
      'owner to sign again (the register-delegate skill).';
    return { kind: 'expiring', message };
  }
  const until = row.expiryDate ? `until ${row.expiryDate}` : 'with no expiry';
  return { kind: 'registered', message: `The delegate is registered for this Safe ${until}.` };
}

/** Explains a 4xx refusal of a proposal; rows are all registrations of the delegate. */
export function explainRefusal(
  body: unknown, rows: DelegateRow[], safe: Address, now: number,
): Refusal {
  const again = 'An owner must register it again with the register-delegate skill.';
  const text = JSON.stringify(body);
  if (!text.includes('is not an owner or delegate')) {
    return { kind: 'rejected', message: `The service refused the proposal: ${text}` };
  }
  const own = rowsForSafe(rows, safe);
  const live = own.find((r) => r.expiryDate === null || Date.parse(r.expiryDate) > now);
  if (live) {
    const message = `The delegator ${live.delegator} is not an owner of ${safe}. ${again}`;
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

const selectorOf = (data: Hex) => data.slice(0, 10).toLowerCase();
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const isBatch = (data: Hex) => selectorOf(data) === MULTI_SEND;
export const isKnownMultiSend = (to: string) => KNOWN_MULTI_SEND.has(to.toLowerCase());

/** The arguments after the selector, only when they re-encode to the same bytes. */
function decodeArgs(params: readonly AbiParameter[], data: Hex): readonly unknown[] | null {
  const args = `0x${data.slice(10)}`.toLowerCase() as Hex;
  try {
    const values = decodeAbiParameters(params, args);
    return encodeAbiParameters(params, values) === args ? values : null;
  } catch {
    return null;
  }
}

/** One packed entry at hex offset at: the call and the offset after it, or null. */
function entryAt(packed: string, at: number): { call: Call; end: number } | null {
  if (packed.length - at < ENTRY_HEAD) return null;
  const operation = Number.parseInt(packed.slice(at, at + 2), 16);
  const size = BigInt(`0x${packed.slice(at + 106, at + ENTRY_HEAD)}`) * 2n;
  if (operation > 1 || size > BigInt(packed.length - at - ENTRY_HEAD)) return null;
  const end = at + ENTRY_HEAD + Number(size);
  const call: Call = { operation: operation as 0 | 1,
    to: getAddress(`0x${packed.slice(at + 2, at + 42)}`),
    value: BigInt(`0x${packed.slice(at + 42, at + 106)}`),
    data: `0x${packed.slice(at + ENTRY_HEAD, end)}` };
  return { call, end };
}

/** The calls of a multiSend(bytes) batch, or null when the data is not a well-formed batch. */
export function decodeMultiSend(data: Hex): Call[] | null {
  const args = isBatch(data) ? decodeArgs([{ type: 'bytes' }], data) : null;
  if (!args) return null;
  const packed = (args[0] as Hex).slice(2);
  const calls: Call[] = [];
  for (let at = 0; at < packed.length;) {
    const entry = calls.length < MAX_BATCH ? entryAt(packed, at) : null;
    if (!entry) return null;
    calls.push(entry.call);
    at = entry.end;
  }
  return calls;
}

const ALLOWANCE_ARGS = [{ type: 'address' }, { type: 'uint256' }] as const;
const OPERATOR_ARGS = [{ type: 'address' }, { type: 'bool' }] as const;
const PERMIT2_ARGS = [{ type: 'address' }, { type: 'address' }, { type: 'uint160' },
  { type: 'uint48' }] as const;

/** A Permit2-style approve: the token is an argument, the call goes to the contract at via. */
function permit2Approval(via: Address, data: Hex): Approval {
  const args = decodeArgs(PERMIT2_ARGS, data);
  if (!args) return { token: via, kind: 'undecoded' };
  return { token: args[0] as Address, kind: 'permit2', spender: args[1] as Address,
    amount: args[2] as bigint, expiration: args[3] as number, via };
}

/** The approval a call grants, or null when it is not an approval call. */
export function approvalOf(call: { to: Address; data: Hex }): Approval | null {
  const selector = selectorOf(call.data);
  const token = getAddress(call.to);
  if (selector === PERMIT2_APPROVE) return permit2Approval(token, call.data);
  if (selector === SET_APPROVAL_FOR_ALL) {
    const args = decodeArgs(OPERATOR_ARGS, call.data);
    if (!args) return { token, kind: 'undecoded' };
    return { token, kind: 'operator', operator: args[0] as Address, approved: args[1] as boolean };
  }
  if (selector !== APPROVE && selector !== INCREASE_ALLOWANCE) return null;
  const args = decodeArgs(ALLOWANCE_ARGS, call.data);
  if (!args) return { token, kind: 'undecoded' };
  return { token, kind: 'allowance', spender: args[0] as Address, amount: args[1] as bigint,
    increase: selector === INCREASE_ALLOWANCE };
}

export const isUnlimited = (a: Approval) =>
  ((a.kind === 'allowance' || a.kind === 'permit2') && a.amount >= UNLIMITED) ||
  (a.kind === 'operator' && a.approved);

/** A delegatecall, unless it is a batch sent to a known Safe MultiSend contract. */
export const isUnknownDelegatecall = (tx: { operation: 0 | 1; to: Address; data: Hex }) =>
  tx.operation === 1 && !(isBatch(tx.data) && isKnownMultiSend(tx.to));

/** The 1-based positions of inner calls that delegatecall or are batches themselves. */
export const innerDelegatecalls = (batch: Call[]) =>
  batch.flatMap((call, i) => (call.operation === 1 || isBatch(call.data) ? [i + 1] : []));

/** True when the transaction, or a call of its batch, targets the Safe itself. */
export const callsSafe = (tx: SafeTx, batch: Call[] | null, safe: Address) =>
  [tx, ...(batch ?? [])].some((call) => sameAddress(call.to, safe));

function innerDelegatecallLine(position: number, call: Call): string {
  if (call.operation === 1) {
    return `inner call ${position} is a delegatecall: ${call.to} runs with the Safe's storage ` +
      'and funds.';
  }
  return `inner call ${position} to ${call.to} is a nested batch; its calls are not checked.`;
}

function approvalRisk(a: Approval): Finding | null {
  if (a.kind === 'undecoded') {
    return { risk: 'approval-undecoded',
      line: `RISK approval-undecoded: the approval call to ${a.token} could not be read.` };
  }
  if (!isUnlimited(a)) return null;
  const grant = a.kind === 'operator' ? `${a.operator} move every token of that collection` :
    `${a.spender} spend without limit${a.kind === 'permit2' ? ` through ${a.via}` : ''}`;
  return { risk: 'unlimited-approval', line: `RISK unlimited-approval: ${a.token} lets ${grant}.` };
}

export function review(tx: SafeTx, safe: Address): Review {
  const batch = decodeMultiSend(tx.data);
  const approvals = [tx, ...(batch ?? [])].flatMap((call) => approvalOf(call) ?? []);
  const findings: Finding[] = [];
  const add = (risk: Risk, line: string) => findings.push({ risk, line: `RISK ${risk}: ${line}` });
  if (isUnknownDelegatecall(tx)) {
    add('delegatecall', `${tx.to} runs with the Safe's storage and funds. Owners must trust ` +
      'that contract.');
  }
  if (isBatch(tx.data) && !batch) add('batch-undecoded', 'the inner calls could not be read.');
  const inner = batch ?? [];
  for (const position of innerDelegatecalls(inner)) {
    add('batch-delegatecall', innerDelegatecallLine(position, inner[position - 1]));
  }
  if (callsSafe(tx, batch, safe)) {
    add('self-call', 'changes the Safe itself: owners, threshold, modules, guard or fallback ' +
      'handler.');
  }
  findings.push(...approvals.flatMap((a) => approvalRisk(a) ?? []));
  return { batch, approvals, findings };
}

/** The risk kinds of a review, each once, in the order of their lines. */
export const risksOf = (r: Review): Risk[] => [...new Set(r.findings.map((f) => f.risk))];

export const isGated = (kind: string): kind is GatedRisk =>
  (GATED_RISKS as readonly string[]).includes(kind);

/** The gated kinds among the risks, in the order of their lines. */
export const gatedOf = (risks: Risk[]): GatedRisk[] => risks.filter(isGated);

export const nextStep = (hash: Hex, risks: Risk[]): Next => ({ expectHash: hash,
  acceptRisk: gatedOf(risks),
  refused: risks.includes('batch-undecoded') ? UNREADABLE_BATCH : null });

/** The lines a dry run prints after the summary: the flags of the sending run, or its refusal. */
export function nextLines(next: Next): string[] {
  if (next.refused) return ['a sending run refuses this: the multiSend batch cannot be read.'];
  const kinds = next.acceptRisk;
  const accept = kinds.length > 0 ? ` --accept-risk ${kinds.join(',')}` : '';
  return [`to send, run again without --dry-run and with --expect-hash ${next.expectHash}${accept}`,
    ...(kinds.length > 0 ?
      [`pass --accept-risk only after the user said yes to: ${kinds.join(', ')}.`] : [])];
}

export const valueLine = (value: bigint) =>
  `Value: ${value} wei (${formatEther(value)} in the native coin)`;

export function dataDescription(data: Hex): string {
  const bytes = (data.length - 2) / 2;
  if (bytes === 0) return 'none';
  if (bytes < 4) return `${bytes} bytes, no selector`;
  return `${bytes} bytes, selector ${data.slice(0, 10)}`;
}

export const dataLine = (data: Hex) => `Data: ${dataDescription(data)}`;

export function batchLines(data: Hex, batch: Call[] | null): string[] {
  if (!isBatch(data)) return [];
  if (!batch) return ['Batch: could not be decoded'];
  return [`Batch: ${batch.length} call${batch.length === 1 ? '' : 's'}`, ...batch.map((c, i) =>
    `  ${i + 1}. To: ${c.to}, value ${c.value} wei, ${dataDescription(c.data)}`)];
}

export function approvalLine(a: Approval): string {
  if (a.kind === 'undecoded') return `Approval: ${a.token}: could not be decoded`;
  if (a.kind === 'operator') {
    return a.approved ? `Approval: ${a.token} lets ${a.operator} move every token of that ` +
      'collection' : `Approval: ${a.token} removes ${a.operator} as operator`;
  }
  if (a.kind === 'permit2') {
    // Permit2 reads an expiration of 0 as the timestamp of the block that runs the call.
    const until = a.expiration === 0 ? 'for the current block only' :
      `until ${a.expiration} (Unix time)`;
    return `Approval: ${a.token} lets ${a.spender} spend ${a.amount} (raw units) ${until}, ` +
      `granted through ${a.via}`;
  }
  return `Approval: ${a.token} lets ${a.spender} spend ${a.amount}${a.increase ? ' more' : ''} ` +
    '(raw units)';
}

export function nonceLine(nonce: bigint, kind: NonceKind): string {
  if (kind === 'next') return `Nonce: ${nonce} (next free)`;
  if (kind === 'replaces') return `Nonce: ${nonce} (REPLACES pending nonce ${nonce})`;
  return `Nonce: ${nonce}`;
}

/** The lines that report the proposal, risks first. */
export function summaryLines(s: Summary): string[] {
  return [
    ...s.review.findings.map((finding) => finding.line),
    `Chain: ${s.chain} (${s.chainId})`,
    `Safe: ${s.safe}`,
    `To: ${s.tx.to}`,
    valueLine(s.tx.value),
    dataLine(s.tx.data),
    ...batchLines(s.tx.data, s.review.batch),
    ...s.review.approvals.map(approvalLine),
    `Operation: ${s.tx.operation} (${s.tx.operation === 1 ? 'delegatecall' : 'call'})`,
    nonceLine(s.tx.nonce, s.nonceKind),
    `Note (public): ${s.note}`,
    `safeTxHash: ${s.hash}`,
    ...(s.service ? [`Service: ${s.service}`] : []),
    `Delegate: ${s.delegate}`,
  ];
}

function die(message: string, code = 2): never {
  process.stderr.write(`propose: ${message}\n`);
  process.exit(code);
}

type SafeInfo = { nonce: string; owners: string[]; version: string | null };

function read<T>(chain: string, path: string): T {
  const r = api(chain, 'GET', path);
  if (r.exit !== 0) process.exit(r.exit);
  return r.body as T;
}

type Picked = { nonce: number; kind: NonceKind };

function pickNonce(chain: string, safe: Address, safeNonce: number, wanted?: string): Picked {
  const queue = `/api/v2/safes/${safe}/multisig-transactions/`;
  if (wanted !== undefined) {
    const nonce = wantedNonce(wanted, safeNonce);
    const pending = read<{ count?: number; results?: unknown[] }>(chain,
      `${queue}?nonce=${nonce}&executed=false`);
    const count = pending.count ?? pending.results?.length ?? 0;
    return { nonce, kind: count > 0 ? 'replaces' : 'given' };
  }
  const last = read<{ results: { nonce: string }[] }>(chain,
    `${queue}?executed=false&nonce__gte=${safeNonce}&ordering=-nonce&limit=1`);
  const highest = last.results.length ? Number(last.results[0].nonce) : null;
  return { nonce: nextNonce(safeNonce, highest), kind: 'next' };
}

function parse(argv: string[]) {
  const options = {
    chain: { type: 'string' }, safe: { type: 'string' }, to: { type: 'string' },
    value: { type: 'string', default: '0' }, data: { type: 'string', default: '0x' },
    note: { type: 'string', default: '' }, nonce: { type: 'string' },
    'key-file': { type: 'string' }, delegatecall: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, 'expect-hash': { type: 'string' },
    'accept-risk': { type: 'string', multiple: true },
  } as const;
  const { values: o } = parseArgs({ args: argv, options, strict: true });
  if (!o.chain || !o.safe || !o.to) die(USAGE);
  if (!/^\d+$/.test(o.value)) die('--value is a whole number of wei');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(o.data)) die('--data is 0x-prefixed hex bytes');
  const expected = o['expect-hash'];
  if (expected !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(expected)) {
    die(`--expect-hash: ${expected} is not a 32-byte hex safeTxHash`);
  }
  return { ...o, chain: o.chain, safe: addressArg('safe', o.safe), to: addressArg('to', o.to),
    accepted: acceptedRisks(o['accept-risk'] ?? []) };
}

function acceptedRisks(values: string[]): GatedRisk[] {
  if (values.length > 1) die('--accept-risk: give it once, with the kinds separated by commas');
  return (values[0]?.split(',') ?? []).map((kind) => isGated(kind) ? kind :
    die(`--accept-risk: ${kind} is not one of ${GATED_RISKS.join(', ')}`));
}

/** Stops unless the transaction hashes to the safeTxHash that --expect-hash gives. */
function checkExpectedHash(expected: string | undefined, hash: Hex, nonce: number) {
  if (expected === undefined || expected.toLowerCase() === hash.toLowerCase()) return;
  die(`the transaction is not the one of the dry run: --expect-hash is ${expected}, it now ` +
    `hashes to ${hash} (nonce ${nonce}). Nothing was signed or sent. Run the dry run again and ` +
    'check its summary.');
}

/** The checks between the summary and the signature of a sending run, in this order. */
function gate(o: Options, hash: Hex, nonce: number, risks: Risk[]) {
  if (risks.includes('batch-undecoded')) die(UNREADABLE_BATCH);
  checkExpectedHash(o['expect-hash'], hash, nonce);
  const missing = gatedOf(risks).filter((kind) => !o.accepted.includes(kind));
  if (missing.length === 0) return;
  die(`this proposal has risks that need an explicit yes: ${missing.join(', ')}. Nothing was ` +
    `signed or sent. Ask the user, then run again with --accept-risk ${gatedOf(risks).join(',')}.`);
}

type Options = ReturnType<typeof parse>;

type Request = { method: string; path: string; body: object };

const checkLines = (chain: string, hash: Hex) => `  safeTxHash: ${hash}\n` +
  `  Check: scripts/safe-api.sh ${chain} GET /api/v2/multisig-transactions/${hash}/`;

function unknownOutcome(chain: string, hash: Hex): never {
  die('the outcome is unknown: the service may have stored the proposal.\n' +
    `${checkLines(chain, hash)}\n  200: it is proposed. 404: it is not; run propose.ts again.`, 5);
}

/** A 4xx stays the outcome; the delegate rows read before the POST only name its cause. */
function refused(safe: Address, rows: DelegateRow[], body: unknown): never {
  die(explainRefusal(body, rows, safe, Date.now()).message, 4);
}

/** After a stored proposal every read-back failure exits 5, except a 429 (3). */
function readBack(chain: string, hash: Hex): Record<string, unknown> {
  const back = api(chain, 'GET', `/api/v2/multisig-transactions/${hash}/`);
  if (back.exit === 0) return back.body as Record<string, unknown>;
  die('proposed: the service stored the proposal, but the read-back failed. Do not propose ' +
    `it again.\n${checkLines(chain, hash)}`, back.exit === 3 ? 3 : 5);
}

/** Separate runs do not coordinate, so two proposals can share a nonce. */
function warnSameNonce(chain: string, safe: Address, nonce: number) {
  const r = api(chain, 'GET', `/api/v2/safes/${safe}/multisig-transactions/?nonce=${nonce}`);
  const body = r.body;
  const counted = typeof body === 'object' && body !== null && 'count' in body;
  const count = counted ? Number(body.count) : 0;
  if (r.exit !== 0) {
    process.stderr.write(`propose: could not list the proposals with nonce ${nonce}.\n`);
  } else if (count > 1) {
    process.stderr.write(`propose: WARNING ${count} proposals have nonce ${nonce}; only one ` +
      'can execute. Tell the owners which one to confirm in Safe{Wallet}.\n');
  }
}

type Report = { rows: DelegateRow[]; risks: Risk[]; summary: string[]; nonce: number };

function send(o: Options, hash: Hex, request: Request, report: Report) {
  const posted = api(o.chain, request.method, request.path, request.body);
  if (posted.exit === 5) unknownOutcome(o.chain, hash);
  if (posted.exit === 4) refused(o.safe, report.rows, posted.body);
  if (posted.exit !== 0) process.exit(posted.exit);
  const t = readBack(o.chain, hash);
  const { safeTxHash: h, nonce, proposer, proposedByDelegate, origin, confirmationsRequired } = t;
  const confirmations = (t.confirmations as unknown[] | null)?.length ?? 0;
  console.log(JSON.stringify({ mode: 'sent', safeTxHash: h, nonce, proposer, proposedByDelegate,
    origin, confirmations, confirmationsRequired, risks: report.risks, summary: report.summary }));
  process.stderr.write('propose: proposed. Owners confirm and execute it in Safe{Wallet}.\n');
  if (typeof h !== 'string' || h.toLowerCase() !== hash.toLowerCase()) {
    process.stderr.write(`propose: WARNING the service returned safeTxHash ${String(h)}, not ` +
      `${hash}. Check the proposal in Safe{Wallet} before anyone confirms it.\n`);
  }
  warnSameNonce(o.chain, o.safe, report.nonce);
}

const writeSummary = (summary: string[]) =>
  process.stderr.write(`propose: summary\n${summary.map((line) => `  ${line}\n`).join('')}`);

async function main(argv: string[]) {
  const o = parse(argv);
  const origin = buildOrigin(o.note);
  const delegate = privateKeyToAccount(loadKey(o['key-file']));
  const info = read<SafeInfo>(o.chain, `/api/v1/safes/${o.safe}/`);
  if (info.owners.some((owner) => getAddress(owner) === delegate.address)) {
    die('this key is an owner of the Safe. propose.ts signs only as a delegate; owners use ' +
      'Safe{Wallet}.');
  }
  const picked = pickNonce(o.chain, o.safe, Number(info.nonce), o.nonce);
  const tx: SafeTx = { to: o.to, value: BigInt(o.value), data: o.data as Hex,
    operation: o.delegatecall ? 1 : 0, nonce: BigInt(picked.nonce) };
  const chainId = chainIdOf(o.chain);
  const hash = safeTxHash(tx, o.safe, chainId, info.version);
  const { results: rows } = read<{ results: DelegateRow[] }>(o.chain,
    `/api/v2/delegates/?delegate=${delegate.address}`);
  const status = delegateStatus(rowsByOwners(rowsForSafe(rows, o.safe), info.owners), Date.now());
  const checked = review(tx, o.safe);
  const risks = risksOf(checked);
  const service = process.env.SAFE_TX_SERVICE_URL;
  const summary = summaryLines({ chain: o.chain, chainId, safe: o.safe, tx, review: checked,
    nonceKind: picked.kind, note: JSON.parse(origin).note, hash,
    service: service ? serviceName(service) : undefined, delegate: status.message });
  const body = { to: tx.to, value: o.value, data: tx.data, operation: tx.operation, safeTxGas: 0,
    baseGas: 0, gasPrice: 0, gasToken: zeroAddress, refundReceiver: zeroAddress,
    nonce: picked.nonce, contractTransactionHash: hash, sender: delegate.address, origin };
  const request = { method: 'POST', path: `/api/v2/safes/${o.safe}/multisig-transactions/`, body };
  if (o['dry-run']) {
    const next = nextStep(hash, risks);
    console.log(JSON.stringify({ mode: 'dry-run', safeTxHash: hash, risks, summary,
      delegate: { status: status.kind, message: status.message }, request, next }, null, 2));
    writeSummary(summary);
    checkExpectedHash(o['expect-hash'], hash, picked.nonce);
    for (const line of nextLines(next)) process.stderr.write(`propose: ${line}\n`);
    return void process.stderr.write('propose: dry run only; nothing was signed or sent.\n');
  }
  writeSummary(summary);
  gate(o, hash, picked.nonce, risks);
  if (status.kind === 'expired' || status.kind === 'not-registered') die(status.message, 4);
  const signature = await delegate.sign({ hash });
  send(o, hash, { ...request, body: { ...body, signature } },
    { rows, risks, summary, nonce: picked.nonce });
}

if (isEntry(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error: Error) => die(error.message));
}
