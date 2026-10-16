'use strict';

const { partition } = require('./pin-machine.js');

function tabIdOf(row) {
  const n = Number(row && (row.tabId ?? row.targetInfo?.tabId));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function chromeRow(tab, page) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title || '',
    url: tab.url || '',
    active: !!tab.active,
    discarded: !!tab.discarded,
    highlighted: !!tab.highlighted,
    attached: Boolean(page && page.sessionId),
    sessionId: page && page.sessionId ? page.sessionId : '',
    targetId: page && page.targetId ? page.targetId : '',
  };
}

function buildCatalog({ chromeTabs, cdpPages, focusedWindowId, listTabsOk } = {}) {
  const tabs = Array.isArray(chromeTabs) ? chromeTabs : [];
  const rawPages = Array.isArray(cdpPages) ? cdpPages : [];
  const part = partition(rawPages);
  const bySession = new Map(rawPages.map((t) => [t.sessionId || '', t]));
  const enriched = part.pages.map((p) => ({
    ...p,
    tabId: tabIdOf(bySession.get(p.sessionId) || p),
  }));

  const byTab = new Map();
  for (const p of enriched) {
    if (p.tabId) byTab.set(p.tabId, p);
  }
  const chromeIds = new Set(tabs.map((t) => t.id));

  const windowMap = new Map();
  const matched = new Set();
  for (const tab of tabs) {
    if (!tab || tab.id == null) continue;
    const page = byTab.get(tab.id) || null;
    if (page) matched.add(page.sessionId);
    const wid = tab.windowId;
    if (!windowMap.has(wid)) {
      windowMap.set(wid, {
        windowId: wid,
        current: focusedWindowId != null && wid === focusedWindowId,
        tabs: [],
      });
    }
    windowMap.get(wid).tabs.push(chromeRow(tab, page));
  }
  for (const w of windowMap.values()) {
    w.tabs.sort((a, b) => a.index - b.index);
  }
  const windows = Array.from(windowMap.values()).sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.windowId - b.windowId;
  });

  const attached = [];
  const stale = [];
  const ok = listTabsOk === true;
  for (const p of enriched) {
    if (matched.has(p.sessionId)) continue;
    const row = {
      tabId: p.tabId || 0,
      sessionId: p.sessionId,
      targetId: p.targetId,
      title: p.title || '',
      url: p.url || '',
      type: p.type,
    };
    if (ok && p.tabId && !chromeIds.has(p.tabId)) {
      stale.push({ ...row, reason: 'tab_gone' });
    } else {
      attached.push(row);
    }
  }

  return {
    focusedWindowId: focusedWindowId || 0,
    listTabsOk: ok,
    windows,
    attached,
    stale,
    reapSessionIds: stale.map((s) => s.sessionId).filter(Boolean),
    iframes: part.iframes,
    pages: part.pages,
  };
}

function reapFromMap(connectedTargets, sessionIds) {
  const dropped = [];
  for (const sid of sessionIds || []) {
    if (connectedTargets.has(sid)) {
      connectedTargets.delete(sid);
      dropped.push(sid);
    }
  }
  return dropped;
}

module.exports = { buildCatalog, reapFromMap, tabIdOf };
