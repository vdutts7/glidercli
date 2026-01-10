#!/usr/bin/env node
/**
 * bcdp.js - Full CDP capabilities for browser automation
 * Direct CDP scripting without external dependencies
 * 
 * Capabilities:
 *   - evaluate: Run JS in page context
 *   - navigate: Go to URL
 *   - screenshot: Capture page
 *   - click: Click element by selector
 *   - type: Type text into element
 *   - scroll: Scroll page
 *   - wait: Wait for selector/navigation
 *   - dom: Query DOM elements
 *   - network: Intercept requests
 *   - cookies: Get/set cookies
 *   - storage: Get/set localStorage/sessionStorage
 *   - scripts: List/read/edit page scripts (live patching)
 *   - styles: Get computed styles
 *   - debug: Set breakpoints, inspect variables
 */

const WebSocket = require('ws');
const fs = require('fs');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';

class BrowserCDP {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
    this.scripts = new Map();
    this.eventHandlers = new Map();
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
    
    // Events
    if (msg.method === 'Target.attachedToTarget') {
      if (!this.sessionId) {
        this.sessionId = msg.params.sessionId;
        this.targetId = msg.params.targetInfo.targetId;
      }
    }
    
    if (msg.method === 'Debugger.scriptParsed') {
      const { scriptId, url } = msg.params;
      if (url && !url.startsWith('chrome') && !url.startsWith('devtools')) {
        this.scripts.set(url, scriptId);
      }
    }
    
    // Custom event handlers
    const handlers = this.eventHandlers.get(msg.method);
    if (handlers) handlers.forEach(h => h(msg.params));
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
  }

  off(event, handler) {
    this.eventHandlers.get(event)?.delete(handler);
  }

  async send(method, params = {}, sessionId = null) {
    const id = ++this.messageId;
    const msg = { id, method, params };
    if (sessionId || this.sessionId) msg.sessionId = sessionId || this.sessionId;
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
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, null);
    await new Promise(r => setTimeout(r, 500));
    if (!this.sessionId) throw new Error('No browser tab connected');
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('DOM.enable');
    await this.send('Network.enable');
  }

  // ═══════════════════════════════════════════════════════════════════
  // CORE: Evaluate JS
  // ═══════════════════════════════════════════════════════════════════
  async evaluate(expression, { returnByValue = true, awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue, awaitPromise });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  // ═══════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════════════════════════════
  async navigate(url, { waitUntil = 'load', timeout = 30000 } = {}) {
    const loadPromise = new Promise(resolve => {
      const handler = () => { this.off('Page.loadEventFired', handler); resolve(); };
      this.on('Page.loadEventFired', handler);
      setTimeout(() => { this.off('Page.loadEventFired', handler); resolve(); }, timeout);
    });
    await this.send('Page.navigate', { url });
    if (waitUntil === 'load') await loadPromise;
  }

  async reload() {
    await this.send('Page.reload');
  }

  async goBack() {
    const history = await this.send('Page.getNavigationHistory');
    if (history.currentIndex > 0) {
      await this.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id });
    }
  }

  async goForward() {
    const history = await this.send('Page.getNavigationHistory');
    if (history.currentIndex < history.entries.length - 1) {
      await this.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex + 1].id });
    }
  }

  async getUrl() {
    return this.evaluate('window.location.href');
  }

  async getTitle() {
    return this.evaluate('document.title');
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCREENSHOT
  // ═══════════════════════════════════════════════════════════════════
  async screenshot({ path, format = 'png', quality = 80, fullPage = false } = {}) {
    const params = { format };
    if (format === 'jpeg') params.quality = quality;
    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      params.clip = { x: 0, y: 0, width: metrics.contentSize.width, height: metrics.contentSize.height, scale: 1 };
    }
    const result = await this.send('Page.captureScreenshot', params);
    const buffer = Buffer.from(result.data, 'base64');
    if (path) fs.writeFileSync(path, buffer);
    return { data: result.data, buffer };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOM INTERACTION
  // ═══════════════════════════════════════════════════════════════════
  async click(selector, { button = 'left', clickCount = 1 } = {}) {
    const box = await this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      const rect = el.getBoundingClientRect();
      ({ x: rect.x + rect.width/2, y: rect.y + rect.height/2 })
    `);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button, clickCount });
  }

  async type(selector, text, { delay = 0 } = {}) {
    await this.click(selector);
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
      if (delay) await new Promise(r => setTimeout(r, delay));
    }
  }

  async fill(selector, value) {
    await this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `);
  }

  async select(selector, value) {
    await this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `);
  }

  async hover(selector) {
    const box = await this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector}');
      const rect = el.getBoundingClientRect();
      ({ x: rect.x + rect.width/2, y: rect.y + rect.height/2 })
    `);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  }

  async scroll({ x = 0, y = 0, selector } = {}) {
    if (selector) {
      await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior: 'smooth' })`);
    } else {
      await this.evaluate(`window.scrollBy(${x}, ${y})`);
    }
  }

  async scrollToBottom() {
    await this.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  }

  async scrollToTop() {
    await this.evaluate('window.scrollTo(0, 0)');
  }

  // ═══════════════════════════════════════════════════════════════════
  // WAIT
  // ═══════════════════════════════════════════════════════════════════
  async waitForSelector(selector, { timeout = 30000, visible = false } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const exists = await this.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        ${visible ? 'el && el.offsetParent !== null' : '!!el'}
      `);
      if (exists) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async waitForNavigation({ timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Navigation timeout')), timeout);
      const handler = () => { clearTimeout(timer); this.off('Page.loadEventFired', handler); resolve(); };
      this.on('Page.loadEventFired', handler);
    });
  }

  async waitForNetwork({ timeout = 5000 } = {}) {
    // Wait for network to be idle (no requests for timeout ms)
    let lastActivity = Date.now();
    const handler = () => { lastActivity = Date.now(); };
    this.on('Network.requestWillBeSent', handler);
    this.on('Network.responseReceived', handler);
    
    while (Date.now() - lastActivity < timeout) {
      await new Promise(r => setTimeout(r, 100));
    }
    
    this.off('Network.requestWillBeSent', handler);
    this.off('Network.responseReceived', handler);
  }

  // ═══════════════════════════════════════════════════════════════════
  // COOKIES & STORAGE
  // ═══════════════════════════════════════════════════════════════════
  async getCookies(urls) {
    const result = await this.send('Network.getCookies', urls ? { urls } : {});
    return result.cookies;
  }

  async setCookie(cookie) {
    await this.send('Network.setCookie', cookie);
  }

  async deleteCookies(name, url) {
    await this.send('Network.deleteCookies', { name, url });
  }

  async clearCookies() {
    await this.send('Network.clearBrowserCookies');
  }

  async getLocalStorage() {
    return this.evaluate('Object.fromEntries(Object.entries(localStorage))');
  }

  async setLocalStorage(key, value) {
    await this.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }

  async getSessionStorage() {
    return this.evaluate('Object.fromEntries(Object.entries(sessionStorage))');
  }

  async setSessionStorage(key, value) {
    await this.evaluate(`sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // NETWORK INTERCEPTION
  // ═══════════════════════════════════════════════════════════════════
  async setRequestInterception(patterns) {
    await this.send('Fetch.enable', { patterns: patterns.map(p => ({ urlPattern: p })) });
  }

  async continueRequest(requestId, { url, method, headers, postData } = {}) {
    await this.send('Fetch.continueRequest', { requestId, url, method, headers, postData });
  }

  async fulfillRequest(requestId, { responseCode = 200, responseHeaders = [], body }) {
    const encodedBody = body ? Buffer.from(body).toString('base64') : undefined;
    await this.send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders, body: encodedBody });
  }

  async failRequest(requestId, reason = 'Failed') {
    await this.send('Fetch.failRequest', { requestId, errorReason: reason });
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCRIPTS (Live Editing - like playwriter Editor)
  // ═══════════════════════════════════════════════════════════════════
  async enableDebugger() {
    await this.send('Debugger.enable');
    // Wait for scripts to be parsed
    await new Promise(r => setTimeout(r, 200));
  }

  async listScripts(search) {
    await this.enableDebugger();
    const scripts = Array.from(this.scripts.entries()).map(([url, id]) => ({ url, scriptId: id }));
    return search ? scripts.filter(s => s.url.toLowerCase().includes(search.toLowerCase())) : scripts;
  }

  async getScriptSource(urlOrId) {
    await this.enableDebugger();
    const scriptId = this.scripts.get(urlOrId) || urlOrId;
    const result = await this.send('Debugger.getScriptSource', { scriptId });
    return result.scriptSource;
  }

  async setScriptSource(urlOrId, newSource) {
    await this.enableDebugger();
    const scriptId = this.scripts.get(urlOrId) || urlOrId;
    const result = await this.send('Debugger.setScriptSource', { scriptId, scriptSource: newSource });
    return { success: true, stackChanged: result.stackChanged };
  }

  async editScript(urlOrId, oldString, newString) {
    const source = await this.getScriptSource(urlOrId);
    const count = (source.match(new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (count === 0) throw new Error('oldString not found');
    if (count > 1) throw new Error(`oldString found ${count} times - make it unique`);
    const newSource = source.replace(oldString, newString);
    return this.setScriptSource(urlOrId, newSource);
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEBUGGING (like playwriter Debugger)
  // ═══════════════════════════════════════════════════════════════════
  async setBreakpoint(url, line, condition) {
    await this.enableDebugger();
    const result = await this.send('Debugger.setBreakpointByUrl', {
      lineNumber: line - 1,
      urlRegex: url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      condition
    });
    return result.breakpointId;
  }

  async removeBreakpoint(breakpointId) {
    await this.send('Debugger.removeBreakpoint', { breakpointId });
  }

  async resume() {
    await this.send('Debugger.resume');
  }

  async stepOver() {
    await this.send('Debugger.stepOver');
  }

  async stepInto() {
    await this.send('Debugger.stepInto');
  }

  async stepOut() {
    await this.send('Debugger.stepOut');
  }

  async pause() {
    await this.send('Debugger.pause');
  }

  // ═══════════════════════════════════════════════════════════════════
  // FETCH (using browser's authenticated session)
  // ═══════════════════════════════════════════════════════════════════
  async fetch(url, options = {}) {
    const script = `
      (async () => {
        const response = await fetch(${JSON.stringify(url)}, {
          credentials: 'include',
          ...${JSON.stringify(options)}
        });
        const contentType = response.headers.get('content-type') || '';
        let body;
        if (contentType.includes('application/json')) {
          body = await response.json();
        } else {
          body = await response.text();
        }
        return { status: response.status, contentType, body, headers: Object.fromEntries(response.headers) };
      })()
    `;
    return this.evaluate(script);
  }

  // ═══════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════
  async getHTML(selector) {
    if (selector) {
      return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.outerHTML`);
    }
    return this.evaluate('document.documentElement.outerHTML');
  }

  async getText(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  }

  async getAttribute(selector, attr) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attr)})`);
  }

  async querySelectorAll(selector) {
    return this.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => ({
      tag: el.tagName.toLowerCase(),
      id: el.id,
      class: el.className,
      text: el.textContent?.slice(0, 100),
      href: el.href,
      src: el.src
    }))`);
  }

  async pdf({ path, format = 'A4', printBackground = true } = {}) {
    const result = await this.send('Page.printToPDF', { format, printBackground });
    const buffer = Buffer.from(result.data, 'base64');
    if (path) fs.writeFileSync(path, buffer);
    return { data: result.data, buffer };
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// Export for programmatic use
module.exports = { BrowserCDP };
