'use strict';

/**
 * Session runnable gate — product auto-heal for Chromium background throttle.
 * One primitive for CLI thaw, explore, and every /cdp verb path.
 */

const THAW_STEPS = [
  { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
  { method: 'Page.setWebLifecycleState', params: { state: 'active' } },
];

const LIFECYCLE_METHODS = new Set(THAW_STEPS.map((step) => step.method));

function thawCdpCalls(sessionId) {
  return THAW_STEPS.map(({ method, params }) => {
    const call = { method, params: { ...params } };
    if (sessionId) call.sessionId = sessionId;
    return call;
  });
}

function isLifecycleMethod(method) {
  return LIFECYCLE_METHODS.has(method);
}

/**
 * @param {{ sessionId?: string|null, send: (call: {method:string, params:object, sessionId?:string}) => Promise<any> }} opts
 */
async function ensureSessionRunnable({ sessionId = null, send }) {
  if (typeof send !== 'function') throw new TypeError('ensureSessionRunnable requires send()');
  for (const call of thawCdpCalls(sessionId || null)) {
    await send(call);
  }
  return { sessionId: sessionId || null, thawed: true };
}

/**
 * Poll /targets (or any listTargets) until targetId has a sessionId.
 * Replaces fixed sleeps on --fresh-tab.
 */
async function waitForTargetSession({
  targetId,
  listTargets,
  timeoutMs = 10000,
  intervalMs = 100,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!targetId) throw new TypeError('waitForTargetSession requires targetId');
  if (typeof listTargets !== 'function') throw new TypeError('waitForTargetSession requires listTargets()');
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const raw = await listTargets();
    const list = Array.isArray(raw) ? raw : (raw && raw.targets) || [];
    const hit = list.find((row) => row && row.targetId === targetId && row.sessionId);
    if (hit) return hit.sessionId;
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  return null;
}

module.exports = {
  thawCdpCalls,
  ensureSessionRunnable,
  waitForTargetSession,
  isLifecycleMethod,
  LIFECYCLE_METHODS,
};
