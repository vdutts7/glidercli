'use strict';

const { partition } = require('./pin-machine.js');

function tabIdOf(row) {
  const n = Number(row && (row.tabId ?? row.targetInfo?.tabId));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function contextIdOf(page) {
  return (page && (page.browserContextId || page.targetInfo?.browserContextId)) || '';
}

function windowIncognito(chromeWindows, wid, tabsInWindow) {
  const meta = (chromeWindows || []).find((w) => (w.windowId ?? w.id) === wid);
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'incognito')) {
    return { incognito: !!meta.incognito, incognitoSource: 'chrome.windows' };
  }
  if ((tabsInWindow || []).some((t) => t.incognito)) {
    return { incognito: true, incognitoSource: 'chrome.tabs' };
  }
  return { incognito: false, incognitoSource: '' };
}

function ti(page) {
  return (page && page.targetInfo && typeof page.targetInfo === 'object') ? page.targetInfo : {};
}

function chromeRow(tab, page, win) {
  const fromTab = !!tab.incognito;
  const incognito = win.incognito || fromTab;
  const incognitoSource = win.incognito
    ? win.incognitoSource
    : (fromTab ? 'chrome.tabs' : '');
  const info = ti(page);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title || '',
    url: tab.url || '',
    active: !!tab.active,
    discarded: !!tab.discarded,
    highlighted: !!tab.highlighted,
    pinned: !!tab.pinned,
    load: tab.status || tab.load || '',
    incognito,
    incognitoSource,
    attached: Boolean(page && page.sessionId),
    audible: !!tab.audible,
    muted: !!(tab.muted || (tab.mutedInfo && tab.mutedInfo.muted)),
    mutedReason: tab.mutedReason || (tab.mutedInfo && tab.mutedInfo.reason) || '',
    mutedExtensionId: tab.mutedExtensionId || (tab.mutedInfo && tab.mutedInfo.extensionId) || '',
    autoDiscardable: tab.autoDiscardable !== false,
    groupId: tab.groupId == null ? '' : tab.groupId,
    openerTabId: tab.openerTabId == null ? '' : tab.openerTabId,
    pendingUrl: tab.pendingUrl || '',
    favIconUrl: tab.favIconUrl || '',
    frozen: !!tab.frozen,
    lastAccessed: tab.lastAccessed == null ? '' : tab.lastAccessed,
    width: tab.width == null ? '' : tab.width,
    height: tab.height == null ? '' : tab.height,
    chromeSessionId: tab.chromeSessionId || tab.sessionIdChrome || '',
    successorTabId: tab.successorTabId == null ? '' : tab.successorTabId,
    splitViewId: tab.splitViewId == null ? '' : tab.splitViewId,
    selected: !!tab.selected,
    sessionId: page && page.sessionId ? page.sessionId : '',
    targetId: page && page.targetId ? page.targetId : '',
    browserContextId: contextIdOf(page),
    targetType: (page && (page.type || info.type)) || '',
    subtype: info.subtype || '',
    openerId: info.openerId || (page && page.openerId) || '',
    openerFrameId: info.openerFrameId || (page && page.parentFrameId) || '',
    canAccessOpener: info.canAccessOpener,
    parent_sessionId: (page && page.parent_sessionId) || '',
    parent_targetId: (page && (page.parent_targetId || page.parentFrameId)) || '',
    parentFrameId: (page && page.parentFrameId) || '',
    cdpAttached: info.attached,
  };
}

function cdpRow(p, extra) {
  const info = ti(p);
  return {
    tabId: p.tabId || 0,
    sessionId: p.sessionId || '',
    targetId: p.targetId || '',
    title: p.title || '',
    url: p.url || '',
    type: p.type || info.type || '',
    targetType: p.type || info.type || '',
    subtype: info.subtype || '',
    browserContextId: contextIdOf(p),
    openerId: info.openerId || '',
    openerFrameId: info.openerFrameId || p.parentFrameId || '',
    parent_sessionId: p.parent_sessionId || '',
    parent_targetId: p.parent_targetId || p.parentFrameId || '',
    parentFrameId: p.parentFrameId || '',
    ...extra,
  };
}

function buildCatalog({ chromeTabs, chromeWindows, cdpPages, focusedWindowId, listTabsOk } = {}) {
  const tabs = Array.isArray(chromeTabs) ? chromeTabs : [];
  const rawPages = Array.isArray(cdpPages) ? cdpPages : [];
  const part = partition(rawPages);
  const bySession = new Map(rawPages.map((t) => [t.sessionId || '', t]));
  const enriched = part.pages.map((p) => {
    const raw = bySession.get(p.sessionId) || p;
    return {
      ...p,
      tabId: tabIdOf(raw),
      browserContextId: contextIdOf(raw),
      targetInfo: raw.targetInfo,
    };
  });

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
      const win = windowIncognito(
        chromeWindows,
        wid,
        tabs.filter((t) => t.windowId === wid),
      );
      const meta = (chromeWindows || []).find((w) => (w.windowId ?? w.id) === wid) || {};
      windowMap.set(wid, {
        windowId: wid,
        current: focusedWindowId != null && wid === focusedWindowId,
        focused: !!meta.focused,
        incognito: win.incognito,
        incognitoSource: win.incognitoSource,
        type: meta.type || '',
        state: meta.state || '',
        alwaysOnTop: !!meta.alwaysOnTop,
        width: meta.width == null ? '' : meta.width,
        height: meta.height == null ? '' : meta.height,
        left: meta.left == null ? '' : meta.left,
        top: meta.top == null ? '' : meta.top,
        chromeSessionId: meta.chromeSessionId || meta.sessionId || '',
        tabs: [],
      });
    }
    const bucket = windowMap.get(wid);
    bucket.tabs.push(chromeRow(tab, page, {
      incognito: bucket.incognito,
      incognitoSource: bucket.incognitoSource,
    }));
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
    const row = cdpRow(p);
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
    iframes: (part.iframes || []).map((p) => cdpRow(p)),
    other: (part.other || []).map((p) => cdpRow(p)),
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
