'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  thawCdpCalls,
  ensureSessionRunnable,
  waitForTargetSession,
  isLifecycleMethod,
} = require('../lib/session-runnable.js');

test('thawCdpCalls emits focus + active lifecycle for a session', () => {
  const calls = thawCdpCalls('session-1');
  assert.deepEqual(calls, [
    {
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
      sessionId: 'session-1',
    },
    {
      method: 'Page.setWebLifecycleState',
      params: { state: 'active' },
      sessionId: 'session-1',
    },
  ]);
  assert.equal(isLifecycleMethod('Emulation.setFocusEmulationEnabled'), true);
  assert.equal(isLifecycleMethod('Runtime.evaluate'), false);
});

test('ensureSessionRunnable sends shared thaw steps via send()', async () => {
  const sent = [];
  const result = await ensureSessionRunnable({
    sessionId: 'sid-a',
    send: async (call) => { sent.push(call); return {}; },
  });
  assert.equal(result.thawed, true);
  assert.equal(result.sessionId, 'sid-a');
  assert.deepEqual(sent.map((c) => c.method), [
    'Emulation.setFocusEmulationEnabled',
    'Page.setWebLifecycleState',
  ]);
});

test('waitForTargetSession polls until sessionId appears (no fixed sleep)', async () => {
  let ticks = 0;
  const sleeps = [];
  const sessionId = await waitForTargetSession({
    targetId: 't-1',
    timeoutMs: 1000,
    intervalMs: 10,
    now: () => { ticks += 1; return ticks * 10; },
    sleep: async (ms) => { sleeps.push(ms); },
    listTargets: async () => {
      if (sleeps.length < 2) return [{ targetId: 't-1' }];
      return [{ targetId: 't-1', sessionId: 'session-ready' }];
    },
  });
  assert.equal(sessionId, 'session-ready');
  assert.ok(sleeps.length >= 2);
  assert.ok(sleeps.every((ms) => ms === 10));
});

test('waitForTargetSession returns null on timeout', async () => {
  const sessionId = await waitForTargetSession({
    targetId: 'missing',
    timeoutMs: 30,
    intervalMs: 10,
    now: (() => {
      let t = 0;
      return () => { t += 15; return t; };
    })(),
    sleep: async () => {},
    listTargets: async () => [{ targetId: 'other', sessionId: 'x' }],
  });
  assert.equal(sessionId, null);
});
