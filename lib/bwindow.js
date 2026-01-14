#!/usr/bin/env node
/**
 * bwindow.js - Multi-window/tab management for Glider
 * 
 * Commands:
 *   glider window new [url]              Create new browser window
 *   glider window close <targetId>       Close specific tab/window
 *   glider window closeall               Close all tabs created by Glider
 *   glider window list                   List all windows/tabs
 *   glider window focus <targetId>       Bring tab to foreground
 * 
 * The key insight: tabs created with newWindow:true CAN be closed via Target.closeTarget
 * Tabs created in the main window CANNOT be closed (Chrome security)
 */

const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';

class WindowManager {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.targets = new Map(); // targetId -> { sessionId, url, windowId, createdByGlider }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(RELAY_URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => this._handleMessage(JSON.parse(data.toString())));
    });
  }

  _handleMessage(msg) {
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
      }
      return;
    }

    // Track targets
    if (msg.method === 'Target.targetCreated') {
      const info = msg.params.targetInfo;
      if (info.type === 'page') {
        this.targets.set(info.targetId, { 
          targetId: info.targetId, 
          url: info.url,
          type: info.type
        });
      }
    }

    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      if (this.targets.has(targetInfo.targetId)) {
        this.targets.get(targetInfo.targetId).sessionId = sessionId;
      }
    }

    if (msg.method === 'Target.targetDestroyed') {
      this.targets.delete(msg.params.targetId);
    }
  }

  async send(method, params = {}) {
    const id = ++this.messageId;
    const msg = { id, method, params };
    this.ws.send(JSON.stringify(msg));

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

  async init() {
    // Enable target discovery
    await this.send('Target.setDiscoverTargets', { discover: true });
    await new Promise(r => setTimeout(r, 300));
    
    // Get existing targets
    try {
      const { targetInfos } = await this.send('Target.getTargets');
      for (const info of targetInfos) {
        if (info.type === 'page') {
          this.targets.set(info.targetId, { 
            targetId: info.targetId, 
            url: info.url,
            type: info.type
          });
        }
      }
    } catch (e) {
      // Target.getTargets may not be supported by relay
    }
  }

  /**
   * Create a new browser window (not just a tab)
   * Tabs in this window CAN be closed via Target.closeTarget
   */
  async createWindow(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { 
      url,
      newWindow: true  // CRITICAL: creates separate window
    });
    
    // Wait for target to be ready
    await new Promise(r => setTimeout(r, 500));
    
    // Attach to get sessionId
    try {
      const { sessionId } = await this.send('Target.attachToTarget', { 
        targetId, 
        flatten: true 
      });
      
      this.targets.set(targetId, {
        targetId,
        sessionId,
        url,
        createdByGlider: true,
        isWindow: true
      });
      
      return { targetId, sessionId };
    } catch (e) {
      // May already be attached
      return { targetId };
    }
  }

  /**
   * Create a tab in the current window (will go to focused window)
   */
  async createTab(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    await new Promise(r => setTimeout(r, 500));
    
    try {
      const { sessionId } = await this.send('Target.attachToTarget', { 
        targetId, 
        flatten: true 
      });
      
      this.targets.set(targetId, {
        targetId,
        sessionId,
        url,
        createdByGlider: true,
        isWindow: false
      });
      
      return { targetId, sessionId };
    } catch (e) {
      return { targetId };
    }
  }

  /**
   * Close a specific tab/window
   * Only works for tabs created with newWindow:true or via Target.createTarget
   */
  async closeTarget(targetId) {
    try {
      await this.send('Target.closeTarget', { targetId });
      this.targets.delete(targetId);
      return { success: true, targetId };
    } catch (e) {
      // Fallback: try window.close() via Runtime.evaluate
      const target = this.targets.get(targetId);
      if (target?.sessionId) {
        try {
          await this.send('Runtime.evaluate', {
            expression: 'window.close()',
            returnByValue: true
          }, target.sessionId);
          this.targets.delete(targetId);
          return { success: true, targetId, method: 'window.close' };
        } catch (e2) {
          return { success: false, targetId, error: e2.message };
        }
      }
      return { success: false, targetId, error: e.message };
    }
  }

  /**
   * Close all tabs created by Glider
   */
  async closeAll() {
    const results = [];
    for (const [targetId, info] of this.targets) {
      if (info.createdByGlider) {
        const result = await this.closeTarget(targetId);
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Bring a tab to the foreground
   */
  async focusTarget(targetId) {
    try {
      await this.send('Target.activateTarget', { targetId });
      return { success: true, targetId };
    } catch (e) {
      return { success: false, targetId, error: e.message };
    }
  }

  /**
   * List all targets
   */
  list() {
    return Array.from(this.targets.values());
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
bwindow - Multi-window/tab management for Glider

Commands:
  new [url]              Create new browser window (closeable)
  tab [url]              Create new tab in current window
  close <targetId>       Close specific tab/window
  closeall               Close all Glider-created tabs
  list                   List all windows/tabs
  focus <targetId>       Bring tab to foreground

Examples:
  bwindow new https://google.com
  bwindow close ABC123DEF456
  bwindow list
`);
    process.exit(0);
  }

  const wm = new WindowManager();

  try {
    await wm.connect();
    await wm.init();

    switch (cmd) {
      case 'new':
      case 'window': {
        const url = args[1] || 'about:blank';
        const result = await wm.createWindow(url);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'tab': {
        const url = args[1] || 'about:blank';
        const result = await wm.createTab(url);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'close': {
        const targetId = args[1];
        if (!targetId) {
          console.error('Error: targetId required');
          process.exit(1);
        }
        const result = await wm.closeTarget(targetId);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'closeall': {
        const results = await wm.closeAll();
        console.log(JSON.stringify(results, null, 2));
        break;
      }

      case 'list': {
        const targets = wm.list();
        console.log(JSON.stringify(targets, null, 2));
        break;
      }

      case 'focus': {
        const targetId = args[1];
        if (!targetId) {
          console.error('Error: targetId required');
          process.exit(1);
        }
        const result = await wm.focusTarget(targetId);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    wm.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { WindowManager };
