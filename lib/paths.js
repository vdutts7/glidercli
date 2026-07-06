'use strict';

const os = require('os');
const path = require('path');

/** Browser runtime data — always ~/.glider unless GLIDER_HOME set. */
function gliderHome() {
  return process.env.GLIDER_HOME || path.join(os.homedir(), '.glider');
}

/** Installed package root (glidercli npm tree). */
function packageRoot() {
  return path.join(__dirname, '..');
}

/** Registry base for warch: AGREGISTRY or GLIDER_HOME. */
function registryBase() {
  const ag = process.env.AGREGISTRY;
  if (ag) return expandUser(ag);
  return gliderHome();
}

function registryMode() {
  return process.env.AGREGISTRY ? 'agents' : 'standalone';
}

function configPath(name) {
  const home = gliderHome();
  return [
    path.join(home, 'config', name),
    path.join(home, name),
  ];
}

/** Domain intel: $AGREGISTRY/warch or ~/.glider/warch when AGREGISTRY unset. */
function warchRoot() {
  return path.join(registryBase(), 'warch');
}

function domainsTemplatePath() {
  return path.join(packageRoot(), 'config', 'domains.template.json');
}

function expandUser(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/^~(?=$|[/\\])/, os.homedir());
}

/** warch dir: domains.json entry (relative to registryBase) or warch/<host>. */
function warchDirForHost(host, domainsIndex) {
  if (!host) return null;
  const domains = domainsIndex || {};
  const base = registryBase();
  for (const [key, val] of Object.entries(domains)) {
    if (key === 'meta' || !val || typeof val !== 'object') continue;
    if (val.host !== host && key !== host) continue;
    if (val.warch) {
      const raw = expandUser(String(val.warch));
      return path.isAbsolute(raw) ? raw : path.join(base, raw);
    }
    break;
  }
  return path.join(warchRoot(), host);
}

module.exports = {
  gliderHome,
  packageRoot,
  registryBase,
  registryMode,
  configPath,
  warchRoot,
  domainsTemplatePath,
  expandUser,
  warchDirForHost,
};
