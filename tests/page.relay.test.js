// The explain Page with a configured vision relay (fixture config with a fake
// key and host). fetch is replaced per test; the host LanguageModel must stay idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage, keyEvent, loadPageDefinition, sleep, waitFor } from './helpers/load-page.js';
import { installRuntime, uninstallRuntime } from './helpers/runtime-mocks.js';

const definition = await loadPageDefinition('agent/pages/explain/index.ink', {
  importOverrides: { '../../config/vision.js': 'tests/fixtures/vision-config.js' }
});

const realFetch = globalThis.fetch;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function reply(content) {
  return jsonResponse(200, { choices: [{ message: { content } }] });
}

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return handler(calls.length, call);
  };
  return calls;
}

function openPage(query) {
  const page = createPage(definition);
  page.onLoad(query);
  page.onShow();
  page.onReady();
  return page;
}

test.afterEach(() => {
  uninstallRuntime();
  globalThis.fetch = realFetch;
});

test('the photo goes to the relay with the system prompt, image, key, and effort', async () => {
  const runtime = installRuntime();
  const calls = installFetch(() => reply(
    '【原文】We introduce Lattice Reweighting (LRW-7391).\n【解读】作者提出了 LRW-7391。\n【术语】LRW：格路径重加权'
  ));
  const page = openPage({ question: '这段什么意思' });
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(runtime.calls.prompts.length, 0, 'host model must stay idle');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.example/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-key');
  assert.equal(calls[0].body.model, 'vision-model');
  assert.equal(calls[0].body.reasoning_effort, 'medium');
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.messages[0].role, 'system');
  const user = calls[0].body.messages[1];
  assert.equal(user.role, 'user');
  assert.match(user.content[0].text, /这段什么意思/);
  assert.equal(user.content[1].type, 'image_url');
  assert.match(user.content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(page.data.excerpt, 'We introduce Lattice Reweighting (LRW-7391).');
  assert.match(page.data.stepText, /vision-model/);
  assert.equal(page._turnTimeoutMs(), 160000, 'turn watchdog must outlast the relay timeout');
  assert.equal(calls[0].init.timeout, 150000);
  assert.equal(runtime.calls.spoken.length, 1);
  page.onUnload();
});

test('follow-ups resend the photo turn and the previous answer', async () => {
  const runtime = installRuntime();
  const calls = installFetch((count) => reply(count === 1 ? '【原文】A【解读】B' : '因为方差更小。'));
  const page = openPage({});
  await waitFor(() => page.data.phase === 'answered');
  page.onKeyUp(keyEvent('Enter'));
  runtime.calls.recognitions[0].emit('为什么有效', true);
  runtime.calls.recognitions[0].stop();
  await waitFor(() => page.data.turnCount === 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(calls[1].body.messages[1].content[1].type, 'image_url');
  assert.equal(calls[1].body.messages[2].content, '【原文】A【解读】B');
  assert.equal(calls[1].body.messages[3].content, '为什么有效');
  assert.equal(page.data.explanation, '因为方差更小。');
  assert.equal(runtime.calls.streams.length, 0);
  page.onUnload();
});

test('a blocked or offline relay shows the network error and never falls back to the host model', async () => {
  const runtime = installRuntime();
  // What a browser reports when CORS blocks the request (api.aaccx.pw from aiui.rokid.com).
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const page = openPage({});
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '解读失败');
  assert.match(page.data.errorText, /连不上中转站/);
  assert.match(page.data.errorText, /Failed to fetch/);
  assert.equal(page.data.excerpt, '');
  assert.equal(runtime.calls.prompts.length + runtime.calls.streams.length, 0, 'no host-model fallback');
  page.onUnload();
});

test('relay errors show the relay message without the key, and Enter retries', async () => {
  const runtime = installRuntime();
  const calls = installFetch((count) => count === 1 ?
    jsonResponse(404, { error: { message: 'Model "vision-model" is not supported by any configured account in this group' } }) :
    reply('【解读】好了'));
  const page = openPage({});
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '解读失败');
  assert.match(page.data.errorText, /HTTP 404/);
  assert.match(page.data.errorText, /not supported/);
  assert.ok(!page.data.errorText.includes('fixture-key'));
  assert.equal(page.data.hint, '单击 重试');
  assert.equal(runtime.calls.prompts.length + runtime.calls.streams.length, 0, 'no host-model fallback');
  page.onKeyUp(keyEvent('Enter'));
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.messages[1].content[1].type, 'image_url');
  page.onUnload();
});

test('a NO_IMAGE reply switches to the spoken passage instead of showing invented text', async () => {
  const runtime = installRuntime();
  const calls = installFetch((count) => reply(count === 1 ? 'NO_IMAGE' : '【解读】这是念出来的段落。'));
  const page = openPage({});
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '模型看不到照片');
  assert.match(page.data.errorText, /vision-model/);
  assert.equal(page.data.hint, '单击 念出这段文字 由我来解读');
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(page.data.phase, 'listening');
  runtime.calls.recognitions[0].emit('we introduce lattice reweighting', true);
  runtime.calls.recognitions[0].stop();
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(calls[1].body.messages.length, 2);
  assert.match(calls[1].body.messages[1].content, /念出了论文中的这段文字/);
  assert.equal(page.data.explanation, '这是念出来的段落。');
  page.onUnload();
});

test('hiding the page aborts the in-flight relay request', async () => {
  installRuntime();
  let aborted = false;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'reading');
  page.onHide();
  await sleep(10);
  assert.equal(aborted, true);
  assert.equal(page.data.phase, 'ready');
  assert.equal(page.data.notice, '已中断');
  page.onShow();
  page.onUnload();
});
