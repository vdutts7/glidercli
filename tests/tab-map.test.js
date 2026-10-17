'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { buildMap, resolveRef, resolveChain, lookslikeHandle } = require('../lib/tab-map.js');
const { createMockRelay, makeTempGliderHome, removeTree, runCli, jsonFromStdout } = require('./helpers.js');

const catalog = {
  windows: [{
    windowId: 1,
    current: true,
    tabs: [
      { tabId: 20, sessionId: 's1', title: 'A', url: 'https://a.test/', attached: true, active: true },
      { tabId: 21, title: 'B', url: 'https://b.test/', attached: false, active: false },
    ],
  }],
  attached: [{ sessionId: 's-iframe', title: 'ifr', url: 'https://i.test/' }],
  stale: [{ sessionId: 'ghost', title: 'dead', url: 'https://g.test/' }],
};

test('map handles 1..n then A then S', () => {
  const map = buildMap(catalog);
  assert.equal(map.handles['1'].tabId, 20);
  assert.equal(map.handles['1'].sessionId, 's1');
  assert.equal(map.handles['2'].tabId, 21);
  assert.equal(map.handles['2'].sessionId, '');
  assert.equal(map.handles.A1.sessionId, 's-iframe');
  assert.equal(map.handles.S1.sessionId, 'ghost');
  assert.equal(resolveRef({ handle: '1', map }).row.sessionId, 's1');
  assert.equal(resolveRef({ tabId: 20, map }).via, 'tab');
  assert.equal(resolveRef({ sessionId: 's1', map }).row.handle, '1');
  assert.equal(lookslikeHandle('1'), true);
  assert.equal(lookslikeHandle('A1'), true);
  assert.equal(lookslikeHandle('session-1'), false);
  assert.equal(lookslikeHandle('I1'), true);
});

test('glider tabs writes map; glider use 1 pins that session', async (t) => {
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  const relay = await createMockRelay({
    catalog,
    targets: [{
      sessionId: 's1',
      targetId: 't1',
      targetInfo: { targetId: 't1', type: 'page', title: 'A', url: 'https://a.test/' },
    }],
  });
  t.after(() => relay.close());
  const env = { GLIDER: home, GLIDER_PORT: String(relay.port) };
  const listed = await runCli(['tabs'], { env });
  assert.equal(listed.code, 0, listed.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'state', 'tab-map.json'), 'utf8'));
  assert.equal(saved.handles['1'].sessionId, 's1');
  const used = await runCli(['--json', 'use', '1'], { env });
  assert.equal(used.code, 0, used.stderr);
  const body = jsonFromStdout(used.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.observation.sessionId, 's1');
});

test('resolveChain is window>handle>tab>session; inner must belong to outer', () => {
  const map = buildMap({
    windows: [
      {
        windowId: 1,
        tabs: [
          { tabId: 20, sessionId: 's1', title: 'A', url: 'https://a.test/', attached: true, active: true },
          { tabId: 21, title: 'B', url: 'https://b.test/', attached: false, active: false },
        ],
      },
      {
        windowId: 2,
        tabs: [
          { tabId: 99, sessionId: 's9', title: 'C', url: 'https://c.test/', attached: true, active: true },
        ],
      },
    ],
    attached: [],
    stale: [],
  });
  assert.equal(resolveChain({ windowId: 1, tabId: 20, sessionId: 's1', map }).via, 'window>tab>session');
  assert.equal(resolveChain({ windowId: 1, map }).row.sessionId, 's1');
  assert.equal(resolveChain({ windowId: 1, map }).via, 'window>active');
  assert.equal(resolveChain({ windowId: 1, tabId: 99, map }).error, 'tab');
  assert.equal(resolveChain({ windowId: 2, sessionId: 's1', map }).error, 'session');
  assert.equal(resolveChain({ windowId: 1, handle: '1', tabId: 20, map }).via, 'window>handle>tab');
});

test('resolveChain current/incognito/index/target/iframe', () => {
  const map = buildMap({
    windows: [{
      windowId: 1,
      current: true,
      incognito: true,
      tabs: [
        {
          tabId: 20, sessionId: 's1', targetId: 't1', index: 0, title: 'A', url: 'https://a.test/',
          attached: true, active: true, incognito: true, browserContextId: 'ctx-1',
        },
        {
          tabId: 21, index: 1, title: 'B', url: 'https://b.test/', attached: false, active: false, incognito: true,
        },
      ],
    }],
    attached: [],
    stale: [],
    iframes: [{ sessionId: 's-ifr', targetId: 't-ifr', url: 'https://i.test/', parent_sessionId: 's1' }],
  });
  assert.equal(resolveChain({ current: true, map }).row.sessionId, 's1');
  assert.equal(resolveChain({ incognito: true, index: 0, map }).via, 'incognito>index');
  assert.equal(resolveChain({ targetId: 't1', map }).via, 'target');
  assert.equal(resolveChain({ iframe: true, map }).row.handle, 'I1');
  assert.equal(resolveChain({ browserContextId: 'ctx-1', map }).via, 'context');
});

test('glider use --tab 20 pins by chrome tabId', async (t) => {
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  const relay = await createMockRelay({
    catalog,
    targets: [{
      sessionId: 's1',
      targetId: 't1',
      targetInfo: { targetId: 't1', type: 'page', title: 'A', url: 'https://a.test/' },
    }],
  });
  t.after(() => relay.close());
  const env = { GLIDER: home, GLIDER_PORT: String(relay.port) };
  await runCli(['tabs'], { env });
  const used = await runCli(['--json', 'use', '--tab', '20'], { env });
  assert.equal(used.code, 0, used.stderr);
  assert.equal(jsonFromStdout(used.stdout).observation.sessionId, 's1');
});

test('glider --window --tab chain pins; mismatch fails', async (t) => {
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  const catalog2 = {
    windows: [
      {
        windowId: 1,
        current: true,
        tabs: [
          { tabId: 20, sessionId: 's1', title: 'A', url: 'https://a.test/', attached: true, active: true },
          { tabId: 21, title: 'B', url: 'https://b.test/', attached: false, active: false },
        ],
      },
      {
        windowId: 2,
        tabs: [
          { tabId: 99, sessionId: 's9', title: 'C', url: 'https://c.test/', attached: true, active: true },
        ],
      },
    ],
    attached: [],
    stale: [],
  };
  const relay = await createMockRelay({
    catalog: catalog2,
    targets: [{
      sessionId: 's1',
      targetId: 't1',
      targetInfo: { targetId: 't1', type: 'page', title: 'A', url: 'https://a.test/' },
    }],
  });
  t.after(() => relay.close());
  const env = { GLIDER: home, GLIDER_PORT: String(relay.port) };
  await runCli(['tabs'], { env });
  const used = await runCli(['--json', '--window', '1', '--tab', '20', 'use'], { env });
  assert.equal(used.code, 0, used.stderr);
  assert.equal(jsonFromStdout(used.stdout).observation.sessionId, 's1');
  const bad = await runCli(['--json', '--window', '2', '--tab', '20', 'use'], { env });
  assert.notEqual(bad.code, 0);
});

test('godelify glider-cli-tab-map gate exits 0 on this tree', () => {
  const gate = path.join(os.homedir(), '.cursor', 'tools', 'test', 'glider-cli-tab-map.gate.sh');
  assert.equal(fs.existsSync(gate), true);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(gate, {
    encoding: 'utf8',
    env: { ...process.env, GLIDERCLI: path.join(__dirname, '..') },
  });
  assert.equal(r.status, 0, r.stderr);
});
