'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCatalog, reapFromMap } = require('../lib/tab-catalog.js');

const gemini = 'https://gemini.google.com/app/f295ed7d0e3ee6e5';

test('current window first; chrome titles win; New Tab included', () => {
  const cat = buildCatalog({
    focusedWindowId: 2,
    listTabsOk: true,
    chromeTabs: [
      { id: 10, windowId: 1, index: 0, title: 'vd7', url: 'https://vd7.io/' },
      { id: 20, windowId: 2, index: 0, title: 'clawd-probe-canon', url: 'https://claude.ai/chat/a' },
      { id: 21, windowId: 2, index: 1, title: 'New Tab', url: 'chrome://newtab/' },
    ],
    cdpPages: [
      {
        sessionId: 's-claude',
        targetId: 't-claude',
        tabId: 20,
        targetInfo: { type: 'page', title: 'Greeting - Claude', url: 'https://claude.ai/chat/a' },
      },
    ],
  });
  assert.equal(cat.windows[0].windowId, 2);
  assert.equal(cat.windows[0].current, true);
  assert.equal(cat.windows[0].tabs[0].title, 'clawd-probe-canon');
  assert.equal(cat.windows[0].tabs[0].attached, true);
  assert.equal(cat.windows[0].tabs[1].url, 'chrome://newtab/');
  assert.equal(cat.windows[0].tabs[1].attached, false);
  assert.equal(cat.windows[1].windowId, 1);
});

test('duplicate URL is two tabIds', () => {
  const cat = buildCatalog({
    focusedWindowId: 1,
    listTabsOk: true,
    chromeTabs: [
      { id: 1, windowId: 1, index: 0, title: 'Whirlpool A', url: gemini },
      { id: 2, windowId: 1, index: 1, title: 'Whirlpool B', url: gemini },
    ],
    cdpPages: [
      { sessionId: 's1', targetId: 't1', tabId: 1, targetInfo: { type: 'page', title: 'G', url: gemini } },
      { sessionId: 's2', targetId: 't2', tabId: 2, targetInfo: { type: 'page', title: 'G', url: gemini } },
    ],
  });
  assert.equal(cat.windows[0].tabs.length, 2);
  assert.equal(cat.windows[0].tabs[0].sessionId, 's1');
  assert.equal(cat.windows[0].tabs[1].sessionId, 's2');
  assert.equal(cat.stale.length, 0);
});

test('CDP tabId not in chrome.tabs is stale and reaped; missing tabId stays attached', () => {
  const cat = buildCatalog({
    focusedWindowId: 1,
    listTabsOk: true,
    chromeTabs: [{ id: 5, windowId: 1, index: 0, title: 'live', url: 'https://vd7.io/' }],
    cdpPages: [
      { sessionId: 'ghost', targetId: 'tg', tabId: 99, targetInfo: { type: 'page', title: 'dead', url: 'https://github.com/' } },
      { sessionId: 'old', targetId: 'to', targetInfo: { type: 'page', title: 'no-tabid', url: 'https://codeberg.org/' } },
    ],
  });
  assert.equal(cat.stale.length, 1);
  assert.equal(cat.stale[0].sessionId, 'ghost');
  assert.deepEqual(cat.reapSessionIds, ['ghost']);
  assert.equal(cat.attached.length, 1);
  assert.equal(cat.attached[0].sessionId, 'old');
});

test('reapFromMap drops only named sessions', () => {
  const m = new Map([
    ['a', { sessionId: 'a' }],
    ['b', { sessionId: 'b' }],
  ]);
  assert.deepEqual(reapFromMap(m, ['b']), ['b']);
  assert.equal(m.has('a'), true);
  assert.equal(m.has('b'), false);
});
