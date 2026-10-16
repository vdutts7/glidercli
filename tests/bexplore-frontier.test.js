'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  pathTemplate,
  PATH_TEMPLATE_CAP,
  HYDRA_WIDTH,
  sameOriginUrl,
  createEnqueue,
  harDocumentUrls,
} = require('../lib/bexplore.js');

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
