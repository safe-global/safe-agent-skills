import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED = ['LICENSE', 'README.md', 'package-lock.json', 'package.json', 'scripts/propose.ts',
  'scripts/safe-api.sh', 'scripts/sign-delegate.ts'];
const MTIME = Date.UTC(2026, 0, 1) / 1000;
const OUT = process.argv[2] ?? join(ROOT, 'dist');

function entry(name: string, body: Buffer, mode: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (text: string, at: number) => h.write(text, at, 'ascii');
  const octal = (n: number, width: number) => n.toString(8).padStart(width, '0');
  put(name, 0);
  put(octal(mode, 7), 100);
  put(octal(0, 7), 108);
  put(octal(0, 7), 116);
  put(octal(body.length, 11), 124);
  put(octal(MTIME, 11), 136);
  put(' '.repeat(8), 148);
  put('0', 156);
  put('ustar\x0000', 257);
  put(`${octal(h.reduce((sum, b) => sum + b, 0), 6)}\0 `, 148);
  return Buffer.concat([h, body, Buffer.alloc(-body.length & 511)]);
}

mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(join(ROOT, 'skills')).sort()) {
  const name = file.replace(/\.md$/, '');
  const tar = Buffer.concat([
    entry('SKILL.md', readFileSync(join(ROOT, 'skills', file)), 0o644),
    ...SHIPPED.map((path) => entry(path, readFileSync(join(ROOT, path)),
      statSync(join(ROOT, path)).mode & 0o111 ? 0o755 : 0o644)),
    Buffer.alloc(1024),
  ]);
  const gz = gzipSync(tar, { level: 9 });
  gz[9] = 3; // zlib writes a platform-specific OS byte; fix it to Unix so macOS and Linux agree.
  writeFileSync(join(OUT, `${name}.tar.gz`), gz);
  console.log(`${name} sha256:${createHash('sha256').update(gz).digest('hex')}`);
}
