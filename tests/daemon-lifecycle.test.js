'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const test = require('node:test');
const { spawn, spawnSync } = require('child_process');
const {
  REPO_ROOT,
  getFreePort,
  jsonFromStdout,
  makeTempGliderHome,
  removeTree,
  runCli,
  waitForHttp,
} = require('./helpers.js');

const DAEMON_PATH = path.join(REPO_ROOT, 'lib', 'glider-daemon.sh');

function waitForHttpFailure(url, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        retry();
      });
      req.on('error', resolve);
      req.setTimeout(250, () => req.destroy(new Error('timeout')));
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`relay still accepted connections after ${timeoutMs}ms`));
        return;
      }
      setTimeout(attempt, 50);
    };
    attempt();
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForRecord(filePath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (predicate(record)) return record;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for record state: ${filePath}`);
}

test('daemon owns and terminates its relay child', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const pidFile = path.join(home, `daemon-${port}.pid`);
  fs.writeFileSync(pidFile, `${sleeper.pid}\n`);
  const daemon = spawn('/bin/bash', [DAEMON_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_HOME: home,
      GLIDER_NODE_BIN: process.execPath,
      GLIDER_PORT: String(port),
      PATH: '/usr/bin:/bin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((resolve) => daemon.once('close', resolve));
    }
    try { process.kill(sleeper.pid, 'SIGTERM'); } catch {}
    removeTree(home);
  });

  const statusUrl = `http://127.0.0.1:${port}/status`;
  await waitForHttp(statusUrl);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const record = await waitForRecord(pidFile, (candidate) => candidate.ready === true);
  assert.equal(record.pid, daemon.pid);
  assert.equal(record.port, port);
  assert.equal(record.childPid > 0, true);
  assert.equal(record.ready, true);
  assert.equal(record.started, record.started.trim());
  assert.equal(record.childStarted, record.childStarted.trim());

  const duplicate = spawnSync('/bin/bash', [DAEMON_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_HOME: home,
      GLIDER_NODE_BIN: process.execPath,
      GLIDER_PORT: String(port),
      PATH: '/usr/bin:/bin',
    },
    encoding: 'utf8',
  });
  assert.equal(duplicate.status, 0);
  assert.match(duplicate.stderr, /already running/);

  daemon.kill('SIGTERM');
  const exit = await new Promise((resolve) => {
    daemon.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(path.join(home, `daemon-${port}.claim`)), false);
  await waitForHttpFailure(statusUrl);
});

test('daemon rejects an invalid GLIDER_NODE_BIN before starting', () => {
  const home = makeTempGliderHome();
  try {
    const result = spawnSync('/bin/bash', [DAEMON_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GLIDER_HOME: home,
        GLIDER_NODE_BIN: path.join(home, 'missing-node'),
        PATH: '/usr/bin:/bin',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /set GLIDER_NODE_BIN/);
    assert.equal(fs.existsSync(path.join(home, 'daemon-19988.pid')), false);
  } finally {
    removeTree(home);
  }
});

test('direct daemon launch refuses a standalone relay on the same port', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  t.after(async () => {
    await runCli(['--json', 'stop'], { env }).catch(() => {});
    removeTree(home);
  });

  let result = await runCli(['--json', 'start'], { env });
  assert.equal(result.code, 0, result.stderr);

  const daemon = spawnSync('/bin/bash', [DAEMON_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
      GLIDER_NODE_BIN: process.execPath,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(daemon.status, 1);
  assert.match(daemon.stderr, /already owned by another process/);
  assert.equal(fs.existsSync(path.join(home, `daemon-${port}.pid`)), false);
  assert.equal(fs.existsSync(path.join(home, `daemon-${port}.claim`)), false);

  result = await runCli(['--json', 'status'], { env });
  assert.equal(result.code, 1);
  assert.equal(jsonFromStdout(result.stdout).observation.server, true);
});

test('slow direct daemon handoff keeps a live normalized management lock', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const wrapper = path.join(home, 'slow-node.sh');
  const lockFile = path.join(home, `daemon-${port}.management.lock`);
  const pidFile = path.join(home, `daemon-${port}.pid`);
  fs.writeFileSync(wrapper, [
    '#!/bin/bash',
    'case "$1" in',
    '  *"/bserve.js") sleep 4 ;;',
    'esac',
    'exec "$REAL_NODE" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o700);

  const daemon = spawn('/bin/bash', [DAEMON_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GLIDER_HOME: home,
      GLIDER_NODE_BIN: wrapper,
      GLIDER_PORT: String(port),
      REAL_NODE: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((resolve) => daemon.once('close', resolve));
    }
    removeTree(home);
  });

  await waitForFile(lockFile);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(lock.started, lock.started.trim());
  assert.doesNotThrow(() => process.kill(lock.pid, 0));

  const result = await runCli(['--json', 'start'], {
    env: { GLIDER_HOME: home, GLIDER_PORT: String(port) },
    timeoutMs: 10000,
  });
  assert.equal(result.code, 0, `${result.stderr}\n${stderr}`);
  assert.equal(jsonFromStdout(result.stdout).observation.managedBy, 'daemon');
  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(record.ready, true);
  assert.equal(record.pid, daemon.pid);
  assert.equal(fs.existsSync(lockFile), false);
});
