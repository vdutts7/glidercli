'use strict';

function targetInfo(target) {
  return target && target.targetInfo && typeof target.targetInfo === 'object'
    ? target.targetInfo
    : {};
}

function tabIdOf(target) {
  const value = Number(target && (target.tabId ?? targetInfo(target).tabId));
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function targetType(target) {
  return (target && target.type) || targetInfo(target).type || '';
}

function isSyntheticTabTarget(target) {
  const tabId = tabIdOf(target);
  const info = targetInfo(target);
  return Boolean(
    tabId
    && (info.synthetic === true || target.targetId === `tab-${tabId}`),
  );
}

function recordFromAttached(params) {
  const info = params && params.targetInfo;
  if (!params || !params.sessionId || !info || !info.targetId) return null;
  const tabId = Number(params.tabId || info.tabId) || 0;
  return {
    sessionId: params.sessionId,
    targetId: info.targetId,
    tabId,
    targetInfo: info,
  };
}

function reconcileAttachedTarget(targets, params) {
  const incoming = recordFromAttached(params);
  if (!incoming) return { stored: false, ignored: true, removedSessionIds: [] };

  const tabId = tabIdOf(incoming);
  const page = targetType(incoming) === 'page';
  const peers = page && tabId
    ? Array.from(targets.values()).filter((target) => (
      target.sessionId !== incoming.sessionId
      && targetType(target) === 'page'
      && tabIdOf(target) === tabId
    ))
    : [];

  if (isSyntheticTabTarget(incoming)) {
    const real = peers.find((target) => !isSyntheticTabTarget(target));
    if (real) {
      return {
        stored: false,
        ignored: true,
        record: real,
        removedSessionIds: [],
      };
    }
  }

  const removedSessionIds = [];
  for (const peer of peers) {
    targets.delete(peer.sessionId);
    removedSessionIds.push(peer.sessionId);
  }
  targets.set(incoming.sessionId, incoming);
  return { stored: true, ignored: false, record: incoming, removedSessionIds };
}

function updateTargetInfo(targets, { sessionId, targetInfo: nextInfo, tabId } = {}) {
  if (!nextInfo || typeof nextInfo !== 'object') return null;
  const nextTabId = Number(tabId || nextInfo.tabId) || 0;
  let target = sessionId ? targets.get(sessionId) : null;
  if (!target && nextInfo.targetId) {
    target = Array.from(targets.values())
      .find((entry) => entry.targetId === nextInfo.targetId);
  }
  if (!target && nextTabId) {
    target = Array.from(targets.values())
      .find((entry) => tabIdOf(entry) === nextTabId && targetType(entry) === 'page');
  }
  if (!target) return null;

  target.targetInfo = { ...targetInfo(target), ...nextInfo };
  target.targetId = nextInfo.targetId || target.targetId;
  target.tabId = nextTabId || tabIdOf(target);
  return target;
}

module.exports = {
  isSyntheticTabTarget,
  reconcileAttachedTarget,
  tabIdOf,
  targetType,
  updateTargetInfo,
};
