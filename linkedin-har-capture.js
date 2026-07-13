#!/usr/bin/env node
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { gliderHome } = require('./lib/paths');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';

function loadSearchUrls() {
  const file = process.env.LINKEDIN_URLS_FILE || path.join(gliderHome(), 'linkedin-urls.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const example = path.join(__dirname, 'examples', 'linkedin-urls.example.json');
  if (fs.existsSync(example)) {
    return JSON.parse(fs.readFileSync(example, 'utf8'));
  }
  throw new Error(`No URL list: set LINKEDIN_URLS_FILE or add ${path.join(gliderHome(), 'linkedin-urls.json')}`);
}

class HARCapture {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.requests = [];
    this.responses = new Map();
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
    
    if (msg.method === 'Target.attachedToTarget' && !this.sessionId) {
      this.sessionId = msg.params.sessionId;
    }
    
    if (msg.method === 'Network.requestWillBeSent') {
      this.requests.push({
        id: msg.params.requestId,
        url: msg.params.request.url,
        method: msg.params.request.method,
        headers: msg.params.request.headers,
        postData: msg.params.request.postData,
        timestamp: msg.params.timestamp,
      });
    }
    
    if (msg.method === 'Network.responseReceived') {
      this.responses.set(msg.params.requestId, {
        status: msg.params.response.status,
        headers: msg.params.response.headers,
        mimeType: msg.params.response.mimeType,
      });
    }
  }

  async send(method, params = {}) {
    const id = ++this.messageId;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timeout: ' + method));
      }, 30000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
    });
  }

  async init() {
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise(r => setTimeout(r, 2000));
    if (!this.sessionId) throw new Error('No tab attached');
    
    await this.send('Network.enable');
    await this.send('Page.enable');
    console.error('[capture] Network capture enabled');
  }

  async navigate(url) {
    console.error('[capture] ' + url);
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 4000));
    
    await this.send('Runtime.evaluate', { 
      expression: 'window.scrollTo(0, document.body.scrollHeight / 2)',
      returnByValue: true 
    });
    await new Promise(r => setTimeout(r, 1500));
    await this.send('Runtime.evaluate', { 
      expression: 'window.scrollTo(0, document.body.scrollHeight)',
      returnByValue: true 
    });
    await new Promise(r => setTimeout(r, 1500));
  }

  saveHAR(filename) {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'linkedin-har-capture', version: '1.0.0' },
        entries: this.requests.map(req => {
          const resp = this.responses.get(req.id) || {};
          return {
            startedDateTime: new Date(req.timestamp * 1000).toISOString(),
            request: {
              method: req.method,
              url: req.url,
              headers: Object.entries(req.headers || {}).map(([name, value]) => ({ name, value })),
              postData: req.postData ? { text: req.postData } : undefined
            },
            response: {
              status: resp.status || 0,
              headers: Object.entries(resp.headers || {}).map(([name, value]) => ({ name, value })),
              content: { mimeType: resp.mimeType || '' }
            }
          };
        })
      }
    };
    
    fs.writeFileSync(filename, JSON.stringify(har, null, 2));
    console.error('[capture] HAR saved: ' + filename + ' (' + this.requests.length + ' requests)');
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function main() {
  const outputDir = process.argv[2] || '/tmp/linkedin-capture';
  fs.mkdirSync(outputDir, { recursive: true });
  
  const capture = new HARCapture();
  
  try {
    await capture.connect();
    await capture.init();
    
    for (const url of loadSearchUrls()) {
      await capture.navigate(url);
    }
    
    const harFile = outputDir + '/linkedin-search-' + Date.now() + '.har';
    capture.saveHAR(harFile);
    
    const voyagerEndpoints = new Map();
    for (const req of capture.requests) {
      if (req.url.includes('voyager/api')) {
        const base = req.url.split('?')[0];
        const queryIdMatch = req.url.match(/queryId=([^&]+)/);
        const queryId = queryIdMatch ? queryIdMatch[1] : null;
        const key = queryId || base;
        if (!voyagerEndpoints.has(key)) {
          voyagerEndpoints.set(key, {
            base,
            queryId,
            method: req.method,
            example: req.url.slice(0, 500)
          });
        }
      }
    }
    
    const endpointsFile = outputDir + '/voyager-endpoints.json';
    fs.writeFileSync(endpointsFile, JSON.stringify(
      Object.fromEntries(voyagerEndpoints),
      null, 2
    ));
    console.error('[capture] Endpoints: ' + endpointsFile + ' (' + voyagerEndpoints.size + ' unique)');
    
    console.log(JSON.stringify({
      har: harFile,
      endpoints: endpointsFile,
      requestCount: capture.requests.length,
      voyagerCount: voyagerEndpoints.size
    }));
    
  } finally {
    capture.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
