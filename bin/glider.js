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

// Load pattern registry
let REGISTRY = {};
if (fs.existsSync(REGISTRY_FILE)) {
  try {
    REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch (e) { /* ignore parse errors */ }
}

// Direct CDP module
const { DirectCDP, checkChrome } = require(path.join(LIB_DIR, 'cdp-direct.js'));

// Domain extensions - load from ~/.cursor/glider/domains.json or ~/.glider/domains.json
const DOMAIN_CONFIG_PATHS = [
  path.join(os.homedir(), '.cursor', 'glider', 'domains.json'),
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

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_URL);
    const data = JSON.stringify(body);
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
  
  log.info(`Navigating to: ${url}`);
  
  try {
    const result = await httpPost('/cdp', {
      method: 'Page.navigate',
      params: { url }
    });
    console.log(JSON.stringify(result));
    log.ok('Navigated');
  } catch (e) {
    log.fail(`Navigation failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdEval(js) {
  if (!js) {
    log.fail('Usage: glider eval <javascript>');
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
    
    if (result.result?.value !== undefined) {
      console.log(JSON.stringify(result.result.value));
    } else if (result.result?.description) {
      console.log(result.result.description);
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (e) {
    log.fail(`Eval failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdClick(selector) {
  if (!selector) {
    log.fail('Usage: glider click <selector>');
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
      log.fail(result.result.value.error);
      process.exit(1);
    }
    log.ok(`Clicked: ${selector}`);
  } catch (e) {
    log.fail(`Click failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdType(selector, text) {
  if (!selector || !text) {
    log.fail('Usage: glider type <selector> <text>');
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
  // Bulletproof connect: relay + Chrome + trigger attach via HTTP
  log.info('Connecting...');
  
  // 1. Ensure relay is running
  if (!await checkServer()) {
    await cmdStart();
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 2. Ensure Chrome is running
  try {
    execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' });
  } catch {
    log.info('Starting Chrome...');
    execSync('open -a "Google Chrome"');
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // 3. Wait for extension to connect to relay
  for (let i = 0; i < 10; i++) {
    if (await checkExtension()) break;
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (!await checkExtension()) {
    log.fail('Extension not connected to relay');
    log.info('Make sure Glider extension is installed in Chrome');
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
  
  // 5. Ensure we have a real tab (not chrome://)
  try {
    const tabUrl = execSync(`osascript -e 'tell application "Google Chrome" to return URL of active tab of front window'`).toString().trim();
    if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://')) {
      log.info('Creating new tab...');
      execSync(`osascript -e 'tell application "Google Chrome" to make new tab at front window with properties {URL:"https://google.com"}'`);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {
    // No window, create one
    log.info('Creating new window...');
    execSync(`osascript -e 'tell application "Google Chrome" to make new window with properties {URL:"https://google.com"}'`);
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
  execSync(`osascript -e 'tell application "Google Chrome" to make new tab at front window with properties {URL:"https://google.com"}'`);
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
  
  // 8. Need manual click - open Chrome and show instructions
  log.warn('Click the Glider extension icon in Chrome');
  console.log(`  ${B5}(on any real webpage, not chrome:// pages)${NC}`);
  execSync(`osascript -e 'tell application "Google Chrome" to activate'`);
  
  // Send macOS notification so user sees it even if not looking at terminal
  notify('Glider', 'Click the extension icon in Chrome to connect', true);
  
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
  const domainKeys = Object.keys(DOMAINS);
  if (domainKeys.length === 0) {
    log.warn('No domains configured');
    log.info('Add domains to ~/.cursor/glider/domains.json or ~/.glider/domains.json');
    return;
  }
  console.log(`${GREEN}${domainKeys.length}${NC} domain(s) configured:\n`);
  for (const key of domainKeys) {
    const d = DOMAINS[key];
    const type = d.script ? 'script' : 'url';
    const target = d.script || d.url || '';
    console.log(`  ${CYAN}${key}${NC} ${DIM}(${type})${NC}`);
    if (d.description) console.log(`      ${d.description}`);
    console.log(`      ${DIM}${target}${NC}`);
  }
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
  try {
    const result = await httpPost('/cdp', {
      method: 'Runtime.evaluate',
      params: { expression: 'window.location.href', returnByValue: true }
    });
    console.log(result.result?.value || '');
  } catch (e) {
    log.fail(`URL extraction failed: ${e.message}`);
    process.exit(1);
  }
}

// Fetch URL using browser session (authenticated)
async function cmdFetch(url, opts = []) {
  if (!url) {
    log.fail('Usage: glider fetch <url> [--output file]');
    process.exit(1);
  }
  
  log.info(`Fetching: ${url}`);
  
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
    
    if (outputFile) {
      fs.writeFileSync(outputFile, output);
      log.ok(`Saved to ${outputFile}`);
    } else {
      console.log(output);
    }
  } catch (e) {
    log.fail(`Fetch failed: ${e.message}`);
    process.exit(1);
  }
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
    log.fail('Usage: glider explore <url> [--depth N] [--output dir] [--har file]');
    process.exit(1);
  }
  
  let depth = 2;
  let outputDir = '/tmp/glider-explore';
  let harFile = null;
  
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--depth' || opts[i] === '-d') depth = parseInt(opts[++i], 10);
    else if (opts[i] === '--output' || opts[i] === '-o') outputDir = opts[++i];
    else if (opts[i] === '--har') harFile = opts[++i];
  }
  
  log.info(`Exploring: ${url} (depth: ${depth})`);
  
  // Use the bexplore.js library
  const bexplorePath = path.join(LIB_DIR, 'bexplore.js');
  if (fs.existsSync(bexplorePath)) {
    const { spawn } = require('child_process');
    const spawnArgs = [bexplorePath, url, '--depth', String(depth), '--output', outputDir];
    if (harFile) spawnArgs.push('--har', harFile);
    
    const child = spawn('node', spawnArgs, {
      stdio: 'inherit'
    });
    await new Promise((resolve, reject) => {
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code: ${code}`)));
    });
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
    glider <command> [args]

${B5}SETUP${NC}
    ${BW}install${NC}             Install daemon ${DIM}(runs at login, auto-restarts)${NC}
    ${BW}uninstall${NC}           Remove daemon
    ${BW}connect${NC}             Connect to browser ${DIM}(run once per Chrome session)${NC}

${B5}STATUS${NC}
    ${BW}status${NC}              Check server, extension, tabs
    ${BW}test${NC}                Run diagnostics

${B5}NAVIGATION${NC}
    ${BW}goto${NC} <url>          Navigate to URL
    ${BW}eval${NC} <js>           Execute JavaScript
    ${BW}click${NC} <selector>    Click element
    ${BW}type${NC} <sel> <text>   Type into input
    ${BW}screenshot${NC} [path]   Take screenshot

${B5}PAGE INFO${NC}
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
    ${BW}fetch${NC} <url>         Fetch URL with browser session ${DIM}(auth)${NC}
    ${BW}spawn${NC} <urls...>     Open multiple tabs
    ${BW}extract${NC} [opts]      Extract from all tabs
    ${BW}explore${NC} <url>       Crawl site, capture network
    ${BW}favicon${NC} <url> [out] Extract favicon from site ${DIM}(webp)${NC}

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
    Add custom domain commands via ~/.cursor/glider/domains.json:
    {
      "mysite": { "url": "https://mysite.com/dashboard" },
      "mytool": { "script": "~/.cursor/tools/scripts/mytool.sh" }
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
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  if (!cmd || cmd === '--help' || cmd === '-h') {
    showHelp();
    process.exit(0);
  }
  
  // Ensure server is running for most commands
  if (!['start', 'stop', 'help', '--help', '-h'].includes(cmd)) {
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
    case 'install':
      await cmdInstallDaemon();
      break;
    case 'uninstall':
      await cmdUninstallDaemon();
      break;
    case 'connect':
      await cmdConnect();
      break;
    case 'test':
      await cmdTest();
      break;
    case 'tabs':
      await cmdTabs();
      break;
    case 'window':
    case 'win':
      await cmdWindow(args.slice(1));
      break;
    case 'domains':
      await cmdDomains();
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
      await cmdEval(args.slice(1).join(' '));
      break;
    case 'click':
      await cmdClick(args[1]);
      break;
    case 'type':
      await cmdType(args[1], args.slice(2).join(' '));
      break;
    case 'screenshot':
      await cmdScreenshot(args[1]);
      break;
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
      // Check if it's a domain command from config
      if (DOMAINS[cmd]) {
        const domain = DOMAINS[cmd];
        if (domain.script) {
          // Execute external script
          const scriptPath = domain.script.replace(/^~/, os.homedir());
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
        } else if (domain.url) {
          // Navigate to domain URL
          await cmdGoto(domain.url);
        }
        break;
      }
      log.fail(`Unknown command: ${cmd}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(e => {
  log.fail(e.message);
  process.exit(1);
});
