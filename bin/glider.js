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
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const LIB_DIR = path.join(__dirname, '..', 'lib');
const STATE_FILE = '/tmp/glider-state.json';
const LOG_FILE = '/tmp/glider.log';

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

// Colors
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

// Gradient colors for rainbow effect
const G1 = '\x1b[38;5;51m';   // cyan
const G2 = '\x1b[38;5;45m';   // teal
const G3 = '\x1b[38;5;39m';   // blue
const G4 = '\x1b[38;5;33m';   // deeper blue
const G5 = '\x1b[38;5;27m';   // indigo
const G6 = '\x1b[38;5;21m';   // purple

// Banner - simple ASCII, works everywhere
const BANNER = `
${CYAN}  ------------------------------------------------------->${NC}
${CYAN}       _____ ${BLUE}__    ${MAGENTA}__ ${CYAN}____  ${BLUE}_____ ${MAGENTA}____  ${NC}
${CYAN}      / ____|${BLUE}| |   ${MAGENTA}| |${CYAN}|  _ \\${BLUE}| ____|${MAGENTA}|  _ \\ ${NC}
${CYAN}     | |  __ ${BLUE}| |   ${MAGENTA}| |${CYAN}| | | ${BLUE}|  _| ${MAGENTA}| |_) |${NC}
${CYAN}     | | |_ |${BLUE}| |   ${MAGENTA}| |${CYAN}| | | ${BLUE}| |___${MAGENTA}|  _ < ${NC}
${CYAN}     | |__| |${BLUE}| |___${MAGENTA}| |${CYAN}| |_| ${BLUE}| ____|${MAGENTA}| | \\ \\${NC}
${CYAN}      \\_____|${BLUE}|_____|${MAGENTA}__|${CYAN}|____/${BLUE}|_____|${MAGENTA}|_|  \\_\\${NC}
${CYAN}  ------------------------------------------------------->${NC}
${DIM}       Browser Automation CLI ${WHITE}v${require('../package.json').version}${NC}  ${DIM}|${NC}  ${CYAN}github.com/vdutts7/glidercli${NC}
`;

function showBanner() {
  console.log(BANNER);
}

const log = {
  ok: (msg) => console.error(`${GREEN}✓${NC} ${msg}`),
  fail: (msg) => console.error(`${RED}✗${NC} ${msg}`),
  info: (msg) => console.error(`${BLUE}→${NC} ${msg}`),
  warn: (msg) => console.error(`${YELLOW}!${NC} ${msg}`),
  step: (msg) => console.error(`${CYAN}[STEP]${NC} ${msg}`),
  result: (msg) => console.log(msg),
};

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
  console.log('═══════════════════════════════════════');
  console.log('  STATUS');
  console.log('═══════════════════════════════════════');
  
  const serverOk = await checkServer();
  console.log(serverOk ? `${GREEN}✓${NC} Server running on port ${PORT}` : `${RED}✗${NC} Server not running`);
  
  if (serverOk) {
    const extOk = await checkExtension();
    console.log(extOk ? `${GREEN}✓${NC} Extension connected` : `${RED}✗${NC} Extension not connected`);
    
    if (extOk) {
      const targets = await getTargets();
      if (targets.length > 0) {
        console.log(`${GREEN}✓${NC} ${targets.length} tab(s) connected:`);
        targets.forEach(t => {
          const url = t.targetInfo?.url || 'unknown';
          console.log(`      ${CYAN}${url}${NC}`);
        });
      } else {
        console.log(`${YELLOW}!${NC} No tabs connected`);
      }
    }
  }
  console.log('═══════════════════════════════════════');
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

async function cmdTest() {
  showBanner();
  console.log('═══════════════════════════════════════');
  console.log('  GLIDER TEST');
  console.log('═══════════════════════════════════════');
  
  // Test 1: Server
  const serverOk = await checkServer();
  console.log(serverOk ? `${GREEN}[1/4]${NC} Server: OK` : `${RED}[1/4]${NC} Server: FAIL`);
  if (!serverOk) {
    log.info('Starting server...');
    await cmdStart();
  }
  
  // Test 2: Extension
  const extOk = await checkExtension();
  console.log(extOk ? `${GREEN}[2/4]${NC} Extension: OK` : `${RED}[2/4]${NC} Extension: NOT CONNECTED`);
  
  // Test 3: Tab
  const tabOk = await checkTab();
  console.log(tabOk ? `${GREEN}[3/4]${NC} Tab: OK` : `${RED}[3/4]${NC} Tab: NO TABS`);
  
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
${YELLOW}USAGE:${NC}
    glider <command> [args]

${YELLOW}SERVER:${NC}
    status              Check server, extension, tabs
    start               Start relay server
    stop                Stop relay server
    restart             Stop then start relay server
    test                Run connectivity test

${YELLOW}NAVIGATION:${NC}
    goto <url>          Navigate current tab to URL
    open <url>          Open URL in default browser
    eval <js>           Execute JavaScript, return result
    click <selector>    Click element
    type <sel> <text>   Type into input
    screenshot [path]   Take screenshot

${YELLOW}PAGE INFO:${NC}
    text                Get page text content
    html [selector]     Get page HTML (or element HTML)
    title               Get page title
    url                 Get current URL
    tabs                List connected tabs

${YELLOW}AUTOMATION:${NC}
    run <task.yaml>     Execute YAML task file
    loop <task> [opts]  Run in Ralph Wiggum loop until complete

${YELLOW}CONFIG:${NC}
    domains             List configured domain shortcuts

${YELLOW}LOOP OPTIONS:${NC}
    -n, --max-iterations N   Max iterations (default: 10)
    -t, --timeout N          Max runtime in seconds (default: 3600)
    -m, --marker STRING      Completion marker (default: LOOP_COMPLETE)

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
  
  // Show loaded domains if any
  const domainKeys = Object.keys(DOMAINS);
  if (domainKeys.length > 0) {
    console.log(`${YELLOW}LOADED DOMAINS:${NC} (from config)`);
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
    case 'test':
      await cmdTest();
      break;
    case 'tabs':
      await cmdTabs();
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
    case 'loop':
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
