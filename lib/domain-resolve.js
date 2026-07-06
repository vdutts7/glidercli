'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  configPath,
  gliderHome,
  registryBase,
  registryMode,
  warchDirForHost,
  warchRoot,
} = require('./paths.js');

function loadDomainsIndex() {
  for (const cfgPath of configPath('domains.json')) {
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
  const domains = loadDomainsIndex();
  const warchPath = host ? warchDirForHost(host, domains) : null;
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
    registry_mode: registryMode(),
    glider_home: gliderHome(),
    registry_base: registryBase(),
    warch_root: warchRoot(),
    warch_path: warchPath,
    glider_json_exists: gliderJsonExists,
    gotchas_exists: gotchasExists,
    domains_index_hit: host ? Object.keys(domains).find((k) => {
      if (k === 'meta') return false;
      const v = domains[k];
      return v && typeof v === 'object' && (v.host === host || k === host);
    }) ?? null : null,
    capture_mode: gliderJson?.capture_mode ?? null,
    wait_ms: gliderJson?.wait_ms ?? null,
    auth_mode: gliderJson?.auth_mode ?? null,
  };
}

module.exports = {
  resolveDomain,
  hostFromUrl,
  warchRoot,
  loadDomainsIndex,
  gliderHome,
};
