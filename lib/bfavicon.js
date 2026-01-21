#!/usr/bin/env node
/**
 * bfavicon.js - Bulletproof favicon extractor via CDP
 * 
 * Usage:
 *   ./bfavicon.js <url> [output.webp]
 */

const WebSocket = require('ws');
const fs = require('fs');
const { execSync } = require('child_process');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:19988/cdp';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const log = {
  ok: (msg) => console.error(`${GREEN}✓${NC} ${msg}`),
  fail: (msg) => console.error(`${RED}✗${NC} ${msg}`),
  info: (msg) => console.error(`${CYAN}→${NC} ${msg}`),
  warn: (msg) => console.error(`${YELLOW}⚠${NC} ${msg}`),
};

class FaviconExtractor {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(RELAY_URL);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
          }
        }
      });
    });
  }

  async send(method, params = {}) {
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('Timeout'));
        }
      }, 30000);
    });
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 3000));
  }

  async extractFavicon() {
    // Bulletproof extraction - try everything, return first success
    const script = `
      (async () => {
        const origin = window.location.origin;
        const results = [];
        
        // Build list of ALL possible favicon URLs
        const urls = new Set();
        
        // 1. From link tags
        document.querySelectorAll('link[rel*="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]')
          .forEach(l => l.href && urls.add(l.href));
        
        // 2. From meta tags
        document.querySelectorAll('meta[property="og:image"], meta[name="msapplication-TileImage"]')
          .forEach(m => m.content && urls.add(m.content));
        
        // 3. Default locations - try ALL common paths
        const defaults = [
          '/favicon.ico', '/favicon.png', '/favicon.svg', '/favicon.webp',
          '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png',
          '/apple-touch-icon-180x180.png', '/apple-touch-icon-152x152.png',
          '/icon.png', '/icon.ico', '/logo.png', '/logo.ico',
          '/images/favicon.ico', '/images/favicon.png',
          '/assets/favicon.ico', '/assets/favicon.png',
          '/static/favicon.ico', '/static/favicon.png',
        ];
        defaults.forEach(p => urls.add(origin + p));
        
        // 4. Check manifest
        const manifest = document.querySelector('link[rel="manifest"]');
        if (manifest?.href) {
          try {
            const m = await fetch(manifest.href).then(r => r.json());
            (m.icons || []).forEach(i => urls.add(new URL(i.src, manifest.href).href));
          } catch {}
        }
        
        // 5. Look for any img with icon/logo/favicon in src
        document.querySelectorAll('img[src*="icon"], img[src*="logo"], img[src*="favicon"]')
          .forEach(img => img.src && urls.add(img.src));
        
        // Try each URL - fetch directly, no HEAD check
        for (const url of urls) {
          try {
            const resp = await fetch(url, { mode: 'cors', credentials: 'include' });
            if (!resp.ok) continue;
            
            const blob = await resp.blob();
            if (blob.size < 50) continue; // Skip tiny/empty
            
            // Convert to base64
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            
            return { url, base64, size: blob.size, type: blob.type };
          } catch (e) {
            // Silent fail, try next
          }
        }
        
        return null;
      })()
    `;

    const result = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true
    });

    return result?.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage: glider favicon <url> [output.webp]`);
    process.exit(0);
  }

  let url = args[0];
  let outputPath = args[1];

  if (!url.startsWith('http')) url = 'https://' + url;

  log.info(`Extracting favicon from: ${url}`);

  const extractor = new FaviconExtractor();

  try {
    await extractor.connect();
    log.ok('Connected to relay');

    await extractor.navigate(url);
    log.ok('Page loaded');

    const favicon = await extractor.extractFavicon();
    
    if (!favicon) {
      log.fail('No favicon found');
      process.exit(1);
    }

    log.ok(`Found: ${favicon.url} (${favicon.size} bytes, ${favicon.type})`);

    // Determine output path
    if (!outputPath) {
      const hostname = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      outputPath = `/tmp/${hostname}-favicon.png`;
    }

    // Save the file
    const buffer = Buffer.from(favicon.base64, 'base64');
    const tempFile = `/tmp/favicon-temp-${Date.now()}`;
    
    // Detect format and save appropriately
    const isIco = favicon.type.includes('icon') || favicon.url.endsWith('.ico');
    const tempPath = isIco ? `${tempFile}.ico` : `${tempFile}.png`;
    fs.writeFileSync(tempPath, buffer);

    // Convert to webp if requested
    if (outputPath.endsWith('.webp')) {
      try {
        // If ico, convert to png first
        let pngPath = tempPath;
        if (isIco) {
          pngPath = `${tempFile}.png`;
          execSync(`magick "${tempPath}" -resize 32x32 "${pngPath}" 2>/dev/null || convert "${tempPath}" -resize 32x32 "${pngPath}" 2>/dev/null`);
        }
        execSync(`cwebp "${pngPath}" -o "${outputPath}" -q 90 2>/dev/null`);
        log.ok(`Saved as WebP: ${outputPath}`);
        // Cleanup
        try { fs.unlinkSync(tempPath); } catch {}
        if (pngPath !== tempPath) try { fs.unlinkSync(pngPath); } catch {}
      } catch (e) {
        // Fallback - just save as-is
        const fallbackPath = outputPath.replace('.webp', isIco ? '.ico' : '.png');
        fs.copyFileSync(tempPath, fallbackPath);
        log.warn(`Conversion failed, saved as: ${fallbackPath}`);
        outputPath = fallbackPath;
      }
    } else {
      fs.copyFileSync(tempPath, outputPath);
      log.ok(`Saved: ${outputPath}`);
    }

    // Copy to dist too
    const distPath = outputPath.replace('/public/', '/dist/web/');
    if (distPath !== outputPath && fs.existsSync(outputPath)) {
      try {
        const distDir = require('path').dirname(distPath);
        if (fs.existsSync(distDir)) {
          fs.copyFileSync(outputPath, distPath);
          log.ok(`Copied to dist: ${distPath}`);
        }
      } catch {}
    }

    console.log(outputPath);

  } catch (e) {
    log.fail(e.message);
    process.exit(1);
  } finally {
    extractor.close();
  }
}

main();
