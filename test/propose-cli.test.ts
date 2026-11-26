import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import {
  AS_DELEGATE, AS_OWNER, DAY_MS, DELEGATE, DELEGATE_KEY, DIR, OWNER, OWNER_KEY, QUEUE, SAFE, TO,
  clearSeen, posts, routes, run, seen,
} from './stub.ts';

const PROPOSE = ['--chain', 'local', '--safe', SAFE, '--to', TO, '--note', 'rent'];

test('a mixed-case address with a wrong checksum is refused before any request', async () => {
  const typo = '0x969A68ec8eD50C4935Dee71878B510c78D2a8aF6';
  const badCase = `${SAFE.slice(0, -1)}${SAFE.endsWith('A') ? 'a' : 'A'}`;
  const runs: [string, string[], string][] = [
    ['propose.ts', ['--chain', 'local', '--safe', SAFE, '--to', typo, '--note', 'x'],
      `--to: ${typo}`],
    ['propose.ts', ['--chain', 'local', '--safe', badCase, '--to', TO, '--note', 'x'],
      `--safe: ${badCase}`],
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
      clearSeen();
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
    clearSeen();
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
