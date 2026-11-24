'use strict';

function targetInfo(target) {
  return target && target.targetInfo && typeof target.targetInfo === 'object'
    ? target.targetInfo
    : {};
}

function targetType(target) {
  return (target && target.type) || targetInfo(target).type || '';
}

function attachedTabs(catalog) {
  if (!catalog || !Array.isArray(catalog.windows)) return [];
  return catalog.windows.flatMap((window) => (
    Array.isArray(window.tabs) ? window.tabs.filter((tab) => tab.attached) : []
  ));
}

function summarizeStatus(catalog, targets) {
  const rawTargets = Array.isArray(targets) ? targets : [];
  const catalogAvailable = Boolean(catalog && Array.isArray(catalog.windows));
  const tabs = attachedTabs(catalog);
  const debuggerOnlyPages = catalogAvailable && Array.isArray(catalog.attached)
    ? catalog.attached.filter((target) => targetType(target) === 'page')
    : [];
  const childTargets = catalogAvailable
    ? [
      ...(Array.isArray(catalog.iframes) ? catalog.iframes : []),
      ...(Array.isArray(catalog.other) ? catalog.other : []),
    ]
    : [];
  const staleTargets = catalogAvailable && Array.isArray(catalog.stale)
    ? catalog.stale
    : [];
  const fallbackPages = catalogAvailable
    ? []
    : rawTargets.filter((target) => targetType(target) === 'page');

  return {
    catalogAvailable,
    tabs,
    debuggerOnlyPages,
    childTargets,
    staleTargets,
    fallbackPages,
    connectedPageCount: catalogAvailable
      ? tabs.length + debuggerOnlyPages.length
      : fallbackPages.length,
    rawTargetCount: rawTargets.length,
  };
}

module.exports = { attachedTabs, summarizeStatus, targetType };
