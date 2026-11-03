import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAddress, hashTypedData, isAddress, recoverAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const SAFE_API = fileURLToPath(new URL('./safe-api.sh', import.meta.url));
const HOUR = 3600;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const USAGE = `usage:
  sign-delegate.ts new-key --out <path>
  sign-delegate.ts typed-data --chain <slug> --delegate <address>
  sign-delegate.ts submit --chain <slug> --safe <address> --delegate <address>
      (--owner-key-env <VAR> | --delegator <address> --signature 0x...)
      [--label <text>] [--expires-in <seconds, default 604800 = 7 days>]`;

export type ApiResult = { exit: number; body: unknown };

/** True when node runs this module as its script; import.meta.main is missing before 24.2. */
export function isEntry(moduleUrl: string): boolean {
  const script = process.argv[1];
  try {
    return script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

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

type SignatureStatus = 'valid' | 'expired' | 'future' | 'mismatch';
export type SignatureCheck = { status: SignatureStatus; deadline?: number };

function statusAt(totp: number, current: number): SignatureStatus {
  if (totp > current) return 'future';
  return totp >= current - 1 ? 'valid' : 'expired';
}

/** Finds the hour the delegator signed in: the current or previous one is valid. */
export async function checkDelegateSignature(
  signature: Hex, delegate: Address, delegator: Address, chainId: number, now: number,
): Promise<SignatureCheck> {
  const current = totpAt(now);
  for (let totp = current + 1; totp >= current - 48; totp--) {
    const hash = hashTypedData(delegateTypedData(delegate, totp, chainId));
    const signer = await recoverAddress({ hash, signature }).catch(() => null);
    if (signer !== delegator) continue;
    return { status: statusAt(totp, current), deadline: deadlineOf(totp) };
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
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, `${key}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const { code, syscall, message } = error as NodeJS.ErrnoException;
    if (code === 'EEXIST' && syscall === 'open') {
      die(`${out} exists. An existing key file is never replaced: choose another --out path.`);
    }
    die(`cannot create ${out}: ${message}`);
  }
  console.log(privateKeyToAccount(key).address);
}

/** A strict address argument: getAddress alone re-checksums a mixed-case typo silently. */
export function addressArg(option: string, value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`--${option}: ${value} is not a valid address (wrong EIP-55 checksum?)`);
  }
  return getAddress(value);
}

/** Wallets may return v as 0 or 1; the service reads only 27 or 28 as an owner signature. */
export function normaliseV(signature: Hex): Hex {
  const v = Number.parseInt(signature.slice(-2), 16);
  return v < 27 ? (`${signature.slice(0, -2)}${(v + 27).toString(16)}` as Hex) : signature;
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
  const delegator = addressArg('delegator', o.delegator);
  return { delegator, signature: normaliseV(o.signature as Hex) };
}

function submitOptions(o: Options) {
  if (!o.chain || !o.safe || !o.delegate) die(USAGE);
  const expiresIn = Number(o['expires-in'] ?? 7 * 24 * HOUR);
  const label = o.label ?? 'safe-agent-skill';
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) die('--expires-in: whole seconds > 0');
  if (label.length > 50) die('--label has more than 50 characters');
  const [safe, delegate] = [addressArg('safe', o.safe), addressArg('delegate', o.delegate)];
  return { chain: o.chain, safe, delegate, expiresIn, label };
}

const CLOCK = 'Check the system clock, and sign again after the hour starts.';

function refuseSignature(check: SignatureCheck, delegator: Address, now: number) {
  if (check.status === 'mismatch') {
    die(`the signature does not recover to ${delegator} for this delegate and chain in the last ` +
      '48 hours. Sign the output of typed-data with that owner.');
  }
  if (check.status === 'future') {
    die(`the signature is for the next UTC hour (from ${iso((totpAt(now) + 1) * HOUR)}): the ` +
      `clock of the signer is ahead of this clock. Nothing was sent. ${CLOCK}`);
  }
  if (check.status === 'expired') {
    die(`the signature expired at ${iso(check.deadline ?? 0)}. Nothing was sent. ` +
      'Run typed-data again and ask the owner to sign again.');
  }
}

/** Only a 4xx is a refusal: after a 5xx or a network error the outcome is unknown. */
function registrationFailed(posted: ApiResult, readBack: string): never {
  if (posted.exit === 5) {
    die('the outcome is unknown: the service may have stored the registration. Check with:\n' +
      `  ${readBack}`, 5);
  }
  if (posted.exit !== 4) process.exit(posted.exit);
  const text = JSON.stringify(posted.body);
  const clock = text.includes('Signature does not match provided delegator')
    ? ` The signature passed the local check, so the clocks probably differ. ${CLOCK}` : '';
  die(`registration refused: ${text}${clock}`, 4);
}

async function submit(o: Options) {
  const { chain, safe, delegate, expiresIn, label } = submitOptions(o);
  const chainId = chainIdOf(chain);
  const { delegator, signature } = await ownerSignature(o, delegate, chainId);
  const now = Date.now() / 1000;
  refuseSignature(await checkDelegateSignature(signature, delegate, delegator, chainId, now),
    delegator, now);
  const expiryDate = iso(Math.floor(now) + expiresIn);
  const body = { safe, delegate, delegator, signature, label, expiryDate };
  const posted = api(chain, 'POST', '/api/v2/delegates/', body);
  const rowsPath = `/api/v2/delegates/?delegate=${delegate}&safe=${safe}`;
  const readBack = `scripts/safe-api.sh ${chain} GET '${rowsPath}'`;
  if (posted.exit !== 0) registrationFailed(posted, readBack);
  const rows = api(chain, 'GET', rowsPath);
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
    return typedData(o.chain, addressArg('delegate', o.delegate));
  }
  if (command === 'submit') return submit(o);
  die(USAGE);
}

if (isEntry(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error: Error) => die(error.message));
}
