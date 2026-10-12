'use strict';

/** CDP pin machine. SSOT: operator $CURREGISTRY/glider/cdp-target-shape.json */
const PAGE = 'page';
const IFRAME = 'iframe';
const NEVER = new Set([IFRAME, 'worker', 'service_worker', 'shared_worker', 'browser']);

function hostFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function hostIn(url, host) {
  if (!host || !url) return false;
  const h = String(host).toLowerCase().replace(/^\./, '');
  const u = String(url).toLowerCase();
  return u.includes(h) || u.includes(h.replace(/^www\./, ''));
}

function info(t) {
  const ti = t && typeof t.targetInfo === 'object' && t.targetInfo ? t.targetInfo : {};
  return {
    sessionId: t.sessionId || '',
    targetId: t.targetId || ti.targetId || '',
    type: String(ti.type || t.type || 'unknown').toLowerCase(),
    url: ti.url || t.url || '',
    title: ti.title || t.title || '',
    parentFrameId: ti.parentFrameId || t.parentFrameId || '',
    attached: ti.attached,
  };
}

function partition(raw) {
  const rows = (Array.isArray(raw) ? raw : []).filter((t) => t && typeof t === 'object').map(info);
  const pages = rows.filter((r) => r.type === PAGE);
  const iframes = rows.filter((r) => r.type === IFRAME).map((fr) => {
    const parent = pages.find((p) => p.targetId && p.targetId === fr.parentFrameId) || null;
    return {
      ...fr,
      parent_sessionId: parent ? parent.sessionId : '',
      parent_targetId: fr.parentFrameId || '',
    };
  });
  const other = rows.filter((r) => r.type !== PAGE && r.type !== IFRAME);
  return { pages, iframes, other, rows };
}

function pinOf(page, reason) {
  return {
    sessionId: page.sessionId,
    targetId: page.targetId,
    type: PAGE,
    url: page.url,
    host: hostFromUrl(page.url),
    reason,
  };
}

function resolvePin({ targets, host, targetId, sessionId } = {}) {
  const part = partition(targets);
  if (!part.rows.length) {
    return { state: 'S0_empty', pin: null, ...part };
  }
  const wantHost = host || '';
  const wantTarget = targetId || '';
  const wantSession = sessionId || '';

  if (wantSession) {
    const row = part.rows.find((r) => r.sessionId === wantSession || r.targetId === wantSession);
    if (row && row.type === PAGE) {
      return { state: 'S4_pin', pin: pinOf(row, 'explicit_session'), ...part };
    }
    if (row && row.type === IFRAME) {
      const parent = part.pages.find((p) => p.targetId === row.parentFrameId);
      if (parent) return { state: 'S4_pin', pin: pinOf(parent, 'parent_of_oopif'), ...part };
      return { state: 'F_orphan_iframe', pin: null, ...part };
    }
    if (row && NEVER.has(row.type)) {
      return { state: 'F_need_context', pin: null, ...part };
    }
  }

  if (!wantHost && !wantTarget) {
    return { state: 'F_need_context', pin: null, ...part };
  }

  if (wantTarget) {
    const page = part.pages.find((p) => p.targetId === wantTarget);
    if (page) return { state: 'S4_pin', pin: pinOf(page, 'same_tab_new_session'), ...part };
  }

  if (wantHost) {
    const hits = part.pages.filter((p) => hostIn(p.url, wantHost));
    if (hits.length > 1) return { state: 'F_ambiguous', pin: null, hits, ...part };
    if (hits.length === 1) return { state: 'S4_pin', pin: pinOf(hits[0], 'page_url'), ...part };
    const kids = part.iframes.filter((fr) => hostIn(fr.url, wantHost) && fr.parent_sessionId);
    if (kids.length) {
      const parent = part.pages.find((p) => p.sessionId === kids[0].parent_sessionId);
      if (parent) return { state: 'S4_pin', pin: pinOf(parent, 'parent_of_oopif'), ...part };
      return { state: 'F_orphan_iframe', pin: null, ...part };
    }
    if (part.pages.length) return { state: 'F_stale', pin: null, ...part };
    return { state: 'F_no_page', pin: null, ...part };
  }

  return { state: 'F_stale', pin: null, ...part };
}

module.exports = {
  PAGE,
  NEVER,
  hostFromUrl,
  hostIn,
  info,
  partition,
  resolvePin,
};
