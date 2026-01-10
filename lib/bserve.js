#!/usr/bin/env node
/**
 * browser-relay-server.js
 * Minimal CDP relay server - connects to Chrome extension for browser automation
 * Based on playwriter architecture but stripped down for direct scripting
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.RELAY_PORT || 19988;
const HOST = '127.0.0.1';

// State
let extensionWs = null;
const playwrightClients = new Map();
const connectedTargets = new Map();
const pendingRequests = new Map();
let messageId = 0;

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      extension: extensionWs !== null,
      targets: connectedTargets.size,
      clients: playwrightClients.size
    }));
  } else if (req.url === '/targets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.from(connectedTargets.values())));
  } else if (req.url === '/attach' && req.method === 'POST') {
    // Trigger extension to attach active tab
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
    // HTTP POST endpoint for CDP commands
    let body = '';
    req.on('data', chunk => body += chunk);
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
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket server
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
  if (extensionWs) {
    console.log('[relay] Replacing existing extension connection');
    extensionWs.close(4001, 'Replaced');
    connectedTargets.clear();
  }
  
  extensionWs = ws;
  console.log('[relay] Extension connected');
  
  // Ping to keep alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: 'ping' }));
    }
  }, 5000);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleExtensionMessage(msg);
    } catch (e) {
      console.error('[relay] Error parsing extension message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log('[relay] Extension disconnected');
    clearInterval(pingInterval);
    extensionWs = null;
    connectedTargets.clear();
    
    // Notify all clients
    for (const client of playwrightClients.values()) {
      client.ws.close(1000, 'Extension disconnected');
    }
    playwrightClients.clear();
  });
}

function handleExtensionMessage(msg) {
  console.log('[relay] Extension message:', JSON.stringify(msg).slice(0, 200));
  
  // Response to our request
  if (msg.id !== undefined) {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }
  
  // Pong
  if (msg.method === 'pong') return;
  
  // Log from extension
  if (msg.method === 'log') {
    console.log(`[ext:${msg.params.level}]`, ...msg.params.args);
    return;
  }
  
  // CDP event from extension
  if (msg.method === 'forwardCDPEvent') {
    const { method, params, sessionId } = msg.params;
    
    // Track targets
    if (method === 'Target.attachedToTarget') {
      connectedTargets.set(params.sessionId, {
        sessionId: params.sessionId,
        targetId: params.targetInfo.targetId,
        targetInfo: params.targetInfo
      });
      console.log(`[relay] Target attached: ${params.targetInfo.url}`);
    } else if (method === 'Target.detachedFromTarget') {
      connectedTargets.delete(params.sessionId);
      console.log(`[relay] Target detached: ${params.sessionId}`);
    } else if (method === 'Target.targetInfoChanged') {
      const target = Array.from(connectedTargets.values())
        .find(t => t.targetId === params.targetInfo.targetId);
      if (target) {
        target.targetInfo = params.targetInfo;
      }
    }
    
    // Forward to all CDP clients
    const cdpEvent = { method, params, sessionId };
    for (const client of playwrightClients.values()) {
      client.ws.send(JSON.stringify(cdpEvent));
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
      
      if (!extensionWs) {
        ws.send(JSON.stringify({ id, error: { message: 'Extension not connected' } }));
        return;
      }
      
      try {
        const result = await routeCDPCommand({ method, params, sessionId });
        ws.send(JSON.stringify({ id, sessionId, result }));
        
        // Send attachedToTarget events after setAutoAttach
        if (method === 'Target.setAutoAttach' && !sessionId) {
          for (const target of connectedTargets.values()) {
            ws.send(JSON.stringify({
              method: 'Target.attachedToTarget',
              params: {
                sessionId: target.sessionId,
                targetInfo: { ...target.targetInfo, attached: true },
                waitingForDebugger: false
              }
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
    playwrightClients.delete(clientId);
    console.log(`[relay] CDP client disconnected: ${clientId}`);
  });
}

async function sendToExtension({ method, params, timeout = 30000 }) {
  if (!extensionWs) throw new Error('Extension not connected');
  
  const id = ++messageId;
  extensionWs.send(JSON.stringify({ id, method, params }));
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, timeout);
    
    pendingRequests.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
  });
}

async function routeCDPCommand({ method, params, sessionId }) {
  // Auto-pick first session if none provided
  if (!sessionId && connectedTargets.size > 0) {
    sessionId = Array.from(connectedTargets.values())[0].sessionId;
  }
  
  // Handle some commands locally
  switch (method) {
    case 'Browser.getVersion':
      return {
        protocolVersion: '1.3',
        product: 'Chrome/Extension-Bridge',
        revision: '1.0.0',
        userAgent: 'CDP-Bridge/1.0.0',
        jsVersion: 'V8'
      };
    
    case 'Target.setAutoAttach':
    case 'Target.setDiscoverTargets':
      return {};
    
    case 'Target.getTargets':
      return {
        targetInfos: Array.from(connectedTargets.values())
          .map(t => ({ ...t.targetInfo, attached: true }))
      };
    
    case 'Target.attachToTarget':
      const targetId = params?.targetId;
      for (const target of connectedTargets.values()) {
        if (target.targetId === targetId) {
          return { sessionId: target.sessionId };
        }
      }
      throw new Error(`Target ${targetId} not found`);
    
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
      const first = Array.from(connectedTargets.values())[0];
      return { targetInfo: first?.targetInfo };
  }
  
  // Forward to extension
  return await sendToExtension({
    method: 'forwardCDPCommand',
    params: { sessionId, method, params }
  });
}

// Export for use as module
module.exports = { server, wss, routeCDPCommand };

// Start server if run directly
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
    wss.close();
    server.close();
    process.exit(0);
  });
}
