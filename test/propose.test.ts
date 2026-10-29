import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrigin, explainRefusal, nextNonce, renewalNotice, safeTxHash,
} from '../scripts/propose.ts';
import type { DelegateRow, SafeTx } from '../scripts/propose.ts';
import type { Hex } from 'viem';

// Sepolia Safe 1.4.1, nonce 9, read from GET /api/v2/safes/{SAFE}/multisig-transactions/.
const SAFE = '0x4994065bC5CcA8a373dF6353e461e9144703B816';
const TX: SafeTx = {
  to: '0x1375A61e0d2640b904b844Ae53a7990b3317Ab52', value: 0n, operation: 0, nonce: 9n,
  data: ('0x095ea7b3000000000000000000000000c92e8bdf79f0507f65a392b0ab4667716bfe0110' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') as Hex,
};
const NOW = Date.parse('2026-10-29T12:00:00Z');
const NOT_DELEGATE = {
  nonFieldErrors: ['Sender=0xD is not an owner or delegate. Current owners=[]'],
};
const row = (safe: string | null, expiryDate: string | null): DelegateRow =>
  ({ safe, delegator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', expiryDate });

test('safeTxHash of a real Sepolia transaction equals the API value', () => {
  const api = '0xa9b6436a284907066328041ef5568051d848ac89f4989517aa019d82c34e4447';
  assert.equal(safeTxHash(TX, SAFE, 11155111, '1.4.1'), api);
  assert.equal(safeTxHash(TX, SAFE, 11155111, '1.3.0+L2'), api);
});

test('a Safe before 1.3.0 hashes without the chain ID (cast vector)', () => {
  const cast = '0x0aad7ea9198968a95bdb88a3870f94e7c306cb4450d7229e41e8704eef6673e2';
  assert.equal(safeTxHash(TX, SAFE, 11155111, '1.1.1'), cast);
});

test('the next nonce follows the pending queue', () => {
  assert.equal(nextNonce(10, null), 10);
  assert.equal(nextNonce(10, 12), 13);
  assert.equal(nextNonce(10, 8), 10);
});

test('origin is JSON of at most 200 characters, and an empty note is refused', () => {
  assert.deepEqual(JSON.parse(buildOrigin('  pay\n the  rent ')), {
    name: 'safe-agent-skill/1.0', url: 'https://github.com/safe-global/safe-agent-skills',
    note: 'pay the rent',
  });
  const long = buildOrigin('é"'.repeat(200));
  assert.ok(long.length <= 200 && long.length > 190, `length ${long.length}`);
  assert.ok(JSON.parse(long).note.endsWith('…'));
  assert.throws(() => buildOrigin(' \n '), /--note is empty/);
});

test('a refusal names its cause', () => {
  const kind = (exit: number, body: unknown, rows: DelegateRow[]) =>
    explainRefusal(exit, body, rows, SAFE, NOW).kind;
  assert.equal(kind(3, { detail: 'Monthly quota exceeded.' }, []), 'quota');
  assert.equal(kind(4, { nonFieldErrors: ['Tx with nonce=1 already executed'] }, []), 'rejected');
  assert.equal(kind(4, NOT_DELEGATE, []), 'not-registered');
  assert.equal(kind(4, NOT_DELEGATE, [row('0x0000000000000000000000000000000000000001', null)]),
    'other-safe');
  assert.equal(kind(4, NOT_DELEGATE, [row(SAFE.toLowerCase(), '2026-10-29T11:59:00Z')]), 'expired');
  assert.equal(kind(4, NOT_DELEGATE, [row(SAFE, '2026-11-05T00:00:00Z')]), 'delegator-not-owner');
  assert.equal(kind(4, NOT_DELEGATE, [row(null, null)]), 'delegator-not-owner');
});

test('a renewal notice appears only in the last 24 hours before expiry', () => {
  assert.match(renewalNotice(row(SAFE, '2026-10-30T11:00:00Z'), NOW) ?? '', /expires at/);
  assert.equal(renewalNotice(row(SAFE, '2026-10-30T13:00:00Z'), NOW), null);
  assert.equal(renewalNotice(row(SAFE, '2026-10-29T11:00:00Z'), NOW), null);
  assert.equal(renewalNotice(row(SAFE, null), NOW), null);
  assert.equal(renewalNotice(undefined, NOW), null);
});
