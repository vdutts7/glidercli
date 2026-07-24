#!/usr/bin/env node
/**
 * GLIDER CLI - Browser automation with autonomous loop execution
 * 
 * Commands:
 *   glider status              Check server/extension/tab status
 *   glider start               Start relay server
 *   glider stop                Stop relay server
 *   glider goto <url>          Navigate to URL
 *   glider eval <js>           Execute JavaScript
 *   glider click <selector>    Click element
 *   glider type <sel> <text>   Type into input
 *   glider screenshot [path]   Take screenshot
 *   glider text                Get page text
 *   glider run <task.yaml>     Run YAML task file
 *   glider loop <task> [-n N]  Run task in Ralph Wiggum loop
 * 
 * The loop command implements the Ralph Wiggum pattern:
 * - Continuously executes until task is complete or limits reached
 * - Safety guards: max iterations, timeout, completion detection
 * - Checkpointing and state persistence
 */

const { spawn, execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const YAML = require('yaml');

// Config
const PORT = process.env.GLIDER_PORT || 19988;
const DEBUG_PORT = process.env.GLIDER_DEBUG_PORT || 9222;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;
const LIB_DIR = path.join(__dirname, '..', 'lib');
const STATE_FILE = '/tmp/glider-state.json';
const LOG_FILE = '/tmp/glider.log';
const REGISTRY_FILE = path.join(LIB_DIR, 'registry.json');

// Active CDP session (multi-tab). Env or --session / --session-id on CLI.
let activeSessionId = process.env.GLIDER_SESSION_ID || null;
let jsonOutput = false;
let allowedDomainList = null;
const SESSION_STORE = path.join(os.homedir(), '.glider', 'config', 'active-session.json');
const { resolveAllowedDomains, assertUrlAllowed, urlAllowed } = require(path.join(LIB_DIR, 'guard.js'));
const { buildSnapshotExpression, formatSnapshotText } = require(path.join(LIB_DIR, 'bsnapshot.js'));

// Load pattern registry
let REGISTRY = {};
if (fs.existsSync(REGISTRY_FILE)) {
  try {
    REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch (e) { /* ignore parse errors */ }
}

// Direct CDP module
const { DirectCDP, checkChrome } = require(path.join(LIB_DIR, 'cdp-direct.js'));
const { resolveDomain } = require(path.join(LIB_DIR, 'domain-resolve.js'));

// Domain extensions - load from ~/.glider/config/domains.json
const DOMAIN_CONFIG_PATHS = [
  path.join(os.homedir(), '.glider', 'config', 'domains.json'),
  path.join(os.homedir(), '.glider', 'domains.json'),
];
let DOMAINS = {};
for (const cfgPath of DOMAIN_CONFIG_PATHS) {
  if (fs.existsSync(cfgPath)) {
    try {
      DOMAINS = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      break;
    } catch (e) { /* ignore parse errors */ }
  }
}

// Browser config- which browser to launch/use (must be Chromium-based, see README.md#Browsers)
const BROWSER_CONFIG_PATHS = [
  path.join(os.homedir(), '.glider', 'config', 'browser.json'),
  path.join(os.homedir(), '.glider', 'browser.json'),
];
let BROWSER_CONFIG = {};
for (const cfgPath of BROWSER_CONFIG_PATHS) {
  if (fs.existsSync(cfgPath)) {
    try {
      BROWSER_CONFIG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      break;
    } catch (e) { /* ignore parse errors */ }
  }
}

// Browsers registry - key → { name, path, processName }. Used when browser.json has "use": "<key>"
const BROWSERS_REGISTRY_PATHS = [
  path.join(os.homedir(), '.glider', 'config', 'browsers-registry.json'),
].filter(Boolean);
let BROWSERS_REGISTRY = {};
for (const regPath of BROWSERS_REGISTRY_PATHS) {
  if (regPath && fs.existsSync(regPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      BROWSERS_REGISTRY = data.registry || data;
      break;
    } catch (e) { /* ignore */ }
  }
}

function getBrowserConfig() {
  let name = BROWSER_CONFIG.name || null;
  let pathOrNull = BROWSER_CONFIG.path || null;
  let processName = BROWSER_CONFIG.processName || null;

  // Key-based lookup: browser.json has { "use": "arc" } → resolve from registry
  if (!name && BROWSER_CONFIG.use && BROWSERS_REGISTRY[BROWSER_CONFIG.use]) {
    const entry = BROWSERS_REGISTRY[BROWSER_CONFIG.use];
    name = entry.name;
    pathOrNull = entry.path != null ? entry.path : null;
    processName = entry.processName || entry.name;
  }

  name = name || 'Google Chrome';
  processName = processName || name;
  return { name, path: pathOrNull, processName };
}

// Colors - matching the deep blue gradient logo
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

// Deep blue gradient (matching logo)
const B1 = '\x1b[38;5;17m';   // darkest navy
const B2 = '\x1b[38;5;18m';   // dark navy
const B3 = '\x1b[38;5;19m';   // navy
const B4 = '\x1b[38;5;20m';   // blue
const B5 = '\x1b[38;5;27m';   // bright blue
const B6 = '\x1b[38;5;33m';   // sky blue
const BW = '\x1b[38;5;255m';  // white (for glider icon)

// Banner - hang glider ASCII art matching logo
const BANNER = `
${B1}    ╔══════════════════════════════════════════════════════════╗${NC}
${B2}    ║${NC}                                                          ${B2}║${NC}
${B3}    ║${NC}  ${BW}        ___________________________________${NC}             ${B3}║${NC}
${B4}    ║${NC}  ${BW}       ╲                                   ╲${NC}            ${B4}║${NC}
${B5}    ║${NC}  ${BW}        ╲___________________________________╲${NC}           ${B5}║${NC}
${B5}    ║${NC}  ${BW}         ╲                                 ╱${NC}            ${B5}║${NC}
${B6}    ║${NC}  ${BW}          ╲_______________________________╱${NC}             ${B6}║${NC}
${B6}    ║${NC}                                                          ${B6}║${NC}
${B5}    ║${NC}     ${BW}${BOLD}G L I D E R${NC}                                        ${B5}║${NC}
${B4}    ║${NC}     ${DIM}Browser Automation CLI${NC}  ${B5}v${require('../package.json').version}${NC}                    ${B4}║${NC}
${B3}    ║${NC}     ${DIM}github.com/vdutts7/glidercli${NC}                          ${B3}║${NC}
${B2}    ║${NC}                                                          ${B2}║${NC}
${B1}    ╚══════════════════════════════════════════════════════════╝${NC}
`;

function showBanner() {
  console.log(BANNER);
}

const log = {
  ok: (msg) => console.error(`${GREEN}✓${NC} ${msg}`),
  fail: (msg) => console.error(`${RED}✗${NC} ${msg}`),
  info: (msg) => console.error(`${B5}→${NC} ${msg}`),
  warn: (msg) => console.error(`${YELLOW}⚠${NC} ${msg}`),
  step: (msg) => console.error(`${B6}▸${NC} ${msg}`),
  result: (msg) => console.log(msg),
  box: (title) => {
    const line = '─'.repeat(50);
    console.log(`${B3}┌${line}┐${NC}`);
    console.log(`${B4}│${NC} ${BW}${BOLD}${title.padEnd(48)}${NC} ${B4}│${NC}`);
    console.log(`${B5}└${line}┘${NC}`);
  },
};

// macOS notification helper
function notify(title, message, sound = false) {
  try {
    const soundFlag = sound ? 'sound name "Ping"' : '';
    execSync(`osascript -e 'display notification "${message}" with title "${title}" ${soundFlag}'`, { stdio: 'ignore' });
  } catch {}
}

// HTTP helpers
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_URL);
    http.get(url, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

function loadPersistedSession() {
  if (activeSessionId) return;
  if (!fs.existsSync(SESSION_STORE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_STORE, 'utf8'));
    if (data.sessionId) activeSessionId = data.sessionId;
  } catch { /* ignore */ }
}

function persistSession(sessionId) {
  activeSessionId = sessionId;
  fs.mkdirSync(path.dirname(SESSION_STORE), { recursive: true });
  fs.writeFileSync(SESSION_STORE, JSON.stringify({ sessionId, updated: new Date().toISOString() }, null, 2));
}

function emitJson(ok, observation, error = null, warnings = []) {
  console.log(JSON.stringify({ ok, observation, error, warnings }, null, 2));
  if (!ok) process.exit(1);
}

async function assertCurrentUrlAllowed(action) {
  if (!allowedDomainList) return;
  const result = await httpPost('/cdp', {
    method: 'Runtime.evaluate',
    params: { expression: 'location.href', returnByValue: true },
  });
  const url = result?.result?.value;
  if (url) assertUrlAllowed(url, allowedDomainList, action);
}

function parseGlobalFlags(argv) {
  const rest = [];
  const cliDomains = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--session' || a === '--session-id') && argv[i + 1]) {
      activeSessionId = argv[++i];
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--allowed-domains' && argv[i + 1]) {
      cliDomains.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    } else {
      rest.push(a);
    }
  }
  allowedDomainList = resolveAllowedDomains(cliDomains);
  return rest;
}

function httpPost(urlPath, body) {
  const payload = { ...body };
  if (urlPath === '/cdp' && activeSessionId && payload.sessionId == null) {
    payload.sessionId = activeSessionId;
  }
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_URL);
    const data = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }, (res) => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(result));
        } catch {
          resolve(result);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Server checks
async function checkServer() {
  try {
    await httpGet('/status');
    return true;
  } catch {
    return false;
  }
}

async function checkExtension() {
  try {
    const status = await httpGet('/status');
    return status && status.extension === true;
  } catch {
    return false;
  }
}

async function checkTab() {
  try {
    const targets = await httpGet('/targets');
    return Array.isArray(targets) && targets.length > 0;
  } catch {
    return false;
  }
}

async function getTargets() {
  try {
    return await httpGet('/targets');
  } catch {
    return [];
  }
}

// Auto-connect helper - ensures Chrome is running and connected before commands
async function ensureConnected() {
  // Check if already connected
  if (await checkTab()) {
    return true;
  }
  
  // Check if server is running
  if (!await checkServer()) {
    log.info('Server not running, starting...');
    await cmdStart();
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // Check if Chrome is running
  try {
    execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' });
  } catch {
    log.info('Chrome not running, launching...');
    // Open Chrome with a new window to google.com
    execSync('open -na "Google Chrome" --args --new-window "https://www.google.com"');
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // Wait for extension to connect
  for (let i = 0; i < 10; i++) {
    if (await checkExtension()) break;
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (!await checkExtension()) {
    log.fail('Extension not connected - make sure Glider extension is installed');
    log.info('Install extension from Chrome Web Store: https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj');
    return false;
  }
  
  // Check if we have tabs now
  if (await checkTab()) {
    log.ok('Auto-connected to existing tab');
    return true;
  }
  
  // Need to create/attach to a tab
  try {
    const tabUrl = execSync(`osascript -e 'tell application "Google Chrome" to return URL of active tab of front window'`).toString().trim();
    if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://')) {
      log.info('Creating new tab (current is chrome://)...');
      execSync(`osascript -e 'tell application "Google Chrome" to make new tab at front window with properties {URL:"https://www.google.com"}'`);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {
    // No window exists, create one
    log.info('Creating new Chrome window...');
    execSync(`osascript -e 'tell application "Google Chrome" to make new window with properties {URL:"https://www.google.com"}'`);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // Trigger attach via HTTP
  try {
    const result = await fetch(`${SERVER_URL}/attach`, { method: 'POST' });
    const data = await result.json();
    if (data.attached > 0) {
      log.ok('Auto-connected!');
      return true;
    }
  } catch {}
  
  // Final fallback - create fresh tab
  log.info('Creating fresh tab...');
  execSync(`osascript -e 'tell application "Google Chrome" to make new tab at front window with properties {URL:"https://www.google.com"}'`);
  await new Promise(r => setTimeout(r, 2000));
  
  try {
    const result = await fetch(`${SERVER_URL}/attach`, { method: 'POST' });
    const data = await result.json();
    if (data.attached > 0) {
      log.ok('Auto-connected!');
      return true;
    }
  } catch {}
  
  log.fail('Could not auto-connect');
  return false;
}

// Commands
async function cmdStatus() {
  showBanner();
  log.box('STATUS');
  
  const serverOk = await checkServer();
  console.log(serverOk ? `  ${GREEN}✓${NC} Server running on port ${PORT}` : `  ${RED}✗${NC} Server not running`);
  
  if (serverOk) {
    const extOk = await checkExtension();
    console.log(extOk ? `  ${GREEN}✓${NC} Extension connected` : `  ${RED}✗${NC} Extension not connected`);
    
    if (extOk) {
      const targets = await getTargets();
      if (targets.length > 0) {
        console.log(`  ${GREEN}✓${NC} ${targets.length} tab(s) connected:`);
        targets.forEach(t => {
          const url = t.targetInfo?.url || 'unknown';
          console.log(`      ${B5}${url}${NC}`);
        });
      } else {
        console.log(`  ${YELLOW}⚠${NC} No tabs connected`);
        console.log(`      ${DIM}Run: glider connect${NC}`);
      }
    }
  } else {
    console.log(`      ${DIM}Run: glider install${NC}`);
  }
  console.log();
}

async function cmdStart() {
  if (await checkServer()) {
    log.ok('Server already running');
    return;
  }
  
  log.info('Starting glider server...');
  const bserve = path.join(LIB_DIR, 'bserve.js');
  
  if (!fs.existsSync(bserve)) {
    log.fail(`bserve not found at ${bserve}`);
    process.exit(1);
  }
  
  const child = spawn('node', [bserve], {
    detached: true,
    stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')],
  });
  child.unref();
  
  // Wait for server
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkServer()) {
      log.ok('Server started');
      return;
    }
  }
  log.fail('Server failed to start');
  process.exit(1);
}

async function cmdStop() {
  try {
    execSync('pkill -f bserve', { stdio: 'ignore' });
    log.ok('Server stopped');
  } catch {
    log.warn('Server was not running');
  }
}

async function cmdGoto(url) {
  if (!url) {
    log.fail('Usage: glider goto <url>');
    process.exit(1);
  }
  
  if (!await ensureConnected()) {
    process.exit(1);
  }

  try {
    assertUrlAllowed(url, allowedDomainList, 'goto');
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(e.message);
    process.exit(1);
  }
  
  if (!jsonOutput) log.info(`Navigating to: ${url}`);
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Page.navigate',
      params: { url }
    });
    // v0.3.15: detect nav errors; auto-attach after successful goto.
    // Prior code printed raw result THEN unconditionally logged '✓ Navigated' -
    // even when result contained {"error":"Session not found"} (stale pinned session after reload-ext).
    // Now: detect embedded error, don't lie about success, then auto-attach the target tab.
    const hasErr = result && (result.error || (typeof result === 'string' && result.includes('error')));
    if (jsonOutput) {
      emitJson(!hasErr, { url, navigate: result }, hasErr ? (result.error?.message || result.error || 'unknown') : null);
    } else if (hasErr) {
      log.fail(`Navigation reported error: ${JSON.stringify(result)}`);
      log.info('  hint: pinned session may be stale (e.g. after reload-ext). Try `glider attach-all` or unset GLIDER_SESSION_ID.');
    } else {
      log.ok('Navigated');
      // Auto-attach the tab we just navigated to (best-effort, non-fatal on failure).
      // Uses URL host as substring filter so we don't accidentally re-attach unrelated tabs.
      try {
        const u = new URL(url);
        const host = u.hostname;
        // small delay lets the tab actually load + register in chrome.tabs before attach
        await new Promise(x => setTimeout(x, 800));
        const attach = await postExtension({ method: 'attachAllTabs', params: { urlSubstring: host } });
        const d = attach.result ?? attach;
        if ((d.attached ?? 0) > 0) {
          log.info(`  auto-attached ${d.attached} tab(s) matching host="${host}"`);
        }
      } catch (attErr) {
        // silent: nav succeeded, auto-attach is a nice-to-have
      }
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Navigation failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdEval(js) {
  if (!js) {
    log.fail('Usage: glider eval <javascript>');
    process.exit(1);
  }
  
  // Auto-connect if not connected
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }
    });
    
    const value = result.result?.value;
    if (jsonOutput) {
      emitJson(true, value !== undefined ? value : result.result);
    } else if (value !== undefined) {
      console.log(JSON.stringify(value));
    } else if (result.result?.description) {
      console.log(result.result.description);
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Eval failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdClick(selector) {
  if (!selector) {
    log.fail('Usage: glider click <selector>');
    process.exit(1);
  }
  
  if (!await ensureConnected()) {
    process.exit(1);
  }

  try {
    await assertCurrentUrlAllowed('click');
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(e.message);
    process.exit(1);
  }
  
  const js = `
    (() => {
      const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
      if (!el) return { error: 'Element not found' };
      el.click();
      return { clicked: true };
    })()
  `;
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: { expression: js, returnByValue: true }
    });
    
    if (result.result?.value?.error) {
      if (jsonOutput) emitJson(false, null, result.result.value.error);
      log.fail(result.result.value.error);
      process.exit(1);
    }
    if (jsonOutput) {
      emitJson(true, { selector, clicked: true });
    } else {
      log.ok(`Clicked: ${selector}`);
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Click failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdType(selector, text) {
  if (!selector || !text) {
    log.fail('Usage: glider type <selector> <text>');
    process.exit(1);
  }
  
  // Auto-connect if not connected
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  const js = `
    (() => {
      const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
      if (!el) return { error: 'Element not found' };
      el.focus();
      el.value = '${text.replace(/'/g, "\\'")}';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { typed: true };
    })()
  `;
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: { expression: js, returnByValue: true }
    });
    
    if (result.result?.value?.error) {
      log.fail(result.result.value.error);
      process.exit(1);
    }
    log.ok(`Typed into: ${selector}`);
  } catch (e) {
    log.fail(`Type failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdScreenshot(outputPath) {
  const filePath = outputPath || `/tmp/glider-screenshot-${Date.now()}.png`;
  
  // Auto-connect if not connected
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Page.captureScreenshot',
      params: { format: 'png' }
    });
    
    if (result.data) {
      fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
      log.ok(`Screenshot saved: ${filePath}`);
    } else {
      log.fail('No screenshot data received');
      process.exit(1);
    }
  } catch (e) {
    log.fail(`Screenshot failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdText() {
  // Auto-connect if not connected
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: {
        expression: 'document.body.innerText',
        returnByValue: true,
      }
    });
    console.log(result.result?.value || '');
  } catch (e) {
    log.fail(`Text extraction failed: ${e.message}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════
// NEW COMMANDS: restart, test, tabs, domains, open, html, title, url
// ═══════════════════════════════════════════════════════════════════

async function cmdRestart() {
  await cmdStop();
  await new Promise(r => setTimeout(r, 500));
  await cmdStart();
}

// reload-ext: automate extension reload + tab re-attachment
async function cmdReloadExt() {
  try {
    const r = await postExtension({ method: 'reloadSelf', params: {} });
    // v0.3.15: same response unwrap fix as attach-all - r.result was always undefined
    const persisted = (r.result?.persisted ?? r.persisted ?? '?');
    log.ok(`Extension reload triggered (persisted ${persisted} tab URLs).`);
    log.info('Waiting 4s for extension to boot back up + reconnect...');
    await new Promise(x => setTimeout(x, 4000));
    // Extension reboots → autoAttachActiveTab restores from chrome.storage
    // Confirm state
    const st = await httpGetJson('/status');
    log.ok(`relay reconnected: extension=${st.extension} targets=${st.targets}`);
  } catch (e) {
    log.fail(`reload-ext failed: ${e.message}`);
    log.info('First-time bootstrap: open your browser extensions page and reload Glider (one time only).');
  }
}

async function cmdAttachAll(filter) {
  try {
    const r = await postExtension({ method: 'attachAllTabs', params: filter ? { urlSubstring: filter } : {} });
    // v0.3.15: attach-all response unwrap fix -
    // relay's sendToExtension unwraps msg.result before HTTP POST responds, so relay body is {attached, skipped, failed, total_connected} bare.
    // Prior code read r.result.attached which was always undefined → literal '?' placeholders on every attach-all.
    const d = r.result ?? r;
    const attached = d.attached ?? 0;
    const skipped = d.skipped ?? 0;
    const failed = d.failed ?? 0;
    const total = d.total_connected ?? 0;
    log.ok(`attach-all: attached=${attached} skipped=${skipped} failed=${failed} total_connected=${total}`);
    if (filter && attached === 0 && total > 0) {
      log.info(`  hint: filter "${filter}" matched 0 new tabs. Try 'glider attach-all' with no filter, or check 'glider tabs' for URL substrings that would match.`);
    }
  } catch (e) {
    log.fail(`attach-all failed: ${e.message}`);
  }
}

// Helper: POST to relay's /extension endpoint (already exists in bserve.js)
async function postExtension(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 19988, path: '/extension', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          if (j.error) reject(new Error(j.error.message || j.error));
          else resolve(j);
        } catch(e) { reject(new Error('bad JSON from /extension: ' + s.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function httpGetJson(pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 19988, path: pathStr }, (res) => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// Daemon management - runs forever, respawns on crash
async function cmdInstallDaemon() {
  const home = os.homedir();
  const daemonScript = path.join(LIB_DIR, 'glider-daemon.sh');
  const logDir = path.join(home, '.glider');
  const pidFile = path.join(logDir, 'daemon.pid');
  
  // Create log directory
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  // Kill existing daemon
  if (fs.existsSync(pidFile)) {
    try {
      const pid = fs.readFileSync(pidFile, 'utf8').trim();
      execSync(`kill ${pid} 2>/dev/null || true`, { stdio: 'ignore' });
    } catch {}
  }
  
  // Start daemon in background, detached from terminal
  const child = spawn('nohup', [daemonScript], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: home
  });
  child.unref();
  
  await new Promise(r => setTimeout(r, 1000));
  
  if (fs.existsSync(pidFile)) {
    log.ok('Daemon started');
    log.info('Relay will auto-restart on crash');
    log.info(`Logs: ${logDir}/daemon.log`);
    log.info(`PID: ${fs.readFileSync(pidFile, 'utf8').trim()}`);
  } else {
    log.fail('Daemon failed to start');
  }
}

async function cmdUninstallDaemon() {
  const home = os.homedir();
  const pidFile = path.join(home, '.glider', 'daemon.pid');
  
  if (!fs.existsSync(pidFile)) {
    log.info('Daemon not running');
    return;
  }
  
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    execSync(`kill ${pid}`, { stdio: 'ignore' });
    fs.unlinkSync(pidFile);
    log.ok('Daemon stopped');
  } catch (e) {
    log.fail(`Failed to stop: ${e.message}`);
  }
}

async function cmdConnect() {
  // Bulletproof connect: relay + browser + trigger attach via HTTP
  log.info('Connecting...');
  
  // 1. Ensure relay is running
  if (!await checkServer()) {
    await cmdStart();
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 2. Ensure browser is running (see getBrowserConfig + README.md#Browsers)
  const browser = getBrowserConfig();
  try {
    execSync(`pgrep -x "${browser.processName}"`, { stdio: 'ignore' });
  } catch {
    log.info(`Starting ${browser.name}...`);
    if (browser.path) {
      execSync(`open "${browser.path}"`, { stdio: 'ignore' });
    } else {
      execSync(`open -a "${browser.name}"`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // 3. Wait for extension to connect to relay
  for (let i = 0; i < 10; i++) {
    if (await checkExtension()) break;
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (!await checkExtension()) {
    log.fail('Extension not connected to relay');
    log.info(`Make sure Glider extension is installed in ${browser.name} (Chromium-based only; see glider README.md#Browsers)`);
    process.exit(1);
  }
  log.ok('Extension connected');
  
  // Wait for extension to fully initialize
  await new Promise(r => setTimeout(r, 500));
  
  // 4. Check if already have targets
  if (await checkTab()) {
    log.ok('Already connected to tab(s)');
    const targets = await getTargets();
    targets.slice(0, 3).forEach(t => {
      console.log(`  ${CYAN}${t.targetInfo?.url || 'unknown'}${NC}`);
    });
    return;
  }
  
  // 5. Ensure we have a real tab (not chrome:// or arc://)
  try {
    const tabUrl = execSync(`osascript -e 'tell application "${browser.name}" to return URL of active tab of front window'`).toString().trim();
    if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('arc://')) {
      log.info('Creating new tab...');
      execSync(`osascript -e 'tell application "${browser.name}" to make new tab at front window with properties {URL:"https://google.com"}'`);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {
    // No window, create one
    log.info('Creating new window...');
    execSync(`osascript -e 'tell application "${browser.name}" to make new window with properties {URL:"https://google.com"}'`);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // 6. Trigger attach via HTTP endpoint (no pixel clicking needed!)
  log.info('Attaching to tab...');
  try {
    const result = await fetch(`${SERVER_URL}/attach`, { method: 'POST' });
    const data = await result.json();
    
    if (data.attached > 0) {
      log.ok('Connected!');
      const targets = await getTargets();
      targets.slice(0, 3).forEach(t => {
        console.log(`  ${CYAN}${t.targetInfo?.url || 'unknown'}${NC}`);
      });
      return;
    }
  } catch (e) {
    log.warn(`Attach failed: ${e.message}`);
  }
  
  // 7. Fallback: create fresh tab and retry
  log.info('Creating fresh tab...');
  execSync(`osascript -e 'tell application "${browser.name}" to make new tab at front window with properties {URL:"https://google.com"}'`);
  await new Promise(r => setTimeout(r, 2000));
  
  try {
    const result = await fetch(`${SERVER_URL}/attach`, { method: 'POST' });
    const data = await result.json();
    
    if (data.attached > 0) {
      log.ok('Connected!');
      const targets = await getTargets();
      targets.slice(0, 3).forEach(t => {
        console.log(`  ${CYAN}${t.targetInfo?.url || 'unknown'}${NC}`);
      });
      return;
    }
  } catch {}
  
  // 8. Need manual click - activate browser and show instructions
  log.warn(`Click the Glider extension icon in ${browser.name}`);
  console.log(`  ${B5}(on any real webpage, not chrome:// or arc:// pages)${NC}`);
  execSync(`osascript -e 'tell application "${browser.name}" to activate'`);
  
  // Send macOS notification so user sees it even if not looking at terminal
  notify('Glider', `Click the extension icon in ${browser.name} to connect`, true);
  
  // Wait for user to click
  log.info('Waiting for connection...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkTab()) {
      log.ok('Connected!');
      notify('Glider', 'Connected to browser');
      const targets = await getTargets();
      targets.slice(0, 3).forEach(t => {
        console.log(`  ${B5}${t.targetInfo?.url || 'unknown'}${NC}`);
      });
      return;
    }
  }
  
  log.fail('Timed out waiting for connection');
  notify('Glider', 'Connection timed out - click extension icon', true);
  log.info('Make sure you clicked the extension icon on a real webpage');
}

function cmdBrowser() {
  const b = getBrowserConfig();
  console.log('Browser config (used by glider connect):');
  console.log(`  name:         ${b.name}`);
  console.log(`  path:         ${b.path || '(default launch via name)'}`);
  console.log(`  processName:  ${b.processName}`);
  if (BROWSER_CONFIG.use) {
    console.log(`  use:          ${BROWSER_CONFIG.use} ${DIM}(from registry)${NC}`);
  }
  console.log('');
  console.log('Source: ~/.glider/config/browser.json { "use": "<key>" } or { name, path } → default "Google Chrome"');
  console.log('Registry: ~/.glider/config/browsers-registry.json. Keys: ' + (Object.keys(BROWSERS_REGISTRY).join(', ') || '(none loaded)'));
  console.log('See README.md#browsers for compatibility and examples.');
}

function cmdUse(key) {
  if (!key) {
    console.log('Usage: glider use <key>');
    console.log('Keys in registry: ' + (Object.keys(BROWSERS_REGISTRY).length ? Object.keys(BROWSERS_REGISTRY).join(', ') : '(no registry loaded)'));
    if (BROWSER_CONFIG.use) console.log('Current: ' + BROWSER_CONFIG.use);
    return;
  }
  if (!BROWSERS_REGISTRY[key]) {
    console.error('Unknown key: ' + key + '. Available: ' + Object.keys(BROWSERS_REGISTRY).join(', '));
    process.exit(1);
  }
  const configDir = path.join(os.homedir(), '.glider', 'config');
  const browserPath = path.join(configDir, 'browser.json');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(browserPath, JSON.stringify({ use: key }, null, 2) + '\n');
  console.log('Set browser to: ' + key + ' → ' + BROWSERS_REGISTRY[key].name);
  console.log('Run: glider connect');
}

async function cmdTest() {
  showBanner();
  log.box('DIAGNOSTICS');
  
  // Test 1: Server
  const serverOk = await checkServer();
  console.log(serverOk ? `  ${GREEN}✓${NC} ${B5}[1/4]${NC} Server` : `  ${RED}✗${NC} ${B5}[1/4]${NC} Server`);
  if (!serverOk) {
    log.info('Starting server...');
    await cmdStart();
  }
  
  // Test 2: Extension
  const extOk = await checkExtension();
  console.log(extOk ? `  ${GREEN}✓${NC} ${B5}[2/4]${NC} Extension` : `  ${RED}✗${NC} ${B5}[2/4]${NC} Extension`);
  
  // Test 3: Tab
  const tabOk = await checkTab();
  console.log(tabOk ? `  ${GREEN}✓${NC} ${B5}[3/4]${NC} Tab attached` : `  ${RED}✗${NC} ${B5}[3/4]${NC} No tabs`);
  
  // Test 4: CDP command
  if (tabOk) {
    try {
      const result = await httpPost('/cdp', {
        method: 'Runtime.evaluate',
        params: { expression: '1+1', returnByValue: true }
      });
      const cdpOk = result.result?.value === 2;
      console.log(cdpOk ? `${GREEN}[4/4]${NC} CDP: OK` : `${RED}[4/4]${NC} CDP: FAIL`);
    } catch {
      console.log(`${RED}[4/4]${NC} CDP: FAIL`);
    }
  } else {
    console.log(`${YELLOW}[4/4]${NC} CDP: SKIPPED (no tab)`);
  }
  
  console.log('═══════════════════════════════════════');
}

async function cmdTabs() {
  const targets = await getTargets();
  if (targets.length === 0) {
    log.warn('No tabs connected');
    return;
  }
  console.log(`${GREEN}${targets.length}${NC} tab(s) connected:\n`);
  targets.forEach((t, i) => {
    const url = t.targetInfo?.url || 'unknown';
    const title = t.targetInfo?.title || '';
    console.log(`  ${CYAN}[${i + 1}]${NC} ${title}`);
    console.log(`      ${DIM}${url}${NC}`);
  });
}

async function cmdWindow(args) {
  const { WindowManager } = require(path.join(LIB_DIR, 'bwindow.js'));
  const wm = new WindowManager();
  
  try {
    await wm.connect();
    await wm.init();
    
    const subcmd = args[0] || 'list';
    
    switch (subcmd) {
      case 'new':
      case 'create': {
        const url = args[1] || 'about:blank';
        log.info(`Creating new window: ${url}`);
        const result = await wm.createWindow(url);
        log.ok(`Window created: ${result.targetId}`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      
      case 'tab': {
        const url = args[1] || 'about:blank';
        log.info(`Creating new tab: ${url}`);
        const result = await wm.createTab(url);
        log.ok(`Tab created: ${result.targetId}`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      
      case 'close': {
        const targetId = args[1];
        if (!targetId) {
          log.fail('targetId required');
          return;
        }
        log.info(`Closing: ${targetId}`);
        const result = await wm.closeTarget(targetId);
        if (result.success) {
          log.ok(`Closed: ${targetId}`);
        } else {
          log.fail(`Failed to close: ${result.error}`);
        }
        break;
      }
      
      case 'closeall': {
        log.info('Closing all Glider-created tabs...');
        const results = await wm.closeAll();
        const success = results.filter(r => r.success).length;
        log.ok(`Closed ${success}/${results.length} tabs`);
        break;
      }
      
      case 'focus': {
        const targetId = args[1];
        if (!targetId) {
          log.fail('targetId required');
          return;
        }
        const result = await wm.focusTarget(targetId);
        if (result.success) {
          log.ok(`Focused: ${targetId}`);
        } else {
          log.fail(`Failed to focus: ${result.error}`);
        }
        break;
      }
      
      case 'list':
      default: {
        const targets = wm.list();
        if (targets.length === 0) {
          log.warn('No windows/tabs tracked');
        } else {
          console.log(`${GREEN}${targets.length}${NC} target(s):\n`);
          targets.forEach((t, i) => {
            const marker = t.createdByGlider ? `${GREEN}●${NC}` : `${DIM}○${NC}`;
            console.log(`  ${marker} ${CYAN}${t.targetId.substring(0, 16)}...${NC}`);
            console.log(`      ${DIM}${t.url || 'unknown'}${NC}`);
          });
        }
        break;
      }
    }
  } catch (err) {
    log.fail(err.message);
  } finally {
    wm.close();
  }
}

async function cmdDomains() {
  const domainKeys = Object.keys(DOMAINS).filter((k) => k !== 'meta');
  if (domainKeys.length === 0) {
    log.warn('No domains configured');
    log.info('Add domains to ~/.glider/config/domains.json');
    return;
  }
  console.log(`${GREEN}${domainKeys.length}${NC} domain(s) configured:\n`);
  for (const key of domainKeys) {
    const d = DOMAINS[key];
    const shortcut = d.shortcut || {};
    const type = shortcut.type || (d.script ? 'script' : d.url ? 'url' : 'none');
    const target = shortcut.target || d.script || d.url || '';
    console.log(`  ${CYAN}${key}${NC} ${DIM}(${type})${NC}`);
    if (d.host) console.log(`      ${DIM}host: ${d.host}${NC}`);
    if (d.warch) console.log(`      ${DIM}warch: ${d.warch}${NC}`);
    if (d.description) console.log(`      ${d.description}`);
    if (target) console.log(`      ${DIM}${target}${NC}`);
  }
}

async function cmdResolve(input, opts = []) {
  if (!input) {
    log.fail('Usage: glider resolve <url|host> [--json]');
    process.exit(1);
  }
  const result = resolveDomain(input);
  if (opts.includes('--json') || jsonOutput) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdOpen(url) {
  if (!url) {
    log.fail('Usage: glider open <url>');
    process.exit(1);
  }
  
  // Open URL in default browser (not in connected tab)
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      log.fail(`Failed to open: ${err.message}`);
      process.exit(1);
    }
    log.ok(`Opened: ${url}`);
  });
}

async function cmdHtml(selector) {
  // Auto-connect if not connected
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  try {
    const expression = selector 
      ? `document.querySelector('${selector.replace(/'/g, "\\'")}')?.outerHTML || 'Element not found'`
      : 'document.documentElement.outerHTML';
    
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    });
    console.log(result.result?.value || '');
  } catch (e) {
    log.fail(`HTML extraction failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdTitle() {
  // Auto-connect if not connected
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true }
    });
    console.log(result.result?.value || '');
  } catch (e) {
    log.fail(`Title extraction failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdUrl() {
  if (!await ensureConnected()) {
    process.exit(1);
  }
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: { expression: 'window.location.href', returnByValue: true }
    });
    const url = result.result?.value || '';
    if (jsonOutput) emitJson(true, { url });
    else console.log(url);
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`URL extraction failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdSnapshot(opts = []) {
  let interactiveOnly = false;
  for (const o of opts) {
    if (o === '--interactive-only' || o === '-i') interactiveOnly = true;
  }
  if (!await ensureConnected()) process.exit(1);
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: {
        expression: buildSnapshotExpression(interactiveOnly),
        returnByValue: true,
        awaitPromise: true,
      },
    });
    const data = result?.result?.value;
    if (!data || data.error) {
      const err = data?.error || 'snapshot failed';
      if (jsonOutput) emitJson(false, null, err);
      log.fail(err);
      process.exit(1);
    }
    if (jsonOutput) {
      emitJson(true, data);
    } else {
      console.log(formatSnapshotText(data));
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Snapshot failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdTargets() {
  const raw = await httpGet('/targets');
  const targets = (Array.isArray(raw) ? raw : []).map((t) => ({
    sessionId: t.sessionId,
    targetId: t.targetId,
    title: t.title || t.targetInfo?.title || '',
    url: t.url || t.targetInfo?.url || '',
  }));
  if (jsonOutput) {
    emitJson(true, { targets, activeSessionId });
  } else {
    if (!targets.length) {
      log.warn('No targets');
      return;
    }
    console.log(`${GREEN}${targets.length}${NC} target(s):\n`);
    for (const t of targets) {
      const mark = t.sessionId === activeSessionId ? `${GREEN}*${NC} ` : '  ';
      console.log(`${mark}${CYAN}${t.sessionId}${NC}  ${t.title}`);
      console.log(`      ${DIM}${t.url}${NC}`);
    }
  }
}

async function cmdUseSession(arg, opts = []) {
  let sessionId = arg;
  const urlIdx = opts.indexOf('--url');
  if (urlIdx >= 0 && opts[urlIdx + 1]) {
    const needle = opts[urlIdx + 1];
    const raw = await httpGet('/targets');
    const targets = Array.isArray(raw) ? raw : [];
    const hit = targets.find((t) => {
      const u = t.url || t.targetInfo?.url || '';
      return u.includes(needle);
    });
    if (!hit) {
      const msg = `no target matching --url ${needle}`;
      if (jsonOutput) emitJson(false, null, msg);
      log.fail(msg);
      process.exit(1);
    }
    sessionId = hit.sessionId;
  }
  if (!sessionId) {
    log.fail('Usage: glider use-session <sessionId> | glider use-session --url <host-fragment>');
    process.exit(1);
  }
  persistSession(sessionId);
  if (jsonOutput) {
    emitJson(true, { sessionId, persisted: SESSION_STORE });
  } else {
    log.ok(`Active session: ${sessionId}`);
    console.log(SESSION_STORE);
  }
}

// Fetch URL using browser session (authenticated)
async function cmdFetch(url, opts = []) {
  if (!url) {
    log.fail('Usage: glider fetch <url> [--output file]');
    process.exit(1);
  }
  
  try {
    assertUrlAllowed(url, allowedDomainList, 'fetch');
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(e.message);
    process.exit(1);
  }

  if (!jsonOutput) log.info(`Fetching: ${url}`);
  
  let outputFile = null;
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--output' || opts[i] === '-o') {
      outputFile = opts[++i];
    }
  }
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (async () => {
            const resp = await fetch(${JSON.stringify(url)});
            const text = await resp.text();
            try { return JSON.parse(text); } catch { return text; }
          })()
        `,
        awaitPromise: true,
        returnByValue: true
      }
    });
    
    const data = result?.result?.value;
    const output = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
    
    if (jsonOutput) {
      emitJson(true, { url, data });
    } else if (outputFile) {
      fs.writeFileSync(outputFile, output);
      log.ok(`Saved to ${outputFile}`);
    } else {
      console.log(output);
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Fetch failed: ${e.message}`);
    process.exit(1);
  }
}

// CORS-bypassing fetch via extension context
async function cmdCorsFetch(url, opts = []) {
  if (!url) {
    log.fail('Usage: glider cfetch <url> [--output file] [--method POST] [--body JSON]');
    process.exit(1);
  }
  
  log.info(`CORS Fetch: ${url}`);
  
  let outputFile = null;
  let method = 'GET';
  let body = null;
  
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--output' || opts[i] === '-o') {
      outputFile = opts[++i];
    } else if (opts[i] === '--method' || opts[i] === '-X') {
      method = opts[++i];
    } else if (opts[i] === '--body' || opts[i] === '-d') {
      body = opts[++i];
    }
  }
  
  try {
    // Browser-typical Accept by default (unlocks Yammer-family 406-strict endpoints).
    const defaultAccept = 'application/json, text/plain, */*';
    async function doFetch(acceptHeader) {
      return httpPost('/extension', {
        method: 'corsFetch',
        params: {
          url,
          options: { method, body, headers: { 'Accept': acceptHeader } }
        }
      });
    }

    let result = await doFetch(defaultAccept);
    // /extension response envelope varies (flat vs wrapped); normalize
    let payload = result?.result ?? result;
    // 2-shot Accept fallback: if server returns 406 on the loose Accept, retry strict
    if (payload?.status === 406) {
      result = await doFetch('application/json');
      payload = result?.result ?? result;
    }

    if (result?.error) {
      log.fail(`Fetch error: ${result.error}`);
      process.exit(1);
    }

    // cli_gap: cfetch_empty_response_crash - data may be undefined/null on empty bodies
    let data = payload?.data;
    if (data === undefined || data === null) data = '';
    const output = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    
    if (outputFile) {
      fs.writeFileSync(outputFile, output);
      log.ok(`Saved to ${outputFile} (status: ${payload?.status})`);
    } else {
      console.log(output);
    }
  } catch (e) {
    log.fail(`CORS Fetch failed: ${e.message}`);
    process.exit(1);
  }
}


// Detect if the attached tab is under Chrome hidden-tab throttling.
// Primitive: runtime_evaluate_sync_reads.
// Recipe: eval document.visibilityState + '|' + document.hidden.
// Semantics: 'hidden|true' → macrotasks (setTimeout/fetch/XHR/workers) will not fire.
// Exit code: 0 if visible, 1 if hidden (chainable in scripts).
async function cmdFrozen(opts = []) {
  let sessionId = null;
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === '--session' || a === '--sessionId') sessionId = opts[++i];
    else if (a === '--help') {
      console.log('Usage: glider frozen [--session <id>]');
      console.log('  Detect whether the attached tab is macrotask-frozen (hidden).');
      console.log('  Exit code: 0 = visible, 1 = hidden (frozen).');
      return;
    }
  }
  if (!await ensureConnected()) process.exit(1);

  const js = `document.visibilityState + '|' + document.hidden + '|' + (document.wasDiscarded||false)`;
  try {
    const cdpParams = { method: 'Runtime.evaluate', params: { expression: js, returnByValue: true } };
    if (sessionId) cdpParams.sessionId = sessionId;
    const result = await httpPost('/cdp', cdpParams);
    if (result && result.error && !result.result) {
      const msg = `CDP error: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`;
      if (jsonOutput) emitJson(false, null, msg);
      log.fail(msg);
      process.exit(2);
    }
    const value = result?.result?.value;
    if (!value) {
      if (jsonOutput) emitJson(false, null, 'no value');
      log.fail('No value returned');
      process.exit(2);
    }
    const [visibilityState, hidden, wasDiscarded] = String(value).split('|');
    const frozen = hidden === 'true';
    const out = { visibilityState, hidden: frozen, wasDiscarded: wasDiscarded === 'true', frozen };
    if (jsonOutput) {
      emitJson(true, out);
    } else {
      if (frozen) {
        log.warn(`FROZEN - visibilityState=${visibilityState} hidden=${hidden} wasDiscarded=${wasDiscarded}`);
        log.info('Macrotasks (setTimeout/fetch/XHR/workers) will not fire until user focuses tab.');
      } else {
        log.ok(`live - visibilityState=${visibilityState} hidden=${hidden} wasDiscarded=${wasDiscarded}`);
      }
    }
    process.exit(frozen ? 1 : 0);
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`frozen check failed: ${e.message}`);
    process.exit(2);
  }
}

// Thaw a macrotask-frozen tab WITHOUT touching the OS window.
//
// Chrome throttles/pauses macrotasks (setTimeout, fetch, XHR, workers, and MSAL
// token refresh) on any tab whose window is minimized or fully occluded --
// document.visibilityState reports 'hidden' and `glider frozen` exits 1. Neither
// Page.bringToFront nor Target.activateTarget un-hide a minimized window, so the
// tab stays frozen. Emulation.setFocusEmulationEnabled + Page.setWebLifecycleState
// ('active') flip the renderer to a focused/active lifecycle state and un-throttle
// it in place -- async fires again within a couple hundred ms, no window restore
// needed. Reverse of `glider frozen` (which only detects). Idempotent.
async function cmdThaw(opts = []) {
  let sessionId = null;
  let all = false;
  let verify = false;
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === '--session' || a === '--sessionId') sessionId = opts[++i];
    else if (a === '--all') all = true;
    else if (a === '--verify') verify = true;
    else if (a === '--help') {
      console.log('Usage: glider thaw [--session <id>] [--all] [--verify]');
      console.log('  Un-throttle a macrotask-frozen (hidden/minimized) tab in place so');
      console.log('  setTimeout/fetch/XHR/workers + token refresh resume -- no window restore.');
      console.log('  --all     thaw every attached tab');
      console.log('  --verify  re-check visibility + async liveness after thawing');
      console.log('  Reverse of `glider frozen` (detect). Idempotent.');
      return;
    }
  }
  if (!await ensureConnected()) process.exit(1);

  let sessions;
  if (all) {
    const raw = await httpGet('/targets');
    sessions = (Array.isArray(raw) ? raw : []).map((t) => t.sessionId).filter(Boolean);
    if (!sessions.length) { log.warn('No targets to thaw'); return; }
  } else {
    sessions = [sessionId || activeSessionId || null];
  }

  const results = [];
  for (const sid of sessions) {
    const p1 = { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } };
    const p2 = { method: 'Page.setWebLifecycleState', params: { state: 'active' } };
    if (sid) { p1.sessionId = sid; p2.sessionId = sid; }
    try {
      await httpPost('/cdp', p1);
      await httpPost('/cdp', p2);
      const entry = { sessionId: sid || activeSessionId || '(pinned)', thawed: true };
      if (verify) {
        const vp = { method: 'Runtime.evaluate', params: { expression: `document.visibilityState`, returnByValue: true } };
        if (sid) vp.sessionId = sid;
        const vr = await httpPost('/cdp', vp);
        entry.visibilityState = vr?.result?.value;
        const ap = { method: 'Runtime.evaluate', params: { expression: `new Promise(r=>setTimeout(()=>r('ALIVE'),250))`, returnByValue: true, awaitPromise: true } };
        if (sid) ap.sessionId = sid;
        const ar = await httpPost('/cdp', ap);
        entry.asyncAlive = ar?.result?.value === 'ALIVE';
      }
      results.push(entry);
    } catch (e) {
      results.push({ sessionId: sid || '(pinned)', thawed: false, error: e.message });
    }
  }

  if (jsonOutput) {
    emitJson(true, all ? { thawed: results } : results[0]);
  } else {
    for (const r of results) {
      if (!r.thawed) { log.fail(`thaw failed (${r.sessionId}): ${r.error}`); continue; }
      let extra = '';
      if (verify) extra = ` - visibilityState=${r.visibilityState} asyncAlive=${r.asyncAlive}`;
      log.ok(`thawed ${r.sessionId}${extra}`);
    }
  }
}

// List cookies for a URL (including HttpOnly) via extension chrome.cookies.getAll bridge.
// Primitive: extension_ws_bridge (background.js exposes method:'getCookies').
// Note: this reads via the CRX cookies API - HttpOnly cookies (ESTSAUTH, s.SessID etc.)
//       ARE returned because MV3 extensions with "cookies" permission bypass the JS wall.
async function cmdCookies(opts = []) {
  let url = null;
  let host = null;         // convenience: bare host → https://<host>/
  let name = null;         // optional exact-name filter
  let showValue = false;   // print full cookie value (default: mask)
  let asHeader = false;    // emit as ready-to-paste "Cookie: k=v; k=v" line

  const positional = [];
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === '--url' || a === '-u') url = opts[++i];
    else if (a === '--host' || a === '-h') host = opts[++i];
    else if (a === '--name' || a === '-n') name = opts[++i];
    else if (a === '--value' || a === '--secret' || a === '--full') showValue = true;
    else if (a === '--header' || a === '--as-header') asHeader = true;
    else if (a === '--help') {
      console.log('Usage: glider cookies <url> | --host <h> | --url <u> [--name <n>] [--value] [--header] [--json]');
      console.log('  Read cookies (INCLUDING HttpOnly) for a URL via the extension cookies API.');
      console.log('  --host <h>   convenience: expands to https://<h>/');
      console.log('  --name <n>   filter to a single cookie by exact name');
      console.log('  --value      print full cookie value (default: masked)');
      console.log('  --header     emit as "Cookie: k=v; k=v" header line');
      return;
    }
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (!url && positional.length) url = positional[0];
  if (!url && host) url = /^https?:\/\//i.test(host) ? host : `https://${host}/`;
  if (!url) {
    log.fail('Usage: glider cookies <url> | --host <h> | --url <u>');
    process.exit(1);
  }

  if (!await ensureConnected()) process.exit(1);

  try {
    const payload = await httpPost('/extension', {
      method: 'getCookies',
      params: { url }
    });

    if (!payload || payload.error) {
      const msg = payload?.error || 'no response from extension';
      if (jsonOutput) emitJson(false, null, msg);
      log.fail(`cookies fetch failed: ${msg}`);
      log.info('Requires glider CRX >= 0.3.21 (bg handler "getCookies"). Reload the extension if just updated.');
      process.exit(1);
    }

    let cookies = payload.data || payload.result?.cookies || payload.cookies || [];
    if (!Array.isArray(cookies)) {
      if (jsonOutput) emitJson(false, null, 'unexpected response shape');
      log.fail('unexpected response shape from extension');
      console.error(JSON.stringify(payload).slice(0, 500));
      process.exit(1);
    }
    if (name) cookies = cookies.filter(c => c.name === name);

    // Filter expired
    const nowSec = Math.floor(Date.now() / 1000);
    for (const c of cookies) {
      if (c.expirationDate) {
        c._expires_in_sec = Math.floor(c.expirationDate - nowSec);
        c._expired = c._expires_in_sec < 0;
      } else {
        c._expires_in_sec = null;
        c._expired = false; // session cookie
      }
    }

    if (asHeader) {
      const line = cookies
        .filter(c => !c._expired)
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      if (jsonOutput) emitJson(true, { header: line, count: cookies.length });
      else console.log(line);
      return;
    }

    if (jsonOutput) {
      const out = cookies.map(c => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite,
        session: !!c.session,
        expirationDate: c.expirationDate || null,
        expires_in_sec: c._expires_in_sec,
        expired: c._expired,
        value: showValue ? c.value : maskCookieValue(c.value),
      }));
      emitJson(true, { url, count: out.length, cookies: out });
      return;
    }

    if (cookies.length === 0) {
      log.warn(name ? `No cookie named "${name}" for ${url}` : `No cookies for ${url}`);
      return;
    }
    log.ok(`${cookies.length} cookie(s) for ${url}:`);
    for (const c of cookies) {
      const flags = [
        c.httpOnly ? 'HttpOnly' : null,
        c.secure ? 'Secure' : null,
        c.sameSite ? `SameSite=${c.sameSite}` : null,
        c.session ? 'Session' : null,
      ].filter(Boolean).join(' ');
      const exp = c._expires_in_sec == null
        ? '(session)'
        : (c._expired ? `EXPIRED ${-c._expires_in_sec}s ago` : `expires in ${Math.floor(c._expires_in_sec/60)}m ${c._expires_in_sec%60}s`);
      const val = showValue ? c.value : maskCookieValue(c.value);
      console.log(`  ${c.name}=${val}  [${c.domain}${c.path}]  ${flags}  ${exp}`);
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`cookies fetch failed: ${e.message}`);
    process.exit(1);
  }
}

function maskCookieValue(v) {
  if (v == null) return '(none)';
  const s = String(v);
  if (s.length < 20) return s.slice(0, 4) + '...' + s.slice(-2);
  return s.slice(0, 12) + '...(' + (s.length - 20) + ' chars)...' + s.slice(-6);
}

// Spawn multiple tabs
async function cmdSpawn(urls) {
  if (!urls || urls.length === 0) {
    log.fail('Usage: glider spawn <url1> <url2> ...');
    process.exit(1);
  }
  
  // Handle file input
  if (urls[0] === '-f' && urls[1]) {
    const content = fs.readFileSync(urls[1], 'utf8');
    urls = content.split('\n').filter(u => u.trim());
  }
  
  log.info(`Spawning ${urls.length} tab(s)...`);
  
  const results = [];
  for (const url of urls) {
    try {
      const result = await httpPost('/cdp', {
        method: 'Target.createTarget',
        params: { url }
      });
      results.push({ url, targetId: result?.targetId });
      log.ok(`Spawned: ${url}`);
    } catch (e) {
      log.warn(`Failed: ${url} - ${e.message}`);
    }
  }
  
  console.log(JSON.stringify(results, null, 2));
}

// Extract from multiple tabs
async function cmdExtract(opts = []) {
  let js = 'document.body.innerText';
  let selector = null;
  let limit = 10000;
  let asJson = false;
  
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--js') js = opts[++i];
    else if (opts[i] === '--selector' || opts[i] === '-s') selector = opts[++i];
    else if (opts[i] === '--limit' || opts[i] === '-l') limit = parseInt(opts[++i], 10);
    else if (opts[i] === '--json') asJson = true;
  }
  
  if (selector) {
    js = `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`;
  }
  
  log.info('Extracting from connected tabs...');
  
  try {
    const targets = await getTargets();
    if (targets.length === 0) {
      log.warn('No tabs connected');
      return;
    }
    
    const results = [];
    for (const target of targets) {
      const url = target.targetInfo?.url || 'unknown';
      try {
        const result = await httpPost('/cdp', {
          method: 'Runtime.evaluate',
          params: {
            expression: js,
            returnByValue: true
          }
        });
        const text = String(result?.result?.value || '').slice(0, limit);
        results.push({ url, text });
        if (!asJson) {
          console.log(`\n--- ${url} ---`);
          console.log(text);
        }
      } catch (e) {
        results.push({ url, error: e.message });
      }
    }
    
    if (asJson) {
      console.log(JSON.stringify(results, null, 2));
    }
  } catch (e) {
    log.fail(`Extract failed: ${e.message}`);
    process.exit(1);
  }
}

// Registry pattern execution - bulletproof extraction using predefined patterns
async function cmdRegistry(patternName, opts = []) {
  if (!patternName) {
    // List all patterns
    const patterns = Object.keys(REGISTRY);
    if (patterns.length === 0) {
      log.warn('No patterns in registry');
      return;
    }
    console.log(`${GREEN}${patterns.length}${NC} pattern(s) available:\n`);
    for (const name of patterns) {
      const p = REGISTRY[name];
      console.log(`  ${CYAN}${name}${NC}`);
      console.log(`      ${DIM}${p.description || 'No description'}${NC}`);
    }
    return;
  }

  const pattern = REGISTRY[patternName];
  if (!pattern) {
    log.fail(`Pattern not found: ${patternName}`);
    log.info('Run "glider registry" to see available patterns');
    process.exit(1);
  }

  // Parse options - for favicon: glider favicon [output.webp]
  // The first arg that looks like a file path is output, anything else is URL
  let outputFile = null;
  let url = null;
  for (let i = 0; i < opts.length; i++) {
    const arg = opts[i];
    if (arg === '--output' || arg === '-o') {
      outputFile = opts[++i];
    } else if (arg.startsWith('-')) {
      // skip flags
    } else if (arg.includes('/') && !arg.startsWith('http') && (arg.endsWith('.webp') || arg.endsWith('.png') || arg.endsWith('.ico'))) {
      // Looks like a file path
      outputFile = arg;
    } else if (!url) {
      url = arg;
    }
  }

  // If URL provided, navigate first
  if (url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    log.info(`Navigating to: ${url}`);
    await cmdGoto(url);
    await new Promise(r => setTimeout(r, 2000));
  }

  log.info(`Running pattern: ${patternName}`);

  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: {
        expression: pattern.pattern,
        returnByValue: true,
        awaitPromise: true,
      }
    });

    let value = result?.result?.value;
    
    if (value === undefined || value === null) {
      log.fail('Pattern returned no value');
      process.exit(1);
    }

    // Handle postprocessing for favicon
    if (patternName === 'favicon' && pattern.postprocess) {
      const base64 = value;
      if (!base64 || base64.length < 50) {
        log.fail('No favicon data received');
        process.exit(1);
      }

      // Determine output path
      if (!outputFile) {
        const currentUrl = await httpPost('/cdp', {
          method: 'Runtime.evaluate',
          params: { expression: 'window.location.hostname', returnByValue: true }
        });
        const hostname = currentUrl?.result?.value?.replace(/^www\./, '').split('.')[0] || 'favicon';
        outputFile = `/tmp/${hostname}-favicon.webp`;
      }

      // Save and convert
      const tempFile = `/tmp/favicon-temp-${Date.now()}`;
      const buffer = Buffer.from(base64, 'base64');
      
      // Detect if ICO
      const isIco = buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1;
      const tempPath = isIco ? `${tempFile}.ico` : `${tempFile}.png`;
      fs.writeFileSync(tempPath, buffer);
      log.ok(`Downloaded: ${buffer.length} bytes`);

      // Convert to webp
      if (outputFile.endsWith('.webp')) {
        try {
          let pngPath = tempPath;
          if (isIco) {
            pngPath = `${tempFile}.png`;
            execSync(`magick "${tempPath}[0]" -resize 32x32 "${pngPath}" 2>/dev/null || convert "${tempPath}[0]" -resize 32x32 "${pngPath}" 2>/dev/null`);
          }
          execSync(`cwebp "${pngPath}" -o "${outputFile}" -q 90 2>/dev/null`);
          log.ok(`Saved: ${outputFile}`);
          
          // Cleanup
          try { fs.unlinkSync(tempPath); } catch {}
          if (pngPath !== tempPath) try { fs.unlinkSync(pngPath); } catch {}
        } catch (e) {
          // Fallback - save as-is
          const fallback = outputFile.replace('.webp', isIco ? '.ico' : '.png');
          fs.copyFileSync(tempPath, fallback);
          log.warn(`Conversion failed, saved as: ${fallback}`);
          outputFile = fallback;
        }
      } else {
        fs.copyFileSync(tempPath, outputFile);
        log.ok(`Saved: ${outputFile}`);
      }

      // Also copy to dist if in spoonfeeder project
      const distPath = outputFile.replace('/public/', '/dist/web/');
      if (distPath !== outputFile && fs.existsSync(outputFile)) {
        try {
          const distDir = path.dirname(distPath);
          if (fs.existsSync(distDir)) {
            fs.copyFileSync(outputFile, distPath);
            log.ok(`Copied to dist: ${distPath}`);
          }
        } catch {}
      }

      console.log(outputFile);
      return;
    }

    // Standard output
    if (outputFile) {
      const output = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
      fs.writeFileSync(outputFile, output);
      log.ok(`Saved to ${outputFile}`);
    } else {
      if (typeof value === 'object') {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(value);
      }
    }
  } catch (e) {
    log.fail(`Pattern failed: ${e.message}`);
    process.exit(1);
  }
}

// Explore site (clicks around, captures network)
async function cmdExplore(url, opts = []) {
  if (!url) {
    log.fail('Usage: glider explore <url> [--depth N] [--output dir] [--har file] [--session-id id]');
    process.exit(1);
  }
  
  let depth = 2;
  let outputDir = '/tmp/glider-explore';
  let harFile = null;
  let sessionId = null;
  let freshTab = false;
  let closeOnDone = false;
  
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--depth' || opts[i] === '-d') depth = parseInt(opts[++i], 10);
    else if (opts[i] === '--output' || opts[i] === '-o') outputDir = opts[++i];
    else if (opts[i] === '--har') harFile = opts[++i];
    else if (opts[i] === '--session-id' || opts[i] === '--session') sessionId = opts[++i];
    else if (opts[i] === '--fresh-tab') freshTab = true;
    else if (opts[i] === '--close-on-done') closeOnDone = true;
  }
  if (!sessionId && !freshTab && activeSessionId) sessionId = activeSessionId;

  try {
    assertUrlAllowed(url, allowedDomainList, 'explore');
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(e.message);
    process.exit(1);
  }
  
  // v0.4.2: --fresh-tab sidesteps H4 (CSS.enable forwardCDPCommand timeout
  // on long-lived session reuse). Opens a new tab, waits for target attach,
  // uses the new session-id, and optionally closes on done.
  let freshTargetId = null;
  if (freshTab) {
    const { WindowManager } = require(path.join(LIB_DIR, 'bwindow.js'));
    const wm = new WindowManager();
    await wm.connect();
    await wm.init();
    log.info(`[explore] Opening fresh tab for capture...`);
    const result = await wm.createTab(url);
    freshTargetId = result.targetId;
    await new Promise(r => setTimeout(r, 2500));
    try {
      const targetsRes = await httpGet('/targets');
      const targets = (targetsRes && targetsRes.targets) || targetsRes || [];
      const t = (Array.isArray(targets) ? targets : []).find(x => x.targetId === freshTargetId);
      if (t && t.sessionId) sessionId = t.sessionId;
    } catch {}
    if (!sessionId) log.info('[explore] fresh-tab created but sessionId not resolved (bexplore will auto-pin)');
    else log.ok(`[explore] fresh-tab session: ${sessionId}`);
  }

  log.info(`Exploring: ${url} (depth: ${depth})`);
  
  // Use the bexplore.js library
  const bexplorePath = path.join(LIB_DIR, 'bexplore.js');
  if (fs.existsSync(bexplorePath)) {
    const { spawn } = require('child_process');
    const spawnArgs = [bexplorePath, url, '--depth', String(depth), '--output', outputDir];
    if (harFile) spawnArgs.push('--har', harFile);
    if (sessionId) spawnArgs.push('--session-id', sessionId);
    
    const child = spawn('node', spawnArgs, {
      stdio: 'inherit'
    });
    try {
      await new Promise((resolve, reject) => {
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code: ${code}`)));
      });
    } finally {
      if (freshTab && closeOnDone && freshTargetId) {
        try {
          const { WindowManager } = require(path.join(LIB_DIR, 'bwindow.js'));
          const wm = new WindowManager();
          await wm.connect();
          await wm.init();
          await wm.closeTarget(freshTargetId);
          log.ok(`[explore] fresh-tab closed: ${freshTargetId}`);
        } catch (e) {
          log.info(`[explore] fresh-tab close failed: ${e.message}`);
        }
      }
    }
  } else {
    // Fallback: simple exploration
    await cmdGoto(url);
    await new Promise(r => setTimeout(r, 2000));
    
    // Get all links
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: {
        expression: `Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http'))`,
        returnByValue: true
      }
    });
    
    const links = result?.result?.value || [];
    log.ok(`Found ${links.length} links`);
    
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'links.json'), JSON.stringify(links, null, 2));
    
    // Screenshot
    await cmdScreenshot(path.join(outputDir, 'screenshot.png'));
    
    log.ok(`Output saved to ${outputDir}`);
  }
}

// YAML Task Runner
async function cmdRun(taskFile) {
  if (!taskFile || !fs.existsSync(taskFile)) {
    log.fail(`Task file not found: ${taskFile}`);
    process.exit(1);
  }
  
  const content = fs.readFileSync(taskFile, 'utf8');
  const task = YAML.parse(content);
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  GLIDER RUN: ${task.name || 'Unnamed task'}`);
  console.log(`  Steps: ${task.steps?.length || 0}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  
  if (!task.steps || !Array.isArray(task.steps)) {
    log.fail('No steps defined in task file');
    process.exit(1);
  }
  
  let failed = false;
  
  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i];
    const [cmd, arg] = Object.entries(step)[0];
    const stepNum = i + 1;
    
    log.step(`[${stepNum}/${task.steps.length}] ${cmd}: ${String(arg).slice(0, 60)}${String(arg).length > 60 ? '...' : ''}`);
    
    try {
      switch (cmd) {
        case 'goto':
        case 'navigate':
          await cmdGoto(arg);
          break;
        case 'wait':
        case 'sleep':
          await new Promise(r => setTimeout(r, arg * 1000));
          log.ok(`Waited ${arg}s`);
          break;
        case 'eval':
        case 'js':
          await cmdEval(arg);
          break;
        case 'click':
          await cmdClick(arg);
          break;
        case 'type':
          if (Array.isArray(arg)) {
            await cmdType(arg[0], arg[1]);
          }
          break;
        case 'screenshot':
          await cmdScreenshot(arg);
          break;
        case 'text':
          await cmdText();
          break;
        case 'log':
        case 'echo':
          console.log(`${BLUE}[LOG]${NC} ${arg}`);
          break;
        case 'assert':
          const assertResult = await httpPost('/cdp', {
            method: 'Runtime.evaluate',
            params: { expression: arg, returnByValue: true }
          });
          if (assertResult.result?.value === true) {
            log.ok('Assertion passed');
          } else {
            log.fail(`Assertion failed: ${JSON.stringify(assertResult.result?.value)}`);
            failed = true;
          }
          break;
        default:
          log.warn(`Unknown command: ${cmd}`);
      }
    } catch (e) {
      log.fail(`Step failed: ${e.message}`);
      failed = true;
    }
    
    console.log('');
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  if (failed) {
    console.log(`${RED}  ✗ Task failed${NC}`);
    process.exit(1);
  } else {
    console.log(`${GREEN}  ✓ Task completed successfully${NC}`);
  }
  console.log('═══════════════════════════════════════════════════════════');
}

// Ralph Wiggum Loop - The core autonomous execution pattern
async function cmdLoop(taskFileOrPrompt, options = {}) {
  const maxIterations = options.maxIterations || 10;
  const maxRuntime = options.maxRuntime || 3600; // 1 hour default
  const checkpointInterval = options.checkpointInterval || 5;
  const completionMarker = options.completionMarker || 'LOOP_COMPLETE';
  
  // Initialize state
  const state = {
    iteration: 0,
    startTime: Date.now(),
    completed: [],
    pending: [],
    status: 'running',
    lastOutput: null,
    errors: [],
  };
  
  // Save state helper
  const saveState = () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  };
  
  // Load task
  let task;
  if (fs.existsSync(taskFileOrPrompt)) {
    const content = fs.readFileSync(taskFileOrPrompt, 'utf8');
    task = YAML.parse(content);
  } else {
    // Inline prompt mode
    task = { name: 'Inline task', prompt: taskFileOrPrompt, steps: [] };
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GLIDER LOOP - Ralph Wiggum Autonomous Execution');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Task: ${task.name || 'Unnamed'}`);
  console.log(`Max iterations: ${maxIterations}`);
  console.log(`Max runtime: ${maxRuntime}s`);
  console.log(`Completion marker: ${completionMarker}`);
  console.log('');
  
  // Main loop
  while (state.status === 'running') {
    state.iteration++;
    
    // Safety checks
    const elapsed = (Date.now() - state.startTime) / 1000;
    
    if (state.iteration > maxIterations) {
      log.warn(`Max iterations (${maxIterations}) reached`);
      state.status = 'max_iterations';
      break;
    }
    
    if (elapsed > maxRuntime) {
      log.warn(`Max runtime (${maxRuntime}s) reached`);
      state.status = 'timeout';
      break;
    }
    
    console.log('──────────────────────────────────────────────────────────');
    console.log(`  Iteration ${state.iteration} / ${maxIterations} (${elapsed.toFixed(1)}s elapsed)`);
    console.log('──────────────────────────────────────────────────────────');
    
    try {
      // Execute steps if defined
      if (task.steps && task.steps.length > 0) {
        for (const step of task.steps) {
          const [cmd, arg] = Object.entries(step)[0];
          log.step(`${cmd}: ${String(arg).slice(0, 50)}`);
          
          switch (cmd) {
            case 'goto':
              await cmdGoto(arg);
              break;
            case 'wait':
              await new Promise(r => setTimeout(r, arg * 1000));
              break;
            case 'eval':
              const evalResult = await httpPost('/cdp', {
                method: 'Runtime.evaluate',
                params: { expression: arg, returnByValue: true, awaitPromise: true }
              });
              state.lastOutput = evalResult.result?.value;
              log.result(JSON.stringify(state.lastOutput));
              break;
            case 'click':
              await cmdClick(arg);
              break;
            case 'screenshot':
              await cmdScreenshot(arg);
              break;
            default:
              log.warn(`Unknown: ${cmd}`);
          }
        }
      }
      
      // Check for completion marker in last output
      if (state.lastOutput && String(state.lastOutput).includes(completionMarker)) {
        log.ok('Completion marker detected!');
        state.status = 'completed';
        break;
      }
      
      // Check for completion marker in task file (if it was modified)
      if (fs.existsSync(taskFileOrPrompt)) {
        const currentContent = fs.readFileSync(taskFileOrPrompt, 'utf8');
        if (currentContent.includes(completionMarker) || currentContent.includes('DONE')) {
          log.ok('Task file marked as complete');
          state.status = 'completed';
          break;
        }
      }
      
      state.completed.push({ iteration: state.iteration, success: true });
      
    } catch (e) {
      log.fail(`Iteration error: ${e.message}`);
      state.errors.push({ iteration: state.iteration, error: e.message });
      
      // Exponential backoff on errors
      const backoff = Math.min(30, Math.pow(2, state.errors.length));
      log.info(`Backing off ${backoff}s before retry...`);
      await new Promise(r => setTimeout(r, backoff * 1000));
    }
    
    // Checkpoint
    if (state.iteration % checkpointInterval === 0) {
      saveState();
      log.info(`Checkpoint saved (iteration ${state.iteration})`);
    }
    
    // Small delay between iterations
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // Final state save
  saveState();
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Loop finished: ${state.status}`);
  console.log(`  Iterations: ${state.iteration}`);
  console.log(`  Successful: ${state.completed.length}`);
  console.log(`  Errors: ${state.errors.length}`);
  console.log(`  Runtime: ${((Date.now() - state.startTime) / 1000).toFixed(1)}s`);
  console.log('═══════════════════════════════════════════════════════════');
  
  if (state.status === 'completed') {
    console.log(`${GREEN}  ✓ Task completed successfully${NC}`);
  } else {
    console.log(`${YELLOW}  ! Task stopped: ${state.status}${NC}`);
  }
}

// Help
function showHelp() {
  showBanner();
  console.log(`
${B5}USAGE${NC}
    glider [--session <id>] [--json] [--allowed-domains 'host,*'] <command> [args]
    ${DIM}GLIDER_SESSION_ID=session-N${NC}  ${DIM}pin tab for all /cdp commands${NC}

${B5}SETUP${NC}
    ${BW}install${NC}             Install daemon ${DIM}(runs at login, auto-restarts)${NC}
    ${BW}uninstall${NC}           Remove daemon
    ${BW}update${NC}              Update to latest version
    ${BW}connect${NC}             Connect to browser ${DIM}(run once per Chrome session)${NC}

${B5}STATUS${NC}
    ${BW}status${NC}              Check server, extension, tabs
    ${BW}browser${NC}             Show browser config ${DIM}(name, path, processName, or use key)${NC}
    ${BW}use${NC} <key>           Set browser by registry key ${DIM}(e.g. arc, brave, chrome)${NC}
    ${BW}test${NC}                Run diagnostics
    ${BW}domains${NC}             List ~/.glider domain shortcuts + warch paths
    ${BW}resolve${NC} <url>        Domain intel under ~/.glider/warch ${DIM}(--json)${NC}

${B5}NAVIGATION${NC}
    ${BW}goto${NC} <url>          Navigate to URL
    ${BW}eval${NC} <js>           Execute JavaScript
    ${BW}click${NC} <selector>    Click element
    ${BW}type${NC} <sel> <text>   Type into input
    ${BW}screenshot${NC} [path]   Take screenshot

${B5}PAGE INFO${NC}
    ${BW}snapshot${NC} [opts]      Page index for agents ${DIM}(--json, --interactive-only)${NC}
    ${BW}text${NC}                Get page text
    ${BW}html${NC} [selector]     Get HTML
    ${BW}title${NC}               Get page title
    ${BW}url${NC}                 Get current URL
    ${BW}tabs${NC}                List connected tabs

${B5}MULTI-WINDOW${NC}
    ${BW}window new${NC} [url]    Create new browser window ${DIM}(closeable)${NC}
    ${BW}window tab${NC} [url]    Create tab in current window
    ${BW}window close${NC} <id>   Close specific tab/window
    ${BW}window closeall${NC}     Close all Glider-created tabs
    ${BW}window focus${NC} <id>   Bring tab to foreground
    ${BW}window list${NC}         List all windows/tabs

${B5}MULTI-TAB${NC}
    ${BW}targets${NC}             List targets ${DIM}(sessionId, title, url)${NC}
    ${BW}use-session${NC} <id>    Pin session ${DIM}(or --url host-fragment)${NC}
    ${BW}fetch${NC} <url>         Fetch URL with browser session ${DIM}(auth)${NC}
    ${BW}spawn${NC} <urls...>     Open multiple tabs
    ${BW}extract${NC} [opts]      Extract from all tabs
    ${BW}explore${NC} <url>       Crawl site, capture network
    ${BW}favicon${NC} <url> [out] Extract favicon from site ${DIM}(webp)${NC}

${B5}EXTRACTION PATTERNS${NC} ${DIM}(bulletproof, domain-agnostic)${NC}
    ${BW}reg${NC}                 List all patterns
    ${BW}reg table${NC}           Extract table as JSON ${DIM}(headers → keys)${NC}
    ${BW}reg table-csv${NC}       Extract table as CSV
    ${BW}reg table-paginated${NC} Get pagination info ${DIM}(hasNextPage, rowCount)${NC}
    ${BW}reg buttons${NC}         List all buttons ${DIM}(text, aria-label)${NC}
    ${BW}reg inputs${NC}          List all input fields
    ${BW}reg loading${NC}         Check for loading spinners
    ${BW}reg errors${NC}          Find error messages
    ${BW}reg data-attrs${NC}      Find data-testid elements ${DIM}(stable selectors)${NC}

${B5}AUTOMATION${NC}
    ${BW}run${NC} <task.yaml>     Execute YAML task file
    ${BW}loop${NC} <task> [opts]  Autonomous loop ${DIM}(run until complete)${NC}
    ${BW}ralph${NC} <task>        ${DIM}Alias for loop${NC}

${B5}LOOP OPTIONS${NC}
    -n, --max-iterations N   Max iterations ${DIM}(default: 10)${NC}
    -t, --timeout N          Timeout in seconds ${DIM}(default: 3600)${NC}
    -m, --marker STRING      Completion marker ${DIM}(default: LOOP_COMPLETE)${NC}

${B5}EXAMPLES${NC}
    ${DIM}$${NC} glider install              ${DIM}# one-time setup${NC}
    ${DIM}$${NC} glider connect              ${DIM}# connect to Chrome${NC}
    ${DIM}$${NC} glider goto "https://x.com" ${DIM}# navigate${NC}
    ${DIM}$${NC} glider eval "document.title"${DIM}# run JS${NC}
    ${DIM}$${NC} glider run scrape.yaml      ${DIM}# run task${NC}
    ${DIM}$${NC} glider loop task.yaml -n 50 ${DIM}# autonomous loop${NC}

${YELLOW}TASK FILE FORMAT:${NC}
    name: "Task name"
    steps:
      - goto: "https://example.com"
      - wait: 2
      - eval: "document.title"
      - click: "button.submit"
      - type: ["#input", "hello"]
      - screenshot: "/tmp/shot.png"
      - assert: "document.title.includes('Example')"
      - log: "Step done"

${YELLOW}EXAMPLES:${NC}
    glider status
    glider start
    glider goto "https://google.com"
    glider eval "document.title"
    glider html "div.main"
    glider run mytask.yaml
    glider loop mytask.yaml -n 20 -t 600

${YELLOW}RALPH WIGGUM PATTERN:${NC}
    The loop command implements autonomous execution:
    - Runs until completion marker found or limits reached
    - Safety guards: max iterations, timeout, error backoff
    - State persistence for recovery
    - Checkpointing every N iterations

${YELLOW}REQUIREMENTS:${NC}
    - Node.js 18+
    - Glider Chrome extension connected

${YELLOW}DOMAIN EXTENSIONS:${NC}
    Add custom domain commands via ~/.glider/config/domains.json:
    {
      "mysite": { "url": "https://mysite.com/dashboard" },
      "mytool": { "script": "~/scripts/mytool.sh" }
    }
    Then: glider mysite  ->  navigates to that URL
          glider mytool  ->  runs that script
`);

  // Show loaded domains if any (from local config)
  const domainKeys = Object.keys(DOMAINS);
  if (domainKeys.length > 0) {
    console.log(`${YELLOW}LOADED DOMAINS:${NC} (from local config)`);
    for (const key of domainKeys) {
      const d = DOMAINS[key];
      const desc = d.description || d.url || d.script || '';
      console.log(`    ${GREEN}${key}${NC}  ${DIM}${desc}${NC}`);
    }
    console.log('');
  }

  // Plugins socket - hydrated from ~/.glider/plugins/*.plugin.{json,js}
  // (loadPlugins is called from main() before showHelp when invoked as `glider help`,
  //  but a bare `glider --help` runs before main; safe-load here for that path.)
  if (GLIDER_PLUGIN_REGISTRY.size === 0) {
    try { loadPlugins(); } catch {}
  }
  const seen = new Set();
  const pluginVerbs = [];
  for (const [verb, def] of GLIDER_PLUGIN_REGISTRY) {
    if (def.verb !== verb) continue; // skip aliases
    if (seen.has(def._source)) continue;
    seen.add(def._source);
    pluginVerbs.push({ verb, def });
  }
  if (pluginVerbs.length > 0) {
    console.log(`${YELLOW}PLUGINS:${NC} (from ~/.glider/plugins/)`);
    for (const { verb, def } of pluginVerbs) {
      const desc = (Array.isArray(def.help) ? def.help.find(l => !/^Usage:/i.test(l)) : def.help) || '(no description)';
      const shortDesc = String(desc).replace(/^\s+/, '').slice(0, 60);
      console.log(`    ${GREEN}${verb.padEnd(16)}${NC} ${DIM}${shortDesc}${NC}`);
    }
    console.log('');
  }
  console.log(`${YELLOW}DOM-SCORCH (waves 1-5):${NC}`);
  console.log(`    ${GREEN}${'read'.padEnd(16)}${NC} ${DIM}read attr/prop/text/html/value; --all --count --exists --visible --enabled${NC}`);
  console.log(`    ${GREEN}${'click'.padEnd(16)}${NC} ${DIM}--text --contains --regex --nth --role --inside --wait --double --right --hold${NC}`);
  console.log(`    ${GREEN}${'type'.padEnd(16)}${NC} ${DIM}--editor auto|ckeditor|tinymce|prosemirror|monaco|slate|contentEditable ; --file --clear-first --commit${NC}`);
  console.log(`    ${GREEN}${'wait'.padEnd(16)}${NC} ${DIM}--selector --text --gone --matches --stable --url-matches --timeout${NC}`);
  console.log(`    ${GREEN}${'hover'.padEnd(16)}${NC} ${DIM}hover a target${NC}`);
  console.log(`    ${GREEN}${'focus/blur'.padEnd(16)}${NC} ${DIM}focus/blur an element${NC}`);
  console.log(`    ${GREEN}${'scroll'.padEnd(16)}${NC} ${DIM}scroll to <sel> | by <dx> <dy> | until <sel>${NC}`);
  console.log(`    ${GREEN}${'key'.padEnd(16)}${NC} ${DIM}"Ctrl+Enter" | "ArrowDown x5" | "Escape" | --text "literal"${NC}`);
  console.log(`    ${GREEN}${'right-click'.padEnd(16)}${NC} ${DIM}right-click (same flags as click)${NC}`);
  console.log(`    ${GREEN}${'double-click'.padEnd(16)}${NC} ${DIM}double-click (same flags as click)${NC}`);
  console.log(`    ${GREEN}${'drag'.padEnd(16)}${NC} ${DIM}drag <src> --to <dst>${NC}`);
  console.log(`    ${GREEN}${'click-at'.padEnd(16)}${NC} ${DIM}click-at x,y${NC}`);
  console.log(`    ${GREEN}${'select'.padEnd(16)}${NC} ${DIM}<sel> --by-text | --by-value | --nth${NC}`);
  console.log(`    ${GREEN}${'eval'.padEnd(16)}${NC} ${DIM}--arg K=V --arg-file K=@path --json --await${NC}`);
  console.log(`    ${GREEN}${'screenshot'.padEnd(16)}${NC} ${DIM}--selector --clip --full-page --format webp|jpg|png${NC}`);
  console.log(`    ${GREEN}${'frames'.padEnd(16)}${NC} ${DIM}list all frames in the page${NC}`);
  console.log(`    ${GREEN}${'frame-eval'.padEnd(16)}${NC} ${DIM}<frameId> <js> - eval inside iframe${NC}`);
  console.log(`    ${GREEN}${'upload'.padEnd(16)}${NC} ${DIM}<input-sel> <file-path> via DOM.setFileInputFiles${NC}`);
  console.log(`    ${GREEN}${'har'.padEnd(16)}${NC} ${DIM}har start | stop | dump [PATH]${NC}`);
  console.log(`    ${GREEN}${'emulate'.padEnd(16)}${NC} ${DIM}tz | geo | viewport | offline | ua | color-scheme${NC}`);
  console.log(`    ${GREEN}${'storage'.padEnd(16)}${NC} ${DIM}get | set | delete | keys | jar (localStorage)${NC}`);
  console.log(`    ${GREEN}${'cookies'.padEnd(16)}${NC} ${DIM}(read: no flags) | --set NAME=VAL --host H | --delete NAME --host H${NC}`);
  console.log(`    ${GREEN}${'history'.padEnd(16)}${NC} ${DIM}back | forward | reload${NC}`);
  console.log(`    ${GREEN}${'dialog'.padEnd(16)}${NC} ${DIM}dialog auto accept|dismiss${NC}`);
  console.log(`    ${GREEN}${'console'.padEnd(16)}${NC} ${DIM}console tail | dump${NC}`);
  console.log(`    ${GREEN}${'pdf'.padEnd(16)}${NC} ${DIM}[PATH] [--landscape] [--margin N] [--scale F]${NC}`);
  console.log(`    ${GREEN}${'mock'.padEnd(16)}${NC} ${DIM}<url-glob> --status N --body FILE | mock clear${NC}`);
  console.log(`    ${GREEN}${'a11y'.padEnd(16)}${NC} ${DIM}Accessibility.getFullAXTree (snapshot --a11y flag equivalent)${NC}`);
  console.log(`    ${GREEN}${'frozen'.padEnd(16)}${NC} ${DIM}detect if tab is macrotask-frozen (hidden); exit 1 = frozen${NC}`);
  console.log(`    ${GREEN}${'thaw'.padEnd(16)}${NC} ${DIM}un-throttle a frozen/hidden tab in place (--all --verify); aka unfreeze/wake${NC}`);
  console.log('');
}

// Version check - non-blocking, runs in background
async function checkForUpdates() {
  try {
    const https = require('https');
    const pkg = require('../package.json');
    const current = pkg.version;
    
    const data = await new Promise((resolve, reject) => {
      https.get('https://registry.npmjs.org/glidercli/latest', { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    
    const latest = data.version;
    if (latest && latest !== current) {
      console.error(`${YELLOW}⬆${NC}  Update available: ${DIM}${current}${NC} → ${GREEN}${latest}${NC}  ${DIM}(run: glider update)${NC}`);
    }
  } catch {} // Silent fail - don't block CLI
}

// Update command
async function cmdUpdate() {
  log.info('Checking for updates...');
  try {
    const pkg = require('../package.json');
    const current = pkg.version;
    
    // Check latest
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get('https://registry.npmjs.org/glidercli/latest', { timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    
    const latest = data.version;
    if (latest === current) {
      log.ok(`Already on latest version (${current})`);
      return;
    }
    
    log.info(`Updating ${current} → ${latest}...`);
    execSync('npm update -g glidercli', { stdio: 'inherit' });
    log.ok(`Updated to ${latest}`);
  } catch (e) {
    log.fail(`Update failed: ${e.message}`);
    log.info('Try manually: npm update -g glidercli');
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// PLUGIN SOCKET  (v0.3.21)
// ────────────────────────────────────────────────────────────────
// glidercli itself is verb-agnostic. Local plugins hydrate additional
// verbs at runtime from `$HOME/.glider/plugins/*.plugin.{json,js}`.
// This lets consumers (org-specific ontologies, private tentacles) ship
// their own verbs without ever landing in the public npm package.
//
// Plugin discovery order:
//   1. $GLIDER_PLUGIN_DIR  (env override)
//   2. $HOME/.glider/plugins/
//
// Two plugin formats:
//
// (a) JSON - declarative, for simple eval-based verbs:
//   {
//     "verb": "myverb",
//     "aliases": ["mv"],
//     "help": ["Usage: glider myverb [--flag]", "  Describe it..."],
//     "primitive": "eval" | "extension" | "cdp",
//     "recipe":    "<javascript expression>" (for primitive=eval)
//     "method":    "<extension method name>" (for primitive=extension)
//     "args":      { "--flag": {"type":"boolean|string|number"} },   optional
//     "output":    { "format":"table|json|raw" }                     optional
//   }
//
// (b) JS - imperative, for complex verbs:
//   module.exports = {
//     verb: 'myverb',
//     aliases: ['mv'],
//     help: ['Usage: glider myverb ...'],
//     async run(argv, ctx) {
//       // ctx = { cdp, ext, log, jsonOutput, emitJson, ensureConnected, mask, httpPost, httpGet, os, fs, path }
//       const val = await ctx.cdp.eval('1+1', { sessionId: ctx.persistedSessionId });
//       ctx.log.ok(JSON.stringify(val));
//     }
//   };
const GLIDER_PLUGIN_REGISTRY = new Map(); // verb → plugin def

function pluginDirs() {
  const dirs = [];
  if (process.env.GLIDER_PLUGIN_DIR) dirs.push(process.env.GLIDER_PLUGIN_DIR);
  dirs.push(path.join(os.homedir(), '.glider', 'plugins'));
  return dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function loadPlugins() {
  const dirs = pluginDirs();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/\.plugin\.(json|js|cjs)$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        let def;
        if (/\.json$/i.test(name)) {
          def = JSON.parse(fs.readFileSync(full, 'utf8'));
          def._source = full;
          def._type = 'json';
        } else {
          def = require(full);
          def._source = full;
          def._type = 'js';
        }
        if (!def.verb || typeof def.verb !== 'string') {
          log.warn(`Plugin ${name}: missing "verb", skipping`);
          continue;
        }
        GLIDER_PLUGIN_REGISTRY.set(def.verb, def);
        for (const a of (def.aliases || [])) GLIDER_PLUGIN_REGISTRY.set(a, def);
      } catch (e) {
        log.warn(`Plugin ${name}: load failed - ${e.message}`);
      }
    }
  }
}

// Build the helper context passed to JS plugins
function makePluginCtx() {
  return {
    // Primitives
    cdp: {
      async eval(js, opts = {}) {
        const params = { method: 'Runtime.evaluate', params: { expression: js, returnByValue: true, awaitPromise: !!opts.awaitPromise } };
        if (opts.sessionId) params.sessionId = opts.sessionId;
        const r = await httpPost('/cdp', params);
        if (r && r.error && !r.result) throw new Error(`CDP: ${typeof r.error === 'string' ? r.error : JSON.stringify(r.error)}`);
        return r?.result?.value;
      },
      async call(method, params, opts = {}) {
        const body = { method, params: params || {} };
        if (opts.sessionId) body.sessionId = opts.sessionId;
        return await httpPost('/cdp', body);
      },
    },
    ext: {
      async call(method, params) {
        return await httpPost('/extension', { method, params: params || {} });
      },
    },
    // Utilities
    log,
    get jsonOutput() { return jsonOutput; },
    emitJson,
    ensureConnected,
    httpPost, httpGet,
    // Common masks
    mask: {
      jwt(s) {
        if (!s || typeof s !== 'string') return String(s);
        if (s.length < 40) return s.slice(0,6) + '...' + s.slice(-4);
        return s.slice(0,20) + '...(' + (s.length - 30) + ' chars)...' + s.slice(-10);
      },
      cookie(s) {
        if (s == null) return '(none)';
        const t = String(s);
        if (t.length < 20) return t.slice(0,4) + '...' + t.slice(-2);
        return t.slice(0,12) + '...(' + (t.length - 20) + ' chars)...' + t.slice(-6);
      },
    },
    // Node built-ins (avoid plugins needing to require these themselves)
    os, fs, path,
    // Version marker for plugins to feature-detect
    apiVersion: 1,
  };
}

async function runPlugin(def, argv) {
  const ctx = makePluginCtx();

  // Help dispatch
  if (argv.includes('--help') || argv.includes('-h')) {
    if (Array.isArray(def.help)) def.help.forEach(l => console.log(l));
    else if (typeof def.help === 'string') console.log(def.help);
    else console.log(`Usage: glider ${def.verb} [args]`);
    return;
  }

  // JS plugin - call run()
  if (def._type === 'js') {
    if (typeof def.run !== 'function') {
      log.fail(`Plugin ${def.verb}: JS plugin must export "run(argv, ctx)"`);
      process.exit(1);
    }
    if (!await ensureConnected()) process.exit(1);
    try {
      await def.run(argv, ctx);
    } catch (e) {
      if (jsonOutput) emitJson(false, null, e.message);
      log.fail(`Plugin ${def.verb} failed: ${e.message}`);
      if (process.env.GLIDER_PLUGIN_DEBUG) console.error(e.stack);
      process.exit(1);
    }
    return;
  }

  // JSON plugin - declarative execution
  if (!await ensureConnected()) process.exit(1);
  const parsed = parseJsonPluginArgs(argv, def.args || {});
  try {
    let out;
    if (def.primitive === 'eval') {
      if (!def.recipe) throw new Error('JSON plugin with primitive=eval requires "recipe"');
      const sessionId = parsed['--session'] || parsed.sessionId;
      const val = await ctx.cdp.eval(def.recipe, { sessionId, awaitPromise: !!def.awaitPromise });
      out = val;
    } else if (def.primitive === 'extension') {
      if (!def.method) throw new Error('JSON plugin with primitive=extension requires "method"');
      const params = { ...parsed };
      delete params._;
      out = await ctx.ext.call(def.method, params);
    } else {
      throw new Error(`Unknown primitive "${def.primitive}" (expected: eval | extension)`);
    }
    if (jsonOutput || def.output?.format === 'json') {
      emitJson(true, out);
    } else {
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    }
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Plugin ${def.verb} failed: ${e.message}`);
    process.exit(1);
  }
}

function parseJsonPluginArgs(argv, schema) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const spec = schema[a] || { type: 'string' };
      if (spec.type === 'boolean') out[a] = true;
      else out[a] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// WAVES 1-5 (dom-scorch) - AGNOSTIC DOM PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

// --- flag parser used by dom-scorch verbs ---------------------------
function parseFlags(argv, specs) {
  // specs: { longName: {short?, type: 'boolean'|'string'|'int'|'float', default?} }
  const out = { _: [] };
  for (const k of Object.keys(specs)) if ('default' in specs[k]) out[k] = specs[k].default;
  const shortMap = {};
  for (const [k, s] of Object.entries(specs)) if (s.short) shortMap['-' + s.short] = k;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let key = null;
    if (a.startsWith('--')) key = a.slice(2);
    else if (shortMap[a]) key = shortMap[a];
    if (key && specs[key]) {
      const s = specs[key];
      if (s.type === 'boolean') out[key] = true;
      else {
        const v = argv[++i];
        out[key] = s.type === 'int' ? parseInt(v, 10)
                 : s.type === 'float' ? parseFloat(v)
                 : v;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// --- guard: allow-list check + auto-connect --------------------------
async function _guardAndConnect(action) {
  if (!await ensureConnected()) process.exit(1);
  try { await assertCurrentUrlAllowed(action); }
  catch (e) { if (jsonOutput) emitJson(false, null, e.message); log.fail(e.message); process.exit(1); }
}

// --- shared runtime helper: eval JS, unwrap value -------------------
async function _rtEval(expression, opts = {}) {
  const result = await httpPost('/cdp', {
    method: 'Runtime.evaluate',
    params: {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise !== false,
      ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}),
      ...(opts.uniqueContextId ? { uniqueContextId: opts.uniqueContextId } : {}),
    }
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'eval threw');
  }
  return result;
}

// --- WAVE 1: cmdRead ------------------------------------------------
// glider read <sel> [--attr X | --prop Y | --text | --html | --value | --all | --count | --exists | --visible | --enabled]
async function cmdRead(argv) {
  const opts = parseFlags(argv, {
    attr: { type: 'string' },
    prop: { type: 'string' },
    text: { type: 'boolean' },
    html: { type: 'boolean' },
    value: { type: 'boolean' },
    all: { type: 'boolean' },
    count: { type: 'boolean' },
    exists: { type: 'boolean' },
    visible: { type: 'boolean' },
    enabled: { type: 'boolean' },
  });
  const sel = opts._[0];
  if (!sel) { log.fail('Usage: glider read <selector> [--attr X | --prop Y | --text | --html | --value | --all | --count | --exists | --visible | --enabled]'); process.exit(1); }
  await _guardAndConnect('read');
  const selJ = JSON.stringify(sel);
  const attrJ = opts.attr ? JSON.stringify(opts.attr) : 'null';
  const propJ = opts.prop ? JSON.stringify(opts.prop) : 'null';
  const mode = opts.count ? 'count'
             : opts.exists ? 'exists'
             : opts.visible ? 'visible'
             : opts.enabled ? 'enabled'
             : opts.attr ? 'attr'
             : opts.prop ? 'prop'
             : opts.value ? 'value'
             : opts.html ? 'html'
             : opts.text ? 'text'
             : 'text';
  const modeJ = JSON.stringify(mode);
  const allJ = opts.all ? 'true' : 'false';
  const js = `(() => {
    const sel=${selJ}, mode=${modeJ}, attr=${attrJ}, prop=${propJ}, all=${allJ};
    const els=[...document.querySelectorAll(sel)];
    if (mode==='count') return els.length;
    if (mode==='exists') return els.length>0;
    if (els.length===0) return null;
    const one=e=>{
      if (mode==='visible'){const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}
      if (mode==='enabled') return !e.disabled && e.getAttribute('aria-disabled')!=='true';
      if (mode==='attr') return e.getAttribute(attr);
      if (mode==='prop') return e[prop];
      if (mode==='value') return e.value;
      if (mode==='html') return e.outerHTML;
      return e.innerText;
    };
    return all ? els.map(one) : one(els[0]);
  })()`;
  try {
    const r = await _rtEval(js);
    const v = r.result?.value;
    if (jsonOutput) emitJson(true, v);
    else if (v === null || v === undefined) { /* nothing */ }
    else if (typeof v === 'string') console.log(v);
    else console.log(JSON.stringify(v));
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Read failed: ${e.message}`); process.exit(1);
  }
}

// --- WAVE 1: cmdHover -----------------------------------------------
async function cmdHover(argv) {
  const opts = parseFlags(argv, {
    text: { type: 'string' },
    contains: { type: 'string' },
    nth: { type: 'int' },
  });
  const sel = opts._[0];
  if (!sel && !opts.text && !opts.contains) { log.fail('Usage: glider hover <selector> [--text S | --contains S | --nth N]'); process.exit(1); }
  await _guardAndConnect('hover');
  const findExpr = _buildFindElExpr(sel, opts);
  const js = `(() => {
    const el = ${findExpr};
    if (!el) return { error: 'Element not found' };
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`;
  try {
    const r = await _rtEval(js);
    const v = r.result?.value;
    if (v?.error) { if (jsonOutput) emitJson(false, null, v.error); log.fail(v.error); process.exit(1); }
    // dispatch a real mousemove via CDP
    await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: v.x, y: v.y, button: 'none', clickCount: 0 } });
    if (jsonOutput) emitJson(true, { hovered: true, at: v });
    else log.ok(`Hovered at ${v.x},${v.y}`);
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Hover failed: ${e.message}`); process.exit(1);
  }
}

// --- WAVE 1: cmdFocus / cmdBlur -------------------------------------
async function cmdFocusVerb(argv) {
  const sel = argv[0];
  if (!sel) { log.fail('Usage: glider focus <selector>'); process.exit(1); }
  await _guardAndConnect('focus');
  const js = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { error: 'not found' }; el.focus(); return { focused: true }; })()`;
  const r = await _rtEval(js);
  const v = r.result?.value;
  if (v?.error) { log.fail(v.error); process.exit(1); }
  if (jsonOutput) emitJson(true, { selector: sel, focused: true });
  else log.ok(`Focused: ${sel}`);
}
async function cmdBlurVerb(argv) {
  const sel = argv[0];
  await _guardAndConnect('blur');
  const js = sel
    ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { error: 'not found' }; el.blur(); return { blurred: true }; })()`
    : `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return { blurred: true }; })()`;
  const r = await _rtEval(js);
  const v = r.result?.value;
  if (v?.error) { log.fail(v.error); process.exit(1); }
  if (jsonOutput) emitJson(true, { blurred: true });
  else log.ok(`Blurred${sel ? ': ' + sel : ''}`);
}

// --- WAVE 1: cmdScroll -----------------------------------------------
// scroll-to <sel>  |  scroll-by dx dy  |  scroll-until <sel>
async function cmdScroll(argv) {
  const sub = argv[0];
  await _guardAndConnect('scroll');
  if (sub === 'to' && argv[1]) {
    const sel = argv[1];
    const js = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { error: 'not found' }; el.scrollIntoView({behavior:'auto',block:'center'}); return { scrolled: true }; })()`;
    const r = await _rtEval(js);
    const v = r.result?.value;
    if (v?.error) { log.fail(v.error); process.exit(1); }
    if (jsonOutput) emitJson(true, { scrolledTo: sel }); else log.ok(`Scrolled to: ${sel}`);
  } else if (sub === 'by' && argv[1] && argv[2]) {
    const dx = parseFloat(argv[1]); const dy = parseFloat(argv[2]);
    const js = `(() => { window.scrollBy(${dx}, ${dy}); return { x: window.scrollX, y: window.scrollY }; })()`;
    const r = await _rtEval(js);
    if (jsonOutput) emitJson(true, r.result?.value); else log.ok(`Scrolled by ${dx},${dy}`);
  } else if (sub === 'until' && argv[1]) {
    const sel = argv[1];
    const timeoutMs = 10000; const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await _rtEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const r=el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`);
      if (r.result?.value === true) { if (jsonOutput) emitJson(true, { found: sel }); else log.ok(`Reached: ${sel}`); return; }
      await _rtEval(`window.scrollBy(0, window.innerHeight * 0.8); void 0;`);
      await new Promise(r => setTimeout(r, 300));
    }
    if (jsonOutput) emitJson(false, null, 'scroll-until timeout');
    log.fail(`scroll-until timeout: ${sel}`); process.exit(1);
  } else {
    log.fail('Usage: glider scroll to <sel> | scroll by <dx> <dy> | scroll until <sel>'); process.exit(1);
  }
}

// --- WAVE 1: cmdClick (upgraded) -------------------------------------
// Backward-compat: glider click <selector>
// New:            glider click [<sel>] [--text S] [--contains S] [--regex R] [--nth N] [--role R] [--inside S] [--wait MS] [--scroll-into-view] [--double] [--right] [--hold MS] [--modifier ctrl|shift|alt|meta]
function _buildFindElExpr(sel, opts) {
  // returns a JS expression evaluating to element or null; expects `document`
  const selJ  = sel ? JSON.stringify(sel) : 'null';
  const textJ = opts.text ? JSON.stringify(opts.text) : 'null';
  const contJ = opts.contains ? JSON.stringify(opts.contains) : 'null';
  const rxJ   = opts.regex ? JSON.stringify(opts.regex) : 'null';
  const roleJ = opts.role ? JSON.stringify(opts.role) : 'null';
  const insJ  = opts.inside ? JSON.stringify(opts.inside) : 'null';
  const nthN  = Number.isInteger(opts.nth) ? opts.nth : 0;
  return `(() => {
    const sel=${selJ}, text=${textJ}, cont=${contJ}, rxs=${rxJ}, role=${roleJ}, inside=${insJ}, nth=${nthN};
    const root = inside ? document.querySelector(inside) : document;
    if (!root) return null;
    let els;
    if (sel) els = [...root.querySelectorAll(sel)];
    else if (role) els = [...root.querySelectorAll('[role="'+role+'"]')];
    else els = [...root.querySelectorAll('button, [role=button], a, [role=link], [role=menuitem], [role=option], [role=listitem], li')];
    if (text) { const t=text.toLowerCase(); els = els.filter(e => (e.innerText||'').toLowerCase().includes(t)); }
    if (cont) { const t=cont.toLowerCase(); els = els.filter(e => (e.innerText||'').toLowerCase().includes(t)); }
    if (rxs) { const rx=new RegExp(rxs, 'i'); els = els.filter(e => rx.test(e.innerText||'')); }
    return els[nth] || null;
  })()`;
}
async function cmdClickV2(argv) {
  const opts = parseFlags(argv, {
    text: { type: 'string' }, contains: { type: 'string' }, regex: { type: 'string' },
    nth: { type: 'int' }, role: { type: 'string' }, inside: { type: 'string' },
    wait: { type: 'int' }, 'scroll-into-view': { type: 'boolean' },
    double: { type: 'boolean' }, right: { type: 'boolean' },
    hold: { type: 'int' }, modifier: { type: 'string' },
  });
  const sel = opts._[0];
  if (!sel && !opts.text && !opts.contains && !opts.regex && !opts.role) {
    log.fail('Usage: glider click <selector> [--text S | --contains S | --regex R | --nth N | --role R | --inside S | --scroll-into-view | --double | --right | --wait MS]'); process.exit(1);
  }
  await _guardAndConnect('click');
  const findExpr = _buildFindElExpr(sel, opts);
  const modifiers = { ctrl: 2, shift: 8, alt: 1, meta: 4 };
  const modBits = opts.modifier ? (modifiers[opts.modifier] || 0) : 0;
  // Wait for existence if --wait
  if (opts.wait) {
    const deadline = Date.now() + opts.wait;
    while (Date.now() < deadline) {
      const r = await _rtEval(`(() => { return !!${findExpr}; })()`);
      if (r.result?.value === true) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (opts['scroll-into-view']) {
    await _rtEval(`(() => { const el=${findExpr}; if (el) el.scrollIntoView({behavior:'auto',block:'center'}); void 0; })()`);
    await new Promise(r => setTimeout(r, 100));
  }
  // For pointer-input path (right/double/hold), we need coords; simple .click() covers left-single
  if (opts.right || opts.double || opts.hold) {
    const cr = await _rtEval(`(() => { const el=${findExpr}; if (!el) return {error:'not found'}; const r=el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
    const v = cr.result?.value;
    if (v?.error) { if (jsonOutput) emitJson(false, null, v.error); log.fail(v.error); process.exit(1); }
    const button = opts.right ? 'right' : 'left';
    await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: v.x, y: v.y, button, clickCount: opts.double ? 2 : 1, modifiers: modBits } });
    if (opts.hold) await new Promise(r => setTimeout(r, opts.hold));
    await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: v.x, y: v.y, button, clickCount: opts.double ? 2 : 1, modifiers: modBits } });
    if (opts.double) {
      await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: v.x, y: v.y, button, clickCount: 2, modifiers: modBits } });
      await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: v.x, y: v.y, button, clickCount: 2, modifiers: modBits } });
    }
    if (jsonOutput) emitJson(true, { clicked: true, button, at: v });
    else log.ok(`Clicked (${button}${opts.double ? ',double' : ''}) at ${v.x},${v.y}`);
    return;
  }
  // Left-single path via el.click()
  const js = `(() => { const el=${findExpr}; if (!el) return {error:'Element not found'}; el.click(); return { clicked: true }; })()`;
  try {
    const r = await _rtEval(js);
    if (r.result?.value?.error) { if (jsonOutput) emitJson(false, null, r.result.value.error); log.fail(r.result.value.error); process.exit(1); }
    if (jsonOutput) emitJson(true, { clicked: true });
    else log.ok(`Clicked${sel ? ': '+sel : ''}${opts.text ? ' text='+opts.text : ''}`);
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Click failed: ${e.message}`); process.exit(1);
  }
}

// --- WAVE 1: cmdType (upgraded, --editor auto) ----------------------
async function cmdTypeV2(argv) {
  const opts = parseFlags(argv, {
    editor: { type: 'string' }, // auto|ckeditor|tinymce|prosemirror|monaco|slate|contentEditable|textarea|input
    file: { type: 'string' },
    'clear-first': { type: 'boolean' },
    commit: { type: 'string' },  // enter|tab|blur|none
    code: { type: 'boolean' },
    lang: { type: 'string' },
    intro: { type: 'string' },
    raw: { type: 'boolean' },
    'delay-ms': { type: 'int' },
  });
  const sel = opts._[0];
  let text = opts._.slice(1).join(' ');
  if (opts.file) {
    try { text = fs.readFileSync(opts.file, 'utf8'); } catch (e) { log.fail(`Cannot read --file: ${e.message}`); process.exit(1); }
  }
  if (!sel || (text === undefined || text === null)) {
    log.fail('Usage: glider type <selector> <text> [--editor auto|...] [--file PATH] [--clear-first] [--commit enter|tab|blur|none] [--code --lang X --intro TXT]'); process.exit(1);
  }
  await _guardAndConnect('type');
  const editor = opts.editor || 'auto';
  const clear = !!opts['clear-first'];
  const codeBlock = !!opts.code;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const langJ = JSON.stringify(opts.lang || 'plaintext');
  const introB64 = Buffer.from(opts.intro || '', 'utf8').toString('base64');
  const selJ = JSON.stringify(sel);
  const edJ = JSON.stringify(editor);
  // The heart: editor-agnostic write
  const js = `(() => {
    const dec = b => new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));
    const body = dec('${b64}');
    const intro = dec('${introB64}');
    const el = document.querySelector(${selJ});
    if (!el) return { error: 'Element not found', selector: ${selJ} };
    const codeBlock = ${codeBlock ? 'true' : 'false'};
    const langHint = ${langJ};
    const clearFirst = ${clear ? 'true' : 'false'};
    let editor = ${edJ};
    // auto-detect
    if (editor === 'auto') {
      if (el.ckeditorInstance) editor = 'ckeditor';
      else if (window.tinymce && window.tinymce.get && window.tinymce.get(el.id)) editor = 'tinymce';
      else if (el.pmView || el.classList.contains('ProseMirror') || el.closest('.ProseMirror')) editor = 'prosemirror';
      else if (el.classList.contains('monaco-editor') || el.closest('.monaco-editor')) editor = 'monaco';
      else if (el.hasAttribute('data-slate-editor')) editor = 'slate';
      else if (el.CodeMirror || el.classList.contains('CodeMirror')) editor = 'codemirror';
      else if (el.isContentEditable) editor = 'contentEditable';
      else if (el.tagName === 'TEXTAREA') editor = 'textarea';
      else editor = 'input';
    }
    try {
      if (editor === 'ckeditor') {
        const inst = el.ckeditorInstance;
        if (!inst) return { error: 'ckeditor instance missing' };
        if (clearFirst) inst.setData('');
        if (codeBlock) {
          const pre = document.createElement('pre'), code = document.createElement('code');
          if (langHint) code.className = 'language-' + langHint;
          code.textContent = body;
          pre.appendChild(code);
          const introHtml = intro ? ('<p>' + intro.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>') : '';
          el.focus(); inst.setData(introHtml + pre.outerHTML);
        } else {
          el.focus(); inst.setData(body);
        }
        return { editor: 'ckeditor', wrote: inst.getData().length };
      }
      if (editor === 'tinymce') {
        const inst = window.tinymce.get(el.id);
        if (clearFirst) inst.setContent('');
        if (codeBlock) inst.setContent('<pre><code class="language-'+langHint+'">'+body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</code></pre>');
        else inst.setContent(body);
        return { editor: 'tinymce' };
      }
      if (editor === 'monaco') {
        const mEl = el.classList.contains('monaco-editor') ? el : el.closest('.monaco-editor');
        // Search Monaco global registry for editor bound to this DOM node
        if (window.monaco && window.monaco.editor) {
          const eds = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
          const me = eds.find(m => m.getContainerDomNode && m.getContainerDomNode() === mEl);
          if (me) { if (clearFirst) me.setValue(''); me.setValue(body); return { editor: 'monaco' }; }
        }
        return { error: 'monaco editor not resolvable' };
      }
      if (editor === 'prosemirror' || editor === 'slate' || editor === 'contentEditable') {
        // Best-effort: focus, select-all, insertText (execCommand path)
        const target = el.isContentEditable ? el : (el.querySelector('[contenteditable=true]') || el);
        target.focus();
        if (clearFirst) {
          const s = window.getSelection(); const r = document.createRange();
          r.selectNodeContents(target); s.removeAllRanges(); s.addRange(r);
          document.execCommand('delete', false, null);
        }
        // Insert as either code block or plain
        if (codeBlock) {
          document.execCommand('insertHTML', false, '<pre><code>' + body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</code></pre>');
        } else {
          document.execCommand('insertText', false, body);
        }
        return { editor };
      }
      if (editor === 'textarea' || editor === 'input') {
        const nativeSetter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value').set;
        if (clearFirst) { nativeSetter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }
        nativeSetter.call(el, (clearFirst || !el.value ? '' : el.value) + body);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { editor };
      }
      return { error: 'unknown editor: ' + editor };
    } catch (e) { return { error: 'editor write threw: ' + e.message }; }
  })()`;
  try {
    const r = await _rtEval(js);
    const v = r.result?.value;
    if (v?.error) { if (jsonOutput) emitJson(false, null, v.error); log.fail(v.error); process.exit(1); }
    if (opts.commit && opts.commit !== 'none') {
      // fire commit key via keyboard input layer
      const keyMap = { enter: 'Enter', tab: 'Tab' };
      if (opts.commit === 'blur') {
        await _rtEval(`(() => { const el = document.querySelector(${selJ}); if (el && el.blur) el.blur(); void 0; })()`);
      } else if (keyMap[opts.commit]) {
        await _dispatchKey(keyMap[opts.commit]);
      }
    }
    if (jsonOutput) emitJson(true, v);
    else log.ok(`Typed via ${v.editor || 'unknown'}${v.wrote ? ' (' + v.wrote + ' chars)' : ''}`);
  } catch (e) {
    if (jsonOutput) emitJson(false, null, e.message);
    log.fail(`Type failed: ${e.message}`); process.exit(1);
  }
}

// --- WAVE 1: cmdWait (upgraded) --------------------------------------
async function cmdWait(argv) {
  const opts = parseFlags(argv, {
    selector: { type: 'string' }, text: { type: 'string' }, gone: { type: 'string' },
    matches: { type: 'string' }, stable: { type: 'int' },
    'network-idle': { type: 'int' }, 'url-matches': { type: 'string' },
    'url-changes-from': { type: 'string' },
    timeout: { type: 'int', default: 10000 }, poll: { type: 'int', default: 200 },
  });
  const positional = opts._[0];
  // Back-compat: bare number = sleep in seconds
  if (positional && /^\d+(\.\d+)?$/.test(positional) && !opts.selector && !opts.matches && !opts.text && !opts.gone && !opts['url-matches']) {
    await new Promise(r => setTimeout(r, parseFloat(positional) * 1000));
    if (jsonOutput) emitJson(true, { slept_ms: parseFloat(positional) * 1000 });
    return;
  }
  await _guardAndConnect('wait');
  const deadline = Date.now() + opts.timeout;
  const buildProbe = () => {
    if (opts.selector) {
      const t = opts.text ? JSON.stringify(opts.text.toLowerCase()) : 'null';
      return `(() => { const e = document.querySelector(${JSON.stringify(opts.selector)}); if (!e) return false; const t=${t}; return t ? (e.innerText||'').toLowerCase().includes(t) : true; })()`;
    }
    if (opts.gone) return `!document.querySelector(${JSON.stringify(opts.gone)})`;
    if (opts.matches) return `!!(${opts.matches})`;
    if (opts['url-matches']) return `new RegExp(${JSON.stringify(opts['url-matches'])}).test(location.href)`;
    if (opts['url-changes-from']) return `location.href !== ${JSON.stringify(opts['url-changes-from'])}`;
    return 'true';
  };
  const probe = buildProbe();
  let lastRect = null; let stableStart = null;
  while (Date.now() < deadline) {
    try {
      const r = await _rtEval(probe, { awaitPromise: false });
      const v = r.result?.value;
      if (opts.stable && opts.selector) {
        const rr = await _rtEval(`(() => { const e = document.querySelector(${JSON.stringify(opts.selector)}); if (!e) return null; const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })()`);
        const rect = rr.result?.value;
        if (rect && lastRect && rect.every((n,i)=>n===lastRect[i])) {
          if (!stableStart) stableStart = Date.now();
          if (Date.now() - stableStart >= opts.stable) { if (jsonOutput) emitJson(true, { stable_ms: opts.stable }); else log.ok(`stable for ${opts.stable}ms`); return; }
        } else { stableStart = null; }
        lastRect = rect;
      } else if (v === true) {
        if (jsonOutput) emitJson(true, { matched: true });
        else log.ok('condition met');
        return;
      }
    } catch (_) { /* ignore transient */ }
    await new Promise(r => setTimeout(r, opts.poll));
  }
  if (jsonOutput) emitJson(false, null, 'wait timeout');
  log.fail(`wait timeout after ${opts.timeout}ms`); process.exit(1);
}

// --- WAVE 2: cmdKey / cmdRightClick / cmdDoubleClick / cmdDrag --------
function _keyEventTemplate(keyName) {
  const specials = {
    Enter: { code: 'Enter', keyCode: 13, key: 'Enter', text: '\r' },
    Tab: { code: 'Tab', keyCode: 9, key: 'Tab' },
    Escape: { code: 'Escape', keyCode: 27, key: 'Escape' },
    Backspace: { code: 'Backspace', keyCode: 8, key: 'Backspace' },
    Delete: { code: 'Delete', keyCode: 46, key: 'Delete' },
    ArrowUp: { code: 'ArrowUp', keyCode: 38, key: 'ArrowUp' },
    ArrowDown: { code: 'ArrowDown', keyCode: 40, key: 'ArrowDown' },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37, key: 'ArrowLeft' },
    ArrowRight: { code: 'ArrowRight', keyCode: 39, key: 'ArrowRight' },
    Home: { code: 'Home', keyCode: 36, key: 'Home' },
    End: { code: 'End', keyCode: 35, key: 'End' },
    PageUp: { code: 'PageUp', keyCode: 33, key: 'PageUp' },
    PageDown: { code: 'PageDown', keyCode: 34, key: 'PageDown' },
    Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' },
  };
  return specials[keyName] || null;
}
async function _dispatchKey(keyName, mods = 0) {
  const tpl = _keyEventTemplate(keyName);
  if (!tpl) throw new Error('unknown key: ' + keyName);
  await httpPost('/cdp', { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', modifiers: mods, ...tpl } });
  await httpPost('/cdp', { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', modifiers: mods, ...tpl } });
}
async function _insertText(text) {
  await httpPost('/cdp', { method: 'Input.insertText', params: { text } });
}
async function cmdKey(argv) {
  await _guardAndConnect('key');
  // Grammar: `Ctrl+Enter`, `ArrowDown x5`, `Escape`, or `"literal text"`
  const raw = argv.join(' ');
  if (!raw) { log.fail('Usage: glider key "<Chord|Sequence>"  e.g. "Ctrl+Enter"  |  "ArrowDown x5"  |  "Escape"  |  --text "insert this"'); process.exit(1); }
  const opts = parseFlags(argv, { text: { type: 'string' } });
  if (opts.text) { await _insertText(opts.text); if (jsonOutput) emitJson(true, { inserted: opts.text.length }); else log.ok(`Inserted ${opts.text.length} chars`); return; }
  // parse repeat count: "ArrowDown x5"
  const m = raw.match(/^([\w+]+)(?:\s+x(\d+))?$/i);
  if (m) {
    const chord = m[1]; const times = m[2] ? parseInt(m[2], 10) : 1;
    const parts = chord.split('+');
    const key = parts[parts.length - 1];
    const modMap = { ctrl: 2, control: 2, shift: 8, alt: 1, meta: 4, cmd: 4 };
    let mods = 0;
    for (const p of parts.slice(0, -1)) mods |= (modMap[p.toLowerCase()] || 0);
    for (let i = 0; i < times; i++) await _dispatchKey(key, mods);
    if (jsonOutput) emitJson(true, { key: chord, times });
    else log.ok(`Sent ${chord}${times>1 ? ' x'+times : ''}`);
    return;
  }
  log.fail('Could not parse key expression: ' + raw); process.exit(1);
}
async function cmdRightClick(argv) { await cmdClickV2(['--right', ...argv]); }
async function cmdDoubleClick(argv) { await cmdClickV2(['--double', ...argv]); }
async function cmdClickAt(argv) {
  const parts = (argv[0] || '').split(',');
  if (parts.length !== 2) { log.fail('Usage: glider click-at x,y'); process.exit(1); }
  const x = parseInt(parts[0], 10); const y = parseInt(parts[1], 10);
  await _guardAndConnect('click-at');
  await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } });
  await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } });
  if (jsonOutput) emitJson(true, { clicked: {x, y} });
  else log.ok(`Clicked at ${x},${y}`);
}
async function cmdDrag(argv) {
  const opts = parseFlags(argv, { to: { type: 'string' }, steps: { type: 'int', default: 10 } });
  const src = opts._[0]; const dst = opts.to;
  if (!src || !dst) { log.fail('Usage: glider drag <src-sel> --to <dst-sel> [--steps N]'); process.exit(1); }
  await _guardAndConnect('drag');
  const r = await _rtEval(`(() => {
    const a = document.querySelector(${JSON.stringify(src)}); const b = document.querySelector(${JSON.stringify(dst)});
    if (!a || !b) return { error: 'src or dst not found' };
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return { sx: Math.round(ra.left+ra.width/2), sy: Math.round(ra.top+ra.height/2), dx: Math.round(rb.left+rb.width/2), dy: Math.round(rb.top+rb.height/2) };
  })()`);
  const v = r.result?.value;
  if (v?.error) { log.fail(v.error); process.exit(1); }
  await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: v.sx, y: v.sy, button: 'left', clickCount: 1 } });
  for (let i = 1; i <= opts.steps; i++) {
    const x = v.sx + Math.round((v.dx - v.sx) * i / opts.steps);
    const y = v.sy + Math.round((v.dy - v.sy) * i / opts.steps);
    await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'left' } });
  }
  await httpPost('/cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: v.dx, y: v.dy, button: 'left', clickCount: 1 } });
  if (jsonOutput) emitJson(true, { dragged: {from: [v.sx,v.sy], to: [v.dx,v.dy]} });
  else log.ok(`Dragged ${v.sx},${v.sy} -> ${v.dx},${v.dy}`);
}

// --- WAVE 2: cmdSelect ----------------------------------------------
async function cmdSelect(argv) {
  const opts = parseFlags(argv, { 'by-text': { type: 'string' }, 'by-value': { type: 'string' }, nth: { type: 'int', default: 0 } });
  const sel = opts._[0];
  if (!sel || (!opts['by-text'] && !opts['by-value'] && opts.nth === undefined)) {
    log.fail('Usage: glider select <selector> --by-text S | --by-value V | --nth N'); process.exit(1);
  }
  await _guardAndConnect('select');
  const wantJ = JSON.stringify(opts['by-text'] || opts['by-value'] || '');
  const mode = opts['by-text'] ? 'text' : opts['by-value'] ? 'value' : 'nth';
  const nth = opts.nth || 0;
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { error: 'select not found' };
    const want = ${wantJ}; const mode = ${JSON.stringify(mode)}; const nth = ${nth};
    if (el.tagName === 'SELECT') {
      const opts = [...el.options];
      let target;
      if (mode === 'text') target = opts.find(o => (o.textContent||'').trim().toLowerCase().includes(want.toLowerCase()));
      else if (mode === 'value') target = opts.find(o => o.value === want);
      else target = opts[nth];
      if (!target) return { error: 'option not found' };
      el.value = target.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: target.value };
    }
    // aria-listbox / aria-combobox path
    const listbox = el.getAttribute('role') === 'listbox' ? el : el.querySelector('[role=listbox]');
    if (listbox) {
      const options = [...listbox.querySelectorAll('[role=option]')];
      let target;
      if (mode === 'text') target = options.find(o => (o.textContent||'').toLowerCase().includes(want.toLowerCase()));
      else if (mode === 'value') target = options.find(o => o.getAttribute('data-value') === want || o.textContent.trim() === want);
      else target = options[nth];
      if (!target) return { error: 'aria option not found' };
      target.click();
      return { selected: target.textContent.trim() };
    }
    return { error: 'not a select or listbox' };
  })()`;
  const r = await _rtEval(js);
  const v = r.result?.value;
  if (v?.error) { if (jsonOutput) emitJson(false, null, v.error); log.fail(v.error); process.exit(1); }
  if (jsonOutput) emitJson(true, v);
  else log.ok(`Selected: ${v.selected}`);
}

// --- WAVE 2: cmdEval upgrade (--arg, --arg-file, --json, --await, --context) ---
async function cmdEvalV2(argv) {
  const opts = parseFlags(argv, {
    arg: { type: 'string' }, 'arg-file': { type: 'string' },
    json: { type: 'boolean' }, await: { type: 'boolean', default: true },
    context: { type: 'string' },  // main|iframe|sw|worker (advisory only for now)
  });
  const js = opts._.join(' ');
  if (!js) { log.fail('Usage: glider eval <js> [--arg K=V ...] [--arg-file K=@path ...] [--await] [--context main|iframe|sw|worker]'); process.exit(1); }
  if (!await ensureConnected()) process.exit(1);
  // Build ${K} substitutions safely
  // Multiple --arg parses: user may pass --arg foo=bar --arg baz=qux ; parseFlags only kept the last one.
  // So we re-walk argv for all --arg / --arg-file occurrences.
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arg' && argv[i+1]) { const [k, ...rest] = argv[++i].split('='); args[k] = rest.join('='); }
    else if (argv[i] === '--arg-file' && argv[i+1]) {
      const spec = argv[++i]; const [k, ...rest] = spec.split('='); const path = rest.join('=');
      const p = path.replace(/^@/, '');
      args[k] = fs.readFileSync(p, 'utf8');
    }
  }
  // Substitute ${K} with JSON.stringified value so it's injection-safe
  let expr = js.replace(/\$\{(\w+)\}/g, (m, k) => k in args ? JSON.stringify(args[k]) : m);
  try {
    const r = await _rtEval(expr, { awaitPromise: opts.await !== false });
    const v = r.result?.value;
    if (opts.json || jsonOutput) emitJson(true, v !== undefined ? v : r.result);
    else if (v !== undefined) console.log(typeof v === 'string' ? v : JSON.stringify(v));
    else console.log(JSON.stringify(r));
  } catch (e) {
    if (jsonOutput || opts.json) emitJson(false, null, e.message);
    log.fail(`Eval failed: ${e.message}`); process.exit(1);
  }
}

// --- WAVE 2: cmdScreenshot upgrade (--selector, --clip, --full-page, --format) ---
async function cmdScreenshotV2(argv) {
  const opts = parseFlags(argv, {
    selector: { type: 'string' }, clip: { type: 'string' },
    'full-page': { type: 'boolean' }, format: { type: 'string', default: 'png' },
    pad: { type: 'int', default: 0 },
  });
  const outPath = opts._[0] || `/tmp/glider-screenshot-${Date.now()}.${opts.format}`;
  if (!await ensureConnected()) process.exit(1);
  const params = { format: opts.format };
  if (opts.selector) {
    const r = await _rtEval(`(() => { const el = document.querySelector(${JSON.stringify(opts.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 }; })()`);
    const v = r.result?.value;
    if (!v) { log.fail('selector not found'); process.exit(1); }
    params.clip = { x: v.x - opts.pad, y: v.y - opts.pad, width: v.width + opts.pad*2, height: v.height + opts.pad*2, scale: 1 };
  } else if (opts.clip) {
    const [x, y, w, h] = opts.clip.split(',').map(Number);
    params.clip = { x, y, width: w, height: h, scale: 1 };
  }
  if (opts['full-page']) params.captureBeyondViewport = true;
  try {
    const result = await httpPost('/cdp', { method: 'Page.captureScreenshot', params });
    if (result.data) {
      fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
      if (jsonOutput) emitJson(true, { path: outPath, bytes: Buffer.byteLength(result.data, 'base64') });
      else log.ok(`Screenshot: ${outPath}`);
    } else { log.fail('no screenshot data'); process.exit(1); }
  } catch (e) { log.fail(`Screenshot failed: ${e.message}`); process.exit(1); }
}

// --- WAVE 2: session_liveness_probe (upgrade cmdUseSession) ---
async function cmdUseSessionV2(arg, opts = []) {
  // Try normal path first
  try {
    await cmdUseSession(arg, opts);
    return;
  } catch (_) { /* fall through to re-probe */ }
  // Re-probe: connect + fetch targets, re-match on --url if provided
  const urlIdx = opts.indexOf('--url');
  if (urlIdx >= 0 && opts[urlIdx+1]) {
    log.warn('use-session failed - re-probing');
    try {
      const result = await httpPost('/list-targets', {});
      const targets = result.targets || [];
      const want = opts[urlIdx+1].toLowerCase();
      const hit = targets.find(t => (t.url||'').toLowerCase().includes(want));
      if (hit) { await cmdUseSession(hit.sessionId, opts); return; }
    } catch (e) { log.fail(`re-probe failed: ${e.message}`); }
  }
  log.fail(`use-session: session not live and no --url to re-probe`); process.exit(1);
}

// --- WAVE 3: frames + iframe-scope-eval + upload-file ---
async function cmdFrames(argv) {
  await _guardAndConnect('frames');
  try {
    const r = await httpPost('/cdp', { method: 'Page.getFrameTree', params: {} });
    if (jsonOutput) emitJson(true, r.frameTree);
    else console.log(JSON.stringify(r.frameTree, null, 2));
  } catch (e) { log.fail(`frames failed: ${e.message}`); process.exit(1); }
}
async function cmdFrameEval(argv) {
  const frameId = argv[0]; const js = argv.slice(1).join(' ');
  if (!frameId || !js) { log.fail('Usage: glider frame-eval <frameId> <js>'); process.exit(1); }
  await _guardAndConnect('frame-eval');
  // Create isolated world in frame, eval there
  try {
    const iw = await httpPost('/cdp', { method: 'Page.createIsolatedWorld', params: { frameId, worldName: 'glider' } });
    const r = await _rtEval(js, { contextId: iw.executionContextId });
    const v = r.result?.value;
    if (jsonOutput) emitJson(true, v);
    else console.log(typeof v === 'string' ? v : JSON.stringify(v));
  } catch (e) { log.fail(`frame-eval failed: ${e.message}`); process.exit(1); }
}
async function cmdUpload(argv) {
  const sel = argv[0]; const filePath = argv[1];
  if (!sel || !filePath) { log.fail('Usage: glider upload <input-selector> <file-path>'); process.exit(1); }
  await _guardAndConnect('upload');
  try {
    const nodeR = await _rtEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; return true; })()`);
    if (!nodeR.result?.value) { log.fail('input not found'); process.exit(1); }
    // Need backendNodeId via DOM.getDocument -> DOM.querySelector
    const doc = await httpPost('/cdp', { method: 'DOM.getDocument', params: { depth: -1 } });
    const q = await httpPost('/cdp', { method: 'DOM.querySelector', params: { nodeId: doc.root.nodeId, selector: sel } });
    if (!q.nodeId) { log.fail('nodeId lookup failed'); process.exit(1); }
    await httpPost('/cdp', { method: 'DOM.setFileInputFiles', params: { files: [filePath], nodeId: q.nodeId } });
    if (jsonOutput) emitJson(true, { uploaded: filePath, to: sel });
    else log.ok(`Attached ${filePath} to ${sel}`);
  } catch (e) { log.fail(`upload failed: ${e.message}`); process.exit(1); }
}

// --- WAVE 3: cmdHar (start/stop/dump/status) ---
// v0.4.1: rewired to bexplore subprocess (was Potemkin stub - help advertised
// the verb but dump always returned 0 entries; "server-side subscription
// not implemented"). Now delegates to the same code path `explore --har` uses.
async function cmdHar(argv) {
  const sub = argv[0];
  const STATE_PATH = path.join(os.homedir(), '.glider', 'har-state.json');
  const BUF_HAR = path.join(os.homedir(), '.glider', 'har-buffer.har');
  const BUF_OUT = path.join(os.homedir(), '.glider', 'har-buffer-out');
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; } };
  const writeState = (st) => { try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); } catch {} fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); };
  const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

  if (sub === 'start') {
    const url = argv[1];
    if (!url) { log.fail('Usage: glider har start <url> [--session-id id]'); process.exit(1); }
    const existing = readState();
    if (existing && pidAlive(existing.pid)) {
      log.fail(`HAR capture already running (pid=${existing.pid}, url=${existing.url}). Run 'glider har stop' first.`);
      process.exit(1);
    }
    let sessionId = null;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--session-id' || argv[i] === '--session') sessionId = argv[++i];
    }
    if (!sessionId && activeSessionId) sessionId = activeSessionId;
    await _guardAndConnect('har');
    try { fs.mkdirSync(BUF_OUT, { recursive: true }); } catch {}
    try { fs.unlinkSync(BUF_HAR); } catch {}
    const bexplorePath = path.join(LIB_DIR, 'bexplore.js');
    const spawnArgs = [bexplorePath, url, '--depth', '0', '--output', BUF_OUT, '--har', BUF_HAR];
    if (sessionId) spawnArgs.push('--session-id', sessionId);
    const child = spawn('node', spawnArgs, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.unref();
    const state = { pid: child.pid, har: BUF_HAR, url, session_id: sessionId, started_at: new Date().toISOString() };
    writeState(state);
    if (jsonOutput) emitJson(true, state);
    else log.ok(`HAR capture started (pid=${child.pid}, url=${url}); dump with 'glider har dump [path]'`);
  } else if (sub === 'stop') {
    const st = readState();
    if (!st) { log.fail('No HAR capture in progress'); process.exit(1); }
    if (pidAlive(st.pid)) { try { process.kill(st.pid, 'SIGTERM'); } catch {} }
    try { fs.unlinkSync(STATE_PATH); } catch {}
    if (jsonOutput) emitJson(true, { stopped: true, pid: st.pid });
    else log.ok(`HAR capture stopped (pid=${st.pid})`);
  } else if (sub === 'dump') {
    const p = argv[1] || `/tmp/glider-${Date.now()}.har`;
    const st = readState();
    if (!st) { log.fail('No HAR capture in progress. Run: glider har start <url>'); process.exit(1); }
    const timeoutMs = 60000;
    const started = Date.now();
    while (pidAlive(st.pid) && (Date.now() - started) < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (pidAlive(st.pid)) {
      log.fail(`HAR child still running after ${timeoutMs}ms; run 'glider har stop' or wait`);
      process.exit(1);
    }
    if (!fs.existsSync(st.har)) {
      log.fail(`HAR buffer not found at ${st.har} (capture may have failed)`);
      process.exit(1);
    }
    fs.copyFileSync(st.har, p);
    let entryCount = 0;
    try { entryCount = JSON.parse(fs.readFileSync(p, 'utf8')).log.entries.length; } catch {}
    try { fs.unlinkSync(STATE_PATH); } catch {}
    if (jsonOutput) emitJson(true, { path: p, entries: entryCount });
    else log.ok(`HAR dumped to ${p} (${entryCount} entries)`);
  } else if (sub === 'status') {
    const st = readState();
    if (!st) { if (jsonOutput) emitJson(true, { running: false }); else console.log('idle'); return; }
    const alive = pidAlive(st.pid);
    if (jsonOutput) emitJson(true, { running: alive, ...st });
    else console.log(`${alive ? 'RUNNING' : 'DONE'} pid=${st.pid} url=${st.url} started=${st.started_at}`);
  } else {
    log.fail('Usage: glider har start <url> [--session-id id] | stop | dump [PATH] | status'); process.exit(1);
  }
}

// --- WAVE 4: cmdEmulate ---
async function cmdEmulate(argv) {
  const what = argv[0]; const val = argv.slice(1).join(' ');
  if (!what) { log.fail('Usage: glider emulate <tz|geo|viewport|offline|ua|color-scheme> <value>'); process.exit(1); }
  await _guardAndConnect('emulate');
  try {
    if (what === 'tz') {
      await httpPost('/cdp', { method: 'Emulation.setTimezoneOverride', params: { timezoneId: val } });
    } else if (what === 'geo') {
      const [lat, lng, acc] = val.split(',').map(Number);
      await httpPost('/cdp', { method: 'Emulation.setGeolocationOverride', params: { latitude: lat, longitude: lng, accuracy: acc || 100 } });
    } else if (what === 'viewport') {
      const m = val.match(/^(\d+)x(\d+)(?:,(\d+(?:\.\d+)?))?(?:,(true|false))?$/);
      if (!m) { log.fail('viewport format: WxH[,dpr[,mobile]]'); process.exit(1); }
      await httpPost('/cdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width: parseInt(m[1]), height: parseInt(m[2]), deviceScaleFactor: m[3] ? parseFloat(m[3]) : 1, mobile: m[4] === 'true' } });
    } else if (what === 'offline') {
      const presets = { true: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, 'slow-3g': { offline: false, latency: 400, downloadThroughput: 51200, uploadThroughput: 51200 }, 'fast-4g': { offline: false, latency: 20, downloadThroughput: 4*1024*1024/8, uploadThroughput: 3*1024*1024/8 }, false: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } };
      const p = presets[val]; if (!p) { log.fail('offline: true|slow-3g|fast-4g|false'); process.exit(1); }
      await httpPost('/cdp', { method: 'Network.emulateNetworkConditions', params: p });
    } else if (what === 'ua') {
      await httpPost('/cdp', { method: 'Emulation.setUserAgentOverride', params: { userAgent: val } });
    } else if (what === 'color-scheme') {
      await httpPost('/cdp', { method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: val }] } });
    } else { log.fail(`unknown emulate target: ${what}`); process.exit(1); }
    if (jsonOutput) emitJson(true, { emulate: what, value: val });
    else log.ok(`Emulated ${what}=${val}`);
  } catch (e) { log.fail(`emulate failed: ${e.message}`); process.exit(1); }
}

// --- WAVE 4: cmdStorage ---
async function cmdStorage(argv) {
  const sub = argv[0];
  await _guardAndConnect('storage');
  if (sub === 'get') {
    const k = argv[1]; if (!k) { log.fail('storage get <key>'); process.exit(1); }
    const r = await _rtEval(`localStorage.getItem(${JSON.stringify(k)})`);
    if (jsonOutput) emitJson(true, r.result?.value); else console.log(r.result?.value || '');
  } else if (sub === 'set') {
    const k = argv[1]; const v = argv.slice(2).join(' ');
    await _rtEval(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}); void 0;`);
    if (jsonOutput) emitJson(true, { set: k }); else log.ok(`storage set: ${k}`);
  } else if (sub === 'delete') {
    const k = argv[1];
    await _rtEval(`localStorage.removeItem(${JSON.stringify(k)}); void 0;`);
    if (jsonOutput) emitJson(true, { deleted: k }); else log.ok(`storage deleted: ${k}`);
  } else if (sub === 'keys') {
    const r = await _rtEval(`Object.keys(localStorage)`);
    if (jsonOutput) emitJson(true, r.result?.value);
    else (r.result?.value || []).forEach(k => console.log(k));
  } else if (sub === 'jar') {
    const r = await _rtEval(`(() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=localStorage.getItem(k);} return o; })()`);
    if (jsonOutput) emitJson(true, r.result?.value);
    else console.log(JSON.stringify(r.result?.value || {}, null, 2));
  } else {
    log.fail('Usage: glider storage get <k> | set <k> <v> | delete <k> | keys | jar'); process.exit(1);
  }
}

// --- WAVE 4: cmdHistory + cmdDialog + cmdConsole + cmdPdf ---
async function cmdHistory(argv) {
  const sub = argv[0]; await _guardAndConnect('history');
  if (sub === 'back') await _rtEval('history.back(); void 0;');
  else if (sub === 'forward') await _rtEval('history.forward(); void 0;');
  else if (sub === 'reload') await httpPost('/cdp', { method: 'Page.reload', params: {} });
  else { log.fail('Usage: glider history back | forward | reload'); process.exit(1); }
  if (jsonOutput) emitJson(true, { history: sub }); else log.ok(`history ${sub}`);
}
async function cmdDialog(argv) {
  const sub = argv[0]; const action = argv[1];
  if (sub !== 'auto' || !['accept','dismiss'].includes(action)) { log.fail('Usage: glider dialog auto accept|dismiss'); process.exit(1); }
  await _guardAndConnect('dialog');
  // NOTE: needs bg WS subscription to Page.javascriptDialogOpening for full solution.
  // Here: inject a page-side beforeunload/confirm/alert stub.
  await _rtEval(`(() => {
    window.alert = () => ${action === 'accept' ? 'true' : 'undefined'};
    window.confirm = () => ${action === 'accept' ? 'true' : 'false'};
    window.prompt = () => ${action === 'accept' ? "''" : 'null'};
    window.onbeforeunload = null;
    return { installed: true };
  })()`);
  if (jsonOutput) emitJson(true, { dialog: 'auto-' + action });
  else log.ok(`Dialog auto-${action} installed`);
}
async function cmdConsole(argv) {
  const sub = argv[0]; if (sub !== 'tail' && sub !== 'dump') { log.fail('Usage: glider console tail | dump [PATH]'); process.exit(1); }
  await _guardAndConnect('console');
  await httpPost('/cdp', { method: 'Runtime.enable', params: {} });
  // Persistent tail requires bg WS; here we do a one-shot poll: enable console + report installed
  log.warn('console tail is stub - needs bg WS subscription to Runtime.consoleAPICalled');
  if (jsonOutput) emitJson(true, { installed: true, note: 'stub - bg subscription required' });
}
async function cmdPdf(argv) {
  const opts = parseFlags(argv, { landscape: { type: 'boolean' }, margin: { type: 'float' }, scale: { type: 'float', default: 1.0 } });
  const outPath = opts._[0] || `/tmp/glider-${Date.now()}.pdf`;
  await _guardAndConnect('pdf');
  try {
    const params = { landscape: !!opts.landscape, scale: opts.scale, printBackground: true };
    if (opts.margin !== undefined) { params.marginTop = params.marginBottom = params.marginLeft = params.marginRight = opts.margin; }
    const r = await httpPost('/cdp', { method: 'Page.printToPDF', params });
    if (r.data) { fs.writeFileSync(outPath, Buffer.from(r.data, 'base64')); if (jsonOutput) emitJson(true, { path: outPath }); else log.ok(`PDF: ${outPath}`); }
    else { log.fail('no pdf data'); process.exit(1); }
  } catch (e) { log.fail(`pdf failed: ${e.message}`); process.exit(1); }
}
async function cmdCookieWrite(argv) {
  const opts = parseFlags(argv, { set: { type: 'string' }, delete: { type: 'string' }, host: { type: 'string' } });
  if (!opts.host) { log.fail('Usage: glider cookies --set NAME=VAL --host H  |  --delete NAME --host H'); process.exit(1); }
  await _guardAndConnect('cookies-write');
  try {
    if (opts.set) {
      const [name, ...rest] = opts.set.split('='); const value = rest.join('=');
      const r = await httpPost('/extension', { method: 'setCookie', params: { url: 'https://' + opts.host, name, value } });
      if (jsonOutput) emitJson(true, r); else log.ok(`cookie set: ${name}@${opts.host}`);
    } else if (opts.delete) {
      const r = await httpPost('/extension', { method: 'removeCookie', params: { url: 'https://' + opts.host, name: opts.delete } });
      if (jsonOutput) emitJson(true, r); else log.ok(`cookie deleted: ${opts.delete}@${opts.host}`);
    }
  } catch (e) { log.fail(`cookie write failed: ${e.message}`); process.exit(1); }
}

// --- WAVE 5: cmdMock + cmdA11ySnapshot + cmdRecord/Replay ---
async function cmdMock(argv) {
  const sub = argv[0];
  await _guardAndConnect('mock');
  if (sub === 'clear') {
    await httpPost('/cdp', { method: 'Fetch.disable', params: {} });
    if (jsonOutput) emitJson(true, { cleared: true }); else log.ok('mocks cleared');
    return;
  }
  const opts = parseFlags(argv.slice(1), { status: { type: 'int', default: 200 }, body: { type: 'string' } });
  const glob = argv[0];
  if (!glob || !opts.body) { log.fail('Usage: glider mock <url-glob> --status N --body FILE  |  glider mock clear'); process.exit(1); }
  try {
    await httpPost('/cdp', { method: 'Fetch.enable', params: { patterns: [{ urlPattern: glob }] } });
    log.warn('mock is stub - needs bg WS subscription to Fetch.requestPaused + Fetch.fulfillRequest');
    if (jsonOutput) emitJson(true, { registered: glob, note: 'stub' });
  } catch (e) { log.fail(`mock failed: ${e.message}`); process.exit(1); }
}
async function cmdA11y(argv) {
  await _guardAndConnect('a11y');
  try {
    await httpPost('/cdp', { method: 'Accessibility.enable', params: {} });
    const r = await httpPost('/cdp', { method: 'Accessibility.getFullAXTree', params: {} });
    if (jsonOutput) emitJson(true, r.nodes);
    else console.log(JSON.stringify(r.nodes, null, 2));
  } catch (e) { log.fail(`a11y failed: ${e.message}`); process.exit(1); }
}

// End of dom-scorch verb block. Total ≈ 30 verbs / verb-upgrades.


// Main
async function main() {
  const args = parseGlobalFlags(process.argv.slice(2));
  loadPersistedSession();
  loadPlugins();  // hydrate ~/.glider/plugins/*.plugin.{json,js} - verb-agnostic core
  let cmd = args[0];

  // v0.3.15: reload-ext command aliases -
  // Accept common natural-language variants + typos for high-frequency commands.
  // Rewrites args in place so downstream switch stays clean.
  const RELOAD_EXT_TWO_WORD = new Set([
    'ext-reload', 'ext reload',
    'reload-extension', 'reload extension',
    'reload-ext'
  ]);
  const RELOAD_EXT_ALIASES = new Set(['rex', 'reloadext', 'reloadExt']);
  if (cmd === 'ext' && args[1] === 'reload') {
    cmd = 'reload-ext';
    args.splice(0, 2, 'reload-ext');
  } else if (cmd === 'reload' && (args[1] === 'ext' || args[1] === 'extension')) {
    cmd = 'reload-ext';
    args.splice(0, 2, 'reload-ext');
  } else if (RELOAD_EXT_ALIASES.has(cmd)) {
    cmd = 'reload-ext';
    args[0] = 'reload-ext';
  }
  // Typo suggest: if cmd looks like a common command with 1-2 char edit distance, hint it.
  // (Only checked in unknown-command branch below - this block just normalizes.)
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    showHelp();
    process.exit(0);
  }
  
  // Background version check (non-blocking) - skip for update/version commands.
  // Opt out via GLIDER_NO_UPDATE=1 or CI (operator sockets - set outside this repo).
  if (!['update', 'version', '-v', '--version'].includes(cmd)
      && !process.env.GLIDER_NO_UPDATE && !process.env.CI) {
    checkForUpdates();
  }
  
  // Ensure server is running for most commands
  if (!['start', 'stop', 'help', '--help', '-h', 'update', 'version', '-v', '--version', 'domains', 'resolve'].includes(cmd)) {
    if (!await checkServer()) {
      log.info('Server not running, starting...');
      await cmdStart();
    }
  }
  
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart();
      break;
    case 'reload-ext':
    case 'reload-extension':
      await cmdReloadExt();
      break;
    case 'attach-all':
      await cmdAttachAll(args[1]);   // optional URL substring filter, e.g. 'example.com'
      break;
    case 'install':
      await cmdInstallDaemon();
      break;
    case 'uninstall':
      await cmdUninstallDaemon();
      break;
    case 'update':
      await cmdUpdate();
      break;
    case 'version':
    case '-v':
    case '--version':
      console.log(require('../package.json').version);
      break;
    case 'connect':
      await cmdConnect();
      break;
    case 'browser':
      cmdBrowser();
      break;
    case 'use':
      cmdUse(args[1]);
      break;
    case 'test':
      await cmdTest();
      break;
    case 'tabs':
      await cmdTabs();
      break;
    case 'targets':
      await cmdTargets();
      break;
    case 'use-session':
      await cmdUseSessionV2(args[1], args.slice(2));
      break;
    case 'snapshot':
      await cmdSnapshot(args.slice(1));
      break;
    case 'window':
    case 'win':
      await cmdWindow(args.slice(1));
      break;
    case 'domains':
      await cmdDomains();
      break;
    case 'resolve':
      await cmdResolve(args[1], args.slice(2));
      break;
    case 'goto':
    case 'navigate':
      await cmdGoto(args[1]);
      break;
    case 'open':
      await cmdOpen(args[1]);
      break;
    case 'eval':
    case 'js':
      await cmdEvalV2(args.slice(1));
      break;
    case 'click':
      await cmdClickV2(args.slice(1));
      break;
    case 'type':
      await cmdTypeV2(args.slice(1));
      break;
    case 'screenshot':
      await cmdScreenshotV2(args.slice(1));
      break;
    // ── dom-scorch waves 1-5 ──
    case 'read':
      await cmdRead(args.slice(1));
      break;
    case 'hover':
      await cmdHover(args.slice(1));
      break;
    case 'focus':
      await cmdFocusVerb(args.slice(1));
      break;
    case 'blur':
      await cmdBlurVerb(args.slice(1));
      break;
    case 'scroll':
    case 'scroll-to':
    case 'scroll-by':
    case 'scroll-until':
      if (cmd === 'scroll') await cmdScroll(args.slice(1));
      else await cmdScroll([cmd.replace('scroll-',''), ...args.slice(1)]);
      break;
    case 'wait':
      await cmdWait(args.slice(1));
      break;
    case 'key':
      await cmdKey(args.slice(1));
      break;
    case 'right-click':
      await cmdRightClick(args.slice(1));
      break;
    case 'double-click':
      await cmdDoubleClick(args.slice(1));
      break;
    case 'click-at':
      await cmdClickAt(args.slice(1));
      break;
    case 'drag':
      await cmdDrag(args.slice(1));
      break;
    case 'select':
      await cmdSelect(args.slice(1));
      break;
    case 'frames':
      await cmdFrames(args.slice(1));
      break;
    case 'frame-eval':
      await cmdFrameEval(args.slice(1));
      break;
    case 'upload':
      await cmdUpload(args.slice(1));
      break;
    case 'har':
      await cmdHar(args.slice(1));
      break;
    case 'emulate':
      await cmdEmulate(args.slice(1));
      break;
    case 'storage':
      await cmdStorage(args.slice(1));
      break;
    case 'history':
      await cmdHistory(args.slice(1));
      break;
    case 'dialog':
      await cmdDialog(args.slice(1));
      break;
    case 'console':
      await cmdConsole(args.slice(1));
      break;
    case 'pdf':
      await cmdPdf(args.slice(1));
      break;
    case 'mock':
      await cmdMock(args.slice(1));
      break;
    case 'a11y':
      await cmdA11y(args.slice(1));
      break;
    case 'cookies-write':
      await cmdCookieWrite(args.slice(1));
      break;
    // ── /dom-scorch ──
    case 'text':
      await cmdText();
      break;
    case 'html':
      await cmdHtml(args[1]);
      break;
    case 'title':
      await cmdTitle();
      break;
    case 'url':
      await cmdUrl();
      break;
    case 'run':
      await cmdRun(args[1]);
      break;
    case 'fetch':
      await cmdFetch(args[1], args.slice(2));
      break;
    case 'cfetch':
      await cmdCorsFetch(args[1], args.slice(2));
      break;
    case 'frozen':
      await cmdFrozen(args.slice(1));
      break;
    case 'thaw':
    case 'unfreeze':
    case 'wake':
      await cmdThaw(args.slice(1));
      break;
    case 'cookies':
      if (args.slice(1).some(a => a === '--set' || a === '--delete')) {
        await cmdCookieWrite(args.slice(1));
      } else {
        await cmdCookies(args.slice(1));
      }
      break;
    case 'spawn':
      await cmdSpawn(args.slice(1));
      break;
    case 'extract':
      await cmdExtract(args.slice(1));
      break;
    case 'explore':
      await cmdExplore(args[1], args.slice(2));
      break;
    case 'favicon':
      // Use registry pattern - bulletproof method
      await cmdRegistry('favicon', args.slice(1));
      break;
    case 'registry':
    case 'reg':
      // Run a registry pattern
      await cmdRegistry(args[1], args.slice(2));
      break;
    case 'loop':
    case 'ralph':  // alias for loop - Ralph Wiggum pattern
      // Parse loop options
      const loopOpts = {
        maxIterations: 10,
        maxRuntime: 3600,
        completionMarker: 'LOOP_COMPLETE',
      };
      let taskArg = args[1];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '-n' || args[i] === '--max-iterations') {
          loopOpts.maxIterations = parseInt(args[++i], 10);
        } else if (args[i] === '-t' || args[i] === '--timeout') {
          loopOpts.maxRuntime = parseInt(args[++i], 10);
        } else if (args[i] === '-m' || args[i] === '--marker') {
          loopOpts.completionMarker = args[++i];
        }
      }
      await cmdLoop(taskArg, loopOpts);
      break;
    default:
      // Plugin registry check FIRST - locally-hydrated verbs win over "unknown"
      if (GLIDER_PLUGIN_REGISTRY.has(cmd)) {
        await runPlugin(GLIDER_PLUGIN_REGISTRY.get(cmd), args.slice(1));
        break;
      }
      // Check if it's a domain command from config
      if (DOMAINS[cmd]) {
        const domain = DOMAINS[cmd];
        const shortcut = domain.shortcut || {};
        const scriptPathRaw = shortcut.type === 'script' ? shortcut.target : domain.script;
        const urlRaw = shortcut.type === 'url' ? shortcut.target : domain.url;
        if (scriptPathRaw) {
          const scriptPath = scriptPathRaw.replace(/^~/, os.homedir()).replace(/\$HOME/g, os.homedir());
          if (fs.existsSync(scriptPath)) {
            const { execSync } = require('child_process');
            try {
              execSync(`"${scriptPath}" ${args.slice(1).map(a => `"${a}"`).join(' ')}`, { stdio: 'inherit' });
            } catch (e) {
              process.exit(e.status || 1);
            }
          } else {
            log.fail(`Domain script not found: ${scriptPath}`);
            process.exit(1);
          }
        } else if (urlRaw) {
          await cmdGoto(urlRaw);
        }
        break;
      }
      log.fail(`Unknown command: ${cmd}`);
      // v0.3.15: typo suggest (Levenshtein <=2) before dumping full help.
      const KNOWN_CMDS = ['status','start','stop','restart','reload-ext','attach-all','install','uninstall',
        'update','version','connect','browser','use','test','domains','resolve','goto','eval','click','type',
        'screenshot','snapshot','text','html','title','url','tabs','targets','use-session','fetch','spawn',
        'extract','explore','favicon','window','reg','run','loop','ralph',
        'read','hover','focus','blur','scroll','wait','key','right-click','double-click','click-at','drag','select',
        'frames','frame-eval','upload','har','emulate','storage','history','dialog','console','pdf','mock','a11y','cookies'];
      function lev(a, b) {
        if (Math.abs(a.length - b.length) > 2) return 3;
        const m = Array.from({length: a.length+1}, () => new Array(b.length+1).fill(0));
        for (let i = 0; i <= a.length; i++) m[i][0] = i;
        for (let j = 0; j <= b.length; j++) m[0][j] = j;
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
          m[i][j] = a[i-1] === b[j-1] ? m[i-1][j-1] : 1 + Math.min(m[i-1][j-1], m[i-1][j], m[i][j-1]);
        }
        return m[a.length][b.length];
      }
      const near = KNOWN_CMDS.map(k => [k, lev(cmd, k)]).filter(x => x[1] <= 2).sort((a,b) => a[1]-b[1]).slice(0, 3);
      if (near.length > 0) {
        log.info(`  Did you mean: ${near.map(x => x[0]).join(', ')} ?`);
      }
      showHelp();
      process.exit(1);
  }
}

main().catch(e => {
  log.fail(e.message);
  process.exit(1);
});
