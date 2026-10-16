'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCatalog, reapFromMap } = require('../lib/tab-catalog.js');

const gemini = 'https://gemini.google.com/app/f295ed7d0e3ee6e5';

test('debugger-only CDP row is not labeled incognito from browserContextId', () => {
  const cat = buildCatalog({
    focusedWindowId: 2,
    listTabsOk: true,
    chromeWindows: [{ windowId: 2, incognito: true }],
    chromeTabs: [
      { id: 20, windowId: 2, index: 0, title: 'Excalidraw', url: 'https://excalidraw.com/', incognito: true },
    ],
    cdpPages: [
      {
        sessionId: 's-ex',
        targetId: 't-ex',
        tabId: 20,
        browserContextId: 'ctx-incog',
        targetInfo: { type: 'page', title: 'Excalidraw', url: 'https://excalidraw.com/', browserContextId: 'ctx-incog' },
      },
      {
        sessionId: 's-ghost',
        targetId: 't-ghost',
        tabId: 0,
        browserContextId: 'ctx-incog',
        targetInfo: { type: 'page', title: 'ghost', url: 'https://example.test/', browserContextId: 'ctx-incog' },
      },
    ],
  });
  assert.equal(cat.windows[0].incognito, true);
  assert.equal(cat.attached.length, 1);
  assert.equal(cat.attached[0].incognito, undefined);
});

test('cookie store join does not mint incognito', () => {
  const cat = buildCatalog({
    focusedWindowId: 1,
    listTabsOk: true,
    cookieStores: [
      { id: 'store-norm', tabIds: [1] },
      { id: 'store-incog', tabIds: [2, 3] },
    ],
    chromeTabs: [
      { id: 1, windowId: 1, index: 0, title: 'a', url: 'https://vd7.io/', incognito: false },
      { id: 2, windowId: 3, index: 0, title: 'b', url: 'https://excalidraw.com/', incognito: true },
      { id: 3, windowId: 2, index: 0, title: 'c', url: 'https://example.test/', incognito: false },
    ],
    cdpPages: [],
  });
  const w2 = cat.windows.find((w) => w.windowId === 2);
  assert.equal(w2.incognito, false);
  assert.equal(w2.tabs[0].incognito, false);
});

test('window.incognito comes from chrome.windows; tab.incognito stays on the row', () => {
  const cat = buildCatalog({
    focusedWindowId: 2,
    listTabsOk: true,
    chromeWindows: [
      { windowId: 1, incognito: false },
      { windowId: 2, incognito: true },
    ],
    chromeTabs: [
      { id: 10, windowId: 1, index: 0, title: 'vd7', url: 'https://vd7.io/', incognito: false },
      { id: 20, windowId: 2, index: 0, title: 'Excalidraw Whiteboard', url: 'https://excalidraw.com/', incognito: true },
    ],
    cdpPages: [],
  });
  assert.equal(cat.windows[0].windowId, 2);
  assert.equal(cat.windows[0].incognito, true);
  assert.equal(cat.windows[0].tabs[0].incognito, true);
  assert.equal(cat.windows[1].incognito, false);
});

test('incognito falls back to tab.incognito when windows meta is missing', () => {
  const cat = buildCatalog({
    focusedWindowId: 9,
    listTabsOk: true,
    chromeTabs: [
      { id: 1, windowId: 9, index: 0, title: 'secret', url: 'https://example.test/', incognito: true },
    ],
    cdpPages: [],
  });
  assert.equal(cat.windows[0].incognito, true);
});

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

test('listTabs fail does not call chrome-missing CDP stale', () => {
  const cat = buildCatalog({
    focusedWindowId: 1,
    listTabsOk: false,
    chromeTabs: [],
    cdpPages: [
      { sessionId: 'ghost', targetId: 'tg', tabId: 99, targetInfo: { type: 'page', title: 'dead', url: 'https://github.com/' } },
    ],
  });
  assert.equal(cat.stale.length, 0);
  assert.equal(cat.attached.length, 1);
  assert.equal(cat.attached[0].sessionId, 'ghost');
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
