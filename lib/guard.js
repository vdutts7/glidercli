'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DOMAIN_CONFIG = path.join(os.homedir(), '.glider', 'config', 'allowed-domains.json');

function parseDomainList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfigDomains() {
  if (!fs.existsSync(DOMAIN_CONFIG)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(DOMAIN_CONFIG, 'utf8'));
    return Array.isArray(data) ? data : data.allowed || data.domains || [];
  } catch {
    return [];
  }
}

function resolveAllowedDomains(cliList) {
  const fromEnv = parseDomainList(process.env.GLIDER_ALLOWED_DOMAINS);
  const fromCli = cliList && cliList.length ? cliList : [];
  const fromFile = loadConfigDomains();
  if (fromCli.length) return fromCli;
  if (fromEnv.length) return fromEnv;
  if (fromFile.length) return fromFile;
  return null;
}

function hostMatchesPattern(host, pattern) {
  const h = (host || '').toLowerCase();
  const p = (pattern || '').toLowerCase();
  if (!h || !p) return false;
  if (p.includes('*')) {
    const re = new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
    return re.test(h);
  }
  return h === p || h.endsWith(`.${p}`);
}

function urlAllowed(url, allowed) {
  if (!allowed || !allowed.length) return true;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowed.some((p) => hostMatchesPattern(host, p));
}

function assertUrlAllowed(url, allowed, action) {
  if (urlAllowed(url, allowed)) return;
  const host = (() => {
    try { return new URL(url).hostname; } catch { return url; }
  })();
  throw new Error(`blocked by allowed_domains: ${action} on ${host}`);
}

module.exports = {
  parseDomainList,
  resolveAllowedDomains,
  hostMatchesPattern,
  urlAllowed,
  assertUrlAllowed,
};
