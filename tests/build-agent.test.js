import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeVisionConfig, parseEnv, renderVisionConfig } from '../tools/build_agent.mjs';

const BASE = {
  enabled: true,
  baseUrl: 'https://relay.example/v1',
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  apiKey: '',
  timeoutMs: 60000
};

test('parseEnv reads KEY=VALUE lines, quotes, comments, and export prefixes', () => {
  const env = parseEnv('# comment\nREADOUBLE_VISION_KEY="abc"\r\nexport READOUBLE_VISION_MODEL=m\nBAD\n=x\nREADOUBLE_VISION_EFFORT=\n');
  assert.deepEqual(env, {
    READOUBLE_VISION_KEY: 'abc',
    READOUBLE_VISION_MODEL: 'm',
    READOUBLE_VISION_EFFORT: ''
  });
});

test('mergeVisionConfig injects the key and optional overrides without touching the base', () => {
  assert.deepEqual(mergeVisionConfig(BASE, { READOUBLE_VISION_KEY: ' k ' }), { ...BASE, apiKey: 'k' });
  assert.deepEqual(
    mergeVisionConfig(BASE, { READOUBLE_VISION_KEY: 'k', READOUBLE_VISION_MODEL: 'x', READOUBLE_VISION_EFFORT: '' }),
    { ...BASE, apiKey: 'k', model: 'x', reasoningEffort: '' }
  );
  assert.throws(() => mergeVisionConfig(BASE, {}), /READOUBLE_VISION_KEY/);
  assert.equal(BASE.apiKey, '');
});

test('renderVisionConfig produces an importable module', async () => {
  const source = renderVisionConfig({ apiKey: 'k', model: 'm' });
  const module = await import('data:text/javascript,' + encodeURIComponent(source));
  assert.deepEqual(module.default, { apiKey: 'k', model: 'm' });
});
