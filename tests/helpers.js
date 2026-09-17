'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'glider.js');

function jsonFromStdout(stdout) {
  return JSON.parse(stdout.trim());
}

function runCli(args, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GLIDER_NO_UPDATE: '1',
        CI: '1',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function makeTempGliderHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glidercli-test-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  return home;
}

function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function createMockRelay(options = {}) {
  const requests = [];
  const status = options.status || {
    extension: true,
    extensionWorkerAlive: true,
    extensionGeneration: 1,
    targets: 1,
    clients: 0,
  };
  const targets = options.targets || [{
    sessionId: 'session-1',
    targetId: 'target-1',
    targetInfo: {
      targetId: 'target-1',
      type: 'page',
      title: 'Fixture',
      url: 'http://fixture.test/page',
    },
  }];
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      requests.push({ method: req.method, path: req.url, body });
      if (options.handler) {
        const handled = await options.handler({ req, res, body, requests, status, targets });
        if (handled) return;
      }
      if (req.url === '/status' && req.method === 'GET') return sendJson(res, 200, status);
      if (req.url === '/targets' && req.method === 'GET') return sendJson(res, 200, targets);
      if (req.url === '/cdp' && req.method === 'POST') {
        if (body?.method === 'Runtime.evaluate') {
          const expression = body.params?.expression || '';
          const value = expression === '1+1'
            ? 2
            : expression === 'location.href'
              ? targets[0]?.targetInfo?.url
              : options.evaluateValue ?? 'mock-value';
          return sendJson(res, 200, { result: { type: typeof value, value } });
        }
        return sendJson(res, 200, {});
      }
      if (req.url === '/extension' && req.method === 'POST') {
        return sendJson(res, 200, {
          status: 200,
          ok: true,
          data: { method: body?.method, params: body?.params },
        });
      }
      if (req.url === '/attach' && req.method === 'POST') return sendJson(res, 200, { attached: targets.length });
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: address.port,
    requests,
    status,
    targets,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForHttp(url, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
        retry(new Error(`HTTP ${res.statusCode}`));
      });
      req.on('error', retry);
      req.setTimeout(500, () => req.destroy(new Error('timeout')));
    };
    const retry = (error) => {
      if (Date.now() - started >= timeoutMs) return reject(error);
      setTimeout(attempt, 50);
    };
    attempt();
  });
}

module.exports = {
  CLI_PATH,
  REPO_ROOT,
  createMockRelay,
  getFreePort,
  jsonFromStdout,
  makeTempGliderHome,
  removeTree,
  runCli,
  waitForHttp,
};
