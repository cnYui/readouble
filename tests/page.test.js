// Exercises the real explain Page logic (extracted from the .ink file) against
// fake runtime globals: camera, LanguageModel, SpeechRecognition, and TTS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage, keyEvent, loadPageDefinition, sleep, waitFor } from './helpers/load-page.js';
import { installRuntime, uninstallRuntime } from './helpers/runtime-mocks.js';

const definition = await loadPageDefinition('agent/pages/explain/index.ink');

function openPage(query) {
  const page = createPage(definition);
  page.onLoad(query);
  page.onShow();
  page.onReady();
  return page;
}

test.afterEach(() => {
  uninstallRuntime();
});

test('voice question opens the page, auto-captures, explains, and speaks', async () => {
  const runtime = installRuntime();
  const page = openPage({ question: '这段什么意思', task: 'explain' });
  assert.equal(page.data.questionLabel, '问：这段什么意思');
  assert.equal(page.data.taskLabel, '解读');
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(runtime.calls.photos, 1);
  assert.equal(runtime.calls.prompts.length, 1);
  const content = runtime.calls.prompts[0][0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /这段什么意思/);
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(page.data.excerpt, 'We propose a new simple network architecture, the Transformer.');
  assert.equal(page.data.excerptClass, 'on');
  assert.match(page.data.explanation, /Transformer/);
  assert.equal(page.data.terms.length, 2);
  assert.equal(page.data.terms[0].name, 'attention');
  assert.equal(page.data.panelAnswer, 'on');
  assert.equal(page.data.panelCapture, '');
  assert.equal(page.data.pendingClass, '');
  assert.equal(page.data.turnCount, 1);
  assert.equal(runtime.calls.spoken.length, 1);
  assert.match(runtime.calls.spoken[0].text, /Transformer/);
  assert.equal(runtime.calls.spoken[0].mode, 'immediate');
  assert.match(page.data.notice, /已拍照/);
  page.onUnload();
  assert.equal(runtime.calls.destroyed, 1);
});

test('missing or malformed query falls back to the default question', async () => {
  installRuntime();
  const page = openPage(undefined);
  assert.equal(page.data.questionLabel, '问：解释我正在看的这一段');
  assert.equal(page.data.notice, '');
  await waitFor(() => page.data.phase === 'answered');
  page.onUnload();

  installRuntime();
  const malformed = openPage({ question: 12, task: 'nope' });
  assert.equal(malformed.data.questionLabel, '问：解释我正在看的这一段');
  assert.equal(malformed.data.notice, '没听清完整问题，先解读整段');
  await waitFor(() => malformed.data.phase === 'answered');
  malformed.onUnload();
});

test('auto capture that needs a gesture waits for a tap, then Enter captures once', async () => {
  const runtime = installRuntime({ photoError: new Error('takePhoto requires a user interaction') });
  const page = openPage({ question: '解释这段' });
  await waitFor(() => page.data.phase === 'ready' && page.data.captureTitle === '需要你按一下');
  assert.equal(runtime.calls.photos, 1);
  runtime.settings.photoError = null;
  const hook = keyEvent('GlobalHook');
  page.onKeyDown(hook);
  page.onKeyUp(hook);
  const enter = keyEvent('Enter');
  page.onKeyDown(enter);
  page.onKeyUp(enter);
  assert.equal(enter.prevented, true);
  await waitFor(() => page.data.phase === 'answered');
  await sleep(350);
  assert.equal(runtime.calls.photos, 2);
  assert.equal(runtime.calls.prompts.length, 1);
  page.onUnload();
});

test('a lone GlobalHook acts as one tap after the hold', async () => {
  const runtime = installRuntime({ photoError: new Error('user interaction required') });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'ready');
  runtime.settings.photoError = null;
  const hook = keyEvent('GlobalHook');
  page.onKeyDown(hook);
  page.onKeyUp(hook);
  assert.equal(page.data.phase, 'ready');
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(runtime.calls.photos, 2);
  page.onUnload();
});

test('camera denial offers the spoken fallback and answers from the transcript', async () => {
  const runtime = installRuntime({ photoError: new Error('NotAllowedError: permission denied') });
  const page = openPage({ question: '这个定理什么意思' });
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '相机权限被拒绝');
  assert.equal(page.data.hint, '单击 念出这段文字 由我来解读');
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(page.data.phase, 'listening');
  const recognition = runtime.calls.recognitions[0];
  assert.equal(recognition.started, 1);
  recognition.emit('for every epsilon there exists a delta', true);
  assert.equal(page.data.liveTranscript, 'for every epsilon there exists a delta');
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(recognition.stopped, 1);
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(runtime.calls.prompts.length, 0);
  assert.equal(runtime.calls.streams.length, 1);
  assert.match(runtime.calls.streams[0], /相机不可用/);
  assert.match(runtime.calls.streams[0], /for every epsilon/);
  assert.equal(page.data.explanation, '因为它把序列并行处理。');
  page.onUnload();
});

test('two opaque capture failures switch to the spoken fallback', async () => {
  const runtime = installRuntime({ photoError: new Error('needs user gesture') });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'ready');
  runtime.settings.photoError = new Error('failed Exception generated by QuickJS');
  page.onKeyUp(keyEvent('Enter'));
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '拍照失败');
  assert.equal(page.data.hint, '单击 重试');
  page.onKeyUp(keyEvent('Enter'));
  await waitFor(() => page.data.errorTitle === '相机连续失败');
  assert.equal(page.data.hint, '单击 念出这段文字 由我来解读');
  assert.equal(runtime.calls.photos, 3);
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(page.data.phase, 'listening');
  page.onUnload();
});

test('no camera capability at all goes straight to the spoken fallback', async () => {
  installRuntime({ cameraSupported: false });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '相机不可用');
  page.onUnload();
});

test('follow-up question streams into the answer and voice commands work', async () => {
  const runtime = installRuntime();
  const page = openPage({ question: '这段什么意思' });
  await waitFor(() => page.data.phase === 'answered');
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(page.data.phase, 'listening');
  assert.equal(page.data.panelListen, 'on');
  const recognition = runtime.calls.recognitions[0];
  recognition.emit('这个公式怎么推导的？', true);
  recognition.stop();
  await waitFor(() => page.data.phase === 'answered' && page.data.turnCount === 2);
  assert.equal(runtime.calls.streams[0], '这个公式怎么推导的');
  assert.equal(page.data.explanation, '因为它把序列并行处理。');
  assert.equal(page.data.excerpt, 'We propose a new simple network architecture, the Transformer.');
  assert.equal(runtime.calls.spoken.length, 2);

  page.onKeyUp(keyEvent('Enter'));
  runtime.calls.recognitions[1].emit('翻译一下', true);
  runtime.calls.recognitions[1].stop();
  await waitFor(() => page.data.turnCount === 3);
  assert.match(runtime.calls.streams[1], /逐句翻译/);

  page.onKeyUp(keyEvent('Enter'));
  runtime.calls.recognitions[2].emit('重拍', true);
  runtime.calls.recognitions[2].stop();
  await waitFor(() => page.data.turnCount === 4);
  assert.equal(runtime.calls.photos, 2);
  assert.equal(runtime.calls.prompts.length, 2);

  page.onKeyUp(keyEvent('Enter'));
  runtime.calls.recognitions[3].emit('结束', true);
  runtime.calls.recognitions[3].stop();
  await sleep(20);
  assert.equal(page.finishCalls, 1);
  page.onUnload();
});

test('empty transcript returns to the answer and ASR errors are recoverable', async () => {
  const runtime = installRuntime();
  const page = openPage({});
  await waitFor(() => page.data.phase === 'answered');
  page.onKeyUp(keyEvent('Enter'));
  runtime.calls.recognitions[0].stop();
  assert.equal(page.data.phase, 'answered');
  assert.equal(page.data.notice, '没听清，再试一次');
  page.onKeyUp(keyEvent('Enter'));
  runtime.calls.recognitions[1].fail('no-speech', 'No speech detected');
  assert.equal(page.data.phase, 'error');
  assert.equal(page.data.errorTitle, '没听清');
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(page.data.phase, 'listening');
  assert.equal(runtime.calls.recognitions.length, 3);
  page.onUnload();
  assert.equal(runtime.calls.recognitions[2].aborted, 1);
});

test('swipes page the answer and are ignored elsewhere', async () => {
  installRuntime();
  const page = openPage({});
  await waitFor(() => page.data.phase === 'answered');
  const up = keyEvent('ArrowUp');
  page.onKeyUp(up);
  assert.equal(up.prevented, true);
  assert.equal(page.data.scrollTop, 0);
  assert.equal(page.data.notice, '已经在最上面');
  const down = keyEvent('ArrowDown');
  page.onKeyUp(down);
  assert.equal(down.prevented, true);
  assert.equal(page.data.scrollTop, 120);
  page.onKeyUp(keyEvent('Enter'));
  assert.equal(page.data.phase, 'listening');
  const ignored = keyEvent('ArrowDown');
  page.onKeyUp(ignored);
  assert.equal(ignored.prevented, false);
  const back = keyEvent('Backspace');
  page.onKeyUp(back);
  assert.equal(back.prevented, false);
  page.onUnload();
});

test('model unavailable is an explicit error and Enter retries the same request', async () => {
  const runtime = installRuntime({ promptError: new Error('LanguageModel offline') });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'error');
  assert.equal(page.data.errorTitle, '解读失败');
  assert.equal(page.data.hint, '单击 重试');
  runtime.settings.promptError = null;
  page.onKeyUp(keyEvent('Enter'));
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(runtime.calls.photos, 1);
  assert.equal(runtime.calls.prompts.length, 2);
  page.onUnload();
});

test('hiding the page cancels the in-flight turn and stale results are ignored', async () => {
  const runtime = installRuntime();
  let release;
  runtime.session.prompt = () => new Promise((resolve) => {
    release = resolve;
  });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'reading');
  page.onHide();
  assert.equal(page.data.phase, 'ready');
  assert.equal(page.data.notice, '已中断');
  release('【解读】late answer');
  await sleep(20);
  assert.equal(page.data.phase, 'ready');
  assert.notEqual(page.data.explanation, 'late answer');
  page.onShow();
  page.onUnload();
});

test('keys are ignored while the page is hidden', async () => {
  const runtime = installRuntime({ photoError: new Error('needs user gesture') });
  const page = openPage({});
  await waitFor(() => page.data.phase === 'ready');
  page.onHide();
  runtime.settings.photoError = null;
  page.onKeyUp(keyEvent('Enter'));
  await sleep(20);
  assert.equal(runtime.calls.photos, 1);
  page.onShow();
  page.onKeyUp(keyEvent('Enter'));
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(runtime.calls.photos, 2);
  page.onUnload();
});

test('target changes are recorded and unparseable model text still renders', async () => {
  installRuntime({ imageReply: '看不清照片里的文字，请靠近一点。' });
  const page = openPage({});
  page.onTargetChanged('_blank', '_current');
  assert.equal(page.data.hostTarget, '_blank');
  await waitFor(() => page.data.phase === 'answered');
  assert.equal(page.data.explanation, '看不清照片里的文字，请靠近一点。');
  assert.equal(page.data.excerptClass, '');
  assert.deepEqual(page.data.terms, []);
  page.onUnload();
});
