#!/usr/bin/env node
/**
 * Glider CDP relay - localhost bridge between CLI and Chromium extension.
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { relayPort } = require('./relay-config.js');

const PORT = relayPort();
const HOST = '127.0.0.1';

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}="${raw}" (expected integer ${min}..${max})`);
  }
  return value;
}

const CDP_TIMEOUT_MS = envInt('GLIDER_CDP_TIMEOUT_MS', 30000, 100, 600000);
const RECONNECT_GRACE_MS = envInt('GLIDER_RELAY_RECONNECT_GRACE_MS', 10000, 0, 120000);
const COMMAND_RECONNECT_WAIT_MS = envInt('GLIDER_RELAY_COMMAND_RECONNECT_WAIT_MS', 3000, 0, 60000);
const MAX_PENDING = envInt('GLIDER_RELAY_MAX_PENDING', 256, 1, 10000);
const WORKER_STALE_MS = envInt('GLIDER_RELAY_WORKER_STALE_MS', 15000, 1000, 300000);
const PING_INTERVAL_MS = envInt('GLIDER_RELAY_PING_MS', 5000, 500, 60000);

let extensionWs = null;
let extensionGeneration = 0;
let lastPongAt = 0;
let disconnectGraceTimer = null;
let reconnectingUntil = 0;
const playwrightClients = new Map();
const connectedTargets = new Map();
const pendingRequests = new Map();
let messageId = 0;

function extensionSocketOpen() {
  return extensionWs != null && extensionWs.readyState === WebSocket.OPEN;
}

function extensionWorkerAlive() {
  if (!extensionSocketOpen()) return false;
  if (!lastPongAt) return false;
  return (Date.now() - lastPongAt) <= WORKER_STALE_MS;
}

function statusPayload() {
  return {
    pid: process.pid,
    port: PORT,
    extension: extensionSocketOpen(),
    extensionWorkerAlive: extensionWorkerAlive(),
    extensionGeneration,
    reconnecting: Date.now() < reconnectingUntil,
    targets: connectedTargets.size,
    clients: playwrightClients.size,
    pending: pendingRequests.size,
  };
}

function clearDisconnectGrace() {
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }
  reconnectingUntil = 0;
}

function rejectAllPending(reason) {
  for (const pending of pendingRequests.values()) {
    pending.reject(new Error(reason));
  }
  pendingRequests.clear();
}

function closeAllClients(reason) {
  for (const client of playwrightClients.values()) {
    try { client.ws.close(1000, reason); } catch { /* ignore */ }
  }
  playwrightClients.clear();
}

function hardResetExtensionState(reason) {
  clearDisconnectGrace();
  connectedTargets.clear();
  rejectAllPending(reason);
  closeAllClients(reason);
}

function beginDisconnectGrace() {
  if (RECONNECT_GRACE_MS <= 0) {
    hardResetExtensionState('Extension disconnected');
    return;
  }
  reconnectingUntil = Date.now() + RECONNECT_GRACE_MS;
  if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
  disconnectGraceTimer = setTimeout(() => {
    disconnectGraceTimer = null;
    if (extensionSocketOpen()) return;
    console.log('[relay] Extension reconnect grace expired');
    hardResetExtensionState('Extension disconnected');
  }, RECONNECT_GRACE_MS);
}

async function waitForExtensionSocket(timeoutMs) {
  if (extensionSocketOpen()) return;
  if (timeoutMs <= 0) throw new Error('Extension not connected');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (extensionSocketOpen()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Extension not connected');
}

function removeTargetById(targetId) {
  for (const [sessionId, target] of connectedTargets.entries()) {
    if (target.targetId === targetId) {
      connectedTargets.delete(sessionId);
      return true;
    }
  }
  return false;
}

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusPayload()));
  } else if (req.url === '/targets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.from(connectedTargets.values())));
  } else if (req.url === '/attach' && req.method === 'POST') {
    (async () => {
      try {
        const result = await sendToExtension({ method: 'attachActiveTab', params: {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
  } else if (req.url === '/cdp' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { method, params, sessionId } = JSON.parse(body);
        const result = await routeCDPCommand({ method, params, sessionId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url === '/extension' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { method, params } = JSON.parse(body);
        const result = await sendToExtension({ method, params });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const path = req.url;
  if (path === '/extension') {
    handleExtensionConnection(ws);
  } else if (path.startsWith('/cdp')) {
    const clientId = path.split('/')[2] || 'default';
    handleCDPConnection(ws, clientId);
  } else {
    ws.close(1000, 'Unknown path');
  }
});

function handleExtensionConnection(ws) {
  if (extensionWs && extensionWs !== ws) {
    console.log('[relay] Replacing existing extension connection');
    const previous = extensionWs;
    extensionWs = null;
    try { previous.close(4001, 'Replaced'); } catch { /* ignore */ }
    // Hard cut on replace (not a transient flap): drop clients + pending.
    // Targets stay until the new extension re-announces or grace paths clear them.
    rejectAllPending('Extension replaced');
    closeAllClients('Extension replaced');
  }

  clearDisconnectGrace();
  extensionWs = ws;
  extensionGeneration += 1;
  lastPongAt = Date.now();
  console.log('[relay] Extension connected');

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* ignore */ }
    }
  }, PING_INTERVAL_MS);
  try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* ignore */ }

  ws.on('message', (data) => {
    if (extensionWs !== ws) return;
    try {
      const msg = JSON.parse(data.toString());
      handleExtensionMessage(msg);
    } catch (e) {
      console.error('[relay] Error parsing extension message:', e);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (extensionWs !== ws) return;
    console.log('[relay] Extension disconnected');
    extensionWs = null;
    lastPongAt = 0;
    beginDisconnectGrace();
  });
}

function handleExtensionMessage(msg) {
  if (msg.id !== undefined) {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error))));
      else pending.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'pong') {
    lastPongAt = Date.now();
    return;
  }

  if (msg.method === 'log') {
    console.log(`[ext:${msg.params.level}]`, ...msg.params.args);
    return;
  }

  if (msg.method === 'forwardCDPEvent') {
    const { method, params, sessionId } = msg.params;

    if (method === 'Target.attachedToTarget') {
      connectedTargets.set(params.sessionId, {
        sessionId: params.sessionId,
        targetId: params.targetInfo.targetId,
        targetInfo: params.targetInfo,
      });
      console.log(`[relay] Target attached: ${params.targetInfo.url}`);
    } else if (method === 'Target.detachedFromTarget') {
      connectedTargets.delete(params.sessionId);
      console.log(`[relay] Target detached: ${params.sessionId}`);
    } else if (method === 'Target.targetDestroyed') {
      if (removeTargetById(params.targetId)) {
        console.log(`[relay] Target destroyed: ${params.targetId}`);
      }
    } else if (method === 'Target.targetInfoChanged') {
      const target = Array.from(connectedTargets.values())
        .find((entry) => entry.targetId === params.targetInfo.targetId);
      if (target) target.targetInfo = params.targetInfo;
    }

    const cdpEvent = { method, params, sessionId };
    for (const client of playwrightClients.values()) {
      try { client.ws.send(JSON.stringify(cdpEvent)); } catch { /* ignore */ }
    }
  }
}

function handleCDPConnection(ws, clientId) {
  if (playwrightClients.has(clientId)) {
    ws.close(1000, 'Client ID already connected');
    return;
  }

  playwrightClients.set(clientId, { id: clientId, ws });
  console.log(`[relay] CDP client connected: ${clientId}`);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { id, method, params, sessionId } = msg;

      try {
        await waitForExtensionSocket(COMMAND_RECONNECT_WAIT_MS);
        const result = await routeCDPCommand({ method, params, sessionId });
        ws.send(JSON.stringify({ id, sessionId, result }));

        if (method === 'Target.setAutoAttach' && !sessionId) {
          for (const target of connectedTargets.values()) {
            ws.send(JSON.stringify({
              method: 'Target.attachedToTarget',
              params: {
                sessionId: target.sessionId,
                targetInfo: { ...target.targetInfo, attached: true },
                waitingForDebugger: false,
              },
            }));
          }
        }
      } catch (e) {
        ws.send(JSON.stringify({ id, sessionId, error: { message: e.message } }));
      }
    } catch (e) {
      console.error('[relay] Error handling CDP message:', e);
    }
  });

  ws.on('close', () => {
    if (playwrightClients.get(clientId)?.ws === ws) {
      playwrightClients.delete(clientId);
    }
    console.log(`[relay] CDP client disconnected: ${clientId}`);
  });
}

async function sendToExtension({ method, params, timeout = CDP_TIMEOUT_MS }) {
  await waitForExtensionSocket(COMMAND_RECONNECT_WAIT_MS);
  if (!extensionSocketOpen()) throw new Error('Extension not connected');

  const maxAttempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (pendingRequests.size >= MAX_PENDING) {
        throw new Error(`Relay pending queue full (${MAX_PENDING}); drop or wait`);
      }
      const id = ++messageId;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Timeout after ${timeout}ms: ${method}`));
        }, timeout);

        pendingRequests.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        extensionWs.send(JSON.stringify({ id, method, params }), (error) => {
          if (!error) return;
          clearTimeout(timer);
          pendingRequests.delete(id);
          reject(error);
        });
      });
      return result;
    } catch (error) {
      lastError = error;
      const msg = error && error.message ? error.message : String(error);
      // Chromium "No SW" race: wait for MV3 alarm/WS revive, then retry (no UI).
      if (!/No SW/i.test(msg) || attempt >= maxAttempts) break;
      await new Promise((r) => setTimeout(r, 200 * attempt));
      await waitForExtensionSocket(COMMAND_RECONNECT_WAIT_MS);
    }
  }
  throw lastError || new Error(`Extension RPC failed: ${method}`);
}

async function routeCDPCommand({ method, params, sessionId }) {
  const browserLevelCommands = [
    'Target.createTarget',
    'Target.closeTarget',
    'Target.activateTarget',
    'Target.getTargets',
    'Target.setAutoAttach',
    'Target.setDiscoverTargets',
    'Target.attachToTarget',
    'Target.getTargetInfo',
    'Browser.getVersion',
  ];

  if (!sessionId && connectedTargets.size > 0 && !browserLevelCommands.includes(method)) {
    sessionId = Array.from(connectedTargets.values())[0].sessionId;
  }

  switch (method) {
    case 'Browser.getVersion':
      return {
        protocolVersion: '1.3',
        product: 'Chrome/Extension-Bridge',
        revision: '1.0.0',
        userAgent: 'CDP-Bridge/1.0.0',
        jsVersion: 'V8',
      };

    case 'Target.setAutoAttach':
      if (sessionId) break;
      return {};
    case 'Target.setDiscoverTargets':
      return {};

    case 'Target.getTargets':
      return {
        targetInfos: Array.from(connectedTargets.values())
          .map((t) => ({ ...t.targetInfo, attached: true })),
      };

    case 'Target.attachToTarget':
      break;

    case 'Target.getTargetInfo':
      if (params?.targetId) {
        for (const target of connectedTargets.values()) {
          if (target.targetId === params.targetId) {
            return { targetInfo: target.targetInfo };
          }
        }
      }
      if (sessionId) {
        const target = connectedTargets.get(sessionId);
        if (target) return { targetInfo: target.targetInfo };
      }
      return { targetInfo: Array.from(connectedTargets.values())[0]?.targetInfo };

    case 'Target.createTarget':
    case 'Target.closeTarget':
    case 'Target.activateTarget':
      break;
  }

  const result = await sendToExtension({
    method: 'forwardCDPCommand',
    params: { sessionId, method, params },
  });

  if (method === 'Target.closeTarget' && params?.targetId) {
    const success = result?.success !== false && result?.error == null;
    if (success) removeTargetById(params.targetId);
  }

  return result;
}

module.exports = {
  server,
  wss,
  routeCDPCommand,
  statusPayload,
  sendToExtension,
};

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[relay] CDP relay server running on ws://${HOST}:${PORT}`);
    console.log('[relay] Endpoints:');
    console.log(`  - Extension: ws://${HOST}:${PORT}/extension`);
    console.log(`  - CDP:       ws://${HOST}:${PORT}/cdp`);
    console.log(`  - Status:    http://${HOST}:${PORT}/status`);
    console.log(`  - Targets:   http://${HOST}:${PORT}/targets`);
  });

  process.on('SIGINT', () => {
    console.log('\n[relay] Shutting down...');
    clearDisconnectGrace();
    wss.close();
    server.close();
    process.exit(0);
  });
}
