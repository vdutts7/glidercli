#!/usr/bin/env node
/**
 * bextract.js - Extract content from multiple browser tabs in parallel via Glider
 * 
 * Usage:
 *   bextract                          # Extract from all connected tabs
 *   bextract --sessions s1,s2,s3      # Extract from specific sessions
 *   bextract --exclude session-1      # Exclude specific sessions
 *   bextract --js 'document.title'    # Custom JS expression
 *   bextract --selector '.content'    # Extract specific element
 * 
 * Options:
 *   --js <expr>         JavaScript expression to evaluate (default: document.body.innerText)
 *   --selector <sel>    CSS selector to extract
 *   --sessions <list>   Comma-separated session IDs
 *   --exclude <list>    Comma-separated sessions to exclude
 *   --limit <n>         Max characters per result (default: 10000)
 *   --timeout <ms>      Timeout per extraction (default: 15000)
 *   --json              Output as JSON
 *   --quiet             Suppress progress output
 * 
 * Examples:
 *   bextract --exclude session-1 --limit 5000
 *   bextract --js 'document.title' --json
 *   bextract --selector 'article' --sessions session-2,session-3
 */

const WebSocket = require('ws');
const http = require('http');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';
const DEFAULT_LIMIT = 10000;
const DEFAULT_TIMEOUT = 15000;

async function getTargets() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:19988/targets', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', () => resolve([]));
  });
}

async function extractFromSession(sessionId, jsExpr, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, limit = DEFAULT_LIMIT } = options;
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    let resolved = false;
    
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error(`Timeout for ${sessionId}`));
      }
    }, timeout);
    
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        sessionId,
        method: 'Runtime.evaluate',
        params: { 
          expression: jsExpr,
          returnByValue: true 
        }
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1 && !resolved) {
        resolved = true;
        clearTimeout(timer);
        ws.close();
        
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          let value = msg.result?.result?.value;
          if (typeof value === 'string' && value.length > limit) {
            value = value.substring(0, limit) + `\n... [truncated at ${limit} chars]`;
          }
          resolve(value);
        }
      }
    });
    
    ws.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function extractParallel(sessions, jsExpr, options = {}) {
  const { quiet = false } = options;
  const results = {};
  
  const promises = sessions.map(async ({ sessionId, url }) => {
    try {
      if (!quiet) console.error(`[bextract] Extracting from ${sessionId}...`);
      const content = await extractFromSession(sessionId, jsExpr, options);
      results[sessionId] = { url, content, error: null };
    } catch (err) {
      results[sessionId] = { url, content: null, error: err.message };
    }
  });
  
  await Promise.all(promises);
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  
  let jsExpr = 'document.body.innerText';
  let selector = null;
  let sessions = null;
  let exclude = [];
  let limit = DEFAULT_LIMIT;
  let timeout = DEFAULT_TIMEOUT;
  let outputJson = false;
  let quiet = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--js' || arg === '-e') {
      jsExpr = args[++i];
    } else if (arg === '--selector' || arg === '-s') {
      selector = args[++i];
    } else if (arg === '--sessions') {
      sessions = args[++i].split(',');
    } else if (arg === '--exclude' || arg === '-x') {
      exclude = args[++i].split(',');
    } else if (arg === '--limit' || arg === '-l') {
      limit = parseInt(args[++i], 10);
    } else if (arg === '--timeout' || arg === '-t') {
      timeout = parseInt(args[++i], 10);
    } else if (arg === '--json' || arg === '-j') {
      outputJson = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
bextract - Extract content from multiple browser tabs in parallel

Usage:
  bextract                          # Extract from all connected tabs
  bextract --sessions s1,s2,s3      # Extract from specific sessions
  bextract --exclude session-1      # Exclude specific sessions
  bextract --js 'document.title'    # Custom JS expression
  bextract --selector '.content'    # Extract specific element

Options:
  -e, --js <expr>       JavaScript expression (default: document.body.innerText)
  -s, --selector <sel>  CSS selector to extract
  --sessions <list>     Comma-separated session IDs
  -x, --exclude <list>  Sessions to exclude
  -l, --limit <n>       Max chars per result (default: ${DEFAULT_LIMIT})
  -t, --timeout <ms>    Timeout per extraction (default: ${DEFAULT_TIMEOUT})
  -j, --json            Output as JSON
  -q, --quiet           Suppress progress output
  -h, --help            Show this help
`);
      process.exit(0);
    }
  }
  
  // Build JS expression
  if (selector) {
    jsExpr = `document.querySelector('${selector}')?.innerText || ''`;
  }
  
  try {
    // Get targets
    const targets = await getTargets();
    if (targets.length === 0) {
      console.error('Error: No browser tabs connected. Click extension icon on tabs first.');
      process.exit(1);
    }
    
    // Filter sessions
    let filteredTargets = targets;
    if (sessions) {
      filteredTargets = targets.filter(t => sessions.includes(t.sessionId));
    }
    if (exclude.length > 0) {
      filteredTargets = filteredTargets.filter(t => !exclude.includes(t.sessionId));
    }
    
    if (filteredTargets.length === 0) {
      console.error('Error: No matching sessions found');
      process.exit(1);
    }
    
    if (!quiet) {
      console.error(`[bextract] Extracting from ${filteredTargets.length} tabs in parallel...`);
    }
    
    // Extract in parallel
    const results = await extractParallel(
      filteredTargets.map(t => ({ sessionId: t.sessionId, url: t.targetInfo?.url })),
      jsExpr,
      { limit, timeout, quiet }
    );
    
    // Output
    if (outputJson) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const [sessionId, data] of Object.entries(results)) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`SESSION: ${sessionId}`);
        console.log(`URL: ${data.url}`);
        console.log('='.repeat(60));
        if (data.error) {
          console.log(`ERROR: ${data.error}`);
        } else {
          console.log(data.content);
        }
      }
    }
    
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
