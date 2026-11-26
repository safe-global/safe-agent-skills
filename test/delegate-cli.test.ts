import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { delegateTypedData, totpAt } from '../scripts/sign-delegate.ts';
import {
  AS_DELEGATE, AS_OWNER, CHAIN_ID, DAY_MS, DELEGATE, DIR, OWNER, SAFE, posts, routes, run, seen,
} from './stub.ts';

const SUBMIT = ['submit', '--chain', 'local', '--safe', SAFE, '--delegate', DELEGATE];

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
  const runs: [string, string[], string][] = [
    ['sign-delegate.ts', ['submit', '--chain', 'local', '--safe', SAFE, '--delegate', typo,
      '--owner-key-env', 'TEST_OWNER_KEY'], `--delegate: ${typo}`],
  ];
  for (const [script, args, prefix] of runs) {
    const r = await run(script, args, { ...AS_DELEGATE, ...AS_OWNER });
    assert.equal(r.code, 2, prefix);
    assert.ok(r.stderr.includes(`${prefix} is not a valid address (wrong EIP-55 checksum?)`));
  }
  assert.equal(seen.length, 0);
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
