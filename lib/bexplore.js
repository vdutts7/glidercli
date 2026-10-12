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
const http = require('http');
const { relayHttpUrl, relayWebSocketUrl } = require('./relay-config.js');

const RELAY_URL = relayWebSocketUrl();
const RELAY_HTTP = relayHttpUrl();

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
    // 0 = passive (reload/HAR/screenshots, zero clicks). Any other value = full live-DOM flay.
    this.depth = options.depth === 0 ? 0 : Infinity;
    this.outputDir = options.outputDir || '/tmp/explore';
    this.harFile = options.harFile;
    this.wantedSessionId = options.sessionId || null;
    this.sessionResolved = null;
    
    // Captured data
    this.requests = [];
    this.responses = [];
    this.bodies = {};
    this._bodyJobs = [];
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
      const sid = msg.params.sessionId;
      if (this.wantedSessionId) {
        if (sid === this.wantedSessionId) {
          this.sessionId = sid;
          if (this.sessionResolved) this.sessionResolved();
        }
      } else if (!this.sessionId) {
        this.sessionId = sid;
        if (this.sessionResolved) this.sessionResolved();
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

    if (msg.method === 'Network.loadingFinished') {
      const id = msg.params.requestId;
      this._bodyJobs.push(this._pullBody(id));
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

  async send(method, params = {}, options = {}) {
    const id = ++this.messageId;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    const timeoutMs = options.timeoutMs ?? 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify(msg), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async sendWithRetry(method, params = {}, options = {}) {
    const retries = options.retries ?? 3;
    const delayMs = options.delayMs ?? 400;
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.send(method, params, options);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          console.error(`[explore] ${method} attempt ${attempt}/${retries} failed: ${err.message}`);
          await new Promise((r) => setTimeout(r, delayMs * attempt));
        }
      }
    }
    throw lastErr;
  }

  async fetchTargets() {
    return new Promise((resolve, reject) => {
      const url = new URL('/targets', RELAY_HTTP);
      http.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid /targets JSON: ${e.message}`));
          }
        });
      }).on('error', reject);
    });
  }

  async prefetchSessionFromTargets() {
    if (!this.wantedSessionId) return false;
    const targets = await this.fetchTargets();
    if (!Array.isArray(targets)) {
      throw new Error('/targets did not return an array');
    }
    const hit = targets.find((t) => t.sessionId === this.wantedSessionId);
    if (!hit) {
      const available = targets.map((t) => t.sessionId).filter(Boolean).join(', ') || 'none';
      throw new Error(`Session ${this.wantedSessionId} not in /targets (available: ${available})`);
    }
    this.sessionId = this.wantedSessionId;
    console.error(`[explore] Session pinned from /targets: ${this.sessionId} (${hit.url || hit.title || 'tab'})`);
    return true;
  }

  async init() {
    if (this.wantedSessionId) {
      await this.prefetchSessionFromTargets();
    }

    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    if (!this.sessionId) {
      await new Promise((resolve, reject) => {
        this.sessionResolved = resolve;
        setTimeout(() => {
          if (!this.sessionId) reject(new Error('Timeout waiting for tab attachment'));
          else resolve();
        }, 10000);
      });
    } else if (this.sessionResolved) {
      this.sessionResolved();
    }

    if (!this.sessionId) throw new Error('No browser tab connected');

    const domainEnables = [
      ['Runtime.enable', {}],
      ['Page.enable', {}],
      ['DOM.enable', {}],
      ['CSS.enable', {}],
      ['Network.enable', {}],
      ['Debugger.enable', {}],
      ['Log.enable', {}],
    ];
    for (const [method, params] of domainEnables) {
      const retries = method === 'CSS.enable' ? 4 : 2;
      await this.sendWithRetry(method, params, { retries, delayMs: 500 });
    }

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
        try {
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
          try {
          const qa = el.getAttribute('data-qa');
          if (qa) return '[data-qa="' + qa.replace(/"/g, '\\"') + '"]';
          
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return '[aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]';
          
          if (el.id) return '#' + CSS.escape(el.id);
          
          const classes = Array.from(el.classList).filter(c => !c.includes('--') && c.length > 2);
          for (const cls of classes) {
            try {
              const sel = '.' + CSS.escape(cls);
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (_) {}
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
          } catch (_) { return null; }
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
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          result.buttons.push({
            text: el.textContent?.trim().slice(0, 50) || el.value || el.getAttribute('aria-label'),
            selector: getSelector(el),
            label: el.getAttribute('aria-label'),
            qa: el.getAttribute('data-qa'),
            type: el.type || 'button'
          });
        });
        
        // Links (internal only)
        const baseUrl = window.location.origin;
        document.querySelectorAll('a[href]').forEach(el => {
          const href = el.href;
          const r = el.getBoundingClientRect();
          if (href && href.startsWith(baseUrl) && (r.width > 0 || r.height > 0)) {
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
        } catch (e) {
          return {
            tabs: [], buttons: [], links: [], forms: [], tables: [], modals: [],
            filters: [], pagination: null, infiniteScroll: false, sidePanels: [],
            dropdowns: [], checkboxes: [], inputs: [], discoveryError: String(e && e.message || e)
          };
        }
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
    const depth = this.depth;
    this.clicksPerformed = 0;
    console.error(`[explore] Starting exploration of ${startUrl} (depth=${depth})`);
    fs.mkdirSync(this.outputDir, { recursive: true });
    
    // If we want fresh network capture, reload the page
    if (options.reload !== false) {
      console.error('[explore] Reloading page to capture all network traffic...');
      await this.send('Page.reload');
      await new Promise(r => setTimeout(r, 6000));
    }
    
    this.siteMap.url = await this.evaluate('window.location.href');
    this.siteMap.title = await this.evaluate('document.title');
    
    // Initial screenshot
    await this.screenshot('initial');
    
    // Discover all elements (best-effort - heavy SPAs may throw during discovery;
    // don't let a discovery failure abort HAR persistence)
    let elements;
    try {
      elements = await this.discoverElements();
      console.error(`[explore] Found: ${elements.tabs.length} tabs, ${elements.buttons.length} buttons, ${elements.links.length} links`);
      if (elements.buttons.length + elements.links.length + elements.tabs.length === 0) {
        await new Promise(r => setTimeout(r, 4000));
        elements = await this.discoverElements();
        console.error(`[explore] rediscover: ${elements.tabs.length} tabs, ${elements.buttons.length} buttons, ${elements.links.length} links`);
      }
    } catch (e) {
      console.error(`[explore] DOM discovery failed (${e.message}); skipping discovery, preserving HAR`);
      elements = { tabs: [], buttons: [], links: [], forms: [], tables: [], dropdowns: [], checkboxes: [], modals: [], sidePanels: [] };
      this.siteMap.discoveryError = e.message;
    }
    
    if (depth === 0) {
      console.error('[explore] depth=0 passive - no clicks, scroll, or toggles');
    } else {
      const visited = new Set();
      const poison = /delete|remove|sign out|log out|logout|disconnect|unsubscribe/;
      const flayKey = (kind, item) => {
        const href = (item.href || '').split('?')[0].split('#')[0];
        const text = (item.text || item.label || '').trim().slice(0, 80);
        return `${kind}|${href}|${text}|${item.selector || ''}`;
      };
      const unsafe = (item) => poison.test((item.text || item.label || '').toLowerCase());
      let stagnant = 0;
      while (stagnant < 2) {
        let els;
        try {
          els = await this.discoverElements();
        } catch (e) {
          console.error(`[explore] rediscover failed (${e.message})`);
          els = { tabs: [], buttons: [], links: [], checkboxes: [] };
        }
        const queue = [];
        for (const tab of els.tabs || []) queue.push({ kind: 'tab', item: tab });
        for (const btn of els.buttons || []) queue.push({ kind: 'button', item: btn });
        for (const link of els.links || []) queue.push({ kind: 'link', item: link });
        for (const cb of els.checkboxes || []) queue.push({ kind: 'checkbox', item: cb });
        const next = queue.find(({ kind, item }) => !unsafe(item) && !visited.has(flayKey(kind, item)) && (item.text || item.label || item.href || item.selector));
        if (!next) {
          console.error('[explore] frontier empty; scrolling then one more discover');
          await this.scrollToBottom();
          stagnant += 1;
          continue;
        }
        stagnant = 0;
        const key = flayKey(next.kind, next.item);
        visited.add(key);
        const label = next.item.text || next.item.label || next.item.href || key;
        console.error(`[explore] flay ${next.kind}: ${String(label).slice(0, 80)} (visited=${visited.size})`);
        try {
          if (next.kind === 'link' && next.item.href) {
            await this.evaluate(`location.assign(${JSON.stringify(next.item.href)})`);
          } else if (next.kind === 'checkbox' && next.item.label) {
            await this.evaluate(`
              const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
                .find(e => e.labels?.[0]?.textContent?.includes(${JSON.stringify(next.item.label)}));
              if (cb) cb.click();
            `);
          } else if (next.item.selector) {
            await this.clickElement(next.item.selector);
          } else if (next.item.text) {
            await this.clickByText(next.item.text);
          }
          this.clicksPerformed++;
          await new Promise(r => setTimeout(r, 800));
          if (this.clicksPerformed % 5 === 0) {
            await this.screenshot(`flay-${this.clicksPerformed}`);
          }
        } catch (e) {
          console.error(`[explore] flay click failed: ${e.message}`);
        }
      }
      await this.screenshot('scrolled');
    }
    
    // Final screenshot (best-effort)
    try {
      await this.screenshot('final');
    } catch (e) {
      console.error(`[explore] Final screenshot failed (${e.message}); continuing`);
    }
    
    const report = this.generateReport();
    if (this.harFile) {
      await this.saveHAR();
    }
    try {
      this.generateTaskFile(report);
    } catch (e) {
      console.error('[explore] task.yaml skipped:', e.message);
    }
    return report;
  }

  generateReport() {
    const report = {
      url: this.siteMap.url,
      title: this.siteMap.title,
      timestamp: new Date().toISOString(),
      depth: this.depth,
      clicksPerformed: this.clicksPerformed ?? 0,
      passive: this.depth === 0,
      sessionId: this.sessionId,
      
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
    return report;
  }
  
  generateTaskFile(report) {
    let yaml;
    try {
      yaml = require('yaml');
    } catch (e) {
      console.error('[explore] yaml module missing; skip task.yaml');
      return;
    }
    
    // Build task steps from discovered elements
    const steps = [];
    
    // Start with navigation
    steps.push({ goto: report.url });
    steps.push({ wait: 2 });
    
    // Add clicks for key buttons (with selectors)
    if (this.depth > 0) {
      const actionButtons = (report.raw.buttons || [])
        .filter(b => b.selector && b.qa && !b.qa.includes('history') && !b.qa.includes('search'));
      
      for (const btn of actionButtons) {
        steps.push({ log: `Click: ${btn.text || btn.label}` });
        steps.push({ click: btn.selector });
        steps.push({ wait: 0.5 });
      }
    }
    
    // Add screenshot at end
    steps.push({ screenshot: path.join(this.outputDir, 'task-result.png') });
    
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

  _bodyable(mime) {
    const m = (mime || '').toLowerCase();
    if (!m) return true;
    if (/image|font|video|audio|wasm|octet-stream|woff|zip|pdf/.test(m)) return false;
    return /json|text|xml|javascript|graphql|urlencoded/.test(m) || m.startsWith('text/');
  }

  async _pullBody(id) {
    if (this.bodies[id]) return;
    const resp = this.responses.find(r => r.id === id);
    if (resp && !this._bodyable(resp.mimeType)) return;
    try {
      const r = await this.send('Network.getResponseBody', { requestId: id }, { timeoutMs: 2500 });
      if (r && r.body != null) {
        this.bodies[id] = r.base64Encoded
          ? Buffer.from(r.body, 'base64').toString('utf8')
          : r.body;
      }
    } catch (_) { /* evicted/opaque */ }
  }

  async saveHAR() {
    await Promise.allSettled(this._bodyJobs);
    const bodies = { ...this.bodies };
    for (const resp of this.responses) {
      if (bodies[resp.id]) continue;
      if (!this._bodyable(resp.mimeType)) continue;
      try {
        const r = await this.send('Network.getResponseBody', { requestId: resp.id }, { timeoutMs: 1500 });
        if (r && r.body != null) {
          bodies[resp.id] = r.base64Encoded
            ? Buffer.from(r.body, 'base64').toString('utf8')
            : r.body;
        }
      } catch (_) { /* cached/opaque/CORS - leave text empty */ }
    }
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'bexplore', version: '1.0.0' },
        entries: this.requests.map(req => {
          const resp = this.responses.find(r => r.id === req.id);
          const text = bodies[req.id] || '';
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
              content: { mimeType: resp.mimeType, text, size: text.length }
            } : { status: 0, headers: [], content: {} }
          };
        })
      }
    };
    
    fs.writeFileSync(this.harFile, JSON.stringify(har, null, 2));
    const withBody = Object.keys(bodies).length;
    console.error(`[explore] HAR saved: ${this.harFile} (${withBody} bodies)`);
  }

  async close() {
    // F1: detach the CDP session before closing WS so the extension's chrome.debugger
    // registry doesn't leak an attached target. Without this, every explore run leaves
    // a phantom attach subscription that eventually saturates the relay and causes
    // future Target.setAutoAttach calls to time out for ALL subsequent runs.
    try {
      if (this.ws && this.ws.readyState === 1 && this.sessionId) {
        await Promise.race([
          this.send('Target.detachFromTarget', { sessionId: this.sessionId }, { noWait: false })
            .catch(() => {}),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      }
    } catch (_e) {
      // best-effort; never let cleanup itself throw
    }
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
  --depth 0       Passive only (reload, discover, screenshots, HAR). Omit for full live-DOM flay.
  --output DIR    Output directory (default: /tmp/explore)
  --har FILE      Save HAR file
  --session-id ID CDP session (e.g. session-6 from GET /targets)
  --help          Show this help

Depth 0 (passive): reload, discover DOM, screenshots, HAR - zero clicks.
Any other / omitted: recursively click every new live-DOM control until the frontier is empty.

The tool will:
  1. Discover all tabs, buttons, links, forms, tables
  2. Click through tabs to reveal content (depth > 0 only)
  3. Click safe buttons to trigger XHR (depth > 0 only)
  4. Scroll to trigger lazy loading (depth > 0 only)
  5. Toggle checkboxes/filters (depth > 0 only)
  6. Capture all network requests
  7. Save screenshots at each step
  8. Generate a comprehensive report

Examples:
  node bexplore.js --depth 0 --output /tmp/passive --har /tmp/passive.har --session-id session-3
  node bexplore.js --output /tmp/sage-explore --har /tmp/sage.har
  node bexplore.js --depth 5 --output ~/explore-results
`);
    process.exit(0);
  }
  
  let depth = Infinity;
  let outputDir = '/tmp/explore';
  let harFile = null;
  let sessionId = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--depth') {
        const n = parseInt(args[++i], 10);
        depth = n === 0 ? 0 : Infinity;
      }
    else if (args[i] === '--output') outputDir = args[++i];
    else if (args[i] === '--har') harFile = args[++i];
    else if (args[i] === '--session-id') sessionId = args[++i];
  }
  
  const explorer = new SiteExplorer({ depth, outputDir, harFile, sessionId });
  
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
    // Salvage: even on catastrophic failure, save whatever HAR + partial report we have
    try {
      if (harFile && explorer.requests && explorer.requests.length > 0) {
        await explorer.saveHAR();
        console.error(`[explore] HAR salvaged despite error (${explorer.requests.length} requests captured)`);
      }
      if (explorer.outputDir && fs.existsSync(explorer.outputDir)) {
        const partialReport = {
          error: err.message,
          url: explorer.siteMap?.url || 'unknown',
          requestsCaptured: explorer.requests?.length || 0,
          responsesCaptured: explorer.responses?.length || 0,
          partial: true
        };
        fs.writeFileSync(path.join(explorer.outputDir, 'report.json'), JSON.stringify(partialReport, null, 2));
        console.error(`[explore] Partial report saved: ${explorer.outputDir}/report.json`);
      }
    } catch (salvageErr) {
      console.error(`[explore] Salvage failed: ${salvageErr.message}`);
    }
    process.exit(1);
  } finally {
    await explorer.close();
  }
}

module.exports = { SiteExplorer };

if (require.main === module) {
  main();
}
