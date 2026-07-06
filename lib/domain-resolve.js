'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const DOMAIN_CONFIG_PATHS = [
  path.join(os.homedir(), '.glider', 'config', 'domains.json'),
  path.join(os.homedir(), '.glider', 'domains.json'),
];

function warchRoot() {
  const base = process.env.AGREGISTRY ||path.join(os.homedir(), '.glider');
  return path.join(base, 'warch');
}

function loadDomainsIndex() {
  for (const cfgPath of DOMAIN_CONFIG_PATHS) {
    if (!fs.existsSync(cfgPath)) continue;
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (_) { /* ignore */ }
  }
  return {};
}

function hostFromUrl(input) {
  if (!input) return null;
  try {
    const u = input.includes('://') ? input : `https://${input}`;
    return new URL(u).hostname || null;
  } catch (_) {
    return null;
  }
}

function resolveDomain(input) {
  const host = hostFromUrl(input);
  const root = warchRoot();
  const warchPath = host ? path.join(root, host) : null;
  const domains = loadDomainsIndex();
  let indexHit = null;
  for (const [key, val] of Object.entries(domains)) {
    if (key === 'meta' || !val || typeof val !== 'object') continue;
    if (val.host === host || key === host) {
      indexHit = key;
      break;
    }
  }
  const gliderJsonPath = warchPath && path.join(warchPath, 'glider.json');
  const gotchasPath = warchPath && path.join(warchPath, 'gotchas.json');
  const gliderJsonExists = !!(gliderJsonPath && fs.existsSync(gliderJsonPath));
  const gotchasExists = !!(gotchasPath && fs.existsSync(gotchasPath));
  let gliderJson = null;
  if (gliderJsonExists) {
    try {
      gliderJson = JSON.parse(fs.readFileSync(gliderJsonPath, 'utf8'));
    } catch (_) { /* ignore */ }
  }
  return {
    host,
    warch_path: warchPath,
    glider_json_exists: gliderJsonExists,
    gotchas_exists: gotchasExists,
    domains_index_hit: indexHit,
    capture_mode: gliderJson?.capture_mode ?? null,
    wait_ms: gliderJson?.wait_ms ?? null,
  };
}

module.exports = { resolveDomain, hostFromUrl, warchRoot, loadDomainsIndex };
