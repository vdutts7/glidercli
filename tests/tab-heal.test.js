'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMockRelay,
  jsonFromStdout,
  runCli,
} = require('./helpers.js');

test('glider tabs --json prints windows then attached then stale; never /targets dump', async (t) => {
  const relay = await createMockRelay({
    catalog: {
      focusedWindowId: 2,
      listTabsOk: true,
      windows: [
        {
          windowId: 2,
          current: true,
          tabs: [{
            tabId: 20,
            windowId: 2,
            index: 0,
            title: 'clawd-probe-canon',
            url: 'https://claude.ai/chat/a',
            attached: true,
            sessionId: 's-claude',
            targetId: 't-claude',
          }],
        },
      ],
      attached: [{
        tabId: 0,
        sessionId: 's-iframe',
        title: 'debugger-only',
        url: 'https://example.test/hidden',
      }],
      stale: [{
        tabId: 99,
        sessionId: 'ghost',
        title: 'dead',
        url: 'https://github.com/',
        reason: 'tab_gone',
      }],
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'tabs'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 0, result.stderr);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.observation.windows[0].current, true);
  assert.equal(body.observation.windows[0].tabs[0].title, 'clawd-probe-canon');
  assert.equal(body.observation.attached[0].sessionId, 's-iframe');
  assert.equal(body.observation.stale[0].sessionId, 'ghost');
  assert.equal(body.observation.fallback, undefined);
});

test('glider tabs fails when catalog is missing; does not print CDP pages as tabs', async (t) => {
  const relay = await createMockRelay({ catalog: null });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'tabs'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 1, result.stdout);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, false);
  assert.match(body.error, /catalog unavailable/);
  assert.equal(body.observation, null);
});

test('heal recycles advertised-missing catalog when status.catalog is false on our binary skip', async (t) => {
  const relay = await createMockRelay({
    status: {
      extension: true,
      extensionWorkerAlive: true,
      extensionGeneration: 1,
      targets: 1,
      clients: 0,
      catalog: true,
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'heal'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 0, result.stderr);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.observation.actions.some((a) => a.step === 'recycle_relay'), false);
});
