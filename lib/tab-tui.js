'use strict';

// 16-color SGR only. Roles: $CURREGISTRY/tui/color-differential.yaml
// one field per line; labels dim; ids 96; url 94; no 38;5 / 38;2
const NC = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[96m';
const LIME = '\x1b[92m';
const WHITE = '\x1b[97m';
const VALUE = YELLOW;
const GREY = VALUE;
const OTHER = '\x1b[90m';
const CURRENT = '\x1b[93m';
const MAGENTA = '\x1b[95m';
const BLUE = '\x1b[94m';

const WIN = '  ';
const TAB = '      ';

function lab(s) {
  return `${DIM}${s}${NC}`;
}

function val(sgr, s) {
  return `${sgr}${s}${NC}`;
}

function dash(v) {
  if (v == null || v === '') return '-';
  return String(v);
}

function kv(indent, label, value, sgr) {
  return `${indent}${lab(`${label}:`)} ${val(sgr, dash(value))}`;
}

function kvBool(indent, label, b, onSgr, offSgr) {
  return kv(indent, label, b ? 'true' : 'false', b ? (onSgr || LIME) : (offSgr || VALUE));
}

function attachStatus(kind) {
  if (kind === 'attached') return ['attached', LIME];
  if (kind === 'stale') return ['stale', YELLOW];
  return ['not attached', VALUE];
}

function printWindow(lines, w) {
  lines.push(lab('window'));
  lines.push(kv(WIN, 'windowId', w.windowId, CYAN));
  lines.push(kvBool(WIN, 'current', !!w.current, CURRENT, VALUE));
  lines.push(kvBool(WIN, 'focused', !!w.focused, LIME, VALUE));
  lines.push(kvBool(WIN, 'incognito', !!w.incognito, MAGENTA, VALUE));
  lines.push(kv(WIN, 'incognitoSource', w.incognitoSource || '', VALUE));
  lines.push(kv(WIN, 'type', w.type || '', VALUE));
  lines.push(kv(WIN, 'state', w.state || '', VALUE));
  lines.push(kvBool(WIN, 'alwaysOnTop', !!w.alwaysOnTop));
  lines.push(kv(WIN, 'width', w.width, CYAN));
  lines.push(kv(WIN, 'height', w.height, CYAN));
  lines.push(kv(WIN, 'left', w.left, CYAN));
  lines.push(kv(WIN, 'top', w.top, CYAN));
  lines.push(kv(WIN, 'chromeSessionId', w.chromeSessionId || '', CYAN));
}

function printTab(lines, t, handle, activeSessionId, kind) {
  const pin = t.sessionId && t.sessionId === activeSessionId;
  const mark = pin ? `${val(GREEN, '*')} ` : '  ';
  const [st, stSgr] = attachStatus(kind);
  const head = t.title ? val(WHITE, t.title) : val(BLUE, t.url || '-');
  lines.push(`${mark}${val(CYAN, `[${handle}]`)} ${head}`);
  lines.push(kv(TAB, 'handle', handle, CYAN));
  lines.push(kv(TAB, 'kind', t.kind || 'tab', VALUE));
  lines.push(kv(TAB, 'index', t.index, CYAN));
  lines.push(kv(TAB, 'tabId', t.tabId, CYAN));
  lines.push(kv(TAB, 'windowId', t.windowId, CYAN));
  lines.push(kv(TAB, 'title', t.title || '', WHITE));
  lines.push(kv(TAB, 'url', t.url || '', BLUE));
  lines.push(kv(TAB, 'status', st, stSgr));
  lines.push(kv(TAB, 'load', t.load || '', t.load === 'loading' ? YELLOW : VALUE));
  lines.push(kvBool(TAB, 'active', !!t.active));
  lines.push(kvBool(TAB, 'highlighted', !!t.highlighted));
  lines.push(kvBool(TAB, 'pinned', !!t.pinned));
  lines.push(kvBool(TAB, 'discarded', !!t.discarded));
  lines.push(kvBool(TAB, 'attached', !!t.attached || kind === 'attached'));
  lines.push(kvBool(TAB, 'incognito', !!t.incognito, MAGENTA, VALUE));
  lines.push(kv(TAB, 'incognitoSource', t.incognitoSource || '', VALUE));
  lines.push(kvBool(TAB, 'audible', !!t.audible));
  lines.push(kvBool(TAB, 'muted', !!t.muted));
  lines.push(kv(TAB, 'mutedReason', t.mutedReason || '', VALUE));
  lines.push(kv(TAB, 'mutedExtensionId', t.mutedExtensionId || '', CYAN));
  lines.push(kvBool(TAB, 'autoDiscardable', t.autoDiscardable !== false));
  lines.push(kv(TAB, 'groupId', t.groupId, CYAN));
  lines.push(kv(TAB, 'openerTabId', t.openerTabId, CYAN));
  lines.push(kv(TAB, 'pendingUrl', t.pendingUrl || '', BLUE));
  lines.push(kv(TAB, 'favIconUrl', t.favIconUrl || '', BLUE));
  lines.push(kvBool(TAB, 'frozen', !!t.frozen));
  lines.push(kv(TAB, 'lastAccessed', t.lastAccessed, CYAN));
  lines.push(kv(TAB, 'width', t.width, CYAN));
  lines.push(kv(TAB, 'height', t.height, CYAN));
  lines.push(kv(TAB, 'chromeSessionId', t.chromeSessionId || '', CYAN));
  lines.push(kv(TAB, 'successorTabId', t.successorTabId, CYAN));
  lines.push(kv(TAB, 'splitViewId', t.splitViewId, CYAN));
  lines.push(kvBool(TAB, 'selected', !!t.selected));
  lines.push(kv(TAB, 'sessionId', t.sessionId || '', CYAN));
  lines.push(kv(TAB, 'targetId', t.targetId || '', CYAN));
  lines.push(kv(TAB, 'targetType', t.targetType || t.type || '', VALUE));
  lines.push(kv(TAB, 'subtype', t.subtype || '', VALUE));
  lines.push(kv(TAB, 'browserContextId', t.browserContextId || '', CYAN));
  lines.push(kv(TAB, 'openerId', t.openerId || '', CYAN));
  lines.push(kv(TAB, 'openerFrameId', t.openerFrameId || '', CYAN));
  lines.push(kv(TAB, 'parentFrameId', t.parentFrameId || '', CYAN));
  lines.push(kvBool(TAB, 'canAccessOpener', !!t.canAccessOpener));
  lines.push(kv(TAB, 'cdpAttached', t.cdpAttached == null ? '' : t.cdpAttached, t.cdpAttached ? LIME : VALUE));
  lines.push(kv(TAB, 'parent_sessionId', t.parent_sessionId || '', CYAN));
  lines.push(kv(TAB, 'parent_targetId', t.parent_targetId || '', CYAN));
  if (t.reason) lines.push(kv(TAB, 'reason', t.reason, VALUE));
}

function formatCatalogTui(catalog, activeSessionId) {
  const lines = [];
  const winCount = catalog.windows.reduce((n, w) => n + (w.tabs || []).length, 0);
  lines.push(`${val(GREEN, String(winCount))} tab(s) in ${catalog.windows.length} window(s)`);
  lines.push('');
  let n = 0;
  for (const w of catalog.windows) {
    printWindow(lines, w);
    for (const t of w.tabs || []) {
      n += 1;
      printTab(lines, { ...t, kind: t.kind || 'tab' }, String(n), activeSessionId, t.attached ? 'attached' : 'not_attached');
    }
    lines.push('');
  }
  if ((catalog.attached || []).length) {
    lines.push(`${DIM}attached (debugger, not in chrome.tabs)${NC}`);
    catalog.attached.forEach((t, i) => {
      printTab(lines, { ...t, kind: t.kind || 'attached' }, `A${i + 1}`, activeSessionId, 'attached');
    });
    lines.push('');
  }
  if ((catalog.stale || []).length) {
    lines.push(`${val(YELLOW, 'stale')} ${lab('(dropped from map)')}`);
    catalog.stale.forEach((t, i) => {
      printTab(lines, { ...t, kind: t.kind || 'stale' }, `S${i + 1}`, activeSessionId, 'stale');
    });
    lines.push('');
  }
  if ((catalog.iframes || []).length) {
    lines.push(`${DIM}iframes (OOPIF)${NC}`);
    catalog.iframes.forEach((t, i) => {
      printTab(lines, { ...t, kind: t.kind || 'iframe' }, `I${i + 1}`, activeSessionId, 'attached');
    });
    lines.push('');
  }
  if ((catalog.other || []).length) {
    lines.push(`${DIM}other (cdp non-page)${NC}`);
    catalog.other.forEach((t, i) => {
      printTab(lines, { ...t, kind: t.kind || t.targetType || 'other' }, `O${i + 1}`, activeSessionId, 'attached');
    });
  }
  return lines.join('\n');
}

module.exports = {
  formatCatalogTui,
  LIME,
  GREY,
  WHITE,
  VALUE,
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
