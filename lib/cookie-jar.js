'use strict';

const fs = require('fs');
const path = require('path');
const { cookiesDirRoot, cookiesDomainsFile, warchScanRoots } = require('./paths.js');

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function parseHeaderLine(raw) {
  if (raw == null || raw === '') return '';
  for (const line of String(raw).split(/\r?\n/)) {
    let clean = stripAnsi(line).trimStart();
    if (clean.startsWith('Cookie:')) clean = clean.slice('Cookie:'.length).trimStart();
    if (clean && clean.includes('=')) return clean;
  }
  return '';
}

/** Split a Cookie header into [{name,value}, ...]. */
function parseHeaderPairs(raw) {
  const line = parseHeaderLine(raw);
  if (!line) return [];
  const out = [];
  for (const part of line.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: p.slice(0, eq).trim(), value: p.slice(eq + 1) });
  }
  return out;
}

function jarCookiesPath(domain) {
  return path.join(domainDir(domain), 'cookies.json');
}

function jarUrlForDomain(domain) {
  if (/^https?:\/\//i.test(domain)) return domain.endsWith('/') ? domain : `${domain}/`;
  return `https://${domain}/`;
}

/**
 * Build chrome.cookies.set details list for inject.
 * Prefers cookies.json (full attrs). Falls back to header.txt pairs.
 */
function buildInjectDetails(domain, opts = {}) {
  const storeId = opts.storeId;
  const url = jarUrlForDomain(domain);
  const fullPath = jarCookiesPath(domain);
  if (fs.existsSync(fullPath)) {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      arr = null;
    }
    if (Array.isArray(arr) && arr.length) {
      return arr.map((c) => {
        const details = {
          url: c.url || url,
          name: c.name,
          value: c.value ?? '',
        };
        for (const k of ['domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate']) {
          if (c[k] !== undefined && c[k] !== null) details[k] = c[k];
        }
        // chrome.cookies.set rejects sameSite "unspecified"
        if (details.sameSite === 'unspecified') delete details.sameSite;
        if (storeId != null && storeId !== '') details.storeId = String(storeId);
        return details;
      }).filter((d) => d.name);
    }
  }
  const headerPath = path.join(domainDir(domain), 'header.txt');
  if (!fs.existsSync(headerPath)) {
    const err = new Error(`${domain}: no cookies.json or header.txt in jar`);
    err.code = 'INJECT_MISS';
    throw err;
  }
  const pairs = parseHeaderPairs(fs.readFileSync(headerPath, 'utf8'));
  if (!pairs.length) {
    const err = new Error(`${domain}: empty jar header`);
    err.code = 'INJECT_EMPTY';
    throw err;
  }
  return pairs.map(({ name, value }) => {
    const details = {
      url,
      name,
      value,
      secure: true,
      path: '/',
    };
    // common session cookies are HttpOnly in the live jar
    if (name === 'auth_token' || name === 'ct0' || name === 'twid') details.httpOnly = name !== 'ct0';
    if (name === 'ct0') details.httpOnly = false;
    if (storeId != null && storeId !== '') details.storeId = String(storeId);
    return details;
  });
}

/**
 * Persist full chrome.cookies.getAll rows beside header.txt.
 * Enables lossless inject (HttpOnly / SameSite / domain / path).
 */
function writeCookiesJson(domain, cookies) {
  fs.mkdirSync(domainDir(domain), { recursive: true });
  const list = Array.isArray(cookies) ? cookies : [];
  fs.writeFileSync(jarCookiesPath(domain), `${JSON.stringify(list, null, 2)}\n`);
  return list.length;
}

/**
 * Inject jar into a cookie store via setCookieFn(details) => Promise.
 * setCookieFn must call extension chrome.cookies.set.
 */
async function injectDomain(domain, setCookieFn, opts = {}) {
  const detailsList = buildInjectDetails(domain, opts);
  const results = [];
  for (const details of detailsList) {
    // eslint-disable-next-line no-await-in-loop
    const cookie = await setCookieFn(details);
    results.push({ name: details.name, ok: !!cookie, storeId: details.storeId || null });
  }
  return { domain, count: results.length, storeId: opts.storeId || null, results };
}

function domainDir(domain) {
  return path.join(cookiesDirRoot(), domain);
}

function ensureJarRoot() {
  fs.mkdirSync(cookiesDirRoot(), { recursive: true });
}

function loadDomainsFile() {
  ensureJarRoot();
  const p = cookiesDomainsFile();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveDomains(domains) {
  ensureJarRoot();
  const sorted = [...new Set(domains)].sort();
  fs.writeFileSync(cookiesDomainsFile(), `${JSON.stringify({ domains: sorted }, null, 2)}\n`);
  return sorted;
}

function listDomainNames() {
  const data = loadDomainsFile();
  if (data && Array.isArray(data.domains)) return data.domains;
  rebuildDomains();
  const again = loadDomainsFile();
  return again && Array.isArray(again.domains) ? again.domains : [];
}

function walkGliderJson(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name === 'glider.json') out.push(full);
    }
  }
  return out.sort();
}

function rebuildDomains() {
  ensureJarRoot();
  const domains = [];
  for (const root of warchScanRoots()) {
    for (const gj of walkGliderJson(root)) {
      try {
        const data = JSON.parse(fs.readFileSync(gj, 'utf8'));
        const jar = data.cookie_jar || {};
        if (jar.enabled && data.host) domains.push(data.host);
      } catch {
        /* skip */
      }
    }
  }
  let existing = [];
  try {
    const cur = loadDomainsFile();
    if (cur && Array.isArray(cur.domains)) existing = cur.domains;
  } catch {
    /* fresh */
  }
  for (const d of existing) {
    if (!domains.includes(d)) domains.push(d);
  }
  const sorted = saveDomains(domains);
  return { path: cookiesDomainsFile(), count: sorted.length };
}

function writeMeta(domain, headerLine) {
  const count = headerLine.split(';').filter((p) => p.trim()).length;
  const now = Math.floor(Date.now() / 1000);
  const meta = {
    domain,
    synced_at: now,
    synced_iso: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    cookie_count: count,
    stale: false,
  };
  fs.writeFileSync(path.join(domainDir(domain), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return count;
}

function markStale(domain) {
  const metaPath = path.join(domainDir(domain), 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  m.stale = true;
  m.stale_since = Math.floor(Date.now() / 1000);
  fs.writeFileSync(metaPath, `${JSON.stringify(m, null, 2)}\n`);
}

async function syncOne(domain, fetchLive) {
  fs.mkdirSync(domainDir(domain), { recursive: true });
  let hdr = '';
  let cookies = null;
  if (fetchLive) {
    try {
      const live = await fetchLive(domain);
      // fetchLive may return header string OR { header, cookies }
      if (live && typeof live === 'object' && !Array.isArray(live)) {
        hdr = parseHeaderLine(live.header || '');
        cookies = Array.isArray(live.cookies) ? live.cookies : null;
      } else {
        hdr = parseHeaderLine(live);
      }
    } catch {
      hdr = '';
      cookies = null;
    }
  }
  if (!hdr) {
    markStale(domain);
    const err = new Error(`${domain}: no cookies in response (extension down or not logged in)`);
    err.code = 'SYNC_EMPTY';
    throw err;
  }
  fs.writeFileSync(path.join(domainDir(domain), 'header.txt'), hdr);
  if (cookies) writeCookiesJson(domain, cookies);
  const count = writeMeta(domain, hdr);
  return { domain, count };
}

async function syncAll(fetchLive) {
  const names = listDomainNames();
  let ok = 0;
  let fail = 0;
  for (const d of names) {
    try {
      await syncOne(d, fetchLive);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  return { ok, fail };
}

async function readDomain(domain, fetchLive, warn) {
  if (fetchLive) {
    try {
      const hdr = parseHeaderLine(await fetchLive(domain));
      if (hdr) return hdr;
    } catch {
      /* fall through */
    }
  }
  const jar = path.join(domainDir(domain), 'header.txt');
  if (fs.existsSync(jar)) {
    const metaPath = path.join(domainDir(domain), 'meta.json');
    if (fs.existsSync(metaPath) && typeof warn === 'function') {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const age = Math.floor(Date.now() / 1000) - m.synced_at;
      warn(`using jar (${age}s old)`);
    }
    return fs.readFileSync(jar, 'utf8').trim();
  }
  const err = new Error(`no live cookies and no jar for ${domain}`);
  err.code = 'READ_MISS';
  throw err;
}

function ageDomain(domain) {
  const metaPath = path.join(domainDir(domain), 'meta.json');
  if (!fs.existsSync(metaPath)) return '';
  const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return String(Math.floor(Date.now() / 1000) - m.synced_at);
}

function listJars() {
  listDomainNames();
  const rows = [];
  for (const d of listDomainNames()) {
    const metaPath = path.join(domainDir(d), 'meta.json');
    if (fs.existsSync(metaPath)) {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const age = Math.floor(Date.now() / 1000) - m.synced_at;
      rows.push({ domain: d, age: String(age), stale: m.stale ? 'yes' : 'no' });
    } else {
      rows.push({ domain: d, age: 'never', stale: '-' });
    }
  }
  return rows;
}

function addDomain(domain) {
  const names = listDomainNames();
  if (names.includes(domain)) return { added: false, domain };
  names.push(domain);
  saveDomains(names);
  return { added: true, domain };
}

function rmDomain(domain) {
  const names = listDomainNames();
  if (!names.includes(domain)) return { removed: false, domain };
  saveDomains(names.filter((d) => d !== domain));
  return { removed: true, domain };
}

module.exports = {
  parseHeaderLine,
  parseHeaderPairs,
  buildInjectDetails,
  writeCookiesJson,
  injectDomain,
  jarUrlForDomain,
  rebuildDomains,
  syncOne,
  syncAll,
  readDomain,
  ageDomain,
  listJars,
  addDomain,
  rmDomain,
  listDomainNames,
  domainDir,
};
