import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUESTION,
  MAX_QUESTION_LENGTH,
  arrayBufferToBase64,
  buildImageMessages,
  classifyCameraError,
  classifyFollowUp,
  extractTranscript,
  hintFor,
  normalizeInput,
  parseReply,
  photoToDataUrl,
  spokenText,
  statusFor
} from '../agent/lib/reply.js';

test('normalizeInput keeps a valid question and task', () => {
  const input = normalizeInput({ question: ' 这个公式什么意思 ', task: 'translate' });
  assert.deepEqual(input, { question: '这个公式什么意思', task: 'translate', valid: true });
});

test('normalizeInput falls back for missing, malformed, and oversized input', () => {
  assert.deepEqual(normalizeInput(undefined), { question: DEFAULT_QUESTION, task: 'explain', valid: true });
  assert.deepEqual(normalizeInput(null), { question: DEFAULT_QUESTION, task: 'explain', valid: true });
  assert.equal(normalizeInput([1, 2]).question, DEFAULT_QUESTION);
  assert.equal(normalizeInput('text').valid, false);
  assert.equal(normalizeInput({ question: 42 }).question, DEFAULT_QUESTION);
  assert.equal(normalizeInput({ question: 42 }).valid, false);
  const long = normalizeInput({ question: '问'.repeat(MAX_QUESTION_LENGTH + 5), task: 'bogus' });
  assert.equal(Array.from(long.question).length, MAX_QUESTION_LENGTH);
  assert.equal(long.task, 'explain');
  assert.equal(long.valid, false);
  assert.equal(normalizeInput({ question: '   ' }).question, DEFAULT_QUESTION);
});

test('parseReply splits the three sections and up to three terms', () => {
  const parsed = parseReply(
    '【原文】We propose the Transformer.\n【解读】这段提出了 Transformer。\n【术语】attention：注意力机制\n2. recurrence：循环结构\n- self-attention: 自注意力\nextra：多余的第四个'
  );
  assert.equal(parsed.excerpt, 'We propose the Transformer.');
  assert.equal(parsed.explanation, '这段提出了 Transformer。');
  assert.deepEqual(parsed.terms.map((t) => [t.name, t.meaning]), [
    ['attention', '注意力机制'],
    ['recurrence', '循环结构'],
    ['self-attention', '自注意力']
  ]);
  assert.deepEqual(parsed.terms.map((t) => t.k), ['t0', 't1', 't2']);
});

test('parseReply degrades gracefully without markers or with "无" terms', () => {
  assert.deepEqual(parseReply('照片太模糊，看不清文字，请靠近一些。'), {
    excerpt: '',
    explanation: '照片太模糊，看不清文字，请靠近一些。',
    terms: []
  });
  const noTerms = parseReply('【解读】看不清。【术语】无');
  assert.equal(noTerms.explanation, '看不清。');
  assert.deepEqual(noTerms.terms, []);
  assert.deepEqual(parseReply(''), { excerpt: '', explanation: '', terms: [] });
  assert.deepEqual(parseReply(undefined), { excerpt: '', explanation: '', terms: [] });
  const leading = parseReply('好的。【术语】x：y');
  assert.equal(leading.explanation, '好的。');
});

test('classifyFollowUp recognizes local commands before model questions', () => {
  assert.equal(classifyFollowUp('重拍一下。').kind, 'recapture');
  assert.equal(classifyFollowUp('结束').kind, 'finish');
  assert.equal(classifyFollowUp('翻译一下').kind, 'translate');
  assert.equal(classifyFollowUp('总结一下').kind, 'summarize');
  assert.equal(classifyFollowUp('   ').kind, 'empty');
  const question = classifyFollowUp('这个公式是怎么推导的？');
  assert.equal(question.kind, 'question');
  assert.equal(question.text, '这个公式是怎么推导的');
  assert.equal(classifyFollowUp('翻译这个公式的推导过程').kind, 'question');
});

test('spokenText prefers the explanation and caps the length', () => {
  assert.equal(spokenText({ explanation: '解释。' }, 'fallback'), '解释。');
  assert.equal(spokenText({ explanation: '' }, 'fallback text'), 'fallback text');
  assert.equal(Array.from(spokenText({ explanation: '字'.repeat(400) }, '')).length, 240);
});

test('classifyCameraError maps denial, unavailability, and gesture requirements', () => {
  assert.equal(classifyCameraError(new Error('NotAllowedError: Permission denied')), 'denied');
  assert.equal(classifyCameraError({ errMsg: 'camera unavailable' }), 'unavailable');
  assert.equal(classifyCameraError(new Error('requires a user interaction')), 'needs-gesture');
  assert.equal(classifyCameraError(new Error('boom')), 'failed');
});

test('base64 encoder matches Node for every padding length', () => {
  for (const bytes of [[], [1], [1, 2], [1, 2, 3], [255, 216, 255, 224, 0, 16]]) {
    const buffer = new Uint8Array(bytes).buffer;
    assert.equal(arrayBufferToBase64(buffer), Buffer.from(bytes).toString('base64'));
  }
  const big = new Uint8Array(10000).map((_, i) => i % 251);
  assert.equal(arrayBufferToBase64(big), Buffer.from(big).toString('base64'));
});

test('photoToDataUrl accepts wx results and Blobs and rejects empty data', async () => {
  const wxPhoto = { data: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/webp' };
  const encoded = await photoToDataUrl(wxPhoto);
  assert.equal(encoded.dataUrl, 'data:image/webp;base64,AQID');
  assert.equal(encoded.byteLength, 3);
  const blob = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' });
  const fromBlob = await photoToDataUrl(blob, (buffer) => Buffer.from(buffer).toString('base64'));
  assert.equal(fromBlob.dataUrl, 'data:image/jpeg;base64,BAUG');
  await assert.rejects(photoToDataUrl({ data: new ArrayBuffer(0), mimeType: 'image/jpeg' }));
  await assert.rejects(photoToDataUrl(null));
  const untyped = await photoToDataUrl({ data: new Uint8Array([7]).buffer });
  assert.match(untyped.dataUrl, /^data:image\/jpeg;base64,/);
});

test('buildImageMessages uses the chat-sample multimodal shape', () => {
  const messages = buildImageMessages('说明', 'data:image/jpeg;base64,AA==');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.deepEqual(messages[0].content[0], { type: 'text', text: '说明' });
  assert.deepEqual(messages[0].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } });
});

test('extractTranscript joins results and reports finality', () => {
  assert.deepEqual(extractTranscript(null), { transcript: '', hasFinal: false });
  const event = { results: [Object.assign([{ transcript: '这段 ' }], { isFinal: true }), Object.assign([{ transcript: '什么意思' }], { isFinal: false })] };
  assert.deepEqual(extractTranscript(event), { transcript: '这段 什么意思', hasFinal: true });
});

test('every phase has a status and a hint', () => {
  for (const phase of ['capturing', 'ready', 'reading', 'answered', 'listening', 'error']) {
    assert.ok(statusFor(phase).label);
    assert.ok(statusFor(phase).glyph);
    assert.ok(hintFor(phase, 'llm'));
  }
  assert.equal(hintFor('error', 'camera'), '单击 念出这段文字 由我来解读');
  assert.equal(statusFor('bogus').label, 'ERROR');
});
