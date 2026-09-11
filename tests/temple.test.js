import test from 'node:test';
import assert from 'node:assert/strict';
import { GESTURE_ECHO_MS, GLOBAL_HOOK_HOLD_MS, createTempleInput } from '../agent/lib/temple.js';

function harness() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const fired = [];
  const input = createTempleInput({
    now: () => time,
    schedule: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    cancel: (id) => timers.delete(id),
    onLoneGlobalHook: () => fired.push(time)
  });
  return {
    input,
    fired,
    timers,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
    }
  };
}

test('simulator order GlobalHook then gesture key yields no extra tap', () => {
  const h = harness();
  assert.equal(h.input.globalHookUp(), true);
  h.advance(1);
  h.input.gestureKeyDown();
  h.advance(1);
  h.input.gestureKeyUp();
  h.advance(1000);
  assert.deepEqual(h.fired, []);
  assert.equal(h.input.isPending(), false);
});

test('a lone GlobalHook becomes exactly one tap after the hold', () => {
  const h = harness();
  h.input.globalHookUp();
  h.advance(GLOBAL_HOOK_HOLD_MS - 1);
  assert.deepEqual(h.fired, []);
  h.advance(1);
  assert.deepEqual(h.fired, [GLOBAL_HOOK_HOLD_MS]);
  h.advance(1000);
  assert.equal(h.fired.length, 1);
});

test('GlobalHook echoing a gesture key is ignored', () => {
  const h = harness();
  h.input.gestureKeyUp();
  h.advance(GESTURE_ECHO_MS - 1);
  assert.equal(h.input.globalHookUp(), false);
  h.advance(1000);
  assert.deepEqual(h.fired, []);
});

test('GlobalHook after the echo window counts as a new tap', () => {
  const h = harness();
  h.input.gestureKeyUp();
  h.advance(GESTURE_ECHO_MS);
  assert.equal(h.input.globalHookUp(), true);
  h.advance(GLOBAL_HOOK_HOLD_MS);
  assert.equal(h.fired.length, 1);
});

test('rapid lone GlobalHooks collapse into one tap and dispose cancels', () => {
  const h = harness();
  h.input.globalHookUp();
  h.advance(100);
  h.input.globalHookUp();
  h.advance(GLOBAL_HOOK_HOLD_MS);
  assert.equal(h.fired.length, 1);
  h.input.globalHookUp();
  h.input.dispose();
  h.advance(1000);
  assert.equal(h.fired.length, 1);
  assert.equal(h.timers.size, 0);
});
