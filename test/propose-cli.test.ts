import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  concat, encodeFunctionData, encodePacked, getAddress, maxUint256, parseAbi, recoverAddress, size,
} from 'viem';
import type { Hex } from 'viem';
import {
  AS_DELEGATE, AS_OWNER, DAY_MS, DELEGATE, DELEGATE_KEY, DIR, OWNER, OWNER_KEY, QUEUE, SAFE, TO,
  clearSeen, posts, routes, run, seen,
} from './stub.ts';

const PROPOSE = ['--chain', 'local', '--safe', SAFE, '--to', TO, '--note', 'rent'];
const DRY_RUN = [...PROPOSE, '--dry-run'];
const SIGNATURE_RE = /0x[0-9a-fA-F]{130}/;
// Options that propose.ts does not have, spelled so that a search for them finds only live uses.
const UNKNOWN = ['send', 'confirm', ['pre', 'view'].join('')].map((name) => `--${name}`);

/** The read-back returns what was POSTed, as the service would store it. */
function storeProposals() {
  routes['GET *'] = () => {
    const posted = JSON.parse(posts()[0].body);
    return { status: 200, body: { safeTxHash: posted.contractTransactionHash,
      nonce: posted.nonce, proposer: OWNER.address, proposedByDelegate: DELEGATE,
      origin: posted.origin, confirmations: [], confirmationsRequired: 2 } };
  };
}

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
  const ok = await run('propose.ts',
    [...PROPOSE.slice(0, 4), '--to', lower, '--note', 'x', '--dry-run'], AS_DELEGATE);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).request.body.to, OWNER.address);
});

test('propose refuses an owner key, and a key file that others can read', async () => {
  const owner = await run('propose.ts', PROPOSE, { SAFE_DELEGATE_PRIVATE_KEY: OWNER_KEY });
  assert.equal(owner.code, 2);
  assert.match(owner.stderr, /this key is an owner of the Safe/);
  const file = join(DIR, 'delegate.key');
  writeFileSync(file, `${DELEGATE_KEY}\n`);
  chmodSync(file, 0o644);
  const open = await run('propose.ts', [...PROPOSE, '--key-file', file]);
  assert.equal(open.code, 2);
  assert.match(open.stderr, /readable by others/);
  assert.equal(seen.length, 1, 'only the Safe read before the owner refusal');
});

test('the dry run prints the delegate status and the request, and sends nothing', async () => {
  routes['GET /api/v2/delegates/'] = { status: 200, body: { results: [] } };
  const plain = await run('propose.ts', DRY_RUN, AS_DELEGATE);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stderr, /not registered for this Safe/);
  const { safeTxHash, request } = JSON.parse(plain.stdout);
  assert.deepEqual([request.method, request.path], ['POST', QUEUE]);
  assert.equal(request.body.contractTransactionHash, safeTxHash);
  assert.equal(request.body.operation, 0);
  const call = await run('propose.ts', [...DRY_RUN, '--delegatecall'], AS_DELEGATE);
  assert.equal(JSON.parse(call.stdout).request.body.operation, 1);
  assert.match(call.stderr, /RISK delegatecall: /);
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
  assert.doesNotMatch(r.stderr, /^propose: (?!summary$)/m);
});

test('the dry run signs nothing: no POST, no signature field and no 65-byte signature',
  async () => {
    const r = await run('propose.ts', [...DRY_RUN, '--delegatecall'], AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    const dryRun = JSON.parse(r.stdout);
    assert.equal(dryRun.mode, 'dry-run');
    assert.deepEqual(dryRun.risks, ['delegatecall']);
    assert.equal(dryRun.delegate.status, 'registered');
    assert.ok(!('signature' in dryRun.request.body));
    assert.doesNotMatch(r.stdout + r.stderr, /signature/i);
    assert.doesNotMatch(r.stdout + r.stderr, SIGNATURE_RE);
    assert.match(r.stderr, /^propose: summary\n {2}RISK delegatecall: /m);
    assert.ok(r.stderr.endsWith('propose: dry run only; nothing was signed or sent.\n'));
    assert.equal(posts().length, 0);
  });

test('a proposal is sent by default, signed by the delegate, with its risks and summary',
  async () => {
    storeProposals();
    const approve = `0x095ea7b3${'0'.repeat(64)}${'f'.repeat(64)}`;
    const r = await run('propose.ts', [...PROPOSE, '--data', approve], AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    const sent = JSON.parse(r.stdout);
    const posted = JSON.parse(posts()[0].body);
    assert.equal(sent.mode, 'sent');
    assert.equal(sent.safeTxHash, posted.contractTransactionHash);
    assert.deepEqual(sent.risks, ['unlimited-approval']);
    assert.ok(sent.summary.includes('Data: 68 bytes, selector 0x095ea7b3'));
    assert.match(r.stderr, /^propose: summary\n {2}RISK unlimited-approval: /m);
    const signer = await recoverAddress({ hash: posted.contractTransactionHash as Hex,
      signature: posted.signature as Hex });
    assert.equal(signer, DELEGATE);
  });

test('options that propose.ts does not have exit 2 before any request', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  for (const option of UNKNOWN) {
    const r = await run('propose.ts', [...PROPOSE, option, hash], AS_DELEGATE);
    assert.equal(r.code, 2, option);
    assert.match(r.stderr, new RegExp(`Unknown option '${option}'`));
  }
  assert.equal(seen.length, 0);
});

test('a batch with an inner unlimited approval is sent, with the risk and the batch lines',
  async () => {
    storeProposals();
    const abi = parseAbi(['function multiSend(bytes transactions)',
      'function approve(address spender, uint256 amount)']);
    const token = getAddress(`0x${'1c'.repeat(20)}`);
    const approve = encodeFunctionData({ abi, functionName: 'approve',
      args: [DELEGATE, maxUint256] });
    const calls: [Hex, Hex][] = [[token, approve], [TO as Hex, '0x']];
    const packed = concat(calls.map(([to, data]) => encodePacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, to, 0n, BigInt(size(data)), data])));
    const data = encodeFunctionData({ abi, functionName: 'multiSend', args: [packed] });
    // Safe 1.4.1 MultiSendCallOnly, from safe-deployments.
    const callOnly = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
    const args = ['--chain', 'local', '--safe', SAFE, '--to', callOnly, '--note', 'batch',
      '--data', data, '--delegatecall'];
    const r = await run('propose.ts', args, AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    const sent = JSON.parse(r.stdout);
    assert.equal(posts().length, 1);
    assert.deepEqual(sent.risks, ['unlimited-approval']);
    assert.deepEqual(sent.summary.slice(0, 1), [
      `RISK unlimited-approval: ${token} lets ${DELEGATE} spend without limit.`]);
    const from = sent.summary.indexOf('Batch: 2 calls');
    assert.deepEqual(sent.summary.slice(from, from + 4), ['Batch: 2 calls',
      `  1. To: ${token}, value 0 wei, 68 bytes, selector 0x095ea7b3`,
      `  2. To: ${getAddress(TO)}, value 0 wei, none`,
      `Approval: ${token} lets ${DELEGATE} spend ${maxUint256} (raw units)`]);
    assert.match(r.stderr, /^ {4}2\. To: 0x7{40}, value 0 wei, none$/im);
  });

test('the summary names the service and every nonce variant', async () => {
  const next = JSON.parse((await run('propose.ts', DRY_RUN, AS_DELEGATE)).stdout);
  assert.ok(next.summary.some((line: string) => /^Service: http:\/\/127\.0\.0\.1:\d+$/.test(line)));
  assert.ok(next.summary.includes('Nonce: 5 (next free)'));
  const given = await run('propose.ts', [...DRY_RUN, '--nonce', '7'], AS_DELEGATE);
  assert.ok(JSON.parse(given.stdout).summary.includes('Nonce: 7'));
  routes[`GET ${QUEUE}?nonce=5&executed=false`] = { status: 200,
    body: { count: 1, results: [{ nonce: 5 }] } };
  const replaces = await run('propose.ts', [...DRY_RUN, '--nonce', '5'], AS_DELEGATE);
  assert.ok(JSON.parse(replaces.stdout).summary.includes('Nonce: 5 (REPLACES pending nonce 5)'));
  assert.match(replaces.stderr, /^ {2}Nonce: 5 \(REPLACES pending nonce 5\)$/m);
});

test('the Service line shows the host, never the credentials or query of the URL', async () => {
  const url = new URL((await run('propose.ts', DRY_RUN, AS_DELEGATE)).stderr
    .match(/Service: (\S+)/)![1]);
  // safe-api.sh appends each path to the URL, so a fragment would cut it off; unit tests cover it.
  const service = `http://svcuser:S3CRET@${url.host}/?token=T0KEN`;
  clearSeen();
  const r = await run('propose.ts', DRY_RUN, { ...AS_DELEGATE, SAFE_TX_SERVICE_URL: service });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(seen.length > 0, 'the service URL reaches the stub');
  for (const secret of ['svcuser', 'S3CRET', 'T0KEN']) {
    assert.ok(!(r.stdout + r.stderr).includes(secret), secret);
  }
  assert.ok(JSON.parse(r.stdout).summary.includes(`Service: http://${url.host}`));
  assert.match(r.stderr, new RegExp(`^ {2}Service: http://${url.host}$`, 'm'));
});

test('only registrations by an owner of the Safe count for the delegate status', async () => {
  const stranger = getAddress(`0x${'3c'.repeat(20)}`);
  const notOwner = { safe: null, delegate: DELEGATE, delegator: stranger, expiryDate: null };
  const expired = { safe: SAFE, delegate: DELEGATE, delegator: OWNER.address,
    expiryDate: new Date(Date.now() - DAY_MS).toISOString() };
  const cases: [object[], RegExp][] = [[[notOwner], /not registered for this Safe/],
    [[notOwner, expired], /registration expired at/]];
  for (const [results, message] of cases) {
    routes['GET /api/v2/delegates/'] = { status: 200, body: { results } };
    clearSeen();
    const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, message);
    assert.equal(posts().length, 0);
  }
});

test('the read-back hash is compared, and the same-nonce check uses the local nonce',
  async () => {
    routes['GET *'] = { status: 200, body: { safeTxHash: `0x${'ee'.repeat(32)}`, nonce: 99,
      confirmations: [] } };
    routes[`GET ${QUEUE}?nonce=5`] = { status: 200, body: { count: 2, results: [] } };
    const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    const hash = JSON.parse(posts()[0].body).contractTransactionHash;
    const other = `0x${'ee'.repeat(32)}`;
    assert.ok(r.stderr.includes(`propose: WARNING the service returned safeTxHash ${other}, ` +
      `not ${hash}.`), r.stderr);
    assert.match(r.stderr, /WARNING 2 proposals have nonce 5; only one can execute/);
    assert.ok(!seen.some((s) => s.url.includes('nonce=99')));
    storeProposals();
    routes[`GET ${QUEUE}?nonce=5`] = { status: 200, body: { count: 1, results: [] } };
    clearSeen();
    const same = await run('propose.ts', PROPOSE, AS_DELEGATE);
    assert.equal(same.code, 0, same.stderr);
    assert.doesNotMatch(same.stderr, /WARNING/);
  });

test('a key file only its owner can read proposes as the delegate; others are refused',
  async () => {
    storeProposals();
    const file = join(DIR, 'mode.key');
    writeFileSync(file, `${DELEGATE_KEY}\n`);
    for (const mode of [0o640, 0o604]) {
      chmodSync(file, mode);
      const r = await run('propose.ts', [...PROPOSE, '--key-file', file]);
      assert.equal(r.code, 2, mode.toString(8));
      assert.match(r.stderr, /readable by others: chmod 600/);
    }
    assert.equal(seen.length, 0);
    chmodSync(file, 0o600);
    const ok = await run('propose.ts', [...PROPOSE, '--key-file', file]);
    assert.equal(ok.code, 0, ok.stderr);
    const posted = JSON.parse(posts()[0].body);
    assert.equal(posted.sender, DELEGATE);
    assert.equal(await recoverAddress({ hash: posted.contractTransactionHash as Hex,
      signature: posted.signature as Hex }), DELEGATE);
    writeFileSync(file, '0x1234\n');
    clearSeen();
    const bad = await run('propose.ts', [...PROPOSE, '--key-file', file]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /set SAFE_DELEGATE_PRIVATE_KEY or pass --key-file/);
    assert.equal(seen.length, 0);
  });

test('the next nonce follows the highest pending nonce', async () => {
  routes[`GET ${QUEUE}?executed=false&nonce__gte=5&ordering=-nonce&limit=1`] = { status: 200,
    body: { results: [{ nonce: '7' }] } };
  const r = await run('propose.ts', DRY_RUN, AS_DELEGATE);
  assert.equal(r.code, 0, r.stderr);
  const { summary, request } = JSON.parse(r.stdout);
  assert.ok(summary.includes('Nonce: 8 (next free)'));
  assert.equal(request.body.nonce, 8);
});

test('a registration that expires within a day still proposes, and says so', async () => {
  storeProposals();
  const expiryDate = new Date(Date.now() + DAY_MS / 2).toISOString();
  routes['GET /api/v2/delegates/'] = { status: 200, body: { results: [
    { safe: SAFE, delegate: DELEGATE, delegator: OWNER.address, expiryDate }] } };
  const r = await run('propose.ts', PROPOSE, AS_DELEGATE);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts().length, 1);
  assert.ok(JSON.parse(r.stdout).summary.includes(
    `Delegate: The delegate registration expires at ${expiryDate}. Renewal needs the owner to ` +
    'sign again (the register-delegate skill).'));
});

test('the dry run reports every delegate status', async () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const row = (expiryDate: string) =>
    ({ safe: SAFE, delegate: DELEGATE, delegator: OWNER.address, expiryDate });
  const cases: [object[], string][] = [[[], 'not-registered'], [[row(at(-DAY_MS))], 'expired'],
    [[row(at(DAY_MS / 2))], 'expiring'], [[row(at(7 * DAY_MS))], 'registered']];
  for (const [results, status] of cases) {
    routes['GET /api/v2/delegates/'] = { status: 200, body: { results } };
    const r = await run('propose.ts', DRY_RUN, AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).delegate.status, status);
  }
  assert.equal(posts().length, 0);
});

test('the Note line is the note as stored in origin, not the raw argument', async () => {
  const note = `Pay the rent\nfor ${'November '.repeat(15)}`;
  const r = await run('propose.ts', [...PROPOSE.slice(0, -1), note, '--dry-run'], AS_DELEGATE);
  assert.equal(r.code, 0, r.stderr);
  const { summary, request } = JSON.parse(r.stdout);
  const stored = JSON.parse(request.body.origin).note;
  assert.ok(stored.endsWith('…') && !stored.includes('\n'), stored);
  assert.ok(summary.includes(`Note (public): ${stored}`));
});

const BATCH_ABI = parseAbi(['function multiSend(bytes transactions)']);
// Safe 1.4.1 MultiSendCallOnly, from safe-deployments.
const CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const UNREADABLE = 'propose: the multiSend batch cannot be read, so its calls cannot be checked. ' +
  'Nothing was signed or sent. Encode the batch in the standard form.\n';
const word = (n: number) => n.toString(16).padStart(64, '0');
const batchData = (calls: [0 | 1, Hex, Hex][]) => encodeFunctionData({ abi: BATCH_ABI,
  functionName: 'multiSend', args: [concat(calls.map(([operation, to, data]) => encodePacked(
    ['uint8', 'address', 'uint256', 'uint256', 'bytes'], [operation, to, 0n, BigInt(size(data)),
      data])))] });
const batchArgs = (data: Hex) => ['--chain', 'local', '--safe', SAFE, '--to', CALL_ONLY,
  '--note', 'batch', '--data', data, '--delegatecall'];
const GOOD_BATCH = batchData([[0, TO as Hex, '0x']]);

async function dryRunHash(args: string[]): Promise<Hex> {
  const r = await run('propose.ts', [...args, '--dry-run'], AS_DELEGATE);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).safeTxHash;
}

test('a batch that cannot be read is refused on a sending run, whatever the options', async () => {
  const cases: [string, Hex][] = [
    ['32 zero bytes appended', `${GOOD_BATCH}${'00'.repeat(32)}`],
    ['offset 0x40', `0x8d80ff0a${word(0x40)}${word(0)}${GOOD_BATCH.slice(10 + 64)}`],
    ['one trailing byte', `${GOOD_BATCH}ab`],
  ];
  for (const [name, data] of cases) {
    clearSeen();
    const dry = await run('propose.ts', [...batchArgs(data), '--dry-run'], AS_DELEGATE);
    assert.equal(dry.code, 0, `${name}: ${dry.stderr}`);
    const { risks, next, safeTxHash } = JSON.parse(dry.stdout);
    assert.deepEqual(risks, ['batch-undecoded'], name);
    assert.equal(`propose: ${next.refused}\n`, UNREADABLE, name);
    assert.ok(dry.stderr.endsWith('  Delegate: The delegate is registered for this Safe until ' +
      `${dry.stderr.match(/until (\S+)\.\n/)![1]}.\npropose: a sending run refuses this: the ` +
      'multiSend batch cannot be read.\npropose: dry run only; nothing was signed or sent.\n'),
    name);
    const all = ['--expect-hash', safeTxHash, '--accept-risk', 'self-call,delegatecall'];
    for (const extra of [[], all]) {
      const r = await run('propose.ts', [...batchArgs(data), ...extra], AS_DELEGATE);
      assert.equal(r.code, 2, `${name}: ${r.stderr}`);
      assert.ok(r.stderr.endsWith(UNREADABLE), r.stderr);
      assert.match(r.stderr, /^ {2}RISK batch-undecoded: /m);
    }
    assert.equal(posts().length, 0, name);
  }
  storeProposals();
  const ok = await run('propose.ts', batchArgs(GOOD_BATCH), AS_DELEGATE);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(posts().length, 1);
});

test('--expect-hash sends only the transaction of the dry run', async () => {
  const hash = await dryRunHash(PROPOSE);
  const wrong = `0x${'ab'.repeat(32)}`;
  const bad = await run('propose.ts', [...PROPOSE, '--expect-hash', wrong], AS_DELEGATE);
  assert.equal(bad.code, 2, bad.stderr);
  assert.ok(bad.stderr.endsWith(`propose: the transaction is not the one of the dry run: ` +
    `--expect-hash is ${wrong}, it now hashes to ${hash} (nonce 5). Nothing was signed or sent. ` +
    'Run the dry run again and check its summary.\n'), bad.stderr);
  const dry = await run('propose.ts', [...DRY_RUN, '--expect-hash', wrong], AS_DELEGATE);
  assert.equal(dry.code, 2, dry.stderr);
  assert.match(dry.stderr, /not the one of the dry run/);
  assert.equal(posts().length, 0);
  storeProposals();
  for (const given of [hash, `0x${hash.slice(2).toUpperCase()}`]) {
    clearSeen();
    const r = await run('propose.ts', [...PROPOSE, '--expect-hash', given], AS_DELEGATE);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(posts()[0].body).contractTransactionHash, hash);
  }
});

test('--expect-hash catches a nonce that moved after the dry run', async () => {
  const hash = await dryRunHash(PROPOSE);
  routes[`GET ${QUEUE}?executed=false&nonce__gte=5&ordering=-nonce&limit=1`] = { status: 200,
    body: { results: [{ nonce: '5' }] } };
  const r = await run('propose.ts', [...PROPOSE, '--expect-hash', hash], AS_DELEGATE);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`--expect-hash is ${hash}, it now hashes to 0x[0-9a-f]{64} ` +
    '\\(nonce 6\\)\\. Nothing was signed or sent\\.'));
  assert.equal(posts().length, 0);
});

test('a malformed --expect-hash exits 2 before any request', async () => {
  for (const value of ['0x1234', 'ab'.repeat(32), `0x${'ab'.repeat(31)}`, `0x${'g'.repeat(64)}`,
    `0x${'ab'.repeat(33)}`, '']) {
    const r = await run('propose.ts', [...PROPOSE, '--expect-hash', value], AS_DELEGATE);
    assert.equal(r.code, 2, value);
    assert.ok(r.stderr.includes(`--expect-hash: ${value} is not a 32-byte hex safeTxHash`),
      r.stderr);
  }
  assert.equal(seen.length, 0);
});

test('a self-call, a delegatecall and an inner delegatecall are sent only with --accept-risk',
  async () => {
    const cases: [string[], string][] = [
      [['--chain', 'local', '--safe', SAFE, '--to', SAFE, '--note', 'owner'], 'self-call'],
      [[...PROPOSE, '--delegatecall'], 'delegatecall'],
      [batchArgs(batchData([[1, TO as Hex, '0x']])), 'batch-delegatecall'],
    ];
    for (const [args, kind] of cases) {
      clearSeen();
      const r = await run('propose.ts', args, AS_DELEGATE);
      assert.equal(r.code, 2, `${kind}: ${r.stderr}`);
      assert.ok(r.stderr.endsWith(`propose: this proposal has risks that need an explicit yes: ` +
        `${kind}. Nothing was signed or sent. Ask the user, then run again with --accept-risk ` +
        `${kind}.\n`), r.stderr);
      assert.match(r.stderr, new RegExp(`^ {2}RISK ${kind}: `, 'm'));
      const other = kind === 'self-call' ? 'delegatecall' : 'self-call';
      const wrong = await run('propose.ts', [...args, '--accept-risk', other], AS_DELEGATE);
      assert.equal(wrong.code, 2, `${kind} with ${other}`);
      assert.equal(posts().length, 0, kind);
      storeProposals();
      const ok = await run('propose.ts', [...args, '--accept-risk', kind], AS_DELEGATE);
      assert.equal(ok.code, 0, `${kind}: ${ok.stderr}`);
      assert.deepEqual(JSON.parse(ok.stdout).risks, [kind]);
      assert.equal(posts().length, 1, kind);
    }
  });

test('two gated risks need both kinds in --accept-risk', async () => {
  const args = ['--chain', 'local', '--safe', SAFE, '--to', SAFE, '--note', 'x', '--delegatecall'];
  const one = await run('propose.ts', [...args, '--accept-risk', 'self-call'], AS_DELEGATE);
  assert.equal(one.code, 2, one.stderr);
  assert.ok(one.stderr.endsWith('need an explicit yes: delegatecall. Nothing was signed or ' +
    'sent. Ask the user, then run again with --accept-risk delegatecall,self-call.\n'), one.stderr);
  const none = await run('propose.ts', args, AS_DELEGATE);
  assert.match(none.stderr, /need an explicit yes: delegatecall, self-call\. /);
  assert.equal(posts().length, 0);
  storeProposals();
  const both = await run('propose.ts', [...args, '--accept-risk', 'self-call,delegatecall'],
    AS_DELEGATE);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(posts().length, 1);
});

test('--accept-risk takes only the gated kinds, once', async () => {
  for (const [value, bad] of [['unlimited-approval', 'unlimited-approval'],
    ['self-call,batch-undecoded', 'batch-undecoded'], ['self-call delegatecall',
      'self-call delegatecall'], ['', '']]) {
    const r = await run('propose.ts', [...PROPOSE, '--accept-risk', value], AS_DELEGATE);
    assert.equal(r.code, 2, value);
    assert.ok(r.stderr.includes(`--accept-risk: ${bad} is not one of self-call, delegatecall, ` +
      'batch-delegatecall\n'), r.stderr);
  }
  const twice = await run('propose.ts', [...PROPOSE, '--accept-risk', 'self-call',
    '--accept-risk', 'delegatecall'], AS_DELEGATE);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /--accept-risk: give it once/);
  assert.equal(seen.length, 0);
  storeProposals();
  const unused = await run('propose.ts', [...PROPOSE, '--accept-risk', 'self-call'], AS_DELEGATE);
  assert.equal(unused.code, 0, unused.stderr);
  assert.equal(posts().length, 1);
});

test('an unlimited approval or an undecoded approval alone is sent without --accept-risk',
  async () => {
    storeProposals();
    const unlimited = `0x095ea7b3${'0'.repeat(64)}${'f'.repeat(64)}`;
    const short = `0x095ea7b3${'f'.repeat(64)}`;
    for (const [data, kind] of [[unlimited, 'unlimited-approval'], [short, 'approval-undecoded']]) {
      clearSeen();
      const r = await run('propose.ts', [...PROPOSE, '--data', data], AS_DELEGATE);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).risks, [kind]);
      assert.equal(posts().length, 1);
    }
  });

test('the checks of a sending run come in order: batch, hash, gated risks, registration',
  async () => {
    routes['GET /api/v2/delegates/'] = { status: 200, body: { results: [] } };
    const wrong = `0x${'ab'.repeat(32)}`;
    const undecoded: Hex = `${GOOD_BATCH}ab`;
    const selfCall = ['--chain', 'local', '--safe', SAFE, '--to', SAFE, '--note', 'x'];
    const cases: [string[], RegExp, number][] = [
      [[...batchArgs(undecoded), '--expect-hash', wrong], /batch cannot be read/, 2],
      [[...selfCall, '--expect-hash', wrong], /not the one of the dry run/, 2],
      [selfCall, /need an explicit yes: self-call/, 2],
      [[...selfCall, '--accept-risk', 'self-call'], /not registered for this Safe/, 4],
    ];
    for (const [args, message, code] of cases) {
      const r = await run('propose.ts', args, AS_DELEGATE);
      assert.equal(r.code, code, r.stderr);
      assert.match(r.stderr.split('\n').at(-2)!, message);
    }
    assert.equal(posts().length, 0);
  });

test('the dry run names the flags of the sending run, and they send it', async () => {
  const args = ['--chain', 'local', '--safe', SAFE, '--to', SAFE, '--note', 'x', '--delegatecall'];
  const plain = await run('propose.ts', DRY_RUN, AS_DELEGATE);
  const { safeTxHash: plainHash, next: plainNext } = JSON.parse(plain.stdout);
  assert.deepEqual(plainNext, { expectHash: plainHash, acceptRisk: [], refused: null });
  assert.ok(plain.stderr.endsWith('propose: to send, run again without --dry-run and with ' +
    `--expect-hash ${plainHash}\npropose: dry run only; nothing was signed or sent.\n`));
  const dry = await run('propose.ts', [...args, '--dry-run', '--accept-risk', 'self-call'],
    AS_DELEGATE);
  assert.equal(dry.code, 0, dry.stderr);
  const { safeTxHash, risks, next } = JSON.parse(dry.stdout);
  assert.deepEqual(risks, ['delegatecall', 'self-call']);
  assert.deepEqual(next, { expectHash: safeTxHash, acceptRisk: ['delegatecall', 'self-call'],
    refused: null });
  const tail = 'propose: to send, run again without --dry-run and with --expect-hash ' +
    `${safeTxHash} --accept-risk delegatecall,self-call\npropose: pass --accept-risk only after ` +
    'the user said yes to: delegatecall, self-call.\npropose: dry run only; nothing was signed ' +
    'or sent.\n';
  assert.ok(dry.stderr.endsWith(`  Delegate: ${dry.stderr.match(/Delegate: (.*)\n/)![1]}\n${tail}`),
    dry.stderr);
  assert.equal(posts().length, 0);
  storeProposals();
  const flags = /with (--expect-hash .*)$/m.exec(dry.stderr)![1].split(' ');
  const r = await run('propose.ts', [...args, ...flags], AS_DELEGATE);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(posts()[0].body).contractTransactionHash, safeTxHash);
});
