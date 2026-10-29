import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import type { Hex } from 'viem';
import {
  checkDelegateSignature, deadlineOf, delegateTypedData, normaliseV, totpAt,
} from '../scripts/sign-delegate.ts';

// Vectors from cast: keccak/abi-encode for the digest, `cast wallet sign --data` by anvil
// account 1 for the signature.
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DELEGATE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const TOTP = 493000;
const START = TOTP * 3600;
const DIGEST = '0x4e5d2e2062c8dac35a95bfbea79550333ce421c3380e4f42d206047d15803d1d';
const SIGNATURE: Hex = '0x3628195b787027e7b9314ec21c358d612ebd5e98833f0c2bbde9a45877fca282' +
  '42abc05f533deb3878dcb5a962b5a8b7e2e5a924bafcecb2531d3865c67d2a1e1b' as Hex;

const check = (now: number, delegator: Hex = OWNER, chainId = 31337) =>
  checkDelegateSignature(SIGNATURE, DELEGATE, delegator, chainId, now);

test('the delegate typed data hashes to the cast digest', () => {
  assert.equal(hashTypedData(delegateTypedData(DELEGATE, TOTP, 31337)), DIGEST);
});

test('the cast signature recovers to the owner over this typed data', async () => {
  const typedData = delegateTypedData(DELEGATE, TOTP, 31337);
  assert.equal(await recoverTypedDataAddress({ ...typedData, signature: SIGNATURE }), OWNER);
});

test('a signature is valid in its hour and the next one, then expires', async () => {
  assert.equal(totpAt(START - 1), TOTP - 1);
  assert.equal(totpAt(START), TOTP);
  assert.equal(deadlineOf(TOTP), START + 7200);
  for (const now of [START, START + 3599, START + 3600, START + 7199]) {
    const at = `at +${now - START} s`;
    assert.deepEqual(await check(now), { status: 'valid', deadline: START + 7200 }, at);
  }
  assert.deepEqual(await check(START + 7200), { status: 'expired', deadline: START + 7200 });
  const future = { status: 'future', deadline: START + 7200 };
  assert.deepEqual(await check(START - 1), future, 'a signature for the next hour');
  assert.equal((await check(START - 3601)).status, 'mismatch', 'two hours ahead');
});

test('a signature by another key or for another chain does not match', async () => {
  assert.equal((await check(START, DELEGATE)).status, 'mismatch');
  assert.equal((await check(START, OWNER, 1)).status, 'mismatch');
});

test('a signature with v = 0 or 1 gets v = 27 or 28, and 27 or 28 stays', () => {
  const rs = SIGNATURE.slice(0, -2);
  const pairs = [['00', '1b'], ['01', '1c'], ['1b', '1b'], ['1c', '1c']];
  for (const [v, want] of pairs) assert.equal(normaliseV(`${rs}${v}` as Hex), `${rs}${want}`, v);
});

test('api() starts each safe-api.sh run at least 200 ms after the previous one', async () => {
  const arrivals: number[] = [];
  const server = createServer((_req, res) => {
    arrivals.push(performance.now());
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  // api() blocks its process (spawnSync), so it runs in a child while this process serves.
  const module = new URL('../scripts/sign-delegate.ts', import.meta.url).href;
  const code = `import { api } from ${JSON.stringify(module)};\n` +
    "for (let i = 0; i < 3; i++) api('local', 'GET', '/api/v1/about/');";
  const env = { PATH: process.env.PATH ?? '', SAFE_TX_SERVICE_URL: `http://127.0.0.1:${port}` };
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env });
  const [exit] = (await once(child, 'close')) as [number | null];
  server.close();
  assert.equal(exit, 0);
  assert.equal(arrivals.length, 3);
  for (let i = 1; i < 3; i++) {
    const gap = arrivals[i] - arrivals[i - 1];
    assert.ok(gap >= 200, `run ${i} started ${gap.toFixed(0)} ms after the previous one`);
  }
});
