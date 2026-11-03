import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { delegateTypedData, totpAt } from '../scripts/sign-delegate.ts';

// The scripts run from a copy whose path has a space and a non-ASCII letter.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'scripts-'));
const ROOT = join(DIR, 'safe agent é');
mkdirSync(ROOT);
cpSync(join(REPO, 'scripts'), join(ROOT, 'scripts'), { recursive: true });
cpSync(join(REPO, 'package.json'), join(ROOT, 'package.json'));
symlinkSync(join(REPO, 'node_modules'), join(ROOT, 'node_modules'));

const OWNER_KEY = generatePrivateKey();
const OWNER = privateKeyToAccount(OWNER_KEY);
const DELEGATE_KEY = generatePrivateKey();
const DELEGATE = privateKeyToAccount(DELEGATE_KEY).address;
const SAFE = getAddress(`0x${'5a'.repeat(20)}`);
const QUEUE = `/api/v2/safes/${SAFE}/multisig-transactions/`;
const CHAIN_ID = 31337;
const DAY_MS = 24 * 3600 * 1000;
const SUBMIT = ['submit', '--chain', 'local', '--safe', SAFE, '--delegate', DELEGATE];
const TO = `0x${'7'.repeat(40)}`;
const PROPOSE = ['--chain', 'local', '--safe', SAFE, '--to', TO, '--note', 'rent'];
const AS_DELEGATE = { SAFE_DELEGATE_PRIVATE_KEY: DELEGATE_KEY };
const AS_OWNER = { TEST_OWNER_KEY: OWNER_KEY };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Result = { code: number | null; stdout: string; stderr: string };

function defaults(): Record<string, Reply> {
  const row = { safe: SAFE, delegate: DELEGATE, delegator: OWNER.address, label: 'test',
    expiryDate: new Date(Date.now() + 7 * DAY_MS).toISOString() };
  return {
    'GET /api/v1/about/ethereum-rpc/': { status: 200, body: { chain_id: CHAIN_ID } },
    [`GET /api/v1/safes/${SAFE}/`]: { status: 200,
      body: { nonce: '5', owners: [OWNER.address], version: '1.4.1' } },
    [`GET ${QUEUE}`]: { status: 200, body: { results: [] } },
    'GET /api/v2/delegates/': { status: 200, body: { results: [row] } },
    [`POST ${QUEUE}`]: { status: 201 },
    'POST /api/v2/delegates/': { status: 201 },
  };
}

let routes = defaults();
let seen: { method: string; url: string; body: string }[] = [];
let base = '';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    const { method = '', url = '' } = req;
    seen.push({ method, url, body });
    const reply = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`] ??
      routes[`${method} *`] ?? { status: 404, body: {} };
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
});

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
});
beforeEach(() => {
  routes = defaults();
  seen = [];
});

async function run(script: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: DIR, SAFE_TX_SERVICE_URL: base, ...env },
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  for (const key of [OWNER_KEY, DELEGATE_KEY]) {
    assert.ok(!(stdout + stderr).includes(key.slice(2)), 'a private key appears in the output');
  }
  return { code, stdout, stderr } as Result;
}

const posts = () => seen.filter((s) => s.method === 'POST');

test('new-key creates a missing parent with mode 0700 and never replaces a key file', async () => {
  const parent = join(DIR, 'home', '.safe-agent');
  const out = join(parent, 'delegate.key');
  const made = await run('sign-delegate.ts', ['new-key', '--out', out]);
  assert.equal(made.code, 0, made.stderr);
  const key = readFileSync(out, 'utf8').trim() as Hex;
  assert.equal(made.stdout.trim(), privateKeyToAccount(key).address);
  assert.ok(!made.stdout.includes(key.slice(2)));
  assert.equal(statSync(parent).mode & 0o777, 0o700);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const again = await run('sign-delegate.ts', ['new-key', '--out', out]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /exists\. An existing key file is never replaced/);
  assert.equal(readFileSync(out, 'utf8').trim(), key);
  const shared = join(DIR, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  assert.equal((await run('sign-delegate.ts', ['new-key', '--out', join(shared, 'k')])).code, 0);
  assert.equal(statSync(shared).mode & 0o777, 0o755);
});

test('submit registers the delegate for one Safe, for 7 days by default', async () => {
  const r = await run('sign-delegate.ts', [...SUBMIT, '--owner-key-env', 'TEST_OWNER_KEY'],
    AS_OWNER);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts().length, 1);
  const body = JSON.parse(posts()[0].body);
  assert.equal(body.safe, SAFE);
  assert.equal(body.delegator, OWNER.address);
  const days = (Date.parse(body.expiryDate) - Date.now()) / DAY_MS;
  assert.ok(Math.abs(days - 7) < 0.001, `expires in ${days} days`);
});

test('submit sends a signature with v = 0 or 1 as v = 27 or 28', async () => {
  const signature = await OWNER.signTypedData(
    delegateTypedData(DELEGATE, totpAt(Date.now() / 1000), CHAIN_ID));
  const low = `${signature.slice(0, -2)}${signature.endsWith('1b') ? '00' : '01'}`;
  const r = await run('sign-delegate.ts', [...SUBMIT, '--delegator', OWNER.address,
    '--signature', low]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(posts()[0].body).signature, signature);
});

test('a mixed-case address with a wrong checksum is refused before any request', async () => {
  const typo = '0x969A68ec8eD50C4935Dee71878B510c78D2a8aF6';
  const badCase = `${SAFE.slice(0, -1)}${SAFE.endsWith('A') ? 'a' : 'A'}`;
  const runs: [string, string[], string][] = [
    ['propose.ts', ['--chain', 'local', '--safe', SAFE, '--to', typo, '--note', 'x'],
      `--to: ${typo}`],
    ['propose.ts', ['--chain', 'local', '--safe', badCase, '--to', TO, '--note', 'x'],
      `--safe: ${badCase}`],
    ['sign-delegate.ts', ['submit', '--chain', 'local', '--safe', SAFE, '--delegate', typo,
      '--owner-key-env', 'TEST_OWNER_KEY'], `--delegate: ${typo}`],
  ];
  for (const [script, args, prefix] of runs) {
    const r = await run(script, args, { ...AS_DELEGATE, ...AS_OWNER });
    assert.equal(r.code, 2, prefix);
    assert.ok(r.stderr.includes(`${prefix} is not a valid address (wrong EIP-55 checksum?)`));
  }
  assert.equal(seen.length, 0);
  const lower = OWNER.address.toLowerCase();
  const ok = await run('propose.ts', [...PROPOSE.slice(0, 4), '--to', lower, '--note', 'x',
    '--dry-run'], AS_DELEGATE);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).request.body.to, OWNER.address);
});

test('submit sends no signature from an old hour or from the next hour', async () => {
  const left = 3600 - ((Date.now() / 1000) % 3600);
  if (left < 15) await sleep(left * 1000 + 1000);
  const now = totpAt(Date.now() / 1000);
  const cases: [number, RegExp][] = [[now - 3, /expired at/], [now + 1, /Check the system clock/]];
  for (const [totp, message] of cases) {
    const signature = await OWNER.signTypedData(delegateTypedData(DELEGATE, totp, CHAIN_ID));
    const r = await run('sign-delegate.ts',
      [...SUBMIT, '--delegator', OWNER.address, '--signature', signature]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, message);
  }
  assert.equal(posts().length, 0);
});

test('submit calls only a 4xx a refusal, with a clock hint for a signature mismatch',
  async () => {
    const mismatch = `Signature does not match provided delegator=${OWNER.address}`;
    routes['POST /api/v2/delegates/'] = { status: 400, body: { nonFieldErrors: [mismatch] } };
    const refused = await run('sign-delegate.ts',
      [...SUBMIT, '--owner-key-env', 'TEST_OWNER_KEY'], AS_OWNER);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /registration refused: .*Check the system clock/);
    routes['POST /api/v2/delegates/'] = { status: 502, body: { detail: 'Bad gateway' } };
    const unknown = await run('sign-delegate.ts',
      [...SUBMIT, '--owner-key-env', 'TEST_OWNER_KEY'], AS_OWNER);
    assert.equal(unknown.code, 5);
    assert.match(unknown.stderr, /the outcome is unknown/);
    assert.doesNotMatch(unknown.stderr, /refused/);
  });

test('propose refuses an owner key, and a key file that others can read', async () => {
  const owner = await run('propose.ts', [...PROPOSE, '--dry-run'],
    { SAFE_DELEGATE_PRIVATE_KEY: OWNER_KEY });
  assert.equal(owner.code, 2);
  assert.match(owner.stderr, /this key is an owner of the Safe/);
  const file = join(DIR, 'delegate.key');
  writeFileSync(file, `${DELEGATE_KEY}\n`);
  chmodSync(file, 0o644);
  const open = await run('propose.ts', [...PROPOSE, '--key-file', file, '--dry-run']);
  assert.equal(open.code, 2);
  assert.match(open.stderr, /readable by others/);
  assert.equal(seen.length, 1, 'only the Safe read before the owner refusal');
});

test('--dry-run prints the delegate status and the request, and sends nothing', async () => {
  routes['GET /api/v2/delegates/'] = { status: 200, body: { results: [] } };
  const plain = await run('propose.ts', [...PROPOSE, '--dry-run'], AS_DELEGATE);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stderr, /not registered for this Safe/);
  const { safeTxHash, request } = JSON.parse(plain.stdout);
  assert.deepEqual([request.method, request.path], ['POST', QUEUE]);
  assert.equal(request.body.contractTransactionHash, safeTxHash);
  assert.equal(request.body.operation, 0);
  const call = await run('propose.ts', [...PROPOSE, '--dry-run', '--delegatecall'], AS_DELEGATE);
  assert.equal(JSON.parse(call.stdout).request.body.operation, 1);
  assert.match(call.stderr, /WARNING operation 1/);
  assert.equal(posts().length, 0);
});

test('after a 5xx on the proposal POST the outcome is unknown, with a read-back command',
  async () => {
    routes[`POST ${QUEUE}`] = { status: 502, body: { detail: 'Bad gateway' } };
    const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
    assert.equal(r.code, 5);
    const hash = JSON.parse(posts()[0].body).contractTransactionHash;
    assert.match(r.stderr, /the outcome is unknown/);
    assert.match(r.stderr, new RegExp(`safeTxHash: ${hash}`));
    const check = `scripts/safe-api.sh local GET /api/v2/multisig-transactions/${hash}/`;
    assert.ok(r.stderr.includes(check), r.stderr);
    assert.doesNotMatch(r.stderr, /refused/);
  });

test('a stored proposal whose read-back fails exits 5 (3 for a 429), with the hash and command',
  async () => {
    for (const [status, code] of [[500, 5], [404, 5], [429, 3]]) {
      routes['GET *'] = { status, headers: { 'retry-after': '120' }, body: { detail: 'x' } };
      seen = [];
      const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
      assert.equal(r.code, code, `read-back ${status}`);
      const hash = JSON.parse(posts()[0].body).contractTransactionHash;
      assert.match(r.stderr, /propose: proposed: the service stored the proposal, but the read/);
      assert.match(r.stderr, new RegExp(`safeTxHash: ${hash}`));
      const check = `scripts/safe-api.sh local GET /api/v2/multisig-transactions/${hash}/`;
      assert.ok(r.stderr.includes(check), r.stderr);
      assert.doesNotMatch(r.stderr, /outcome is unknown|refused/);
    }
  });

test('a delegate that is not registered or expired stops before the POST', async () => {
  const expired = { safe: SAFE, delegate: DELEGATE, delegator: OWNER.address,
    expiryDate: new Date(Date.now() - DAY_MS).toISOString() };
  const other = { ...expired, safe: getAddress(`0x${'6b'.repeat(20)}`), expiryDate: null };
  const cases: [object[], RegExp][] = [[[], /not registered for this Safe/],
    [[other], /not registered for this Safe/], [[expired], /registration expired at/]];
  for (const [results, message] of cases) {
    routes['GET /api/v2/delegates/'] = { status: 200, body: { results } };
    seen = [];
    const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, message);
    assert.equal(posts().length, 0);
    assert.deepEqual(seen.filter((s) => s.url.startsWith('/api/v2/delegates/')).map((s) => s.url),
      [`/api/v2/delegates/?delegate=${DELEGATE}`]);
  }
});

test('a registration for every Safe of an owner (safe null) can propose', async () => {
  const row = { safe: null, delegate: DELEGATE, delegator: OWNER.address, expiryDate: null };
  routes['GET /api/v2/delegates/'] = { status: 200, body: { results: [row] } };
  routes['GET *'] = { status: 200, body: { safeTxHash: '0x01', nonce: 5, confirmations: [] } };
  const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts().length, 1);
});

test('a refusal of a registered delegate stays exit 4 and names the cause', async () => {
  const body = { nonFieldErrors: [`Sender=${DELEGATE} is not an owner or delegate.`] };
  routes[`POST ${QUEUE}`] = { status: 422, body };
  const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
  assert.equal(r.code, 4);
  assert.match(r.stderr, new RegExp(`The delegator ${OWNER.address} is not an owner of ${SAFE}`));
  assert.equal(seen.filter((s) => s.url.startsWith('/api/v2/delegates/')).length, 1);
});

test('a proposal warns when another proposal has the same nonce', async () => {
  routes['GET *'] = { status: 200, body: { safeTxHash: '0x01', nonce: 5, confirmations: [] } };
  for (const count of [2, 1]) {
    routes[`GET ${QUEUE}?nonce=5`] = { status: 200, body: { count, results: [] } };
    const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    const warned = /WARNING (\d+) proposals have nonce 5; only one can execute/.exec(r.stderr);
    assert.equal(warned?.[1], count > 1 ? String(count) : undefined, `count ${count}`);
  }
});

test('a 429 on the proposal POST adds no message of its own', async () => {
  routes[`POST ${QUEUE}`] = { status: 429, headers: { 'retry-after': '120' },
    body: { detail: 'Request was throttled.' } };
  const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /rate limited/);
  assert.doesNotMatch(r.stderr, /^propose:/m);
});
