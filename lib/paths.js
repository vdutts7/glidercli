'use strict';

const os = require('os');
const path = require('path');

/** Runtime data: $GLIDER, else $HOME/.glider. */
function gliderHome() {
  return process.env.GLIDER || path.join(os.homedir(), '.glider');
}

function ensureDir(dir) {
  require('fs').mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ephemeral runtime state (loop state, etc.): $GLIDER/state. */
function stateDir() {
  return ensureDir(path.join(gliderHome(), 'state'));
}

/** Default output for screenshots/pdf/har/favicons/explore: $GLIDER/captures[/sub]. */
function capturesDir(sub) {
  return ensureDir(sub ? path.join(gliderHome(), 'captures', sub) : path.join(gliderHome(), 'captures'));
}

/** Scratch files deleted after use: $GLIDER/tmp. */
function scratchDir() {
  return ensureDir(path.join(gliderHome(), 'tmp'));
}

/** Installed package root (glidercli npm tree). */
function packageRoot() {
  return path.join(__dirname, '..');
}

/** Registry base for warch: $GLIDER. */
function registryBase() {
  return gliderHome();
}

function registryMode() {
  return 'standalone';
}

function configPath(name) {
  const home = gliderHome();
  return [
    path.join(home, 'config', name),
    path.join(home, name),
  ];
}

/** Domain intel: $GLIDER/warch. */
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
  stateDir,
  capturesDir,
  scratchDir,
  packageRoot,
  registryBase,
  registryMode,
  configPath,
  warchRoot,
  domainsTemplatePath,
  expandUser,
  warchDirForHost,
};
