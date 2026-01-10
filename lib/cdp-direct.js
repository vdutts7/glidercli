#!/usr/bin/env node
/**
 * cdp-direct.js - Direct Chrome DevTools Protocol connection
 * No relay, no extension, no bullshit. Just straight to Chrome.
 * 
 * Chrome must be running with --remote-debugging-port=9222
 */

const WebSocket = require('ws');
const http = require('http');

const DEBUG_PORT = process.env.GLIDER_DEBUG_PORT || 9222;
const DEBUG_HOST = '127.0.0.1';

class DirectCDP {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.targetId = null;
    this.sessionId = null;
  }

  // Get list of debuggable targets from Chrome
  async getTargets() {
    return new Promise((resolve, reject) => {
      http.get(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/list`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse targets'));
          }
        });
      }).on('error', reject);
    });
  }

  // Get Chrome version info
  async getVersion() {
    return new Promise((resolve, reject) => {
      http.get(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse version'));
          }
        });
      }).on('error', reject);
    });
  }

  // Connect to a specific target (tab)
  async connect(targetOrUrl) {
    let wsUrl;
    
    if (typeof targetOrUrl === 'string' && targetOrUrl.startsWith('ws://')) {
      wsUrl = targetOrUrl;
    } else {
      // Find target by URL pattern or use first page
      const targets = await this.getTargets();
      let target;
      
      if (typeof targetOrUrl === 'string') {
        target = targets.find(t => t.url?.includes(targetOrUrl) && t.type === 'page');
      }
      if (!target) {
        target = targets.find(t => t.type === 'page' && !t.url?.startsWith('chrome://') && !t.url?.startsWith('devtools://'));
      }
      if (!target) {
        target = targets.find(t => t.type === 'page');
      }
      if (!target) {
        throw new Error('No debuggable page found');
      }
      
      wsUrl = target.webSocketDebuggerUrl;
      this.targetId = target.id;
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', async () => {
        // Enable required domains
        await this.send('Runtime.enable');
        await this.send('Page.enable');
        resolve();
      });
      
      this.ws.on('error', reject);
      
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
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
        }
      });
      
      this.ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  // Send CDP command
  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    
    const id = ++this.messageId;
    this.ws.send(JSON.stringify({ id, method, params }));
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 30000);
      
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
    });
  }

  // High-level helpers
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value;
  }

  async navigate(url) {
    return this.send('Page.navigate', { url });
  }

  async screenshot(format = 'png') {
    return this.send('Page.captureScreenshot', { format });
  }

  async getTitle() {
    return this.evaluate('document.title');
  }

  async getUrl() {
    return this.evaluate('window.location.href');
  }

  async getText() {
    return this.evaluate('document.body.innerText');
  }

  async getHtml(selector) {
    if (selector) {
      return this.evaluate(`document.querySelector('${selector}')?.outerHTML`);
    }
    return this.evaluate('document.documentElement.outerHTML');
  }

  async click(selector) {
    return this.evaluate(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('Element not found: ${selector}');
        el.click();
        return true;
      })()
    `);
  }

  async type(selector, text) {
    return this.evaluate(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('Element not found: ${selector}');
        el.focus();
        el.value = '${text.replace(/'/g, "\\'")}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Check if Chrome debugging is available
async function checkChrome() {
  try {
    const cdp = new DirectCDP();
    const version = await cdp.getVersion();
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Export for use as module
module.exports = { DirectCDP, checkChrome, DEBUG_PORT, DEBUG_HOST };

// CLI mode
if (require.main === module) {
  const cmd = process.argv[2];
  const arg = process.argv.slice(3).join(' ');
  
  (async () => {
    const cdp = new DirectCDP();
    
    try {
      if (cmd === 'check' || cmd === 'status') {
        const check = await checkChrome();
        if (check.ok) {
          console.log('Chrome debugging available');
          console.log('Browser:', check.version.Browser);
          const targets = await cdp.getTargets();
          console.log('Tabs:', targets.filter(t => t.type === 'page').length);
        } else {
          console.error('Chrome debugging not available:', check.error);
          console.error('Run: glider chrome-start');
          process.exit(1);
        }
        return;
      }
      
      if (cmd === 'targets' || cmd === 'tabs') {
        const targets = await cdp.getTargets();
        targets.filter(t => t.type === 'page').forEach((t, i) => {
          console.log(`[${i + 1}] ${t.title}`);
          console.log(`    ${t.url}`);
        });
        return;
      }
      
      // Commands that need connection
      await cdp.connect();
      
      switch (cmd) {
        case 'eval':
          const result = await cdp.evaluate(arg || 'document.title');
          console.log(JSON.stringify(result, null, 2));
          break;
        case 'title':
          console.log(await cdp.getTitle());
          break;
        case 'url':
          console.log(await cdp.getUrl());
          break;
        case 'text':
          console.log(await cdp.getText());
          break;
        case 'html':
          console.log(await cdp.getHtml(arg));
          break;
        case 'goto':
          await cdp.navigate(arg);
          console.log('Navigated to:', arg);
          break;
        case 'click':
          await cdp.click(arg);
          console.log('Clicked:', arg);
          break;
        case 'screenshot':
          const ss = await cdp.screenshot();
          const path = arg || `/tmp/screenshot-${Date.now()}.png`;
          require('fs').writeFileSync(path, Buffer.from(ss.data, 'base64'));
          console.log('Screenshot saved:', path);
          break;
        default:
          console.log('Usage: cdp-direct <command> [args]');
          console.log('Commands: check, targets, eval, title, url, text, html, goto, click, screenshot');
      }
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    } finally {
      cdp.close();
    }
  })();
}
