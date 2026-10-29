import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getAddress, hashTypedData, recoverAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const SAFE_API = new URL('./safe-api.sh', import.meta.url).pathname;
const HOUR = 3600;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const USAGE = `usage:
  sign-delegate.ts new-key --out <path>
  sign-delegate.ts typed-data --chain <slug> --delegate <address>
  sign-delegate.ts submit --chain <slug> --safe <address> --delegate <address>
      (--owner-key-env <VAR> | --delegator <address> --signature 0x...)
      [--label <text>] [--expires-in <seconds, default 604800 = 7 days>]`;

export type ApiResult = { exit: number; body: unknown };

const MIN_GAP_MS = 200;
let lastRunEnd = 0;

/**
 * Calls scripts/safe-api.sh; its status lines go to stderr, the parsed body comes back.
 * Runs are serial and start at least 200 ms after the previous one ends (5 requests/s).
 */
export function api(chain: string, method: string, path: string, body?: unknown): ApiResult {
  const args = [SAFE_API, chain, method, path, ...(body === undefined ? [] : ['-'])];
  const input = body === undefined ? '' : JSON.stringify(body);
  const stdio: ['pipe', 'pipe', 'inherit'] = ['pipe', 'pipe', 'inherit'];
  const wait = lastRunEnd + MIN_GAP_MS - Date.now();
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  const r = spawnSync('bash', args, { input, encoding: 'utf8', stdio });
  lastRunEnd = Date.now();
  if (r.error) throw r.error;
  try {
    return { exit: r.status ?? 5, body: r.stdout ? JSON.parse(r.stdout) : null };
  } catch {
    return { exit: r.status ?? 5, body: r.stdout };
  }
}

export function chainIdOf(chain: string): number {
  const r = api(chain, 'GET', '/api/v1/about/ethereum-rpc/');
  const id = (r.body as { chain_id?: unknown } | null)?.chain_id;
  if (r.exit !== 0 || typeof id !== 'number') process.exit(r.exit || 5);
  return id;
}

export function delegateTypedData(delegate: Address, totp: number, chainId: number) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Delegate: [
        { name: 'delegateAddress', type: 'address' },
        { name: 'totp', type: 'uint256' },
      ],
    },
    primaryType: 'Delegate',
    domain: { name: 'Safe Transaction Service', version: '1.0', chainId: BigInt(chainId) },
    message: { delegateAddress: delegate, totp: BigInt(totp) },
  } as const;
}

export const totpAt = (seconds: number) => Math.floor(seconds / HOUR);
/** The service accepts the current and the previous hourly TOTP: valid until this second. */
export const deadlineOf = (totp: number) => (totp + 2) * HOUR;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

export type SignatureCheck = { status: 'valid' | 'expired' | 'mismatch'; deadline?: number };

/** Finds the hour the delegator signed in: the current or previous one is valid. */
export async function checkDelegateSignature(
  signature: Hex, delegate: Address, delegator: Address, chainId: number, now: number,
): Promise<SignatureCheck> {
  const current = totpAt(now);
  for (let totp = current; totp >= current - 48; totp--) {
    const hash = hashTypedData(delegateTypedData(delegate, totp, chainId));
    const signer = await recoverAddress({ hash, signature }).catch(() => null);
    if (signer === delegator) {
      return { status: totp >= current - 1 ? 'valid' : 'expired', deadline: deadlineOf(totp) };
    }
  }
  return { status: 'mismatch' };
}

function die(message: string, code = 2): never {
  process.stderr.write(`sign-delegate: ${message}\n`);
  process.exit(code);
}

function newKey(out: string | undefined) {
  if (!out) die('new-key needs --out <path>');
  const key = generatePrivateKey();
  try {
    writeFileSync(out, `${key}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const reason = (error as Error).message;
    die(`cannot create ${out}: ${reason}. An existing key file is never replaced.`);
  }
  console.log(privateKeyToAccount(key).address);
}

function typedData(chain: string, delegate: Address) {
  const totp = totpAt(Date.now() / 1000);
  const data = delegateTypedData(delegate, totp, chainIdOf(chain));
  const json = (_: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v);
  console.log(JSON.stringify(data, json, 2));
  process.stderr.write(`Sign with eth_signTypedData_v4 as an owner. The signature is valid until ` +
    `${iso(deadlineOf(totp))} (the end of the next whole UTC hour).\n`);
}

type Options = Record<string, string | undefined>;

async function ownerSignature(o: Options, delegate: Address, chainId: number) {
  if (o['owner-key-env']) {
    const key = process.env[o['owner-key-env']]?.trim() ?? '';
    if (!KEY_RE.test(key)) die(`${o['owner-key-env']} does not hold a 32-byte hex private key`);
    const owner = privateKeyToAccount(key as Hex);
    const data = delegateTypedData(delegate, totpAt(Date.now() / 1000), chainId);
    return { delegator: owner.address, signature: await owner.signTypedData(data) };
  }
  if (!o.delegator || !/^0x[0-9a-fA-F]{130}$/.test(o.signature ?? '')) {
    die('submit needs --owner-key-env <VAR>, or --delegator <address> and a 65-byte --signature');
  }
  return { delegator: getAddress(o.delegator), signature: o.signature as Hex };
}

function submitOptions(o: Options) {
  if (!o.chain || !o.safe || !o.delegate) die(USAGE);
  const expiresIn = Number(o['expires-in'] ?? 7 * 24 * HOUR);
  const label = o.label ?? 'safe-agent-skill';
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) die('--expires-in: whole seconds > 0');
  if (label.length > 50) die('--label has more than 50 characters');
  const [safe, delegate] = [getAddress(o.safe), getAddress(o.delegate)];
  return { chain: o.chain, safe, delegate, expiresIn, label };
}

async function submit(o: Options) {
  const { chain, safe, delegate, expiresIn, label } = submitOptions(o);
  const chainId = chainIdOf(chain);
  const { delegator, signature } = await ownerSignature(o, delegate, chainId);
  const now = Date.now() / 1000;
  const check = await checkDelegateSignature(signature, delegate, delegator, chainId, now);
  if (check.status === 'mismatch') {
    die(`the signature does not recover to ${delegator} for this delegate and chain in the last ` +
      '48 hours. Sign the output of typed-data with that owner.');
  }
  if (check.status === 'expired') {
    die(`the signature expired at ${iso(check.deadline ?? 0)}. Nothing was sent. ` +
      'Run typed-data again and ask the owner to sign again.');
  }
  const expiryDate = iso(Math.floor(now) + expiresIn);
  const body = { safe, delegate, delegator, signature, label, expiryDate };
  const posted = api(chain, 'POST', '/api/v2/delegates/', body);
  if (posted.exit !== 0) die(`registration refused: ${JSON.stringify(posted.body)}`, posted.exit);
  const rows = api(chain, 'GET', `/api/v2/delegates/?delegate=${delegate}&safe=${safe}`);
  console.log(JSON.stringify(rows.body));
  process.stderr.write(`Registered: ${delegate} may propose to ${safe} until ${expiryDate}. ` +
    'Renewal needs the owner to sign again.\n');
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const options = {
    out: { type: 'string' }, chain: { type: 'string' }, safe: { type: 'string' },
    delegate: { type: 'string' }, delegator: { type: 'string' }, signature: { type: 'string' },
    label: { type: 'string' }, 'expires-in': { type: 'string' },
    'owner-key-env': { type: 'string' },
  } as const;
  const o: Options = parseArgs({ args: rest, options, strict: true }).values;
  if (command === 'new-key') return newKey(o.out);
  if (command === 'typed-data' && o.chain && o.delegate) {
    return typedData(o.chain, getAddress(o.delegate));
  }
  if (command === 'submit') return submit(o);
  die(USAGE);
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: Error) => die(error.message));
}
