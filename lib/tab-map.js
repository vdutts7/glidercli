'use strict';

const fs = require('fs');
const path = require('path');
const { stateDir } = require('./paths.js');

function mapPath() {
  return path.join(stateDir(), 'tab-map.json');
}

function rowHandle(t, handle) {
  return {
    handle: String(handle),
    kind: t.kind || 'tab',
    tabId: t.tabId == null ? 0 : t.tabId,
    sessionId: t.sessionId || '',
    targetId: t.targetId || '',
    windowId: t.windowId == null ? 0 : t.windowId,
    index: t.index == null ? 0 : t.index,
    title: t.title || '',
    url: t.url || '',
    attached: !!t.attached,
    active: !!t.active,
    discarded: !!t.discarded,
    highlighted: !!t.highlighted,
    incognito: !!t.incognito,
    current: !!t.current,
    browserContextId: t.browserContextId || '',
    parent_sessionId: t.parent_sessionId || '',
  };
}

function buildMap(catalog) {
  const handles = {};
  let n = 0;
  for (const w of catalog.windows || []) {
    for (const t of w.tabs || []) {
      n += 1;
      handles[String(n)] = rowHandle({
        ...t,
        kind: 'tab',
        windowId: t.windowId || w.windowId,
        current: !!w.current,
        incognito: t.incognito || w.incognito,
      }, n);
    }
  }
  (catalog.attached || []).forEach((t, i) => {
    const h = `A${i + 1}`;
    handles[h] = rowHandle({ ...t, kind: 'attached' }, h);
  });
  (catalog.stale || []).forEach((t, i) => {
    const h = `S${i + 1}`;
    handles[h] = rowHandle({ ...t, kind: 'stale' }, h);
  });
  (catalog.iframes || []).forEach((t, i) => {
    const h = `I${i + 1}`;
    handles[h] = rowHandle({ ...t, kind: 'iframe', attached: true }, h);
  });
  return { handles };
}

function writeMap(catalog) {
  const payload = { ...buildMap(catalog), writtenAt: Date.now() };
  fs.writeFileSync(mapPath(), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function readMap() {
  const p = mapPath();
  if (!fs.existsSync(p)) return { handles: {} };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && data.handles ? data : { handles: {} };
  } catch {
    return { handles: {} };
  }
}

function resolveRef(opts) {
  return resolveChain(opts);
}

function resolveChain({
  current, incognito, windowId, index, handle, tabId, targetId, sessionId, browserContextId, iframe, map,
} = {}) {
  const src = map && map.handles ? map : readMap();
  let rows = Object.values(src.handles || {});
  const via = [];
  const fail = (err) => ({ row: null, via: via.join('>'), error: err });
  if (current) {
    rows = rows.filter((r) => r.current);
    via.push('current');
    if (!rows.length) return fail('current');
  }
  if (incognito) {
    rows = rows.filter((r) => r.incognito);
    via.push('incognito');
    if (!rows.length) return fail('incognito');
  }
  if (windowId != null && windowId !== '') {
    const id = Number(windowId);
    rows = rows.filter((r) => Number(r.windowId) === id);
    via.push('window');
    if (!rows.length) return fail('window');
  }
  if (index != null && index !== '') {
    const n = Number(index);
    rows = rows.filter((r) => Number(r.index) === n);
    via.push('index');
    if (!rows.length) return fail('index');
  }
  if (iframe) {
    rows = rows.filter((r) => r.kind === 'iframe');
    via.push('iframe');
    if (!rows.length) return fail('iframe');
  }
  if (handle != null && handle !== '') {
    const hit = src.handles[String(handle)];
    if (!hit) return fail('handle');
    if (rows.length && !rows.some((r) => r.handle === hit.handle)) {
      via.push('handle');
      return fail('handle_not_in_window');
    }
    rows = [hit];
    via.push('handle');
  }
  if (tabId != null && tabId !== '') {
    const id = Number(tabId);
    const hit = rows.find((r) => Number(r.tabId) === id);
    if (!hit) {
      via.push('tab');
      return fail('tab');
    }
    rows = [hit];
    via.push('tab');
  }
  if (targetId) {
    const hit = rows.find((r) => r.targetId === targetId);
    if (!hit) {
      via.push('target');
      return fail('target');
    }
    rows = [hit];
    via.push('target');
  }
  if (sessionId) {
    const hit = rows.find((r) => r.sessionId === sessionId);
    if (!hit) {
      via.push('session');
      return fail('session');
    }
    rows = [hit];
    via.push('session');
  }
  if (browserContextId) {
    const hit = rows.find((r) => r.browserContextId === browserContextId);
    if (!hit) {
      via.push('context');
      return fail('context');
    }
    rows = [hit];
    via.push('context');
  }
  if (rows.length === 1) return { row: rows[0], via: via.join('>') || 'unique' };
  const coarse = via.includes('window') || via.includes('current') || via.includes('incognito');
  if (rows.length > 1 && coarse && !handle && (tabId == null || tabId === '') && !sessionId && !targetId && (index == null || index === '')) {
    const active = rows.find((r) => r.active && r.sessionId && r.kind !== 'iframe');
    if (active) return { row: active, via: via.concat('active').join('>') };
  }
  if (rows.length > 1) return { row: null, via: via.join('>'), error: 'ambiguous' };
  return { row: null, via: via.join('>'), error: 'empty' };
}

function lookslikeHandle(token) {
  return typeof token === 'string' && /^(?:\d+|[ASI]\d+)$/i.test(token);
}

module.exports = {
  mapPath,
  buildMap,
  writeMap,
  readMap,
  resolveRef,
  resolveChain,
  lookslikeHandle,
};
