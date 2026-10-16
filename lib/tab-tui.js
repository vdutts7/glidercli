'use strict';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';
const LIME = '\x1b[38;5;154m';

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
    color = DIM;
  }
  const disc = extra && extra.discarded ? `${DIM} discarded${NC}` : '';
  return `      ${DIM}status:${NC} ${color}${value}${NC}${disc}`;
}

function printTab(lines, t, indexLabel, activeSessionId, kind) {
  const pin = t.sessionId && t.sessionId === activeSessionId;
  const mark = pin ? `${GREEN}*${NC} ` : '  ';
  lines.push(`${mark}${CYAN}[${indexLabel}]${NC} ${t.title || t.url}`);
  lines.push(`      ${DIM}${t.url}${NC}`);
  lines.push(statusLine(kind, t));
}

function formatCatalogTui(catalog, activeSessionId) {
  const lines = [];
  const winCount = catalog.windows.reduce((n, w) => n + (w.tabs || []).length, 0);
  lines.push(`${GREEN}${winCount}${NC} tab(s) in ${catalog.windows.length} window(s)`);
  lines.push('');
  let n = 0;
  for (const w of catalog.windows) {
    const tag = [w.current ? 'current' : 'other', w.incognito ? 'incognito' : null].filter(Boolean).join(', ');
    lines.push(`${CYAN}window ${w.windowId}${NC} ${DIM}(${tag})${NC}`);
    for (const t of w.tabs || []) {
      n += 1;
      printTab(lines, t, String(n), activeSessionId, t.attached ? 'attached' : 'not_attached');
    }
    lines.push('');
  }
  if ((catalog.attached || []).length) {
    lines.push(`${CYAN}attached${NC} ${DIM}(debugger, not in chrome.tabs)${NC}`);
    catalog.attached.forEach((t, i) => {
      printTab(lines, t, `A${i + 1}`, activeSessionId, 'attached');
    });
    lines.push('');
  }
  if ((catalog.stale || []).length) {
    lines.push(`${YELLOW}stale${NC} ${DIM}(dropped from map)${NC}`);
    catalog.stale.forEach((t, i) => {
      printTab(lines, t, `S${i + 1}`, activeSessionId, 'stale');
    });
  }
  return lines.join('\n');
}

module.exports = {
  formatCatalogTui,
  LIME,
  DIM,
  GREEN,
  CYAN,
  YELLOW,
  NC,
};
