import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  GATED_RISKS, KNOWN_MULTI_SEND, RISKS, UNREADABLE_BATCH, approvalLine, approvalOf, buildOrigin,
  callsSafe, dataLine, decodeMultiSend, delegateStatus, explainRefusal, innerDelegatecalls,
  isKnownMultiSend, isUnknownDelegatecall, isUnlimited, nextLines, nextNonce, nextStep, nonceLine,
  review, risksOf, safeTxHash, serviceName, summaryLines, valueLine, wantedNonce,
} from '../scripts/propose.ts';
import type { Call, DelegateRow, SafeTx, Summary } from '../scripts/propose.ts';
import {
  concat, encodeFunctionData, encodePacked, getAddress, maxUint256, parseAbi, size,
} from 'viem';
import type { Address, Hex } from 'viem';

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

test('a Safe version that does not parse gets no hash', () => {
  for (const version of ['unknown', '1.3', 'v1.3.0', '', null]) {
    assert.throws(() => safeTxHash(TX, SAFE, 11155111, version), /unknown Safe version/);
  }
});

test('the next nonce follows the pending queue', () => {
  assert.equal(nextNonce(10, null), 10);
  assert.equal(nextNonce(10, 12), 13);
  assert.equal(nextNonce(10, 8), 10);
});

test('--nonce is a whole number from the Safe nonce up, with no loss of precision', () => {
  assert.equal(wantedNonce('5', 5), 5);
  assert.equal(wantedNonce('9007199254740991', 5), 9007199254740991);
  for (const bad of ['4', '0x10', '-1', '1.5', '9007199254740992', '99999999999999999999']) {
    assert.throws(() => wantedNonce(bad, 5), /whole number from 5/, bad);
  }
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
  const kind = (body: unknown, rows: DelegateRow[]) => explainRefusal(body, rows, SAFE, NOW).kind;
  assert.equal(kind({ nonFieldErrors: ['Tx with nonce=1 already executed'] }, []), 'rejected');
  assert.equal(kind(NOT_DELEGATE, []), 'not-registered');
  assert.equal(kind(NOT_DELEGATE, [row('0x0000000000000000000000000000000000000001', null)]),
    'other-safe');
  assert.equal(kind(NOT_DELEGATE, [row(SAFE.toLowerCase(), '2026-10-29T11:59:00Z')]), 'expired');
  assert.equal(kind(NOT_DELEGATE, [row(SAFE, '2026-11-05T00:00:00Z')]), 'delegator-not-owner');
  assert.equal(kind(NOT_DELEGATE, [row(null, null)]), 'delegator-not-owner');
  const never = explainRefusal(NOT_DELEGATE, [row(null, null)], SAFE, NOW).message;
  assert.match(never, /is not an owner of/);
  assert.doesNotMatch(never, /no longer/);
});

test('the delegate status comes from the longest registration for this Safe', () => {
  const kind = (...rows: DelegateRow[]) => delegateStatus(rows, NOW).kind;
  assert.equal(kind(), 'not-registered');
  assert.equal(kind(row(SAFE, '2026-10-29T11:00:00Z')), 'expired');
  assert.equal(kind(row(SAFE, '2026-10-30T11:00:00Z')), 'expiring');
  assert.equal(kind(row(SAFE, '2026-10-30T13:00:00Z')), 'registered');
  assert.equal(kind(row(SAFE, null)), 'registered');
  assert.equal(kind(row(SAFE, '2026-10-29T11:00:00Z'), row(SAFE, '2026-11-05T00:00:00Z')),
    'registered');
});

test('a note with a control character is refused, and tab and newline still fold', () => {
  assert.equal(JSON.parse(buildOrigin('pay\tthe\r\nrent')).note, 'pay the rent');
  const cases: [string, string][] = [['\x1b[31m', '001B'], ['a\x00', '0000'], ['a\x7f', '007F'],
    ['a\x85', '0085'], ['a\v', '000B'], ['a\u202Eb', '202E'], ['a\u2066b', '2066'],
    ['ok\u2069\x1b', '2069']];
  for (const [note, code] of cases) {
    assert.throws(() => buildOrigin(note),
      new RegExp(`^Error: --note has an invisible or control character \\(U\\+${code}\\): ` +
        'write plain text$'),
      code);
  }
  assert.equal(JSON.parse(buildOrigin('Zahlung für Miete €')).note, 'Zahlung für Miete €');
});

test('a note with an invisible, private-use or unassigned character is refused', () => {
  const cases: [string, string][] = [['a\u200Bb', '200B'], ['a\u200Cb', '200C'],
    ['a\u200Db', '200D'], ['a\u200Eb', '200E'], ['a\u200Fb', '200F'], ['a\u061Cb', '061C'],
    ['a\u2060b', '2060'], ['a\u2064b', '2064'], ['a\u00ADb', '00AD'], ['a\u{E0001}b', 'E0001'],
    ['a\u{E0041}b', 'E0041'], ['a\u{E007F}b', 'E007F'], ['a\uFEFFb', 'FEFF'], ['a\uE000b', 'E000'],
    ['a\u{F0000}b', 'F0000'], ['a\u0378b', '0378'], ['a\uFFFFb', 'FFFF']];
  for (const [note, code] of cases) {
    assert.throws(() => buildOrigin(note),
      new RegExp(`^Error: --note has an invisible or control character \\(U\\+${code}\\): ` +
        'write plain text$'),
      code);
  }
  assert.equal(JSON.parse(buildOrigin('Zahlung für Miete € 日本 ✓')).note,
    'Zahlung für Miete € 日本 ✓');
});

test('a note with a variation selector or a blank filler is refused', () => {
  const cases: [string, string][] = [['a\uFE00b', 'FE00'], ['a\uFE0Fb', 'FE0F'],
    ['a\u{E0100}b', 'E0100'], ['a\u{E01EF}b', 'E01EF'], ['a\u3164b', '3164'], ['a\u115Fb', '115F'],
    ['a\u1160b', '1160'], ['a\u2800b', '2800'], ['a\u034Fb', '034F'], ['a\uFFA0b', 'FFA0']];
  for (const [note, code] of cases) {
    assert.throws(() => buildOrigin(note),
      new RegExp(`^Error: --note has an invisible or control character \\(U\\+${code}\\): ` +
        'write plain text$'),
      code);
  }
  const plain = 'Überweisung an die Kasse, ½ Anteil – 日本 한국어 ⠁ ✓';
  assert.equal(JSON.parse(buildOrigin(plain)).note, plain);
});

test('the service is named by origin and path, without credentials, query or fragment', () => {
  assert.equal(serviceName('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
  assert.equal(serviceName('https://svc:S3CRET@tx.example.org/base/?token=T0KEN#frag'),
    'https://tx.example.org/base');
  assert.equal(serviceName('http://user@[::1]:8000/?k=v'), 'http://[::1]:8000');
  for (const bad of ['not a url', 'ftp://user:pw@host/', 'javascript:alert(1)', '']) {
    assert.equal(serviceName(bad), '(not shown: not an http(s) URL)', bad);
  }
});
test('the summary lines show value, data and nonce in plain words', () => {
  assert.equal(valueLine(0n), 'Value: 0 wei (0 in the native coin)');
  assert.equal(valueLine(1000000000000000n),
    'Value: 1000000000000000 wei (0.001 in the native coin)');
  assert.equal(dataLine('0x'), 'Data: none');
  assert.equal(dataLine('0x0102'), 'Data: 2 bytes, no selector');
  assert.equal(dataLine(TX.data), 'Data: 68 bytes, selector 0x095ea7b3');
  assert.equal(nonceLine(6n, 'next'), 'Nonce: 6 (next free)');
  assert.equal(nonceLine(5n, 'given'), 'Nonce: 5');
  assert.equal(nonceLine(5n, 'replaces'), 'Nonce: 5 (REPLACES pending nonce 5)');
});


const ABI = parseAbi([
  'function multiSend(bytes transactions)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transfer(address to, uint256 amount)',
]);
// Safe 1.4.1 MultiSendCallOnly and MultiSend, from safe-deployments.
const CALL_ONLY: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const MULTI_SEND: Address = '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526';
const TOKEN: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SPENDER: Address = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
const OTHER = getAddress(`0x${'00'.repeat(19)}aa`);

const approve = (amount: bigint) =>
  encodeFunctionData({ abi: ABI, functionName: 'approve', args: [SPENDER, amount] });
const forAll = (approved: boolean) =>
  encodeFunctionData({ abi: ABI, functionName: 'setApprovalForAll', args: [SPENDER, approved] });
const transfer = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [OTHER, 5n] });

const packed = (calls: Call[]) => concat(['0x', ...calls.map((c) => encodePacked(
  ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
  [c.operation, c.to, c.value, BigInt(size(c.data)), c.data]))]);
const multiSend = (bytes: Hex) =>
  encodeFunctionData({ abi: ABI, functionName: 'multiSend', args: [bytes] });
const batchOf = (...calls: Call[]) => multiSend(packed(calls));
const call = (to: Address, data: Hex, operation: 0 | 1 = 0, value = 0n): Call =>
  ({ operation, to, value, data });
const batchTx = (data: Hex, to: Address = MULTI_SEND): SafeTx =>
  ({ to, value: 0n, data, operation: 1, nonce: 9n });
const risks = (tx: SafeTx) => risksOf(review(tx, SAFE));

test('a two-call multiSend batch decodes into its calls', () => {
  const calls = [call(TOKEN, approve(10n)), call(OTHER, '0x', 0, 7n)];
  assert.deepEqual(decodeMultiSend(batchOf(...calls)), calls);
  assert.deepEqual(decodeMultiSend(batchOf()), []);
  const full = Array.from({ length: 256 }, () => call(OTHER, '0x'));
  assert.equal(decodeMultiSend(batchOf(...full))?.length, 256);
});

test('a malformed batch decodes to null', () => {
  const good = batchOf(call(TOKEN, approve(10n)), call(OTHER, '0x'));
  const word = (n: number) => n.toString(16).padStart(64, '0');
  const args = good.slice(10);
  const entry = packed([call(OTHER, transfer)]);
  const cases: [string, Hex][] = [
    ['wrong selector', `0x12345678${args}`],
    ['no arguments', '0x8d80ff0a'],
    ['offset past the end', `0x8d80ff0a${word(0x1000)}${args.slice(64)}`],
    ['offset not canonical', `0x8d80ff0a${word(0x40)}${word(0)}${args.slice(64)}`],
    ['length past the end', `0x8d80ff0a${word(0x20)}${word(0x1000)}${args.slice(128)}`],
    ['entry runs past the end', multiSend(entry.slice(0, -2) as Hex)],
    ['trailing bytes', multiSend(`${entry}ab`)],
    ['operation 2', multiSend(`0x02${entry.slice(4)}`)],
    ['257 entries', batchOf(...Array.from({ length: 257 }, () => call(OTHER, '0x')))],
  ];
  for (const [name, data] of cases) assert.equal(decodeMultiSend(data), null, name);
});

test('a delegatecall is a risk unless it is a batch to a known MultiSend contract', () => {
  const data = batchOf(call(OTHER, '0x'));
  assert.equal(isUnknownDelegatecall(batchTx(data)), false);
  assert.equal(isUnknownDelegatecall(batchTx(data, CALL_ONLY.toLowerCase() as Address)), false);
  assert.equal(isUnknownDelegatecall(batchTx(data, OTHER)), true);
  assert.equal(isUnknownDelegatecall(batchTx('0x', MULTI_SEND)), true);
  assert.deepEqual(risks(batchTx(data)), []);
  assert.deepEqual(risks(batchTx(data, OTHER)), ['delegatecall']);
  assert.deepEqual(risks({ ...batchTx(data), operation: 0 }), []);
});

test('an inner delegatecall or nested batch is a risk, and names the inner target', () => {
  const nested = batchOf(call(OTHER, '0x'));
  const batch = [call(OTHER, '0x'), call(TOKEN, '0x', 1), call(CALL_ONLY, nested)];
  assert.deepEqual(innerDelegatecalls(batch), [2, 3]);
  const r = review(batchTx(batchOf(...batch)), SAFE);
  assert.deepEqual(risksOf(r), ['batch-delegatecall']);
  assert.deepEqual(r.findings.map((f) => f.line), [
    `RISK batch-delegatecall: inner call 2 is a delegatecall: ${TOKEN} runs with the Safe's ` +
      'storage and funds.',
    `RISK batch-delegatecall: inner call 3 to ${CALL_ONLY} is a nested batch; its calls are ` +
      'not checked.',
  ]);
});

test('a batch that does not decode is a risk', () => {
  const r = review(batchTx('0x8d80ff0a00'), SAFE);
  assert.deepEqual(risksOf(r), ['batch-undecoded']);
  assert.equal(r.findings[0].line, 'RISK batch-undecoded: the inner calls could not be read.');
  assert.deepEqual(risks(batchTx('0x8d80ff0a00', OTHER)), ['delegatecall', 'batch-undecoded']);
});

test('a call to the Safe itself is a risk, at the top level and inside a batch', () => {
  const plain: SafeTx = { ...TX, data: '0x' };
  assert.deepEqual(risks(plain), []);
  assert.deepEqual(risks({ ...plain, to: SAFE.toLowerCase() as Address }), ['self-call']);
  const inner = [call(OTHER, '0x'), call(SAFE, '0x')];
  assert.equal(callsSafe(plain, inner, SAFE), true);
  assert.equal(callsSafe(plain, [inner[0]], SAFE), false);
  assert.deepEqual(risks(batchTx(batchOf(...inner))), ['self-call']);
});

test('an approval is read from approve, increaseAllowance and setApprovalForAll', () => {
  assert.deepEqual(approvalOf(call(TOKEN, approve(10n))),
    { token: TOKEN, kind: 'allowance', spender: SPENDER, amount: 10n, increase: false });
  const more = encodeFunctionData({ abi: ABI, functionName: 'increaseAllowance',
    args: [SPENDER, 2n ** 255n] });
  assert.deepEqual(approvalOf(call(TOKEN, more)),
    { token: TOKEN, kind: 'allowance', spender: SPENDER, amount: 2n ** 255n, increase: true });
  assert.deepEqual(approvalOf(call(TOKEN, forAll(false))),
    { token: TOKEN, kind: 'operator', operator: SPENDER, approved: false });
  assert.equal(approvalOf(call(TOKEN, transfer)), null);
  assert.equal(approvalOf(call(TOKEN, '0x095e')), null);
  const upper = approve(10n).replace('0x095ea7b3', '0x095EA7B3') as Hex;
  assert.equal(approvalOf(call(TOKEN, upper))?.kind, 'allowance');
  const unlimited = (data: Hex) => isUnlimited(approvalOf(call(TOKEN, data))!);
  assert.equal(unlimited(approve(2n ** 96n - 2n)), false);
  assert.equal(unlimited(approve(2n ** 96n - 1n)), true);
  assert.equal(unlimited(approve(2n ** 255n - 1n)), true);
  assert.equal(unlimited(approve(maxUint256)), true);
  assert.equal(unlimited(more), true);
  assert.equal(unlimited(forAll(true)), true);
  assert.equal(unlimited(forAll(false)), false);
});

test('an ordinary approval is a summary line, not a risk', () => {
  const tx: SafeTx = { ...TX, to: TOKEN, data: approve(1000n) };
  const r = review(tx, SAFE);
  assert.deepEqual(r.findings, []);
  assert.ok(summaryLines(summary(tx)).includes(
    `Approval: ${TOKEN} lets ${SPENDER} spend 1000 (raw units)`));
});

test('an unlimited approval is a risk, at the top level and inside a batch', () => {
  const top = review({ ...TX, to: TOKEN, data: approve(maxUint256) }, SAFE);
  assert.deepEqual(top.findings, [{ risk: 'unlimited-approval',
    line: `RISK unlimited-approval: ${TOKEN} lets ${SPENDER} spend without limit.` }]);
  const nft = review(batchTx(batchOf(call(TOKEN, forAll(true)))), SAFE);
  assert.deepEqual(nft.findings.map((f) => f.line), [`RISK unlimited-approval: ${TOKEN} lets ` +
    `${SPENDER} move every token of that collection.`]);
  const off = { ...TX, to: TOKEN, data: forAll(false) };
  assert.deepEqual(risks(off), []);
  assert.ok(summaryLines(summary(off)).includes(
    `Approval: ${TOKEN} removes ${SPENDER} as operator`));
});

test('an approval that does not decode is its own risk, never an unlimited one', () => {
  const short = approve(maxUint256).slice(0, 10 + 64) as Hex;
  const dirty = `0x095ea7b3${'ff'.repeat(12)}${approve(1n).slice(34)}` as Hex;
  const badBool = forAll(true).replace(/1$/, '2') as Hex;
  for (const data of [short, dirty, badBool, `${approve(1n)}00` as Hex]) {
    const tx = { ...TX, to: TOKEN, data };
    const r = review(tx, SAFE);
    assert.deepEqual(risksOf(r), ['approval-undecoded'], data);
    assert.equal(r.findings[0].line,
      `RISK approval-undecoded: the approval call to ${TOKEN} could not be read.`);
    assert.ok(summaryLines(summary(tx)).includes(`Approval: ${TOKEN}: could not be decoded`));
  }
});

const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
// Any contract with this function; the script does not match on the Permit2 address.
const ROUTER = getAddress(`0x${'00'.repeat(19)}bb`);
const permit2 = (amount: bigint, expiration = 1800000000) => encodeFunctionData({
  abi: PERMIT2_ABI, functionName: 'approve', args: [TOKEN, SPENDER, amount, expiration] });

test('a Permit2 approve names the token from its arguments and the contract it goes through',
  () => {
    const data = permit2(1000n);
    assert.equal(data.slice(0, 10), '0x87517c45');
    const a = approvalOf(call(ROUTER, data));
    assert.deepEqual(a, { token: TOKEN, kind: 'permit2', spender: SPENDER, amount: 1000n,
      expiration: 1800000000, via: ROUTER });
    assert.equal(approvalLine(a!), `Approval: ${TOKEN} lets ${SPENDER} spend 1000 (raw units) ` +
      `until 1800000000 (Unix time), granted through ${ROUTER}`);
    assert.deepEqual(risks({ ...TX, to: ROUTER, data }), []);
  });

test('a Permit2 approve with expiration 0 lasts for the current block only', () => {
  assert.equal(approvalLine(approvalOf(call(ROUTER, permit2(5n, 0)))!), `Approval: ${TOKEN} lets ` +
    `${SPENDER} spend 5 (raw units) for the current block only, granted through ${ROUTER}`);
});

test('a Permit2 approve from 2^96 - 1 up is unlimited, and a malformed one is undecoded', () => {
  assert.deepEqual(risks({ ...TX, to: ROUTER, data: permit2(2n ** 96n - 2n) }), []);
  assert.deepEqual(risks({ ...TX, to: ROUTER, data: permit2(2n ** 96n - 1n) }),
    ['unlimited-approval']);
  const max = review({ ...TX, to: ROUTER, data: permit2(2n ** 160n - 1n) }, SAFE);
  assert.deepEqual(max.findings, [{ risk: 'unlimited-approval', line: 'RISK unlimited-approval: ' +
    `${TOKEN} lets ${SPENDER} spend without limit through ${ROUTER}.` }]);
  const inBatch = review(batchTx(batchOf(call(ROUTER, permit2(2n ** 160n - 1n)))), SAFE);
  assert.deepEqual(risksOf(inBatch), ['unlimited-approval']);
  const word = (hex: string) => hex.padStart(64, '0');
  const good = permit2(1n);
  const cases: Hex[] = [
    good.slice(0, 10 + 64 * 3) as Hex,
    `${good}00`,
    `${good.slice(0, 10 + 64 * 2)}${word('1'.padEnd(41, '0'))}${good.slice(10 + 64 * 3)}` as Hex,
    `${good.slice(0, 10 + 64 * 3)}${word('1'.padEnd(13, '0'))}` as Hex,
  ];
  for (const data of cases) {
    const r = review({ ...TX, to: ROUTER, data }, SAFE);
    assert.deepEqual(r.findings, [{ risk: 'approval-undecoded',
      line: `RISK approval-undecoded: the approval call to ${ROUTER} could not be read.` }], data);
  }
});

test('an increaseAllowance line says the amount is added', () => {
  const more = encodeFunctionData({ abi: ABI, functionName: 'increaseAllowance',
    args: [SPENDER, 5n] });
  assert.equal(approvalLine(approvalOf(call(TOKEN, more))!),
    `Approval: ${TOKEN} lets ${SPENDER} spend 5 more (raw units)`);
});

test('uppercase calldata arguments decode to the same approval and the same batch', () => {
  const upper = (data: Hex) => `${data.slice(0, 10)}${data.slice(10).toUpperCase()}` as Hex;
  for (const data of [approve(10n), forAll(true), permit2(7n)]) {
    assert.deepEqual(approvalOf(call(TOKEN, upper(data))), approvalOf(call(TOKEN, data)));
  }
  const batch = batchOf(call(TOKEN, approve(10n)), call(OTHER, '0xABCDEF', 1, 3n));
  assert.deepEqual(decodeMultiSend(upper(batch)), decodeMultiSend(batch));
  assert.deepEqual(review(batchTx(upper(batch)), SAFE), review(batchTx(batch), SAFE));
});

test('the known MultiSend list has its 12 addresses, in lowercase and checksum form', () => {
  // MultiSend and MultiSendCallOnly of Safe 1.3.0, 1.4.1 and 1.5.0, from safe-deployments.
  // Only the 1.4.1 pair is labelled elsewhere in this repository.
  const known = [
    '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761', '0x998739bfdaadde7c933b942a68053933098f9eda',
    '0x0dfcccb95225ffb03c6fbb2559b530c2b7c8a912', '0x40a2accbd92bca938b02010e17a5b8929b49130d',
    '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b', '0xf220d3b4dfb23c4ade8c88e526c1353abacbc38f',
    MULTI_SEND.toLowerCase(), '0x309d0b190fecca8e1d5d8309a16f7e3cb133e885',
    CALL_ONLY.toLowerCase(), '0x0408ef011960d02349d50286d20531229bcef773',
    '0x218543288004cd07832472d464648173c77d7eb7', '0xa83c336b20401af773b6219ba5027174338d1836',
  ];
  assert.equal(new Set(known).size, 12);
  assert.deepEqual([...KNOWN_MULTI_SEND].sort(), [...known].sort());
  for (const address of known) {
    assert.equal(isKnownMultiSend(address), true, address);
    assert.equal(isKnownMultiSend(getAddress(address)), true, getAddress(address));
  }
  assert.equal(isKnownMultiSend(OTHER), false);
});

test('the risk table of the skill lists exactly the risk kinds, in order', () => {
  const skill = readFileSync(new URL('../skills/propose-transaction.md', import.meta.url), 'utf8');
  const lines = skill.slice(skill.indexOf('| Risk | When |')).split('\n');
  const table = lines.slice(2, lines.findIndex((line) => !line.trim().startsWith('|')));
  assert.deepEqual(table.map((line) => /^\s*\| `([^`]+)` \|/.exec(line)?.[1]), [...RISKS]);
});

test('the skill says that the note is public, and no example note has personal details', () => {
  const root = new URL('../', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
  assert.ok(read('skills/propose-transaction.md').includes('The note is public and permanent.'));
  const skills = readdirSync(new URL('skills/', root)).map((name) => `skills/${name}`);
  // Built from parts so that this file does not contain them.
  const forbidden = [['Al', 'ice'].join(''), ['in', 'voice 42'].join('')];
  for (const path of [...skills, 'README.md', 'scripts/propose.ts']) {
    const text = read(path).toLowerCase();
    for (const word of forbidden) assert.ok(!text.includes(word.toLowerCase()), `${path}: ${word}`);
  }
});

function summary(tx: SafeTx): Summary {
  return { chain: 'sep', chainId: 11155111, safe: SAFE, tx, review: review(tx, SAFE),
    nonceKind: 'next', note: 'pay', hash: safeTxHash(tx, SAFE, 11155111, '1.4.1'),
    delegate: 'The delegate is registered for this Safe with no expiry.' };
}

test('the summary lists the risks first and the service only when it is set', () => {
  const tx: SafeTx = { ...TX, operation: 1 };
  const lines = summaryLines(summary(tx));
  assert.deepEqual(lines.slice(0, 2).map((line) => line.split(':')[0]),
    ['RISK delegatecall', 'RISK unlimited-approval']);
  assert.deepEqual(lines.slice(2), [
    'Chain: sep (11155111)', `Safe: ${SAFE}`, `To: ${TX.to}`, 'Value: 0 wei (0 in the native coin)',
    'Data: 68 bytes, selector 0x095ea7b3',
    `Approval: ${TX.to} lets ${SPENDER} spend ${maxUint256} (raw units)`,
    'Operation: 1 (delegatecall)', 'Nonce: 9 (next free)', 'Note (public): pay',
    `safeTxHash: ${safeTxHash(tx, SAFE, 11155111, '1.4.1')}`,
    'Delegate: The delegate is registered for this Safe with no expiry.',
  ]);
  const hosted = summaryLines({ ...summary(tx), service: 'http://127.0.0.1:8000' });
  assert.equal(hosted.at(-2), 'Service: http://127.0.0.1:8000');
});

test('the summary lists the calls of a batch and the approvals inside it', () => {
  const tx = batchTx(batchOf(call(TOKEN, approve(5n)), call(OTHER, '0x01', 0, 3n),
    call(OTHER, '0x')));
  const lines = summaryLines(summary(tx));
  const from = lines.findIndex((line) => line.startsWith('Data: '));
  assert.deepEqual(lines.slice(from, from + 6), [
    `Data: ${size(tx.data)} bytes, selector 0x8d80ff0a`,
    'Batch: 3 calls',
    `  1. To: ${TOKEN}, value 0 wei, 68 bytes, selector 0x095ea7b3`,
    `  2. To: ${OTHER}, value 3 wei, 1 bytes, no selector`,
    `  3. To: ${OTHER}, value 0 wei, none`,
    `Approval: ${TOKEN} lets ${SPENDER} spend 5 (raw units)`,
  ]);
  assert.equal(lines[from + 6], 'Operation: 1 (delegatecall)');
  assert.ok(summaryLines(summary(batchTx('0x8d80ff0a00'))).includes('Batch: could not be decoded'));
  assert.ok(summaryLines(summary(batchTx(batchOf(call(OTHER, '0x'))))).includes('Batch: 1 call'));
});

test('the gated risk kinds are risk kinds, and the dry run names them for the sending run', () => {
  assert.deepEqual([...GATED_RISKS], ['self-call', 'delegatecall', 'batch-delegatecall']);
  for (const kind of GATED_RISKS) assert.ok((RISKS as readonly string[]).includes(kind), kind);
  const hash = safeTxHash(TX, SAFE, 11155111, '1.4.1');
  const next = nextStep(hash, ['delegatecall', 'unlimited-approval', 'self-call']);
  assert.deepEqual(next, { expectHash: hash, acceptRisk: ['delegatecall', 'self-call'],
    refused: null });
  assert.deepEqual(nextLines(next), [
    `to send, run again without --dry-run and with --expect-hash ${hash} --accept-risk ` +
      'delegatecall,self-call',
    'pass --accept-risk only after the user said yes to: delegatecall, self-call.']);
  assert.deepEqual(nextLines(nextStep(hash, ['unlimited-approval', 'approval-undecoded'])),
    [`to send, run again without --dry-run and with --expect-hash ${hash}`]);
  const refused = nextStep(hash, ['delegatecall', 'batch-undecoded']);
  assert.equal(refused.refused, UNREADABLE_BATCH);
  assert.deepEqual(nextLines(refused),
    ['a sending run refuses this: the multiSend batch cannot be read.']);
});
