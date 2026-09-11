import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VISION_TIMEOUT_MS,
  buildVisionRequest,
  callVision,
  chatCompletionsUrl,
  describeRelayStatus,
  parseVisionResponse,
  trimHistory,
  visionConfigured
} from '../agent/lib/vision.js';

const CONFIG = {
  enabled: true,
  baseUrl: 'https://relay.example/v1/',
  model: 'vision-model',
  reasoningEffort: 'medium',
  apiKey: 'test-key-123',
  timeoutMs: 45000
};

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

test('visionConfigured requires a key, an https base URL, and a model', () => {
  assert.equal(visionConfigured(CONFIG), true);
  assert.equal(visionConfigured({ ...CONFIG, apiKey: '' }), false);
  assert.equal(visionConfigured({ ...CONFIG, apiKey: '   ' }), false);
  assert.equal(visionConfigured({ ...CONFIG, baseUrl: 'http://relay.example/v1' }), false);
  assert.equal(visionConfigured({ ...CONFIG, model: '' }), false);
  assert.equal(visionConfigured({ ...CONFIG, enabled: false }), false);
  assert.equal(visionConfigured(undefined), false);
});

test('buildVisionRequest targets chat/completions with a bearer header and JSON body', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const { url, init } = buildVisionRequest(CONFIG, messages);
  assert.equal(url, 'https://relay.example/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://a.example/v1'), 'https://a.example/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer test-key-123');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.timeout, 45000);
  assert.deepEqual(JSON.parse(init.body), {
    model: 'vision-model',
    messages,
    stream: false,
    reasoning_effort: 'medium'
  });
  const bare = buildVisionRequest({ ...CONFIG, reasoningEffort: '', timeoutMs: undefined }, messages, 'SIG');
  assert.equal(JSON.parse(bare.init.body).reasoning_effort, undefined);
  assert.equal(bare.init.timeout, DEFAULT_VISION_TIMEOUT_MS);
  assert.equal(bare.init.signal, 'SIG');
});

test('parseVisionResponse reads string and part-array content and rejects errors', () => {
  assert.equal(parseVisionResponse({ choices: [{ message: { content: '【解读】好' } }] }), '【解读】好');
  assert.equal(parseVisionResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, 'b'] } }] }), 'ab');
  assert.throws(() => parseVisionResponse({ error: { message: 'model not found' } }), /model not found/);
  assert.throws(() => parseVisionResponse({ choices: [] }), /没有返回文字答案/);
  assert.throws(() => parseVisionResponse({ choices: [{ message: { content: '  ' } }] }), /没有返回文字答案/);
});

test('describeRelayStatus summarizes status codes with the relay detail', () => {
  assert.equal(describeRelayStatus(401, '{"error":{"message":"invalid token"}}'), '中转站拒绝了这个密钥（HTTP 401）：invalid token');
  assert.equal(describeRelayStatus(404, ''), '中转站找不到这个模型或地址（HTTP 404）');
  assert.equal(describeRelayStatus(429, '{"message":"quota"}'), '请求太频繁或额度不足（HTTP 429）：quota');
  assert.equal(describeRelayStatus(502, '<html>'), '中转站暂时不可用（HTTP 502）');
});

test('callVision returns the answer and never leaks the key into errors', async () => {
  let seen = null;
  const answer = await callVision(async (url, init) => {
    seen = { url, init };
    return fakeResponse(200, { choices: [{ message: { content: '【原文】x【解读】y' } }] });
  }, CONFIG, [{ role: 'user', content: 'q' }]);
  assert.equal(answer, '【原文】x【解读】y');
  assert.equal(seen.url, 'https://relay.example/v1/chat/completions');

  await assert.rejects(
    callVision(async () => fakeResponse(503, 'bad gateway'), CONFIG, []),
    (error) => /中转站暂时不可用（HTTP 503）/.test(error.message) && !error.message.includes('test-key-123')
  );
  await assert.rejects(
    callVision(async () => { throw new TypeError('Failed to fetch'); }, CONFIG, []),
    /连不上中转站：Failed to fetch/
  );
  await assert.rejects(callVision(async () => fakeResponse(200, 'not json'), CONFIG, []), /不是 JSON/);
  await assert.rejects(callVision(undefined, CONFIG, []), /不支持网络请求/);
});

test('trimHistory keeps the system prompt and the photo turn', () => {
  const history = [{ role: 'system' }, { role: 'user', photo: true }];
  for (let index = 0; index < 20; index += 1) history.push({ role: index % 2 ? 'user' : 'assistant', index });
  const trimmed = trimHistory(history, 6);
  assert.equal(trimmed.length, 6);
  assert.equal(trimmed[0].role, 'system');
  assert.equal(trimmed[1].photo, true);
  assert.equal(trimmed[5].index, 19);
  assert.deepEqual(trimHistory(history.slice(0, 3), 6), history.slice(0, 3));
});
