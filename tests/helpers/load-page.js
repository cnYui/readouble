// Loads the `<script setup>` block of a single-file `.ink` Page as a real ES
// module so tests exercise the exported Page object with fake runtime globals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function repoPath(...parts) {
  return path.join(ROOT, ...parts);
}

export async function loadPageDefinition(inkRelativePath) {
  const inkPath = repoPath(inkRelativePath);
  const source = fs.readFileSync(inkPath, 'utf8');
  const match = source.match(/<script setup>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no <script setup> in ' + inkRelativePath);
  const pageDir = path.dirname(inkPath);
  const shimUrl = pathToFileURL(repoPath('tests', 'helpers', 'wx-shim.js')).href;
  let code = match[1];
  code = code.replace(/from\s+'wx'/g, () => `from '${shimUrl}'`);
  code = code.replace(/from\s+'(\.\.?\/[^']+)'/g, (whole, relative) => {
    return `from '${pathToFileURL(path.resolve(pageDir, relative)).href}'`;
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readouble-page-'));
  const tmpFile = path.join(tmpDir, 'page.mjs');
  fs.writeFileSync(tmpFile, code);
  try {
    const module = await import(pathToFileURL(tmpFile).href);
    return module.default;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assignPath(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (typeof cursor[parts[index]] !== 'object' || cursor[parts[index]] === null) {
      cursor[parts[index]] = {};
    }
    cursor = cursor[parts[index]];
  }
  cursor[parts[parts.length - 1]] = value;
}

// Fake Page instance: enumerable definition members plus the runtime-injected
// `data`, `setData()`, and `finish()`.
export function createPage(definition) {
  const page = Object.create(definition);
  page.data = structuredClone(definition.data || {});
  page.patches = [];
  page.finishCalls = 0;
  page.setData = function setData(patch, callback) {
    if (!patch || typeof patch !== 'object') throw new TypeError('setData expects an object');
    for (const key of Object.keys(patch)) {
      if (key.indexOf('.') >= 0) assignPath(page.data, key, patch[key]);
      else page.data[key] = patch[key];
    }
    page.patches.push(patch);
    if (typeof callback === 'function') callback();
  };
  page.finish = function finish() {
    page.finishCalls += 1;
  };
  return page;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  throw new Error('waitFor timed out');
}

export function keyEvent(code) {
  const event = { code, prevented: false };
  event.preventDefault = () => {
    event.prevented = true;
  };
  return event;
}
