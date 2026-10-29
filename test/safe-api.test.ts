import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TLSSocket } from 'node:tls';

const SCRIPT = new URL('../scripts/safe-api.sh', import.meta.url).pathname;
const KEY = `test-key-${randomUUID()}`;
const UA = 'safe-agent-skill/1.0 (+https://github.com/safe-global/safe-agent-skills)';
const SAFES = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40)];
const ESTIMATE = `/api/v1/safes/${SAFES[0]}/multisig-transactions/estimations/`;
const BODY = `{"to":"${SAFES[1]}","value":"0","operation":0}`;
const DIR = mkdtempSync(join(tmpdir(), 'safe-api-'));

type Reply = { status: number; headers?: Record<string, string>; body?: string; delayMs?: number };
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string; at: number };
type Result = { code: number | null; stdout: string; stderr: string };

let replies: Reply[] = [];
let seen: Seen[] = [];
let origin = '';

function stub(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    const { method = '', url = '', headers } = req;
    seen.push({ method, url, headers, body, at: performance.now() });
    const reply = replies.shift() ?? { status: 200, body: '{}' };
    setTimeout(() => {
      if (reply.status === 0) return void req.socket.destroy();
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body ?? '');
    }, reply.delayMs ?? 0);
  });
}

// The stub is also an HTTPS proxy that terminates TLS for api.safe.global with a throwaway
// certificate, so the key is only exercised against the real hosted URL.
const cert = join(DIR, 'cert.pem');
const key = join(DIR, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj',
  '/CN=api.safe.global', '-addext', 'subjectAltName=DNS:api.safe.global', '-keyout', key,
  '-out', cert], { stdio: 'ignore' });
writeFileSync(join(DIR, '.curlrc'), 'verbose\n');
const tls = { isServer: true, key: readFileSync(key), cert: readFileSync(cert) };
const inner = createServer(stub);
const server = createServer(stub);
server.on('connect', (_req, socket) => {
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  inner.emit('connection', new TLSSocket(socket, tls));
});

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  replies = [];
  seen = [];
});

const hosted = (proxy = origin): Record<string, string> =>
  ({ SAFE_API_KEY: KEY, https_proxy: proxy, CURL_CA_BUNDLE: cert, HOME: DIR });
const local = (): Record<string, string> => ({ SAFE_TX_SERVICE_URL: `${origin}/tx-base/` });

async function run(args: string[], env = hosted(), input = ''): Promise<Result> {
  const child = spawn('bash', [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
  child.stdin.end(input);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  assert.ok(!stdout.includes(KEY), 'the key appears in stdout');
  assert.ok(!stderr.includes(KEY), 'the key appears in stderr');
  return { code, stdout, stderr };
}

const gap = (i: number) => seen[i].at - seen[i - 1].at;

test('sends the exact User-Agent and the Bearer key to the hosted URL', async () => {
  const headers = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' };
  replies = [{ status: 200, headers, body: '{"version":"6.13.0"}' }];
  const r = await run(['sep', 'GET', '/api/v1/about/?probe=[1]']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"version":"6.13.0"}');
  assert.equal(seen[0].url, '/tx-service/sep/api/v1/about/?probe=[1]');
  assert.equal(seen[0].headers['user-agent'], UA);
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  const line = /sep GET \/api\/v1\/about\/\?probe=\[1\] -> 200 \(rate limit: 4999 of 5000 left\)/;
  assert.match(r.stderr, line);
});

test('the key stays off the process list while curl runs', async () => {
  replies = [{ status: 200, body: '{}', delayMs: 1500 }];
  const running = run(['sep', 'GET', '/api/v1/about/']);
  const url = 'https://api.safe.global/tx-service/sep/api/v1/about/';
  let curl: string[] = [];
  let listing = '';
  for (let i = 0; i < 50 && curl.length === 0; i++) {
    await sleep(20);
    listing = execFileSync('ps', ['-ww', '-A', '-o', 'args='], { encoding: 'utf8' });
    curl = listing.split('\n').filter((line) => line.includes('curl') && line.includes(url));
  }
  const { code } = await running;
  assert.equal(curl.length, 1, 'the curl child was not seen');
  assert.ok(!listing.includes(KEY), 'the key appears in ps');
  assert.equal(code, 0);
});

test('a hosted target without a key fails with an actionable message', async () => {
  const r = await run(['sep', 'GET', '/api/v1/about/'], { ...hosted(), SAFE_API_KEY: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /SAFE_API_KEY is not set/);
  assert.match(r.stderr, /https:\/\/developer\.safe\.global/);
  assert.match(r.stderr, /export SAFE_API_KEY=/);
  assert.equal(seen.length, 0);
});

test('SAFE_TX_SERVICE_URL sets the base URL and makes the key optional', async () => {
  assert.equal((await run(['gno', 'GET', '/api/v1/about/'], local())).code, 0);
  assert.equal(seen[0].url, '/tx-base/api/v1/about/');
});

test('SAFE_TX_SERVICE_URL never receives SAFE_API_KEY', async () => {
  const r = await run(['gno', 'GET', '/api/v1/about/'], { ...local(), SAFE_API_KEY: KEY });
  assert.equal(r.code, 0);
  assert.equal(seen[0].url, '/tx-base/api/v1/about/');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.match(r.stderr, /SAFE_API_KEY is not sent/);
});

test('429 with Retry-After is retried after the delay, then succeeds', async () => {
  replies = [{ status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: '{"a":1}' }];
  const r = await run(['sep', 'GET', '/api/v1/about/']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"a":1}');
  assert.equal(seen.length, 2);
  assert.ok(gap(1) >= 1000, `retried after ${gap(1)} ms`);
});

test('a persistent 429 stops after 3 attempts with the quota message', async () => {
  const headers = { 'retry-after': '0', 'x-ratelimit-reset': '3600' };
  const quota = { status: 429, headers, body: '{"detail":"Monthly quota exceeded."}' };
  replies = [quota, quota, quota, { status: 201 }];
  const r = await run(['sep', 'POST', ESTIMATE, BODY]);
  assert.equal(r.code, 3);
  assert.equal(seen.length, 3);
  assert.equal(r.stdout, quota.body);
  assert.match(r.stderr, /429 Too Many Requests after 3 attempt\(s\): the Safe API account quota/);
  assert.match(r.stderr, /rate limit resets in 3600s \(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)/);
  assert.match(r.stderr, /Still works: Safe\{Wallet\}/);
});

test('a Retry-After longer than 30 s is reported, not waited for', async () => {
  replies = [{ status: 429, headers: { 'retry-after': '120' } }];
  const r = await run(['sep', 'GET', '/api/v1/about/']);
  assert.equal(r.code, 3);
  assert.equal(seen.length, 1);
  assert.match(r.stderr, /Retry after 120s/);
});

test('GET retries on 503 with backoff', async () => {
  replies = [{ status: 503 }, { status: 200, body: '[]' }];
  const r = await run(['sep', 'GET', '/api/v1/about/']);
  assert.equal(r.code, 0);
  assert.equal(seen.length, 2);
  assert.ok(gap(1) >= 1000, `retried after ${gap(1)} ms`);
});

test('POST does not retry on 503', async () => {
  replies = [{ status: 503 }, { status: 201 }];
  const r = await run(['sep', 'POST', ESTIMATE, BODY]);
  assert.equal(r.code, 5);
  assert.equal(seen.length, 1);
});

test('a redirect exits with the client code and the trailing-slash hint', async () => {
  replies = [{ status: 301, headers: { location: '/tx-service/sep/api/v1/about/' } }];
  const r = await run(['sep', 'GET', '/api/v1/about']);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /add the trailing slash/);
});

test('a connection dropped after the request exits with the network code', async () => {
  replies = [{ status: 0 }];
  const r = await run(['sep', 'POST', ESTIMATE, BODY]);
  assert.equal(r.code, 5);
  assert.equal(seen.length, 1);
  assert.match(r.stderr, /network error after 1 attempt/);
});

test('the body is read from a string, @file and stdin', async () => {
  const file = join(DIR, 'body.json');
  writeFileSync(file, BODY);
  for (const [body, input] of [[BODY, ''], [`@${file}`, ''], ['-', BODY]]) {
    assert.equal((await run(['sep', 'POST', ESTIMATE, body], hosted(), input)).code, 0);
  }
  const got = seen.map((s) => [s.method, s.body, s.headers['content-type']]);
  assert.deepEqual(got, Array(3).fill(['POST', BODY, 'application/json']));
});

test('--each reads several Safes serially, at most 5 requests per second', async () => {
  replies = SAFES.map((address) => ({ status: 200, body: JSON.stringify({ address }) }));
  const r = await run(['sep', 'GET', '/api/v1/safes/{safe}/', '--each', ...SAFES]);
  assert.equal(r.code, 0);
  assert.deepEqual(seen.map((s) => s.url), SAFES.map((s) => `/tx-service/sep/api/v1/safes/${s}/`));
  const lines = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, SAFES.map((safe) => ({ safe, status: 200, body: { address: safe } })));
  for (let i = 1; i < seen.length; i++) assert.ok(gap(i) >= 200, `request ${i} after ${gap(i)} ms`);
});
