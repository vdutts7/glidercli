'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatCatalogTui, LIME, GREY, OTHER, DIM, YELLOW, GREEN, CURRENT, CYAN, MAGENTA, NC } = require('../lib/tab-tui.js');
const { createMockRelay, jsonFromStdout, runCli } = require('./helpers.js');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const catalog = {
  windows: [
    {
      windowId: 1,
      current: true,
      tabs: [
        {
          title: 'AR lane',
          url: 'https://claude.ai/chat/a',
          attached: true,
          sessionId: 's1',
          tabId: 20,
          active: true,
        },
        {
          title: 'DeepSeek',
          url: 'https://chat.deepseek.com/',
          attached: false,
          tabId: 21,
          active: false,
        },
      ],
    },
  ],
  attached: [],
  stale: [],
};

test('TUI: title, url, status under url; attached lime, not-attached light grey', () => {
  const out = formatCatalogTui(catalog, null);
  const plain = stripAnsi(out);
  assert.match(plain, /\[1\] AR lane\n      https:\/\/claude\.ai\/chat\/a\n      status: attached\n      tabId: 20  sessionId: s1  active: true/);
  assert.match(plain, /\[2\] DeepSeek\n      https:\/\/chat\.deepseek\.com\/\n      status: not attached\n      tabId: 21  sessionId: -  active: false/);
  assert.doesNotMatch(plain, /\[1\] AR lane attached/);
  assert.ok(out.includes(`${LIME}attached${NC}`));
  assert.ok(out.includes(`${GREY}not attached${NC}`));
  assert.equal(out.includes(`${DIM}not attached${NC}`), false);
  assert.ok(out.includes(`${DIM}https://chat.deepseek.com/${NC}`));
  assert.ok(out.includes(`${DIM}status:${NC}`));
  assert.match(plain, /window 1 \[current\]/);
  assert.doesNotMatch(plain, /window 1 \(current\)/);
  assert.ok(out.includes(`${CURRENT}[current]${NC}`));
  assert.equal(CURRENT, '\x1b[93m');
  assert.notEqual(CURRENT, CYAN);
  assert.notEqual(CURRENT, '\x1b[96m');
  assert.equal(LIME, '\x1b[92m');
  assert.equal(GREY, '\x1b[97m');
  assert.match(fs.readFileSync(require.resolve('../lib/tab-tui.js'), 'utf8'), /16-color SGR only/);
  assert.equal(/\x1b\[38;[52]/.test(out), false);
});

test('TUI: pin asterisk on active session; discarded token; url fallback title', () => {
  const out = formatCatalogTui({
    windows: [{
      windowId: 9,
      current: true,
      tabs: [
        { title: 'pinned', url: 'https://a.test/', attached: true, sessionId: 'pin-me', discarded: true },
        { url: 'https://b.test/no-title', attached: false },
      ],
    }],
    attached: [],
    stale: [],
  }, 'pin-me');
  const plain = stripAnsi(out);
  assert.match(plain, /\* \[1\] pinned/);
  assert.match(plain, /status: attached discarded/);
  assert.match(plain, /\[2\] https:\/\/b\.test\/no-title/);
  assert.ok(out.includes(`${GREEN}*${NC}`));
});

test('TUI: other+incognito window, debugger-only attached, stale', () => {
  const out = formatCatalogTui({
    windows: [{
      windowId: 2,
      current: false,
      incognito: true,
      tabs: [{ title: 'secret', url: 'https://x.test/', attached: false }],
    }],
    attached: [{ title: 'iframe', url: 'https://example.test/hidden', sessionId: 's-iframe' }],
    stale: [{ title: 'dead', url: 'https://github.com/', sessionId: 'ghost' }],
  }, null);
  const plain = stripAnsi(out);
  assert.match(plain, /window 2 \[other\] \[incognito\]/);
  assert.ok(out.includes(`${OTHER}[other]${NC}`));
  assert.ok(out.includes(`${MAGENTA}[incognito]${NC}`));
  assert.match(plain, /\[1\] secret\n      https:\/\/x\.test\/\n      status: not attached/);
  assert.match(plain, /\[A1\] iframe\n      https:\/\/example\.test\/hidden\n      status: attached/);
  assert.match(plain, /\[S1\] dead\n      https:\/\/github\.com\/\n      status: stale/);
  assert.ok(out.includes(`${YELLOW}stale${NC}`));
  assert.ok(out.includes(`${LIME}attached${NC}`));
});

test('glider tabs TUI prints status lines (not title suffix)', async (t) => {
  const relay = await createMockRelay({ catalog });
  t.after(() => relay.close());
  const result = await runCli(['tabs'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 0, result.stderr);
  const plain = stripAnsi(result.stdout);
  assert.match(plain, /status: attached/);
  assert.match(plain, /status: not attached/);
  assert.match(plain, /tabId: 20  sessionId: s1  active: true/);
  assert.match(plain, /tabId: 21  sessionId: -  active: false/);
  assert.doesNotMatch(plain, /\[1\] AR lane attached/);
});

test('TUI output passes /tui color-contrast (adjacent SGR, 16-color)', () => {
  const py = path.join(os.homedir(), '.cursor', 'tools', 'tui', 'color-contrast.py');
  assert.equal(fs.existsSync(py), true, 'color-contrast.py missing from tui stack');
  const sample = formatCatalogTui({
    windows: [
      { windowId: 1, current: true, tabs: catalog.windows[0].tabs },
      { windowId: 2, current: false, incognito: true, tabs: [{ title: 'x', url: 'https://x.test/', attached: false }] },
    ],
    attached: [],
    stale: [],
  }, null);
  const r = spawnSync('python3', [py, 'audit-text'], {
    input: sample,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('glider --json tabs still exposes attached boolean for scripts', async (t) => {
  const relay = await createMockRelay({ catalog });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'tabs'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 0, result.stderr);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.observation.windows[0].tabs[0].attached, true);
  assert.equal(body.observation.windows[0].tabs[1].attached, false);
  assert.equal(body.observation.windows[0].tabs[0].url, 'https://claude.ai/chat/a');
});
