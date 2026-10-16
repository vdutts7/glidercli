'use strict';

const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

function catalogLooksLive(body) {
  return Boolean(body && Array.isArray(body.windows) && body.error == null);
}

function lstartToMs(started) {
  if (!started) return NaN;
  const t = Date.parse(started);
  return Number.isFinite(t) ? t : NaN;
}

function entryMtimeMs(entryPath) {
  try {
    return fs.statSync(entryPath).mtimeMs;
  } catch {
    return NaN;
  }
}

function relayBinaryStale({ entryMtimeMs: mtime, processStartMs, skewMs = 2000 } = {}) {
  if (!Number.isFinite(mtime) || !Number.isFinite(processStartMs)) return false;
  return mtime > processStartMs + skewMs;
}

function shouldRecycleRelay({
  catalogOk,
  catalogAdvertised,
  entryMtimeMs: mtime,
  processStartMs,
} = {}) {
  if (catalogAdvertised === false) return { recycle: true, reason: 'catalog_unadvertised' };
  if (catalogAdvertised === true) {
    if (relayBinaryStale({ entryMtimeMs: mtime, processStartMs })) {
      return { recycle: true, reason: 'binary_stale' };
    }
    return { recycle: false, reason: null };
  }
  if (catalogOk === false) return { recycle: true, reason: 'catalog_missing' };
  if (relayBinaryStale({ entryMtimeMs: mtime, processStartMs })) {
    return { recycle: true, reason: 'binary_stale' };
  }
  return { recycle: false, reason: null };
}

function shouldHealExtension({ workerAlive, listTabsOk, extensionConnected } = {}) {
  if (extensionConnected === false) return { heal: true, step: 'wake' };
  if (workerAlive === false) return { heal: true, step: 'wake' };
  if (listTabsOk === false) return { heal: true, step: 'reload' };
  return { heal: false, step: null };
}

function childStartMs(pid) {
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
    return lstartToMs(started);
  } catch {
    return NaN;
  }
}

function httpGetJson(port, urlPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(port), path: urlPath, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* not json */ }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: null });
    });
  });
}

async function childNeedsRecycle({ port, entryPath, childPid }) {
  const cat = await httpGetJson(port, '/catalog', 800);
  const st = await httpGetJson(port, '/status', 800);
  const advertised = st.body ? st.body.catalog === true : false;
  const decision = shouldRecycleRelay({
    catalogOk: catalogLooksLive(cat.body) && cat.status >= 200 && cat.status < 300,
    catalogAdvertised: advertised,
    entryMtimeMs: entryMtimeMs(entryPath),
    processStartMs: childStartMs(childPid),
  });
  return decision;
}

module.exports = {
  catalogLooksLive,
  lstartToMs,
  entryMtimeMs,
  relayBinaryStale,
  shouldRecycleRelay,
  shouldHealExtension,
  childNeedsRecycle,
  httpGetJson,
};
