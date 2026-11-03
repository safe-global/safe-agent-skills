import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const INDEX = new URL('../.well-known/agent-skills/index.json', import.meta.url);
const RAW = 'https://raw.githubusercontent.com/safe-global/safe-agent-skills/main/skills/';
type Entry = { name: string; type: string; description: string; url: string; digest: string };

test('the discovery index matches every skill file, its frontmatter and its digest', () => {
  const index = JSON.parse(readFileSync(INDEX, 'utf8')) as { $schema: string; skills: Entry[] };
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  const names = ['decode-and-explain', 'propose-transaction', 'read-safe-state',
    'register-delegate'];
  assert.deepEqual(index.skills.map((s) => s.name).sort(), names);
  for (const skill of index.skills) {
    assert.equal(skill.url, `${RAW}${skill.name}.md`, `${skill.name}: url`);
    const bytes = readFileSync(new URL(`../skills/${skill.name}.md`, import.meta.url));
    const text = bytes.toString('utf8');
    assert.equal(skill.type, 'skill-md');
    assert.equal(skill.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.ok(text.startsWith(`---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`),
      `${skill.name}: frontmatter differs from the index`);
  }
});
