import { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// The scripts run from a copy whose path has a space and a non-ASCII letter.
const REPO = fileURLToPath(new URL('..', import.meta.url));
export const DIR = mkdtempSync(join(tmpdir(), 'scripts-'));
const ROOT = join(DIR, 'safe agent é');
mkdirSync(ROOT);
cpSync(join(REPO, 'scripts'), join(ROOT, 'scripts'), { recursive: true });
cpSync(join(REPO, 'package.json'), join(ROOT, 'package.json'));
symlinkSync(join(REPO, 'node_modules'), join(ROOT, 'node_modules'));

export const OWNER_KEY = generatePrivateKey();
export const OWNER = privateKeyToAccount(OWNER_KEY);
export const DELEGATE_KEY = generatePrivateKey();
export const DELEGATE = privateKeyToAccount(DELEGATE_KEY).address;
export const SAFE = getAddress(`0x${'5a'.repeat(20)}`);
export const QUEUE = `/api/v2/safes/${SAFE}/multisig-transactions/`;
export const CHAIN_ID = 31337;
export const DAY_MS = 24 * 3600 * 1000;
export const TO = `0x${'7'.repeat(40)}`;
export const AS_DELEGATE = { SAFE_DELEGATE_PRIVATE_KEY: DELEGATE_KEY };
export const AS_OWNER = { TEST_OWNER_KEY: OWNER_KEY };

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
export type Seen = { method: string; url: string; body: string };
/** A fixed reply, or one computed from the request (for example from what was POSTed). */
export type Route = Reply | ((request: Seen) => Reply);
export type Result = { code: number | null; stdout: string; stderr: string };

function defaults(): Record<string, Route> {
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

/** Keys are "METHOD url", "METHOD path" (the url without its query) or "METHOD *". */
export const routes: Record<string, Route> = defaults();
/** Every request the stub received in this test, in order. */
export const seen: Seen[] = [];
let base = '';

function replyTo(request: Seen): Reply {
  const { method, url } = request;
  const route = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`] ??
    routes[`${method} *`] ?? { status: 404, body: {} };
  return typeof route === 'function' ? route(request) : route;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    const { method = '' } = req;
    // A service URL with a query (?token=…) puts that query before every path; drop it.
    const url = (req.url ?? '').replace(/^\/\?[^/]*/, '');
    const request = { method, url, body };
    seen.push(request);
    const reply = replyTo(request);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
});

/** Forgets the requests seen so far, for a test that runs a script more than once. */
export const clearSeen = () => void seen.splice(0);

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
  for (const key of Object.keys(routes)) delete routes[key];
  Object.assign(routes, defaults());
  clearSeen();
});

export async function run(script: string, args: string[], env: Record<string, string> = {}) {
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

export const posts = () => seen.filter((s) => s.method === 'POST');
