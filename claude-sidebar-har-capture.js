#!/usr/bin/env node
/**
 * Capture HAR while clicking Claude chat sidebar artifact/download controls.
 * Uses glider CDP relay with explicit session-id (avoids bexplore DOM discovery crash).
 *
 * Usage:
 *   node claude-sidebar-har-capture.js [--session-id session-25] [--output dir]
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';
const CHAT_URL_MATCH = process.env.GLIDER_CHAT_URL_MATCH || null;

class ClaudeSidebarHAR {
  constructor(options = {}) {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
    this.sessionId = options.sessionId || null;
    this.wantedSessionId = options.sessionId || null;
    this.sessionResolved = null;
    this.outputDir = options.outputDir || '/tmp/claude-har';
    this.requests = [];
    this.responses = new Map();
    this.loadingFinished = new Map();
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

    if (msg.method === 'Network.requestWillBeSent') {
      this.requests.push({
        id: msg.params.requestId,
        url: msg.params.request.url,
        method: msg.params.request.method,
        headers: msg.params.request.headers,
        postData: msg.params.request.postData,
        type: msg.params.type,
        timestamp: msg.params.timestamp,
        initiator: msg.params.initiator,
      });
    }

    if (msg.method === 'Network.responseReceived') {
      this.responses.set(msg.params.requestId, {
        url: msg.params.response.url,
        status: msg.params.response.status,
        headers: msg.params.response.headers,
        mimeType: msg.params.response.mimeType,
        timestamp: msg.params.timestamp,
      });
    }

    if (msg.method === 'Network.loadingFinished') {
      this.loadingFinished.set(msg.params.requestId, msg.params.encodedDataLength);
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
        reject(new Error(`Timeout: ${method}`));
      }, 45000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  async init() {
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    await new Promise((resolve, reject) => {
      this.sessionResolved = resolve;
      setTimeout(() => {
        if (!this.sessionId) reject(new Error('Timeout waiting for tab attachment'));
        else resolve();
      }, 10000);
    });

    if (!this.sessionId) throw new Error('No browser tab connected');

    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Page.enable'),
      this.send('Network.enable'),
    ]);

    console.error(`[har] attached session ${this.sessionId}`);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text || JSON.stringify(result.exceptionDetails);
      throw new Error(text);
    }
    return result.result.value;
  }

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async discoverSidebar() {
    return this.evaluate(`
      (() => {
        const out = {
          url: location.href,
          title: document.title,
          sections: [],
          clickTargets: [],
          downloadButtons: [],
        };

        const isVisible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));

        // Right panel / sidebar region (heuristic: right 35% of viewport)
        const vw = window.innerWidth;
        const inRightPanel = (el) => {
          const r = el.getBoundingClientRect();
          return r.left > vw * 0.55 && r.width > 20 && r.height > 10;
        };

        // Section headings
        document.querySelectorAll('h2,h3,h4,[class*="heading"],[class*="Heading"]').forEach((el) => {
          const text = (el.textContent || '').trim();
          if (!text || text.length > 80) return;
          if (!inRightPanel(el)) return;
          out.sections.push(text);
        });

        // Download-ish controls
        const dlPatterns = /download|export|save|copy link/i;
        document.querySelectorAll('button,a,[role="button"]').forEach((el, idx) => {
          if (!isVisible(el) || !inRightPanel(el)) return;
          const label = [
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.textContent,
          ].filter(Boolean).join(' ').trim().slice(0, 120);
          if (!label) return;
          if (dlPatterns.test(label) || label === 'Download' || label.includes('More')) {
            el.setAttribute('data-har-dl', String(out.downloadButtons.length));
            out.downloadButtons.push({ idx: out.downloadButtons.length, label });
          }
        });

        // Sidebar cards (artifact / project / content file rows)
        const cardPatterns = [
          /\\.zshrc/i,
          /b64\\.sh/i,
          /clawd-probe/i,
          /\\.json$/i,
          /\\.zip$/i,
          /\\.txt$/i,
          /\\.sh$/i,
          /PASTED/i,
          /lines\\n/i,
        ];

        document.querySelectorAll('button,a,div[role="button"],[tabindex="0"]').forEach((el) => {
          if (!isVisible(el) || !inRightPanel(el)) return;
          const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
          if (!text || text.length < 3) return;
          const hit = cardPatterns.some((re) => re.test(text));
          if (!hit) return;
          const key = text.slice(0, 80);
          if (out.clickTargets.some((t) => t.key === key)) return;
          const id = out.clickTargets.length;
          el.setAttribute('data-har-card', String(id));
          out.clickTargets.push({ id, key, text: text.slice(0, 120) });
        });

        return out;
      })()
    `);
  }

  async clickSelector(selector) {
    return this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'not found' };
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.click();
        return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
      })()
    `);
  }

  async clickCard(id) {
    return this.clickSelector(`[data-har-card="${id}"]`);
  }

  async clickDownload(idx) {
    return this.clickSelector(`[data-har-dl="${idx}"]`);
  }

  markBaseline() {
    this.baselineCount = this.requests.length;
  }

  newRequests() {
    return this.requests.slice(this.baselineCount || 0);
  }

  saveHAR(filename) {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'claude-sidebar-har-capture', version: '1.0.0' },
        entries: this.requests.map((req) => {
          const resp = this.responses.get(req.id) || {};
          return {
            startedDateTime: new Date(req.timestamp * 1000).toISOString(),
            request: {
              method: req.method,
              url: req.url,
              headers: Object.entries(req.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
              postData: req.postData ? { text: req.postData } : undefined,
            },
            response: {
              status: resp.status || 0,
              headers: Object.entries(resp.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
              content: {
                mimeType: resp.mimeType || '',
                size: this.loadingFinished.get(req.id) || 0,
              },
            },
            _meta: { type: req.type, initiator: req.initiator },
          };
        }),
      },
    };

    fs.writeFileSync(filename, JSON.stringify(har, null, 2));
    console.error(`[har] saved ${filename} (${this.requests.length} requests)`);
  }

  analyze() {
    const api = [];
    const fileEndpoints = new Map();
    const interesting = [];

    for (const req of this.requests) {
      const url = req.url;
      if (!url.includes('claude.ai') && !url.includes('anthropic.com')) continue;

      if (url.includes('/api/') || url.includes('/artifacts/') || url.includes('/files/')) {
        api.push({
          method: req.method,
          url,
          type: req.type,
          status: (this.responses.get(req.id) || {}).status,
          mime: (this.responses.get(req.id) || {}).mimeType,
          size: this.loadingFinished.get(req.id) || 0,
        });

        const m = url.match(/\/api\/[^/]+\/files\/([^/]+)(?:\/(preview|download|content|thumbnail))?/);
        if (m) {
          const key = `${m[1]}:${m[2] || 'root'}`;
          if (!fileEndpoints.has(key)) {
            fileEndpoints.set(key, {
              fileUuid: m[1],
              suffix: m[2] || 'root',
              method: req.method,
              url,
              status: (this.responses.get(req.id) || {}).status,
              mime: (this.responses.get(req.id) || {}).mimeType,
              size: this.loadingFinished.get(req.id) || 0,
            });
          }
        }

        if (
          /download|artifact|files|projects\/.*\/(docs|files|sync)/.test(url) ||
          (this.responses.get(req.id) || {}).mimeType?.includes('zip') ||
          (this.responses.get(req.id) || {}).mimeType?.includes('octet')
        ) {
          interesting.push({
            method: req.method,
            url,
            status: (this.responses.get(req.id) || {}).status,
            mime: (this.responses.get(req.id) || {}).mimeType,
            size: this.loadingFinished.get(req.id) || 0,
          });
        }
      }
    }

    return { api, fileEndpoints: Object.fromEntries(fileEndpoints), interesting };
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let sessionId = null;
  let outputDir = path.join(os.tmpdir(), `claude-sidebar-har-${Date.now()}`);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id') sessionId = args[++i];
    else if (args[i] === '--output') outputDir = args[++i];
  }

  if (!sessionId) {
    const targets = await fetch('http://127.0.0.1:19988/targets').then((r) => r.json());
    const chat = CHAT_URL_MATCH
      ? targets.find((t) => t.targetInfo?.url?.includes(CHAT_URL_MATCH))
      : targets.find((t) => t.targetInfo?.url?.includes('claude.ai/chat/'));
    sessionId = chat?.sessionId;
  }

  if (!sessionId) throw new Error('No session-id and no matching chat tab found');

  fs.mkdirSync(outputDir, { recursive: true });

  const cap = new ClaudeSidebarHAR({ sessionId, outputDir });
  const clickLog = [];

  try {
    await cap.connect();
    await cap.init();
    await cap.sleep(1500);

    const sidebar = await cap.discoverSidebar();
    fs.writeFileSync(path.join(outputDir, 'sidebar-discovered.json'), JSON.stringify(sidebar, null, 2));
    console.error(`[har] page: ${sidebar.url}`);
    console.error(`[har] cards: ${sidebar.clickTargets.length}, download buttons: ${sidebar.downloadButtons.length}`);

    cap.markBaseline();

    // Click each sidebar card and capture network burst
    for (const card of sidebar.clickTargets) {
      console.error(`[har] click card ${card.id}: ${card.key.slice(0, 60)}`);
      const before = cap.requests.length;
      const result = await cap.clickCard(card.id);
      await cap.sleep(2500);

      // If a preview panel opened, try its download controls
      let panelDl = [];
      try {
        panelDl = await cap.evaluate(`
          (() => {
            const hits = [];
            document.querySelectorAll('button,a,[role="button"]').forEach((el) => {
              const label = [el.getAttribute('aria-label'), el.textContent].filter(Boolean).join(' ').trim();
              if (/download|export|save file/i.test(label)) {
                const id = hits.length;
                el.setAttribute('data-har-panel-dl', String(id));
                hits.push(label.slice(0, 80));
              }
            });
            return hits;
          })()
        `);
      } catch (_) {}

      for (let i = 0; i < panelDl.length; i++) {
        console.error(`[har]   panel download: ${panelDl[i]}`);
        await cap.clickSelector(`[data-har-panel-dl="${i}"]`);
        await cap.sleep(2000);
      }

      const burst = cap.requests.slice(before).filter((r) => r.url.includes('claude.ai/api'));
      clickLog.push({ card, result, panelDl, burst: burst.map((r) => ({ method: r.method, url: r.url })) });
    }

    // Explicit download buttons in sidebar
    for (const btn of sidebar.downloadButtons) {
      console.error(`[har] click download btn: ${btn.label}`);
      const before = cap.requests.length;
      const result = await cap.clickDownload(btn.idx);
      await cap.sleep(2000);
      const burst = cap.requests.slice(before).filter((r) => r.url.includes('claude.ai'));
      clickLog.push({ download: btn, result, burst: burst.map((r) => ({ method: r.method, url: r.url })) });
    }

    const harFile = path.join(outputDir, 'sidebar-clicks.har');
    cap.saveHAR(harFile);

    const analysis = cap.analyze();
    fs.writeFileSync(path.join(outputDir, 'endpoints.json'), JSON.stringify(analysis, null, 2));
    fs.writeFileSync(path.join(outputDir, 'click-log.json'), JSON.stringify(clickLog, null, 2));

    console.log(JSON.stringify({
      outputDir,
      har: harFile,
      endpoints: path.join(outputDir, 'endpoints.json'),
      requestCount: cap.requests.length,
      fileEndpoints: Object.keys(analysis.fileEndpoints).length,
      interesting: analysis.interesting.length,
    }, null, 2));
  } finally {
    cap.close();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
