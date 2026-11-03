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
  if (fetchLive) {
    try {
      hdr = parseHeaderLine(await fetchLive(domain));
    } catch {
      hdr = '';
    }
  }
  if (!hdr) {
    markStale(domain);
    const err = new Error(`${domain}: no cookies in response (extension down or not logged in)`);
    err.code = 'SYNC_EMPTY';
    throw err;
  }
  fs.writeFileSync(path.join(domainDir(domain), 'header.txt'), hdr);
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
