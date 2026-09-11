// Opt-in live test against the real vision relay. Skipped unless
// READOUBLE_VISION_KEY is set; the key is read from the environment only and
// is never written to disk by this test.
//
// By default it sends tests/fixtures/test-paper.jpg, a rendered paragraph with
// the made-up method name "LRW-7391" that no model can know from memory, and
// requires the reply to quote it. Override with READOUBLE_TEST_IMAGE and
// READOUBLE_TEST_EXPECT, and the model with READOUBLE_VISION_MODEL /
// READOUBLE_VISION_EFFORT (empty string = omit reasoning_effort).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import config from '../agent/config/vision.js';
import { callVision } from '../agent/lib/vision.js';
import { SYSTEM_PROMPT, buildImageInstruction, buildImageMessages, isNoImageReply, parseReply } from '../agent/lib/reply.js';
import { repoPath } from './helpers/load-page.js';

const key = process.env.READOUBLE_VISION_KEY || '';
const customImage = process.env.READOUBLE_TEST_IMAGE || '';
const imagePath = customImage || repoPath('tests', 'fixtures', 'test-paper.jpg');
const expected = process.env.READOUBLE_TEST_EXPECT || (customImage ? '' : 'LRW-7391');
const skip = key ? false : 'set READOUBLE_VISION_KEY to run the live relay test';

test('relay reads the text in a real photo', { skip, timeout: 240000 }, async () => {
  const model = process.env.READOUBLE_VISION_MODEL || config.model;
  const effort = process.env.READOUBLE_VISION_EFFORT === undefined ?
    config.reasoningEffort : process.env.READOUBLE_VISION_EFFORT;
  const cfg = { ...config, apiKey: key, model, reasoningEffort: effort, timeoutMs: 180000 };
  const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
  const dataUrl = 'data:' + mime + ';base64,' + fs.readFileSync(imagePath).toString('base64');
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...buildImageMessages(buildImageInstruction('这段在讲什么', 'explain'), dataUrl)
  ];
  const started = Date.now();
  const reply = await callVision(fetch, cfg, messages);
  const parsed = parseReply(reply);
  console.log('[relay] model=' + model + ' effort=' + (effort || '-') + ' ms=' + (Date.now() - started));
  console.log('[relay] no-image=' + isNoImageReply(reply));
  console.log('[relay] excerpt=' + parsed.excerpt);
  console.log('[relay] explanation=' + parsed.explanation);
  console.log('[relay] terms=' + parsed.terms.map((term) => term.name).join(' | '));
  assert.ok(!isNoImageReply(reply), model + ' says it cannot see the photo');
  if (expected) assert.ok(reply.includes(expected), model + ' did not quote ' + expected + ' from the photo');
});
