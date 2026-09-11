// Guard: the repository is public and agent/ ships inside the .aix package, so
// no API key may ever be committed. The key lives only in the ignored .env (and
// in the ignored build/agent/ generated from it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoPath } from './helpers/load-page.js';

const KEY_PATTERNS = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bBearer\s+[A-Za-z0-9._-]{24,}/];
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function git(args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: repoPath(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (error) {
    return { ok: false, status: error.status, missing: error.code === 'ENOENT' };
  }
}

function offendersIn(files) {
  const offenders = [];
  for (const file of files) {
    if (!fs.existsSync(file) || fs.statSync(file).size > MAX_SCAN_BYTES) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (KEY_PATTERNS.some((pattern) => pattern.test(text))) offenders.push(path.relative(repoPath(), file));
  }
  return offenders;
}

test('no API key under agent/', () => {
  assert.deepEqual(offendersIn(listFiles(repoPath('agent'))), [], 'remove the key from agent/');
});

test('no API key in any file tracked by Git', (t) => {
  const listed = git(['ls-files', '-z']);
  if (!listed.ok) {
    t.skip('git is not available here');
    return;
  }
  const files = listed.out.split('\0').filter(Boolean).map((file) => repoPath(file));
  assert.deepEqual(offendersIn(files), [], 'a tracked file contains a key');
});

test('.env and build/ are ignored by Git', (t) => {
  const ignore = fs.readFileSync(repoPath('.gitignore'), 'utf8').split(/\r?\n/);
  for (const entry of ['.env', 'build/']) assert.ok(ignore.includes(entry), entry + ' must be in .gitignore');
  const probe = git(['check-ignore', '-q', '.env']);
  if (probe.missing) {
    t.skip('git is not available here');
    return;
  }
  assert.ok(probe.ok, 'git does not ignore .env');
  assert.ok(git(['check-ignore', '-q', 'build/agent/config/vision.js']).ok, 'git does not ignore build/');
  assert.equal(git(['check-ignore', '-q', '.env.example']).ok, false, '.env.example must stay tracked');
});
