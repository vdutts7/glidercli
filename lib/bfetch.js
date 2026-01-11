#!/usr/bin/env node
/**
 * fetch-via-browser.js
 * Fetch URLs using your authenticated browser session via CDP relay
 * 
 * Usage:
 *   ./fetch-via-browser.js <url> [--output file.json]
 *   ./fetch-via-browser.js https://atoz.amazon.work/apis/talent-card-service/employee/profile/noahsten
 */

const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';

class BrowserFetcher {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(RELAY_URL);
      
      this.ws.on('open', () => {
        console.error('[fetcher] Connected to relay');
        resolve();
      });
      
      this.ws.on('error', (err) => {
        reject(new Error(`Connection failed: ${err.message}`));
      });
      
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        
        // Response to our command
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
          return;
        }
        
        // Event
        if (msg.method === 'Target.attachedToTarget') {
          if (!this.sessionId) {
            this.sessionId = msg.params.sessionId;
            this.targetId = msg.params.targetInfo.targetId;
            console.error(`[fetcher] Got target: ${msg.params.targetInfo.url}`);
          }
        }
      });
    });
  }

  async send(method, params = {}, sessionId = null) {
    const id = ++this.messageId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    
    this.ws.send(JSON.stringify(msg));
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 30000);
      
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  }

  async init() {
    // Initialize connection to browser
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
    
    // Wait for target
    if (!this.sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    
    if (!this.sessionId) {
      throw new Error('No browser tab connected. Click the extension icon on a tab first.');
    }
    
    // Enable Runtime for evaluation
    await this.send('Runtime.enable', {}, this.sessionId);
  }

  async fetch(url) {
    console.error(`[fetcher] Fetching: ${url}`);
    
    // Use browser's fetch API with its cookies
    const script = `
      (async () => {
        const response = await fetch(${JSON.stringify(url)}, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*'
          }
        });
        
        const contentType = response.headers.get('content-type') || '';
        const status = response.status;
        
        let body;
        if (contentType.includes('application/json')) {
          body = await response.json();
        } else {
          body = await response.text();
        }
        
        return { status, contentType, body };
      })()
    `;
    
    const result = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true
    }, this.sessionId);
    
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    
    return result.result.value;
  }

  async navigate(url) {
    console.error(`[fetcher] Navigating to: ${url}`);
    await this.send('Page.navigate', { url }, this.sessionId);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async getPageContent() {
    const result = await this.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    }, this.sessionId);
    return result.result.value;
  }

  async screenshot(path) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png'
    }, this.sessionId);
    
    const fs = require('fs');
    fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
    console.error(`[fetcher] Screenshot saved: ${path}`);
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: fetch-via-browser [options] <url>

Fetch URLs using your authenticated browser session.
Requires the relay server running and extension connected.

Options:
  --output, -o <file>  Save output to file
  --raw                Output raw response (don't pretty-print JSON)
  --navigate           Navigate to URL instead of fetching via XHR
  --screenshot <file>  Take screenshot after fetching
  --help, -h           Show this help

Examples:
  fetch-via-browser https://atoz.amazon.work/apis/talent-card-service/employee/profile/noahsten
  fetch-via-browser -o result.json https://example.com/api/data
  fetch-via-browser --navigate --screenshot shot.png https://atoz.amazon.work
`);
    process.exit(0);
  }
  
  let url = null;
  let outputFile = null;
  let raw = false;
  let navigate = false;
  let screenshot = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      outputFile = args[++i];
    } else if (args[i] === '--raw') {
      raw = true;
    } else if (args[i] === '--navigate') {
      navigate = true;
    } else if (args[i] === '--screenshot') {
      screenshot = args[++i];
    } else if (!args[i].startsWith('-')) {
      url = args[i];
    }
  }
  
  if (!url) {
    console.error('Error: URL required');
    process.exit(1);
  }
  
  const fetcher = new BrowserFetcher();
  
  try {
    await fetcher.connect();
    await fetcher.init();
    
    let result;
    
    if (navigate) {
      await fetcher.navigate(url);
      result = await fetcher.getPageContent();
    } else {
      result = await fetcher.fetch(url);
    }
    
    if (screenshot) {
      await fetcher.screenshot(screenshot);
    }
    
    // Output
    let output;
    if (typeof result === 'object') {
      if (result.body && typeof result.body === 'object') {
        output = raw ? JSON.stringify(result.body) : JSON.stringify(result.body, null, 2);
      } else {
        output = raw ? JSON.stringify(result) : JSON.stringify(result, null, 2);
      }
    } else {
      output = result;
    }
    
    if (outputFile) {
      require('fs').writeFileSync(outputFile, output);
      console.error(`[fetcher] Saved to: ${outputFile}`);
    } else {
      console.log(output);
    }
    
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    fetcher.close();
  }
}

main();
