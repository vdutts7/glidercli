'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  pathTemplate,
  SiteExplorer,
  PATH_TEMPLATE_CAP,
  HYDRA_WIDTH,
  sameOriginUrl,
  createEnqueue,
  harDocumentUrls,
} = require('../lib/bexplore.js');

test('enableSession uses shared runnable gate before CDP domain enables', async () => {
  const explorer = new SiteExplorer({ sessionId: 'session-fresh', depth: 0 });
  const calls = [];
  explorer.sendWithRetry = async (method, params, options) => {
    calls.push({ method, params, options });
    return {};
  };
  explorer.send = async (method, params, options) => {
    calls.push({ method, params, options });
    return {};
  };

  await explorer.enableSession('session-fresh');

  assert.deepEqual(calls.map((call) => call.method).slice(0, 4), [
    'Emulation.setFocusEmulationEnabled',
    'Page.setWebLifecycleState',
    'Runtime.enable',
    'Page.enable',
  ]);
  assert.equal(calls[0].options.sessionId, 'session-fresh');
  assert.deepEqual(calls[1].params, { state: 'active' });
});

test('pinned exploration enables session through the shared gate', async () => {
  const explorer = new SiteExplorer({ sessionId: 'session-fresh', depth: 0 });
  const calls = [];
  explorer.fetchTargets = async () => [{
    sessionId: 'session-fresh',
    targetId: 'target-fresh',
    url: 'https://fixture.test/',
  }];
  explorer.send = async (method, params, options) => {
    calls.push({ method, params, options });
    return {};
  };
  explorer.sendWithRetry = explorer.send;

  await explorer.init();

  assert.equal(calls[0].method, 'Target.setAutoAttach');
  assert.equal(calls[1].method, 'Emulation.setFocusEmulationEnabled');
  assert.equal(calls[2].method, 'Page.setWebLifecycleState');
  assert.equal(calls[3].method, 'Runtime.enable');
  assert.equal(calls[1].options.sessionId, 'session-fresh');
  assert.deepEqual(calls[2].params, { state: 'active' });
});

test('same-origin enqueue keeps start host and drops CNN', () => {
  const seen = new Set();
  const q = [];
  const enqueue = createEnqueue({
    startOrigin: 'https://chatgpt.com',
    startHref: 'https://chatgpt.com/c/abc',
    templateHits: new Map(),
    cap: PATH_TEMPLATE_CAP,
    seen,
    push: (u) => q.push(u),
  });
  assert.equal(enqueue('https://chatgpt.com/c/abc'), true);
  assert.equal(enqueue('https://chatgpt.com/c/abc#frag'), false);
  assert.equal(enqueue('https://www.cnn.com/'), false);
  assert.equal(sameOriginUrl('https://www.cnn.com/', 'https://chatgpt.com', 'https://chatgpt.com/'), false);
  assert.deepEqual(q, ['https://chatgpt.com/c/abc']);
});

test('PATH_TEMPLATE_CAP is a runaway guard, not a visit of every uuid path', () => {
  const hits = new Map();
  const q = [];
  const enqueue = createEnqueue({
    startOrigin: 'https://example.com',
    startHref: 'https://example.com/',
    templateHits: hits,
    cap: 2,
    seen: new Set(),
    push: (u) => q.push(u),
  });
  assert.equal(enqueue('https://example.com/wiki/Alpha'), true);
  assert.equal(enqueue('https://example.com/wiki/Beta'), true);
  assert.equal(enqueue('https://example.com/wiki/Gamma'), false);
  assert.equal(pathTemplate('/wiki/Alpha'), '/wiki/{page}');
  assert.equal(q.length, 2);
});

test('HAR frontier is Document navigations only, not every XHR', () => {
  const reqs = [
    { url: 'https://example.com/a', type: 'XHR' },
    { url: 'https://example.com/page-2', type: 'Document' },
    { url: 'https://cdn.example.net/x.js', type: 'Script' },
  ];
  assert.deepEqual(harDocumentUrls(reqs, 0), ['https://example.com/page-2']);
  assert.deepEqual(harDocumentUrls(reqs, 2), []);
});

test('hydra tab cap stays 4', () => {
  assert.equal(HYDRA_WIDTH, 4);
});
