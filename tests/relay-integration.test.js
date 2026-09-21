'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const test = require('node:test');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { REPO_ROOT, getFreePort, waitForHttp } = require('./helpers.js');

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function waitForJson(url, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await requestJson(url);
    if (predicate(response.body)) return response;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for JSON state: ${url}`);
}

test('relay bridges HTTP and WebSocket traffic on GLIDER_PORT', async (t) => {
  const port = await getFreePort();
  const relay = spawn(process.execPath, [path.join(REPO_ROOT, 'lib', 'bserve.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_PORT: String(port),
      RELAY_PORT: '1',
      GLIDER_RELAY_RECONNECT_GRACE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayStderr = '';
  relay.stderr.on('data', (chunk) => { relayStderr += chunk; });
  t.after(async () => {
    if (relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await new Promise((resolve) => relay.once('close', resolve));
  });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  let response = await requestJson(`http://127.0.0.1:${port}/status`);
  assert.equal(response.body.pid, relay.pid);
  assert.equal(response.body.port, port);
  assert.equal(response.body.extension, false);
  assert.equal(response.body.extensionWorkerAlive, false);
  assert.equal(response.body.extensionGeneration, 0);
  assert.equal(response.body.targets, 0);
  assert.equal(response.body.clients, 0);
  assert.equal(response.body.pending, 0);

  const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => extension.close());
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  extension.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'ping') {
      extension.send(JSON.stringify({ method: 'pong' }));
      return;
    }
    if (message.id === undefined) return;
    if (message.method === 'forwardCDPCommand') {
      const method = message.params?.method;
      const result = method === 'Runtime.evaluate'
        ? { result: { type: 'number', value: 2 } }
        : {};
      extension.send(JSON.stringify({ id: message.id, result }));
      return;
    }
    if (message.method === 'corsFetch') {
      extension.send(JSON.stringify({ id: message.id, result: { status: 200, ok: true, data: 'relay-ok' } }));
      return;
    }
    extension.send(JSON.stringify({ id: message.id, result: {} }));
  });
  extension.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: {
          targetId: 'target-1',
          type: 'page',
          title: 'Relay fixture',
          url: 'http://fixture.test/',
        },
      },
      sessionId: 'session-1',
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 50));
  response = await requestJson(`http://127.0.0.1:${port}/targets`);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].sessionId, 'session-1');

  response = await requestJson(`http://127.0.0.1:${port}/cdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    sessionId: 'session-1',
    method: 'Runtime.evaluate',
    params: { expression: '1+1', returnByValue: true },
  });
  assert.equal(response.status, 200, relayStderr);
  assert.equal(response.body.result.value, 2);

  response = await requestJson(`http://127.0.0.1:${port}/extension`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    method: 'corsFetch',
    params: { url: 'http://fixture.test/api' },
  });
  assert.equal(response.body.data, 'relay-ok');

  const cdpClient = new WebSocket(`ws://127.0.0.1:${port}/cdp/regression`);
  t.after(() => cdpClient.close());
  await new Promise((resolve, reject) => {
    cdpClient.once('open', resolve);
    cdpClient.once('error', reject);
  });
  const messages = [];
  cdpClient.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  cdpClient.send(JSON.stringify({
    id: 1,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(messages.some((message) => message.id === 1 && message.result));
  assert.ok(messages.some((message) => message.method === 'Target.attachedToTarget'));

  extension.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.targetDestroyed',
      params: { targetId: 'target-1' },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  response = await requestJson(`http://127.0.0.1:${port}/targets`);
  assert.equal(response.body.length, 0);

  const extensionClosed = new Promise((resolve) => extension.once('close', resolve));
  extension.close();
  await extensionClosed;
  response = await waitForJson(
    `http://127.0.0.1:${port}/status`,
    (status) => status.extension === false && status.targets === 0,
  );
  assert.equal(response.body.extension, false);
  assert.equal(response.body.targets, 0);
});

test('superseded extension close cannot clear the replacement connection', async (t) => {
  const port = await getFreePort();
  const relay = spawn(process.execPath, [path.join(REPO_ROOT, 'lib', 'bserve.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, GLIDER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayStderr = '';
  relay.stderr.on('data', (chunk) => { relayStderr += chunk; });
  t.after(async () => {
    if (relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await new Promise((resolve) => relay.once('close', resolve));
  });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  const first = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  await new Promise((resolve, reject) => {
    first.once('open', resolve);
    first.once('error', reject);
  });
  const firstClosed = new Promise((resolve) => first.once('close', resolve));
  const firstClient = new WebSocket(`ws://127.0.0.1:${port}/cdp/same-client`);
  await new Promise((resolve, reject) => {
    firstClient.once('open', resolve);
    firstClient.once('error', reject);
  });
  const firstClientClosed = new Promise((resolve) => firstClient.once('close', resolve));

  const replacement = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => replacement.close());
  await new Promise((resolve, reject) => {
    replacement.once('open', resolve);
    replacement.once('error', reject);
  });
  const replacementClient = new WebSocket(`ws://127.0.0.1:${port}/cdp/same-client`);
  t.after(() => replacementClient.close());
  await new Promise((resolve, reject) => {
    replacementClient.once('open', resolve);
    replacementClient.once('error', reject);
  });
  await firstClosed;
  await firstClientClosed;
  await new Promise((resolve) => setTimeout(resolve, 50));

  let response = await requestJson(`http://127.0.0.1:${port}/status`);
  assert.equal(response.body.extension, true, relayStderr);
  assert.equal(response.body.extensionGeneration, 2);
  assert.equal(response.body.clients, 1);
  assert.equal(replacementClient.readyState, WebSocket.OPEN);

  replacement.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'replacement-session',
        targetInfo: {
          targetId: 'replacement-target',
          type: 'page',
          title: 'Replacement fixture',
          url: 'http://fixture.test/replacement',
        },
      },
      sessionId: 'replacement-session',
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  response = await requestJson(`http://127.0.0.1:${port}/status`);
  assert.equal(response.body.extension, true);
  assert.equal(response.body.targets, 1);
});

test('relay retains targets during reconnect grace and serves CDP after reconnect', async (t) => {
  const port = await getFreePort();
  const relay = spawn(process.execPath, [path.join(REPO_ROOT, 'lib', 'bserve.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_PORT: String(port),
      GLIDER_RELAY_RECONNECT_GRACE_MS: '2000',
      GLIDER_RELAY_COMMAND_RECONNECT_WAIT_MS: '1500',
      GLIDER_CDP_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await new Promise((resolve) => relay.once('close', resolve));
  });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  function wireExtension(socket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'ping') {
        socket.send(JSON.stringify({ method: 'pong' }));
        return;
      }
      if (message.id === undefined) return;
      if (message.method === 'forwardCDPCommand') {
        socket.send(JSON.stringify({
          id: message.id,
          result: { result: { type: 'number', value: 2 } },
        }));
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  }

  let extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  wireExtension(extension);
  extension.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-grace',
        targetInfo: {
          targetId: 'target-grace',
          type: 'page',
          title: 'Grace',
          url: 'http://fixture.test/grace',
        },
      },
      sessionId: 'session-grace',
    },
  }));
  await waitForJson(`http://127.0.0.1:${port}/status`, (status) => status.targets === 1);

  const closed = new Promise((resolve) => extension.once('close', resolve));
  extension.close();
  await closed;

  let response = await requestJson(`http://127.0.0.1:${port}/status`);
  assert.equal(response.body.extension, false);
  assert.equal(response.body.reconnecting, true);
  assert.equal(response.body.targets, 1);

  extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => extension.close());
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  wireExtension(extension);

  response = await requestJson(`http://127.0.0.1:${port}/cdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    method: 'Runtime.evaluate',
    params: { expression: '1+1', returnByValue: true },
    sessionId: 'session-grace',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.result.value, 2);
});

test('relay removes closed targets from the map and times out pending CDP', async (t) => {
  const port = await getFreePort();
  const relay = spawn(process.execPath, [path.join(REPO_ROOT, 'lib', 'bserve.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_PORT: String(port),
      GLIDER_CDP_TIMEOUT_MS: '200',
      GLIDER_RELAY_RECONNECT_GRACE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await new Promise((resolve) => relay.once('close', resolve));
  });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => extension.close());
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  extension.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'ping') {
      extension.send(JSON.stringify({ method: 'pong' }));
      return;
    }
    if (message.id === undefined) return;
    if (message.method === 'forwardCDPCommand' && message.params?.method === 'Target.closeTarget') {
      extension.send(JSON.stringify({ id: message.id, result: { success: true } }));
      return;
    }
    // Intentionally never answer Runtime.evaluate → timeout path
  });
  extension.send(JSON.stringify({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-gc',
        targetInfo: {
          targetId: 'target-gc',
          type: 'page',
          title: 'GC',
          url: 'http://fixture.test/gc',
        },
      },
      sessionId: 'session-gc',
    },
  }));
  await waitForJson(`http://127.0.0.1:${port}/status`, (status) => status.targets === 1);

  let response = await requestJson(`http://127.0.0.1:${port}/cdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { method: 'Target.closeTarget', params: { targetId: 'target-gc' } });
  assert.equal(response.status, 200);
  response = await requestJson(`http://127.0.0.1:${port}/status`);
  assert.equal(response.body.targets, 0);

  response = await requestJson(`http://127.0.0.1:${port}/cdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } });
  assert.equal(response.status, 500);
  assert.match(String(response.body.error), /Timeout after 200ms/);
});

test('relay retries Target.createTarget on Chromium No SW then succeeds', async (t) => {
  const port = await getFreePort();
  const relay = spawn(process.execPath, [path.join(REPO_ROOT, 'lib', 'bserve.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_PORT: String(port),
      RELAY_PORT: '1',
      GLIDER_RELAY_RECONNECT_GRACE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await new Promise((resolve) => relay.once('close', resolve));
  });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  let nosw = 0;
  const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => extension.close());
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  extension.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'ping') {
      extension.send(JSON.stringify({ method: 'pong' }));
      return;
    }
    if (message.method !== 'forwardCDPCommand') return;
    if (message.params?.method !== 'Target.createTarget') return;
    nosw += 1;
    if (nosw < 3) {
      extension.send(JSON.stringify({ id: message.id, error: 'No SW' }));
      return;
    }
    extension.send(JSON.stringify({ id: message.id, result: { targetId: 'target-nosw' } }));
  });

  const response = await requestJson(`http://127.0.0.1:${port}/cdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { method: 'Target.createTarget', params: { url: 'https://example.com' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.targetId, 'target-nosw');
  assert.equal(nosw, 3);
});
