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
    tabId: t.tabId == null ? 0 : t.tabId,
    sessionId: t.sessionId || '',
    targetId: t.targetId || '',
    windowId: t.windowId == null ? 0 : t.windowId,
    title: t.title || '',
    url: t.url || '',
    attached: !!t.attached,
    active: !!t.active,
    discarded: !!t.discarded,
  };
}

function buildMap(catalog) {
  const handles = {};
  let n = 0;
  for (const w of catalog.windows || []) {
    for (const t of w.tabs || []) {
      n += 1;
      handles[String(n)] = rowHandle({ ...t, windowId: t.windowId || w.windowId }, n);
    }
  }
  (catalog.attached || []).forEach((t, i) => {
    const h = `A${i + 1}`;
    handles[h] = rowHandle(t, h);
  });
  (catalog.stale || []).forEach((t, i) => {
    const h = `S${i + 1}`;
    handles[h] = rowHandle(t, h);
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

function resolveRef({ handle, tabId, sessionId, map } = {}) {
  const src = map && map.handles ? map : readMap();
  const rows = Object.values(src.handles || {});
  if (handle != null && handle !== '') {
    const key = String(handle);
    if (src.handles[key]) return { row: src.handles[key], via: 'handle' };
  }
  if (tabId != null && tabId !== '') {
    const id = Number(tabId);
    const row = rows.find((r) => Number(r.tabId) === id);
    if (row) return { row, via: 'tabId' };
  }
  if (sessionId) {
    const row = rows.find((r) => r.sessionId === sessionId);
    if (row) return { row, via: 'sessionId' };
  }
  return { row: null, via: '' };
}

function lookslikeHandle(token) {
  return typeof token === 'string' && /^(?:\d+|[AS]\d+)$/i.test(token);
}

module.exports = {
  mapPath,
  buildMap,
  writeMap,
  readMap,
  resolveRef,
  lookslikeHandle,
};
