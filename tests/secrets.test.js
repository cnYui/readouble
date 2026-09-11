// Guard: the import root is published through a public GitHub repository and
// shipped inside the .aix package, so no API key may ever be committed there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoPath } from './helpers/load-page.js';

const KEY_PATTERNS = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bBearer\s+[A-Za-z0-9._-]{24,}/];

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

test('no API key is committed under agent/', () => {
  const offenders = [];
  for (const file of listFiles(repoPath('agent'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (KEY_PATTERNS.some((pattern) => pattern.test(text))) offenders.push(path.relative(repoPath(), file));
  }
  assert.deepEqual(offenders, [], 'remove the key before committing: ' + offenders.join(', '));
});
