'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatCatalogTui } = require('../lib/tab-tui.js');
const { createMockRelay, runCli } = require('./helpers.js');

const CSI = /\x1b\[([0-9;]*)m/g;
const LABEL = [2];
const ID = [96];
const URL = [94];
const LIME = [92];
const WHITE = [97];
const VALUE = [33];
const CURRENT = [93];
const OTHER = [90];
const INCOGNITO = [95];
const COUNT = [32];
const STALE = [33];
const FIELD = new Set([
  'window', 'windowId:', 'current:', 'focused:', 'incognito:', 'incognitoSource:',
  'type:', 'state:', 'alwaysOnTop:', 'handle:', 'kind:', 'index:', 'tabId:', 'title:', 'url:',
  'status:', 'load:', 'active:', 'highlighted:', 'pinned:', 'discarded:',
  'attached:', 'audible:', 'muted:', 'mutedReason:', 'mutedExtensionId:', 'autoDiscardable:', 'groupId:',
  'openerTabId:', 'pendingUrl:', 'favIconUrl:', 'frozen:', 'lastAccessed:',
  'width:', 'height:', 'left:', 'top:', 'chromeSessionId:', 'successorTabId:', 'splitViewId:',
  'selected:', 'sessionId:', 'targetId:', 'targetType:', 'subtype:', 'browserContextId:',
  'openerId:', 'openerFrameId:', 'parentFrameId:', 'canAccessOpener:', 'cdpAttached:',
  'parent_sessionId:', 'parent_targetId:', 'reason:',
]);

const catalog = {
  windows: [
    {
      windowId: 100387398,
      current: true,
      tabs: [
        {
          title: "AR's lane, diagram, etc - Claude",
          url: 'https://claude.ai/chat/314a2963-b311-4d8c-a992-95a2e5a0309a',
          attached: false,
          tabId: 100387399,
          active: false,
        },
        {
          title: 'Lumo: Privacy-first AI assistant where chats stay confidential',
          url: 'https://lumo.proton.me/u/0/c/f772ae24-ba30-4b2e-bf05-f49b3a80304c',
          attached: true,
          sessionId: 'session-33',
          tabId: 100387514,
          active: false,
        },
        {
          title: 'New Tab',
          url: 'chrome://newtab/',
          attached: false,
          tabId: 100387517,
          active: true,
        },
      ],
    },
    {
      windowId: 2,
      current: false,
      incognito: true,
      tabs: [{ title: 'secret', url: 'https://x.test/', attached: false, tabId: 9, active: false }],
    },
  ],
  attached: [{ title: 'iframe', url: 'https://example.test/hidden', sessionId: 's-iframe' }],
  stale: [{ title: 'dead', url: 'https://github.com/', sessionId: 'ghost' }],
};

function spans(line) {
  const out = [];
  let fg = [];
  let pos = 0;
  CSI.lastIndex = 0;
  let m;
  const re = /\x1b\[([0-9;]*)m/g;
  while ((m = re.exec(line))) {
    const chunk = line.slice(pos, m.index);
    if (chunk.trim()) out.push({ sgr: [...fg], text: chunk.trim() });
    const codes = m[1] ? m[1].split(';').filter(Boolean).map(Number) : [0];
    if (codes.includes(0)) fg = [];
    else {
      for (const c of codes) {
        if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
          fg = fg.filter((x) => !((x >= 30 && x <= 37) || (x >= 90 && x <= 97)));
        }
        fg.push(c);
      }
    }
    pos = m.index + m[0].length;
  }
  const tail = line.slice(pos);
  if (tail.trim()) out.push({ sgr: [...fg], text: tail.trim() });
  return out;
}

function eq(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function assertRoles(ansi, where) {
  assert.equal(/\x1b\[38;[52]/.test(ansi), false, `${where}: 256/truecolor`);
  const lines = ansi.split('\n');
  let sawUrl = 0;
  let sawLabel = 0;
  for (const line of lines) {
    for (const sp of spans(line)) {
      if (FIELD.has(sp.text)) {
        sawLabel += 1;
        assert.ok(eq(sp.sgr, LABEL), `${where}: field ${sp.text} sgr=${sp.sgr} want ${LABEL}`);
      }
      if (sp.text.startsWith('https://') || sp.text.startsWith('chrome://')) {
        sawUrl += 1;
        assert.ok(eq(sp.sgr, URL), `${where}: URL is a value sgr=${sp.sgr} want ${URL} text=${sp.text}`);
        assert.equal(eq(sp.sgr, LABEL), false, `${where}: URL must not share field dim`);
      }
      if (sp.text === '[current]') assert.ok(eq(sp.sgr, CURRENT), `${where}: [current] ${sp.sgr}`);
      if (sp.text === '[other]') assert.ok(eq(sp.sgr, OTHER), `${where}: [other] ${sp.sgr}`);
      if (sp.text === '[incognito]') assert.ok(eq(sp.sgr, INCOGNITO), `${where}: [incognito] ${sp.sgr}`);
      if (sp.text === 'not attached') assert.ok(eq(sp.sgr, VALUE), `${where}: not attached ${sp.sgr}`);
      if (sp.text === 'true') {
        const ok = eq(sp.sgr, LIME) || eq(sp.sgr, CURRENT) || eq(sp.sgr, INCOGNITO);
        assert.ok(ok, `${where}: true sgr=${sp.sgr}`);
      }
      if (sp.text === 'false') assert.ok(eq(sp.sgr, VALUE), `${where}: false ${sp.sgr}`);
      if (/^\[\d+\]$/.test(sp.text) || /^\[A\d+\]$/.test(sp.text) || /^\[S\d+\]$/.test(sp.text) || /^\[I\d+\]$/.test(sp.text) || /^\[O\d+\]$/.test(sp.text)) {
        assert.ok(eq(sp.sgr, ID), `${where}: index ${sp.text} ${sp.sgr}`);
      }
      if (/^\d+$/.test(sp.text) && sp.text.length >= 1) {
        /* count "3" or windowId or tabId */
        const ok = eq(sp.sgr, COUNT) || eq(sp.sgr, ID);
        assert.ok(ok, `${where}: numeric ${sp.text} sgr=${sp.sgr}`);
      }
    }
  }
  assert.ok(sawUrl >= 3, `${where}: expected URL values, got ${sawUrl}`);
  assert.ok(sawLabel >= 20, `${where}: expected field labels, got ${sawLabel}`);
  const plain = ansi.replace(/\x1b\[[0-9;]*m/g, '');
  for (const line of plain.split('\n')) {
    const keys = line.match(/(?:^|\s)(?:windowId|current|focused|incognito|incognitoSource|type|state|alwaysOnTop|handle|kind|index|tabId|title|url|status|load|active|highlighted|pinned|discarded|attached|audible|muted|mutedReason|mutedExtensionId|autoDiscardable|groupId|openerTabId|pendingUrl|favIconUrl|frozen|lastAccessed|width|height|left|top|chromeSessionId|successorTabId|splitViewId|selected|sessionId|targetId|targetType|subtype|browserContextId|openerId|openerFrameId|parentFrameId|canAccessOpener|cdpAttached|parent_sessionId|parent_targetId|reason):/g);
    assert.ok(!keys || keys.length <= 1, `${where}: packed fields: ${line}`);
  }
}

function contrast(ansi) {
  const py = path.join(os.homedir(), '.cursor', 'tools', 'tui', 'color-contrast.py');
  assert.equal(fs.existsSync(py), true, 'color-contrast.py missing');
  const r = spawnSync('python3', [py, 'audit-text'], { input: ansi, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

test('regression: formatCatalogTui field vs value SGR (screenshot catalog)', () => {
  const ansi = formatCatalogTui(catalog, 'session-33');
  assertRoles(ansi, 'formatCatalogTui');
  contrast(ansi);
  const winId = ansi.split('\n').find((l) => /windowId:/.test(l) && l.includes('100387398'));
  const winSpans = spans(winId);
  assert.ok(eq(winSpans[0].sgr, LABEL) && winSpans[0].text === 'windowId:');
  assert.ok(eq(winSpans[1].sgr, ID) && winSpans[1].text === '100387398');
});

test('regression: glider tabs CLI SGR matches formatCatalogTui', async (t) => {
  const relay = await createMockRelay({ catalog });
  t.after(() => relay.close());
  const result = await runCli(['tabs'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 0, result.stderr);
  assertRoles(result.stdout, 'glider tabs');
  contrast(result.stdout);
});
