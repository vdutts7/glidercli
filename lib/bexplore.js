#!/usr/bin/env node
/**
 * bexplore.js - Ruthless site exploration and HAR capture
 * Clicks around, captures everything, maps the entire site
 * 
 * Usage:
 *   node bexplore.js <url> [--depth N] [--output dir] [--har file.har]
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';

class SiteExplorer {
  constructor(options = {}) {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.eventHandlers = new Map();
    
    // Exploration state
    this.visited = new Set();
    this.toVisit = [];
    this.depth = options.depth || 3;
    this.outputDir = options.outputDir || '/tmp/explore';
    this.harFile = options.harFile;
    
    // Captured data
    this.requests = [];
    this.responses = [];
    this.scripts = [];
    this.stylesheets = [];
    this.websockets = [];
    this.consoleMessages = [];
    this.errors = [];
    
    // Site map
    this.siteMap = {
      url: null,
      title: null,
      tabs: [],
      buttons: [],
      links: [],
      forms: [],
      tables: [],
      modals: [],
      filters: [],
      pagination: null,
      infiniteScroll: false,
      sidePanels: [],
      dropdowns: [],
      checkboxes: [],
      screenshots: []
    };
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
        msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
      }
      return;
    }
    
    if (msg.method === 'Target.attachedToTarget') {
      if (!this.sessionId) {
        this.sessionId = msg.params.sessionId;
      }
    }
    
    // Capture EVERYTHING
    if (msg.method === 'Network.requestWillBeSent') {
      this.requests.push({
        id: msg.params.requestId,
        url: msg.params.request.url,
        method: msg.params.request.method,
        headers: msg.params.request.headers,
        postData: msg.params.request.postData,
        type: msg.params.type,
        timestamp: msg.params.timestamp,
        initiator: msg.params.initiator
      });
    }
    
    if (msg.method === 'Network.responseReceived') {
      this.responses.push({
        id: msg.params.requestId,
        url: msg.params.response.url,
        status: msg.params.response.status,
        headers: msg.params.response.headers,
        mimeType: msg.params.response.mimeType,
        timestamp: msg.params.timestamp
      });
    }
    
    if (msg.method === 'Network.webSocketCreated') {
      this.websockets.push({
        id: msg.params.requestId,
        url: msg.params.url,
        timestamp: Date.now()
      });
    }
    
    if (msg.method === 'Debugger.scriptParsed') {
      if (msg.params.url && !msg.params.url.startsWith('chrome')) {
        this.scripts.push({
          id: msg.params.scriptId,
          url: msg.params.url,
          length: msg.params.length
        });
      }
    }
    
    if (msg.method === 'CSS.styleSheetAdded') {
      this.stylesheets.push({
        id: msg.params.header.styleSheetId,
        url: msg.params.header.sourceURL,
        length: msg.params.header.length
      });
    }
    
    if (msg.method === 'Runtime.consoleAPICalled') {
      this.consoleMessages.push({
        type: msg.params.type,
        args: msg.params.args.map(a => a.value || a.description),
        timestamp: msg.params.timestamp
      });
    }
    
    if (msg.method === 'Runtime.exceptionThrown') {
      this.errors.push({
        text: msg.params.exceptionDetails.text,
        url: msg.params.exceptionDetails.url,
        line: msg.params.exceptionDetails.lineNumber,
        timestamp: msg.params.timestamp
      });
    }
    
    const handlers = this.eventHandlers.get(msg.method);
    if (handlers) handlers.forEach(h => h(msg.params));
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
  }

  async send(method, params = {}) {
    const id = ++this.messageId;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
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
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise(r => setTimeout(r, 500));
    if (!this.sessionId) throw new Error('No browser tab connected');
    
    // Enable ALL the things
    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Page.enable'),
      this.send('DOM.enable'),
      this.send('CSS.enable'),
      this.send('Network.enable'),
      this.send('Debugger.enable'),
      this.send('Log.enable'),
    ]);
    
    // Preserve log - don't clear on navigation
    await this.send('Network.setCacheDisabled', { cacheDisabled: false });
    
    console.error('[explore] All CDP domains enabled');
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { 
      expression, 
      returnByValue: true, 
      awaitPromise: true 
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const filename = `${name}-${Date.now()}.png`;
    const filepath = path.join(this.outputDir, filename);
    fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
    this.siteMap.screenshots.push({ name, path: filepath, timestamp: Date.now() });
    console.error(`[explore] Screenshot: ${filename}`);
    return filepath;
  }

  async discoverElements() {
    console.error('[explore] Discovering page elements...');
    
    const elements = await this.evaluate(`
      (() => {
        const result = {
          tabs: [],
          buttons: [],
          links: [],
          forms: [],
          tables: [],
          modals: [],
          filters: [],
          pagination: null,
          infiniteScroll: false,
          sidePanels: [],
          dropdowns: [],
          checkboxes: [],
          inputs: []
        };
        
        // Helper: generate best selector for element
        const getSelector = (el) => {
          // Priority: data-qa > aria-label > id > unique class > nth-child path
          const qa = el.getAttribute('data-qa');
          if (qa) return '[data-qa="' + qa + '"]';
          
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return '[aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]';
          
          if (el.id) return '#' + el.id;
          
          // Try unique class
          const classes = Array.from(el.classList).filter(c => !c.includes('--') && c.length > 2);
          for (const cls of classes) {
            if (document.querySelectorAll('.' + cls).length === 1) {
              return '.' + cls;
            }
          }
          
          // Build nth-child path (last resort)
          const path = [];
          let current = el;
          while (current && current !== document.body) {
            const parent = current.parentElement;
            if (!parent) break;
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(current) + 1;
            const tag = current.tagName.toLowerCase();
            path.unshift(tag + ':nth-child(' + index + ')');
            current = parent;
            if (path.length > 4) break; // limit depth
          }
          return path.join(' > ') || null;
        };
        
        // Tabs (role=tab, .tab, [data-tab], nav items)
        document.querySelectorAll('[role="tab"], .tab, [data-tab], .nav-item, .nav-link, [class*="tab"]').forEach(el => {
          result.tabs.push({
            text: el.textContent?.trim().slice(0, 50),
            selector: getSelector(el),
            active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true'
          });
        });
        
        // Buttons
        document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .btn, [class*="button"]').forEach(el => {
          if (el.offsetParent !== null) { // visible
            result.buttons.push({
              text: el.textContent?.trim().slice(0, 50) || el.value || el.getAttribute('aria-label'),
              selector: getSelector(el),
              label: el.getAttribute('aria-label'),
              qa: el.getAttribute('data-qa'),
              type: el.type || 'button'
            });
          }
        });
        
        // Links (internal only)
        const baseUrl = window.location.origin;
        document.querySelectorAll('a[href]').forEach(el => {
          const href = el.href;
          if (href && href.startsWith(baseUrl) && el.offsetParent !== null) {
            result.links.push({
              text: el.textContent?.trim().slice(0, 50),
              href: href,
              selector: getSelector(el)
            });
          }
        });
        
        // Forms
        document.querySelectorAll('form').forEach(el => {
          result.forms.push({
            action: el.action,
            method: el.method,
            inputs: Array.from(el.querySelectorAll('input, select, textarea')).map(i => ({
              name: i.name,
              type: i.type,
              placeholder: i.placeholder
            }))
          });
        });
        
        // Tables
        document.querySelectorAll('table, [role="grid"], [class*="table"]').forEach(el => {
          const headers = Array.from(el.querySelectorAll('th, [role="columnheader"]')).map(h => h.textContent?.trim());
          const rows = el.querySelectorAll('tr, [role="row"]').length;
          result.tables.push({ headers, rowCount: rows });
        });
        
        // Pagination
        const paginationEl = document.querySelector('[class*="pagination"], [role="navigation"][aria-label*="page"], .pager');
        if (paginationEl) {
          result.pagination = {
            type: 'numbered',
            pages: Array.from(paginationEl.querySelectorAll('a, button')).map(p => p.textContent?.trim()).filter(t => /\\d+/.test(t))
          };
        }
        
        // Infinite scroll detection
        result.infiniteScroll = !!document.querySelector('[class*="infinite"], [data-infinite], [class*="load-more"]');
        
        // Dropdowns
        document.querySelectorAll('select, [role="listbox"], [role="combobox"], [class*="dropdown"], [class*="select"]').forEach(el => {
          result.dropdowns.push({
            text: el.textContent?.trim().slice(0, 30),
            options: Array.from(el.querySelectorAll('option')).map(o => o.textContent?.trim()).slice(0, 10)
          });
        });
        
        // Checkboxes
        document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach(el => {
          result.checkboxes.push({
            label: el.labels?.[0]?.textContent?.trim() || el.getAttribute('aria-label'),
            checked: el.checked
          });
        });
        
        // Inputs
        document.querySelectorAll('input[type="text"], input[type="search"], textarea').forEach(el => {
          if (el.offsetParent !== null) {
            result.inputs.push({
              name: el.name,
              placeholder: el.placeholder,
              type: el.type
            });
          }
        });
        
        // Side panels / drawers
        document.querySelectorAll('[class*="sidebar"], [class*="drawer"], [class*="panel"], aside').forEach(el => {
          result.sidePanels.push({
            visible: el.offsetParent !== null,
            class: el.className
          });
        });
        
        // Modals (hidden ones too)
        document.querySelectorAll('[role="dialog"], .modal, [class*="modal"]').forEach(el => {
          result.modals.push({
            visible: el.offsetParent !== null || el.style.display !== 'none',
            id: el.id
          });
        });
        
        // Filters
        document.querySelectorAll('[class*="filter"], [data-filter], [role="search"]').forEach(el => {
          result.filters.push({
            text: el.textContent?.trim().slice(0, 50)
          });
        });
        
        return result;
      })()
    `);
    
    Object.assign(this.siteMap, elements);
    return elements;
  }

  async clickElement(selector) {
    try {
      const box = await this.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        ({ x: rect.x + rect.width/2, y: rect.y + rect.height/2, visible: el.offsetParent !== null })
      `);
      
      if (!box || !box.visible) return false;
      
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 500)); // Wait for any XHR
      return true;
    } catch (e) {
      return false;
    }
  }

  async clickByText(text) {
    try {
      // First try to find and get bounding box
      const box = await this.evaluate(`
        const el = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], [class*="btn"]'))
          .find(e => e.textContent?.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        ({ x: rect.x + rect.width/2, y: rect.y + rect.height/2 })
      `);
      
      if (!box) return false;
      
      // Use CDP mouse events for proper click
      await this.send('Input.dispatchMouseEvent', { 
        type: 'mousePressed', 
        x: box.x, 
        y: box.y, 
        button: 'left', 
        clickCount: 1 
      });
      await this.send('Input.dispatchMouseEvent', { 
        type: 'mouseReleased', 
        x: box.x, 
        y: box.y, 
        button: 'left', 
        clickCount: 1 
      });
      
      return true;
    } catch (e) {
      console.error(`[explore] Click failed: ${e.message}`);
      return false;
    }
  }

  async scroll(direction = 'down', amount = 500) {
    const delta = direction === 'down' ? amount : -amount;
    await this.evaluate(`window.scrollBy(0, ${delta})`);
    await new Promise(r => setTimeout(r, 300));
  }

  async scrollToBottom() {
    let lastHeight = 0;
    let attempts = 0;
    while (attempts < 10) {
      const height = await this.evaluate('document.body.scrollHeight');
      if (height === lastHeight) break;
      lastHeight = height;
      await this.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
  }

  async explore(startUrl, options = {}) {
    console.error(`[explore] Starting exploration of ${startUrl}`);
    fs.mkdirSync(this.outputDir, { recursive: true });
    
    // If we want fresh network capture, reload the page
    if (options.reload !== false) {
      console.error('[explore] Reloading page to capture all network traffic...');
      await this.send('Page.reload');
      await new Promise(r => setTimeout(r, 3000)); // Wait for page load
    }
    
    this.siteMap.url = await this.evaluate('window.location.href');
    this.siteMap.title = await this.evaluate('document.title');
    
    // Initial screenshot
    await this.screenshot('initial');
    
    // Discover all elements
    const elements = await this.discoverElements();
    console.error(`[explore] Found: ${elements.tabs.length} tabs, ${elements.buttons.length} buttons, ${elements.links.length} links`);
    
    // Click through tabs
    for (const tab of elements.tabs.slice(0, 10)) {
      if (tab.text) {
        console.error(`[explore] Clicking tab: ${tab.text}`);
        try {
          await this.clickByText(tab.text);
          await new Promise(r => setTimeout(r, 1000));
          await this.screenshot(`tab-${tab.text.replace(/[^a-z0-9]/gi, '-').slice(0, 20)}`);
          await this.discoverElements(); // Re-discover after tab change
        } catch (e) {
          console.error(`[explore] Tab click failed: ${e.message}`);
        }
      }
    }
    
    // Click through buttons (non-destructive ones)
    const safeButtons = elements.buttons.filter(b => {
      const text = (b.text || '').toLowerCase();
      return !text.includes('delete') && !text.includes('remove') && !text.includes('submit') && !text.includes('save') && !text.includes('menu');
    });
    
    for (const btn of safeButtons.slice(0, 10)) {
      if (btn.text) {
        console.error(`[explore] Clicking button: ${btn.text}`);
        try {
          await this.clickByText(btn.text);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(`[explore] Button click failed: ${e.message}`);
        }
      }
    }
    
    // Expand dropdowns
    for (const dropdown of elements.dropdowns.slice(0, 5)) {
      console.error(`[explore] Opening dropdown`);
      // Click to open, then click away
    }
    
    // Scroll to trigger lazy loading
    console.error('[explore] Scrolling to trigger lazy loading...');
    await this.scrollToBottom();
    await this.screenshot('scrolled');
    
    // Check all checkboxes (to see what filters do)
    for (const cb of elements.checkboxes.slice(0, 5)) {
      if (cb.label) {
        console.error(`[explore] Toggling checkbox: ${cb.label}`);
        try {
          await this.evaluate(`
            const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
              .find(e => e.labels?.[0]?.textContent?.includes(${JSON.stringify(cb.label)}));
            if (cb) cb.click();
          `);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(`[explore] Checkbox toggle failed: ${e.message}`);
        }
      }
    }
    
    // Final screenshot
    await this.screenshot('final');
    
    return this.generateReport();
  }

  generateReport() {
    const report = {
      url: this.siteMap.url,
      title: this.siteMap.title,
      timestamp: new Date().toISOString(),
      
      // Site structure
      structure: {
        tabs: this.siteMap.tabs.length,
        buttons: this.siteMap.buttons.length,
        links: this.siteMap.links.length,
        forms: this.siteMap.forms.length,
        tables: this.siteMap.tables.length,
        dropdowns: this.siteMap.dropdowns.length,
        checkboxes: this.siteMap.checkboxes.length,
        pagination: this.siteMap.pagination,
        infiniteScroll: this.siteMap.infiniteScroll
      },
      
      // Network activity
      network: {
        totalRequests: this.requests.length,
        byType: this.requests.reduce((acc, r) => {
          acc[r.type] = (acc[r.type] || 0) + 1;
          return acc;
        }, {}),
        apis: this.requests.filter(r => 
          r.url.includes('/api/') || 
          r.url.includes('.json') || 
          r.type === 'XHR' || 
          r.type === 'Fetch'
        ).map(r => ({
          method: r.method,
          url: r.url,
          hasBody: !!r.postData
        })),
        websockets: this.websockets
      },
      
      // Resources
      resources: {
        scripts: this.scripts.length,
        stylesheets: this.stylesheets.length,
        scriptUrls: this.scripts.map(s => s.url).filter(u => u)
      },
      
      // Console/errors
      console: {
        messages: this.consoleMessages.length,
        errors: this.errors.length
      },
      
      // Screenshots
      screenshots: this.siteMap.screenshots,
      
      // Raw data for deep analysis
      raw: {
        tabs: this.siteMap.tabs,
        buttons: this.siteMap.buttons.slice(0, 50),
        links: this.siteMap.links.slice(0, 100),
        forms: this.siteMap.forms,
        tables: this.siteMap.tables,
        requests: this.requests,
        responses: this.responses
      }
    };
    
    // Save report
    const reportPath = path.join(this.outputDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.error(`[explore] Report saved: ${reportPath}`);
    
    // Generate YAML task file for ralph mode
    this.generateTaskFile(report);
    
    // Save HAR if requested
    if (this.harFile) {
      this.saveHAR();
    }
    
    return report;
  }
  
  generateTaskFile(report) {
    const yaml = require('yaml');
    
    // Build task steps from discovered elements
    const steps = [];
    
    // Start with navigation
    steps.push({ goto: report.url });
    steps.push({ wait: 2 });
    
    // Add clicks for key buttons (with selectors)
    const actionButtons = (report.raw.buttons || [])
      .filter(b => b.selector && b.qa && !b.qa.includes('history') && !b.qa.includes('search'))
      .slice(0, 10);
    
    for (const btn of actionButtons) {
      steps.push({ log: `Click: ${btn.text || btn.label}` });
      steps.push({ click: btn.selector });
      steps.push({ wait: 0.5 });
    }
    
    // Add screenshot at end
    steps.push({ screenshot: path.join(this.outputDir, 'task-result.png') });
    steps.push({ log: 'LOOP_COMPLETE' });
    
    const task = {
      name: `Explore ${new URL(report.url).hostname}`,
      generated: new Date().toISOString(),
      source: 'glider explore',
      steps
    };
    
    const taskPath = path.join(this.outputDir, 'task.yaml');
    fs.writeFileSync(taskPath, yaml.stringify(task));
    console.error(`[explore] Task file saved: ${taskPath}`);
    console.error(`[explore] Run with: glider ralph ${taskPath}`);
  }

  saveHAR() {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'bexplore', version: '1.0.0' },
        entries: this.requests.map(req => {
          const resp = this.responses.find(r => r.id === req.id);
          return {
            startedDateTime: new Date(req.timestamp * 1000).toISOString(),
            request: {
              method: req.method,
              url: req.url,
              headers: Object.entries(req.headers || {}).map(([name, value]) => ({ name, value })),
              postData: req.postData ? { text: req.postData } : undefined
            },
            response: resp ? {
              status: resp.status,
              headers: Object.entries(resp.headers || {}).map(([name, value]) => ({ name, value })),
              content: { mimeType: resp.mimeType }
            } : { status: 0, headers: [], content: {} }
          };
        })
      }
    };
    
    fs.writeFileSync(this.harFile, JSON.stringify(har, null, 2));
    console.error(`[explore] HAR saved: ${this.harFile}`);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
bexplore - Ruthless site exploration and HAR capture

Usage:
  node bexplore.js [options]

Options:
  --depth N       Exploration depth (default: 3)
  --output DIR    Output directory (default: /tmp/explore)
  --har FILE      Save HAR file
  --help          Show this help

The tool will:
  1. Discover all tabs, buttons, links, forms, tables
  2. Click through tabs to reveal content
  3. Click safe buttons to trigger XHR
  4. Scroll to trigger lazy loading
  5. Toggle checkboxes/filters
  6. Capture all network requests
  7. Save screenshots at each step
  8. Generate a comprehensive report

Examples:
  node bexplore.js --output /tmp/sage-explore --har /tmp/sage.har
  node bexplore.js --depth 5 --output ~/explore-results
`);
    process.exit(0);
  }
  
  let depth = 3;
  let outputDir = '/tmp/explore';
  let harFile = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--depth') depth = parseInt(args[++i]);
    else if (args[i] === '--output') outputDir = args[++i];
    else if (args[i] === '--har') harFile = args[++i];
  }
  
  const explorer = new SiteExplorer({ depth, outputDir, harFile });
  
  try {
    await explorer.connect();
    await explorer.init();
    
    const url = await explorer.evaluate('window.location.href');
    const report = await explorer.explore(url, { reload: true });
    
    // Print summary
    console.log('\n' + '═'.repeat(50));
    console.log('EXPLORATION COMPLETE');
    console.log('═'.repeat(50));
    console.log(`URL: ${report.url}`);
    console.log(`Title: ${report.title}`);
    console.log('');
    console.log('Structure:');
    console.log(`  Tabs: ${report.structure.tabs}`);
    console.log(`  Buttons: ${report.structure.buttons}`);
    console.log(`  Links: ${report.structure.links}`);
    console.log(`  Forms: ${report.structure.forms}`);
    console.log(`  Tables: ${report.structure.tables}`);
    console.log('');
    console.log('Network:');
    console.log(`  Total requests: ${report.network.totalRequests}`);
    console.log(`  API endpoints: ${report.network.apis.length}`);
    console.log(`  WebSockets: ${report.network.websockets.length}`);
    console.log('');
    console.log('Resources:');
    console.log(`  Scripts: ${report.resources.scripts}`);
    console.log(`  Stylesheets: ${report.resources.stylesheets}`);
    console.log('');
    console.log(`Screenshots: ${report.screenshots.length}`);
    console.log(`Report: ${outputDir}/report.json`);
    if (harFile) console.log(`HAR: ${harFile}`);
    console.log('═'.repeat(50));
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    explorer.close();
  }
}

module.exports = { SiteExplorer };

if (require.main === module) {
  main();
}
