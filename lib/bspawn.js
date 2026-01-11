#!/usr/bin/env node
/**
 * bspawn.js - Spawn multiple browser tabs in parallel via Glider
 * 
 * Usage:
 *   bspawn <url1> <url2> ...           # Spawn tabs for each URL
 *   bspawn -f urls.txt                 # Read URLs from file (one per line)
 *   bspawn --json '["url1","url2"]'    # URLs as JSON array
 *   cat urls.txt | bspawn -            # Read from stdin
 * 
 * Options:
 *   --wait <ms>     Wait time after spawning (default: 3000)
 *   --status        Show status after spawning
 *   --quiet         Suppress output
 * 
 * Examples:
 *   bspawn https://example.com https://google.com
 *   bspawn -f /tmp/orr-urls.txt --wait 5000
 *   echo "https://example.com" | bspawn -
 */

const WebSocket = require('ws');
const fs = require('fs');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';
const DEFAULT_WAIT = 3000;

async function spawnTabs(urls, options = {}) {
  const { wait = DEFAULT_WAIT, quiet = false } = options;
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    let id = 0;
    const results = [];
    
    ws.on('open', () => {
      if (!quiet) console.error(`[bspawn] Spawning ${urls.length} tabs...`);
      urls.forEach(url => {
        ws.send(JSON.stringify({ 
          id: ++id, 
          method: 'Target.createTarget', 
          params: { url } 
        }));
      });
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.result?.targetId) {
        results.push({ id: msg.id, targetId: msg.result.targetId });
        if (!quiet) console.error(`[bspawn] Tab ${results.length}/${urls.length} created`);
      }
      if (msg.method === 'Target.attachedToTarget') {
        if (!quiet) console.error(`[bspawn] Attached: ${msg.params?.targetInfo?.url?.substring(0, 60)}...`);
      }
      if (results.length === urls.length) {
        setTimeout(() => {
          ws.close();
          resolve(results);
        }, wait);
      }
    });
    
    ws.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)));
    
    // Timeout after 30s
    setTimeout(() => {
      ws.close();
      if (results.length > 0) resolve(results);
      else reject(new Error('Timeout waiting for tabs to spawn'));
    }, 30000);
  });
}

async function getStatus() {
  const http = require('http');
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:19988/targets', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', () => resolve([]));
  });
}

async function main() {
  const args = process.argv.slice(2);
  let urls = [];
  let wait = DEFAULT_WAIT;
  let showStatus = false;
  let quiet = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--wait' || arg === '-w') {
      wait = parseInt(args[++i], 10);
    } else if (arg === '--status' || arg === '-s') {
      showStatus = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '-f' || arg === '--file') {
      const file = args[++i];
      urls = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } else if (arg === '--json' || arg === '-j') {
      urls = JSON.parse(args[++i]);
    } else if (arg === '-') {
      // Read from stdin
      urls = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
bspawn - Spawn multiple browser tabs in parallel via Glider

Usage:
  bspawn <url1> <url2> ...           # Spawn tabs for each URL
  bspawn -f urls.txt                 # Read URLs from file
  bspawn --json '["url1","url2"]'    # URLs as JSON array
  cat urls.txt | bspawn -            # Read from stdin

Options:
  -w, --wait <ms>   Wait time after spawning (default: 3000)
  -s, --status      Show status after spawning
  -q, --quiet       Suppress output
  -h, --help        Show this help
`);
      process.exit(0);
    } else if (arg.startsWith('http')) {
      urls.push(arg);
    }
  }
  
  if (urls.length === 0) {
    console.error('Error: No URLs provided');
    process.exit(1);
  }
  
  try {
    const results = await spawnTabs(urls, { wait, quiet });
    
    if (showStatus) {
      const targets = await getStatus();
      console.log(JSON.stringify(targets.map(t => ({
        sessionId: t.sessionId,
        url: t.targetInfo?.url
      })), null, 2));
    } else if (!quiet) {
      console.log(JSON.stringify(results, null, 2));
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
