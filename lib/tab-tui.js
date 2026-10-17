'use strict';

// 16-color SGR only. Roles: $CURREGISTRY/tui/color-differential.yaml
// labels dim; ids input cyan 96; status values by role; no 38;5 / 38;2
const NC = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[96m';
const LIME = '\x1b[92m';
const WHITE = '\x1b[97m';
const GREY = WHITE;
const OTHER = '\x1b[90m';
const CURRENT = '\x1b[93m';
const MAGENTA = '\x1b[95m';
const BLUE = '\x1b[94m';

function lab(s) {
  return `${DIM}${s}${NC}`;
}

function val(sgr, s) {
  return `${sgr}${s}${NC}`;
}

function statusLine(kind, extra) {
  let value;
  let color;
  if (kind === 'attached') {
    value = 'attached';
    color = LIME;
  } else if (kind === 'stale') {
    value = 'stale';
    color = YELLOW;
  } else {
    value = 'not attached';
    color = WHITE;
  }
  const disc = extra && extra.discarded ? `${DIM} discarded${NC}` : '';
  return `      ${lab('status:')} ${val(color, value)}${disc}`;
}

function windowTags(w) {
  const tags = [];
  if (w.current) tags.push(val(CURRENT, '[current]'));
  else tags.push(val(OTHER, '[other]'));
  if (w.incognito) tags.push(val(MAGENTA, '[incognito]'));
  return tags.join(' ');
}

function idsLine(t) {
  const tabId = t.tabId == null || t.tabId === '' ? '-' : String(t.tabId);
  const activeSgr = t.active ? LIME : WHITE;
  const bits = [
    `${lab('tabId:')} ${val(CYAN, tabId)}`,
    `${lab('active:')} ${val(activeSgr, t.active ? 'true' : 'false')}`,
  ];
  if (t.sessionId) {
    bits.push(`${lab('sessionId:')} ${val(CYAN, t.sessionId)}`);
  }
  return `      ${bits.join('  ')}`;
}

function printTab(lines, t, indexLabel, activeSessionId, kind) {
  const pin = t.sessionId && t.sessionId === activeSessionId;
  const mark = pin ? `${val(GREEN, '*')} ` : '  ';
  lines.push(`${mark}${val(CYAN, `[${indexLabel}]`)} ${t.title || t.url}`);
  lines.push(`      ${val(BLUE, t.url)}`);
  lines.push(statusLine(kind, t));
  lines.push(idsLine(t));
}

function formatCatalogTui(catalog, activeSessionId) {
  const lines = [];
  const winCount = catalog.windows.reduce((n, w) => n + (w.tabs || []).length, 0);
  lines.push(`${val(GREEN, String(winCount))} tab(s) in ${catalog.windows.length} window(s)`);
  lines.push('');
  let n = 0;
  for (const w of catalog.windows) {
    lines.push(`${lab('window')} ${val(CYAN, String(w.windowId))} ${windowTags(w)}`);
    for (const t of w.tabs || []) {
      n += 1;
      printTab(lines, t, String(n), activeSessionId, t.attached ? 'attached' : 'not_attached');
    }
    lines.push('');
  }
  if ((catalog.attached || []).length) {
    lines.push(`${DIM}attached (debugger, not in chrome.tabs)${NC}`);
    catalog.attached.forEach((t, i) => {
      printTab(lines, t, `A${i + 1}`, activeSessionId, 'attached');
    });
    lines.push('');
  }
  if ((catalog.stale || []).length) {
    lines.push(`${val(YELLOW, 'stale')} ${lab('(dropped from map)')}`);
    catalog.stale.forEach((t, i) => {
      printTab(lines, t, `S${i + 1}`, activeSessionId, 'stale');
    });
  }
  return lines.join('\n');
}

module.exports = {
  formatCatalogTui,
  LIME,
  GREY,
  WHITE,
  OTHER,
  DIM,
  GREEN,
  CYAN,
  YELLOW,
  CURRENT,
  MAGENTA,
  BLUE,
  NC,
};
