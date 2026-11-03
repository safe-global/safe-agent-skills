import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const { version } = JSON.parse(read('package.json').toString()) as { version: string };
const RELEASE = `https://github.com/safe-global/safe-agent-skills/releases/download/v${version}/`;
type Entry = { name: string; type: string; description: string; url: string; digest: string };

function pack(): string {
  const out = mkdtempSync(join(tmpdir(), 'pack-'));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/pack.ts', import.meta.url)), out]);
  return out;
}

function untar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let at = 0; tar[at] !== 0; ) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(tar.subarray(at + 124, at + 136).toString(), 8);
    files.set(name, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('the discovery index matches every skill archive, its frontmatter and its digest', () => {
  const index = JSON.parse(read('.well-known/agent-skills/index.json').toString()) as
    { $schema: string; openapi: string; skills: Entry[] };
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  assert.equal(index.openapi, 'https://api.safe.global/tx-service/eth/schema/');
  assert.deepEqual(index.skills.map((s) => s.name).sort(), ['decode-and-explain',
    'propose-transaction', 'read-safe-state', 'register-delegate']);
  const [first, second] = [pack(), pack()];
  for (const skill of index.skills) {
    const archive = readFileSync(join(first, `${skill.name}.tar.gz`));
    assert.deepEqual(readFileSync(join(second, `${skill.name}.tar.gz`)), archive,
      `${skill.name}: not reproducible`);
    assert.equal(skill.type, 'archive');
    assert.equal(skill.url, `${RELEASE}${skill.name}.tar.gz`, `${skill.name}: url`);
    assert.equal(skill.digest, `sha256:${createHash('sha256').update(archive).digest('hex')}`,
      `${skill.name}: digest`);
    const files = untar(gunzipSync(archive));
    for (const path of files.keys()) {
      assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), `${skill.name}: ${path}`);
    }
    assert.deepEqual(files.get('SKILL.md'), read(`skills/${skill.name}.md`));
    assert.ok(files.has('scripts/safe-api.sh'), `${skill.name}: scripts missing`);
    assert.ok(files.get('SKILL.md')!.toString().startsWith(
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`),
    `${skill.name}: frontmatter differs from the index`);
  }
});
