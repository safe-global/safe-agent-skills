import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';

const SAFE_API = fileURLToPath(new URL('./safe-api.sh', import.meta.url));

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

/** A strict address argument: getAddress alone re-checksums a mixed-case typo silently. */
export function addressArg(option: string, value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`--${option}: ${value} is not a valid address (wrong EIP-55 checksum?)`);
  }
  return getAddress(value);
}

/** The delegate key from a file only its owner can read, or from SAFE_DELEGATE_PRIVATE_KEY. */
export function loadKey(file: string | undefined): Hex {
  if (file && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by others: chmod 600`);
  }
  const raw = file ? readFileSync(file, 'utf8') : process.env.SAFE_DELEGATE_PRIVATE_KEY ?? '';
  const key = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('set SAFE_DELEGATE_PRIVATE_KEY or pass --key-file <path> ' +
      '(from sign-delegate.ts new-key)');
  }
  return key as Hex;
}
