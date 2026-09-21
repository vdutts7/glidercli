'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { spawn } = require('child_process');
const {
  createMockRelay,
  getFreePort,
  jsonFromStdout,
  makeTempGliderHome,
  removeTree,
  runCli,
  waitForHttp,
} = require('./helpers.js');

async function waitForRecord(filePath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (predicate(record)) return record;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for record state: ${filePath}`);
}

async function enterDaemonRestartGap(pidFile, supervisorPid, initialChildPid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let childPid = initialChildPid;
  while (Date.now() < deadline) {
    try { process.kill(childPid, 'SIGTERM'); } catch {}
    const cycleDeadline = Math.min(deadline, Date.now() + 3000);
    while (Date.now() < cycleDeadline) {
      const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      assert.equal(record.pid, supervisorPid);
      if (record.childPid === null) return record;
      if (record.childPid !== childPid) {
        childPid = record.childPid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out entering daemon restart gap: ${pidFile}`);
}

test('status and diagnostics emit strict JSON and truthful exit codes', async (t) => {
  const healthy = await createMockRelay();
  t.after(() => healthy.close());
  const env = { GLIDER_PORT: String(healthy.port) };

  let result = await runCli(['--json', 'status'], { env });
  assert.equal(result.code, 0, result.stderr);
  let body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.observation.targetCount, 1);
  assert.doesNotMatch(result.stdout, /G L I D E R/);

  result = await runCli(['--json', 'test'], { env });
  assert.equal(result.code, 0, result.stderr);
  body = jsonFromStdout(result.stdout);
  assert.deepEqual(body.observation, {
    healthy: true,
    server: true,
    extension: true,
    extensionWorkerAlive: true,
    tab: true,
    cdp: true,
  });

  const unhealthy = await createMockRelay({ status: { extension: false, targets: 0, clients: 0 }, targets: [] });
  t.after(() => unhealthy.close());
  result = await runCli(['--json', 'status'], { env: { GLIDER_PORT: String(unhealthy.port) } });
  assert.equal(result.code, 1);
  body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'extension disconnected');
});

test('status does not auto-start a relay when the configured port is closed', async () => {
  const result = await runCli(['--json', 'status'], { env: { GLIDER_PORT: '65534' }, timeoutMs: 3000 });
  assert.equal(result.code, 1);
  assert.equal(jsonFromStdout(result.stdout).error, 'relay unavailable');
});

test('invalid relay ports preserve JSON errors and do not break independent commands', async () => {
  let result = await runCli(['--json', 'status'], { env: { GLIDER_PORT: 'invalid' } });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /Invalid relay port/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);

  result = await runCli(['version'], { env: { GLIDER_PORT: 'invalid' } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${require('../package.json').version}\\s*$`));

  result = await runCli(['help'], { env: { GLIDER_PORT: 'invalid' } });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /runs at login/);
});

test('browser command reads the selected browser from GLIDER_HOME', async () => {
  const home = makeTempGliderHome();
  try {
    fs.writeFileSync(path.join(home, 'config', 'browser.json'), JSON.stringify({
      name: 'Configured Browser',
      path: '/Applications/Configured Browser.app',
      processName: 'Configured Browser',
    }));
    const result = await runCli(['--json', 'browser'], { env: { GLIDER_HOME: home } });
    assert.equal(result.code, 0, result.stderr);
    const body = jsonFromStdout(result.stdout);
    assert.equal(body.observation.name, 'Configured Browser');
    assert.equal(body.observation.source, path.join(home, 'config', 'browser.json'));
  } finally {
    removeTree(home);
  }
});

test('global equals forms and session pinning reach the relay unchanged', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const result = await runCli([
    '--session=session-1',
    '--allowed-domains=fixture.test',
    '--json',
    'eval',
    '1+1',
  ], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 0, result.stderr);
  const cdp = relay.requests.filter((request) => request.path === '/cdp').at(-1);
  assert.equal(cdp.body.sessionId, 'session-1');
  assert.equal(cdp.body.method, 'Runtime.evaluate');
});

test('value flags support equals form and reject every missing-value form', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const env = { GLIDER_PORT: String(relay.port) };

  let result = await runCli(['--json', 'read', '#fixture', '--attr=data-value'], { env });
  assert.equal(result.code, 0, result.stderr);

  for (const args of [
    ['--json', 'read', '#fixture', '--attr'],
    ['--json', 'read', '#fixture', '--attr='],
    ['--json', 'read', '#fixture', '--attr', '--text'],
  ]) {
    result = await runCli(args, { env });
    assert.equal(result.code, 1, `${args.join(' ')}\n${result.stderr}`);
    assert.match(jsonFromStdout(result.stdout).error, /--attr requires a value/);
  }

  result = await runCli(['--json', 'read', '#fixture', '--attr', 'x', '--prop', 'y'], { env });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /Mutually exclusive flags/);
});

test('use-session validates liveness and supports URL space and equals forms', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  const env = { GLIDER_PORT: String(relay.port), GLIDER_HOME: home };

  let result = await runCli(['--json', 'use-session', '--url=fixture.test'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation.sessionId, 'session-1');

  result = await runCli(['--json', 'use-session', '--url', 'fixture.test'], { env });
  assert.equal(result.code, 0, result.stderr);

  result = await runCli(['--json', 'use-session', 'session-stale'], { env });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /not live/);
});

test('plugin socket hydrates local verbs from GLIDER_HOME without package branding', async (t) => {
  const relay = await createMockRelay({ evaluateValue: 42 });
  t.after(() => relay.close());
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  const pluginDir = path.join(home, 'plugins');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'fixture.plugin.json'), JSON.stringify({
    verb: 'fixture-plugin',
    aliases: ['fp'],
    primitive: 'eval',
    recipe: '40 + 2',
    output: { format: 'json' },
  }));
  const env = { GLIDER_PORT: String(relay.port), GLIDER_HOME: home };
  let result = await runCli(['--json', 'fixture-plugin'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation, 42);
  result = await runCli(['--json', 'fp'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation, 42);
});

test('cfetch honors the configured relay port, equals forms, and short aliases', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const env = { GLIDER_PORT: String(relay.port) };

  let result = await runCli([
    '--json',
    'cfetch',
    'http://fixture.test/api',
    '--method=POST',
    '--body={"ok":true}',
  ], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation.status, 200);
  let request = relay.requests.filter((entry) => entry.path === '/extension').at(-1);
  assert.equal(request.body.params.options.method, 'POST');

  result = await runCli([
    '--json',
    'cfetch',
    'http://fixture.test/api',
    '-X',
    'POST',
    '-d',
    '{"short":true}',
  ], { env });
  assert.equal(result.code, 0, result.stderr);
  request = relay.requests.filter((entry) => entry.path === '/extension').at(-1);
  assert.equal(request.body.params.options.body, '{"short":true}');
});

test('cfetch emits strict JSON when the extension request fails', async (t) => {
  const relay = await createMockRelay({
    handler: async ({ req, res }) => {
      if (req.url === '/extension' && req.method === 'POST') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"forced extension failure"}');
        return true;
      }
      return false;
    },
  });
  t.after(() => relay.close());
  const result = await runCli([
    '--json',
    'cfetch',
    'http://fixture.test/api',
  ], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /HTTP 500.*forced extension failure/);
});

test('cold-relay auto-start does not emit a second JSON document', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  t.after(async () => {
    await runCli(['--json', 'stop'], { env }).catch(() => {});
    removeTree(home);
  });

  const result = await runCli([
    '--json',
    'cfetch',
    'http://fixture.test/api',
  ], { env });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /Extension not connected/);
});

test('HTTP relay failures cannot produce success-shaped CLI output', async (t) => {
  const relay = await createMockRelay({
    handler: async ({ req, res }) => {
      if (req.url === '/cdp' && req.method === 'POST') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"forced failure"}');
        return true;
      }
      return false;
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'eval', '1+1'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /HTTP 500.*forced failure/);
});

test('partial event-stream commands fail explicitly with exit code 2', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const env = { GLIDER_PORT: String(relay.port) };
  for (const args of [
    ['--json', 'wait', '--network-idle=250'],
    ['--json', 'wait', '0', '--network-idle=250'],
    ['--json', 'console', 'tail'],
    ['--json', 'mock', 'https://fixture.test/*', '--body', '/tmp/body.txt'],
  ]) {
    const result = await runCli(args, { env });
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(jsonFromStdout(result.stdout).ok, false);
    assert.match(jsonFromStdout(result.stdout).error, /not fully implemented/);
  }
});

test('numeric wait cannot bypass another condition mode', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const result = await runCli([
    '--json',
    'wait',
    '0',
    '--url-changes-from=http://fixture.test/page',
    '--timeout=10',
    '--poll=1',
  ], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /wait timeout/);
});

test('bare reload aliases to reload-ext', async (t) => {
  const healthyStatus = { extension: true, extensionGeneration: 1, targets: 1, clients: 0 };
  const healthy = await createMockRelay({
    status: healthyStatus,
    handler: async ({ req, body }) => {
      if (req.url === '/extension' && body?.method === 'reloadSelf') {
        healthyStatus.extensionGeneration += 1;
      }
      return false;
    },
  });
  t.after(() => healthy.close());
  const result = await runCli(['--json', 'reload'], {
    env: {
      GLIDER_PORT: String(healthy.port),
      GLIDER_RELOAD_TIMEOUT_MS: '100',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation.extension, true);
});

test('reload-ext requires the extension to reconnect before reporting success', async (t) => {
  const stale = await createMockRelay({
    status: { extension: true, extensionGeneration: 1, targets: 1, clients: 0 },
  });
  t.after(() => stale.close());
  let result = await runCli(['--json', 'reload-ext'], {
    env: {
      GLIDER_PORT: String(stale.port),
      GLIDER_RELOAD_TIMEOUT_MS: '100',
    },
  });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /did not reload \(connection never dropped/);

  const healthyStatus = { extension: true, extensionGeneration: 1, targets: 1, clients: 0 };
  const healthy = await createMockRelay({
    status: healthyStatus,
    handler: async ({ req, body }) => {
      if (req.url === '/extension' && body?.method === 'reloadSelf') {
        healthyStatus.extensionGeneration += 1;
      }
      return false;
    },
  });
  t.after(() => healthy.close());
  result = await runCli(['--json', 'reload-ext'], {
    env: {
      GLIDER_PORT: String(healthy.port),
      GLIDER_RELOAD_TIMEOUT_MS: '100',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation.extension, true);
});

test('reload-ext reports reconnect timeout when the socket drops but never returns', async (t) => {
  const status = { extension: true, extensionGeneration: 1, targets: 1, clients: 0 };
  const relay = await createMockRelay({
    status,
    handler: async ({ req, body }) => {
      if (req.url === '/extension' && body?.method === 'reloadSelf') {
        status.extension = false;
      }
      return false;
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'reload-ext'], {
    env: {
      GLIDER_PORT: String(relay.port),
      GLIDER_RELOAD_TIMEOUT_MS: '100',
    },
  });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /did not reconnect within/);
});

test('unverified relay PID records are preserved and cannot terminate unrelated processes', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try { process.kill(sleeper.pid, 'SIGTERM'); } catch {}
    removeTree(home);
  });
  fs.writeFileSync(path.join(home, `relay-${port}.pid`), JSON.stringify({
    schema: 1,
    pid: sleeper.pid,
    port,
    entry: path.join(__dirname, '..', 'lib', 'bserve.js'),
    started: 'not-the-process-start-time',
  }));

  const result = await runCli(['--json', 'stop'], {
    env: { GLIDER_HOME: home, GLIDER_PORT: String(port) },
  });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /Refusing to signal unverified relay PID/);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.equal(fs.existsSync(path.join(home, `relay-${port}.pid`)), true);
});

test('start and stop use a verified owned relay PID record', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const pidFile = path.join(home, `relay-${port}.pid`);
  t.after(() => {
    try {
      const pid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
      process.kill(pid, 'SIGTERM');
    } catch {}
    removeTree(home);
  });
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };

  let result = await runCli(['--json', 'start'], { env });
  assert.equal(result.code, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(record.schema, 1);
  assert.equal(record.port, port);

  result = await runCli(['--json', 'restart'], { env });
  assert.equal(result.code, 0, result.stderr);
  const restart = jsonFromStdout(result.stdout);
  assert.equal(restart.observation.stopped.running, false);
  assert.equal(restart.observation.started.running, true);

  result = await runCli(['--json', 'stop'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(jsonFromStdout(result.stdout).observation.running, false);
  assert.equal(fs.existsSync(pidFile), false);
});

test('relay and daemon ownership survive locale and timezone changes', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const pidFile = path.join(home, `daemon-${port}.pid`);
  const claimDir = path.join(home, `daemon-${port}.claim`);
  const westernEnv = {
    GLIDER_HOME: home,
    GLIDER_PORT: String(port),
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    TZ: 'America/Los_Angeles',
  };
  const utcEnv = {
    GLIDER_HOME: home,
    GLIDER_PORT: String(port),
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
  };
  t.after(async () => {
    await runCli(['--json', 'uninstall'], { env: utcEnv }).catch(() => {});
    try {
      const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      process.kill(record.pid, 'SIGTERM');
    } catch {}
    removeTree(home);
  });

  let result = await runCli(['--json', 'start'], { env: westernEnv });
  assert.equal(result.code, 0, result.stderr);
  result = await runCli(['--json', 'stop'], { env: utcEnv });
  assert.equal(result.code, 0, result.stderr);

  result = await runCli(['--json', 'install'], { env: westernEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(path.join(claimDir, 'owner')), true);

  result = await runCli(['--json', 'uninstall'], { env: utcEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(claimDir), false);
});

test('concurrent cold starts preserve the winning relay ownership record', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  const pidFile = path.join(home, `relay-${port}.pid`);
  t.after(async () => {
    await runCli(['--json', 'stop'], { env }).catch(() => {});
    removeTree(home);
  });

  const starts = await Promise.all(
    Array.from({ length: 6 }, () => runCli(['--json', 'start'], { env })),
  );
  for (const result of starts) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(jsonFromStdout(result.stdout).observation.running, true);
  }

  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const pids = new Set(starts.map((result) => jsonFromStdout(result.stdout).observation.pid));
  assert.deepEqual([...pids], [record.pid]);
  assert.doesNotThrow(() => process.kill(record.pid, 0));
});

test('aged stale lifecycle locks fail closed instead of racing a takeover', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  const lockFile = path.join(home, `relay-${port}.lifecycle.lock`);
  fs.writeFileSync(lockFile, JSON.stringify({
    schema: 1,
    pid: 2147483646,
    entry: path.join(__dirname, '..', 'bin', 'glider.js'),
    started: 'stale',
  }));
  const staleTime = new Date(Date.now() - 10000);
  fs.utimesSync(lockFile, staleTime, staleTime);
  t.after(() => removeTree(home));

  const starts = await Promise.all([
    runCli(['--json', 'start'], { env }),
    runCli(['--json', 'start'], { env }),
  ]);
  for (const result of starts) {
    assert.equal(result.code, 1);
    assert.match(jsonFromStdout(result.stdout).error, /Stale relay lifecycle lock/);
  }
  assert.equal(fs.existsSync(path.join(home, `relay-${port}.pid`)), false);
});

test('daemon install fails when its relay child cannot start', async () => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  try {
    const result = await runCli(['--json', 'install'], {
      env: {
        GLIDER_HOME: home,
        GLIDER_PORT: String(port),
        GLIDER_NODE_BIN: path.join(home, 'missing-node'),
      },
    });
    assert.equal(result.code, 1);
    assert.match(jsonFromStdout(result.stdout).error, /Daemon failed to start/);
    assert.equal(fs.existsSync(path.join(home, `daemon-${port}.pid`)), false);
  } finally {
    removeTree(home);
  }
});

test('daemon install and uninstall are scoped to the configured port', async (t) => {
  const home = makeTempGliderHome();
  const firstPort = await getFreePort();
  const secondPort = await getFreePort();
  const firstEnv = { GLIDER_HOME: home, GLIDER_PORT: String(firstPort) };
  const secondEnv = { GLIDER_HOME: home, GLIDER_PORT: String(secondPort) };
  const firstPidFile = path.join(home, `daemon-${firstPort}.pid`);
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(home, 'daemon.pid'), `${sleeper.pid}\n`);
  t.after(() => {
    try {
      const record = JSON.parse(fs.readFileSync(firstPidFile, 'utf8'));
      process.kill(record.pid, 'SIGTERM');
    } catch {}
    try { process.kill(sleeper.pid, 'SIGTERM'); } catch {}
    removeTree(home);
  });

  let result = await runCli(['--json', 'install'], { env: firstEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.equal(fs.existsSync(path.join(home, 'daemon.pid')), false);
  const installed = jsonFromStdout(result.stdout).observation;
  assert.equal(installed.port, firstPort);
  assert.equal(installed.childPid > 0, true);

  result = await runCli(['--json', 'uninstall'], { env: secondEnv });
  assert.equal(result.code, 0, result.stderr);
  await waitForHttp(`http://127.0.0.1:${firstPort}/status`);

  result = await runCli(['--json', 'uninstall'], { env: firstEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(firstPidFile), false);
});

test('concurrent daemon installs converge on one supervisor and relay child', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  const pidFile = path.join(home, `daemon-${port}.pid`);
  t.after(async () => {
    await runCli(['--json', 'uninstall'], { env }).catch(() => {});
    removeTree(home);
  });

  const installs = await Promise.all([
    runCli(['--json', 'install'], { env }),
    runCli(['--json', 'install'], { env }),
  ]);
  for (const result of installs) {
    assert.equal(result.code, 0, result.stderr);
  }
  const observations = installs.map((result) => jsonFromStdout(result.stdout).observation);
  assert.equal(new Set(observations.map((item) => item.pid)).size, 1);
  assert.equal(new Set(observations.map((item) => item.childPid)).size, 1);
  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(record.pid, observations[0].pid);
  assert.equal(record.childPid, observations[0].childPid);
  assert.equal(fs.existsSync(path.join(home, `daemon-${port}.claim`, 'owner')), true);
});

test('standalone lifecycle refuses daemon-owned relay restart gaps', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  const pidFile = path.join(home, `daemon-${port}.pid`);
  const relayPidFile = path.join(home, `relay-${port}.pid`);
  t.after(async () => {
    await runCli(['--json', 'uninstall'], { env }).catch(() => {});
    try {
      const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      process.kill(record.pid, 'SIGTERM');
    } catch {}
    removeTree(home);
  });

  let result = await runCli(['--json', 'install'], { env });
  assert.equal(result.code, 0, result.stderr);
  const installed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(installed.ready, true);

  await enterDaemonRestartGap(pidFile, installed.pid, installed.childPid);
  result = await runCli(['--json', 'start'], { env });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /managed by daemon/);
  assert.equal(fs.existsSync(relayPidFile), false);
  assert.doesNotThrow(() => process.kill(installed.pid, 0));

  await waitForHttp(`http://127.0.0.1:${port}/status`);
  let restarted = await waitForRecord(
    pidFile,
    (record) => record.pid === installed.pid && record.ready === true && Number.isInteger(record.childPid),
  );
  assert.notEqual(restarted.childPid, installed.childPid);

  await enterDaemonRestartGap(pidFile, installed.pid, restarted.childPid);
  result = await runCli(['--json', 'stop'], { env });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /managed by daemon/);
  assert.equal(fs.existsSync(relayPidFile), false);

  await waitForHttp(`http://127.0.0.1:${port}/status`);
  restarted = await waitForRecord(
    pidFile,
    (record) => record.pid === installed.pid && record.ready === true && Number.isInteger(record.childPid),
  );
  assert.doesNotThrow(() => process.kill(restarted.childPid, 0));
});

test('concurrent daemon install and uninstall preserve a coherent generation', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const env = { GLIDER_HOME: home, GLIDER_PORT: String(port) };
  const pidFile = path.join(home, `daemon-${port}.pid`);
  const claimDir = path.join(home, `daemon-${port}.claim`);
  t.after(async () => {
    await runCli(['--json', 'uninstall'], { env }).catch(() => {});
    try {
      const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      process.kill(record.pid, 'SIGTERM');
    } catch {}
    removeTree(home);
  });

  let result = await runCli(['--json', 'install'], { env });
  assert.equal(result.code, 0, result.stderr);

  const raced = await Promise.all([
    runCli(['--json', 'uninstall'], { env }),
    runCli(['--json', 'install'], { env }),
  ]);
  for (const item of raced) assert.equal(item.code, 0, item.stderr);

  const pidExists = fs.existsSync(pidFile);
  const claimExists = fs.existsSync(claimDir);
  assert.equal(pidExists, claimExists);
  result = await runCli(['--json', 'status'], { env });
  const status = jsonFromStdout(result.stdout).observation;
  assert.equal(status.server, pidExists);
  if (pidExists) {
    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.doesNotThrow(() => process.kill(record.pid, 0));
    assert.doesNotThrow(() => process.kill(record.childPid, 0));
  }
});

test('daemon claim without an ownership record fails closed', async () => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const claimDir = path.join(home, `daemon-${port}.claim`);
  fs.mkdirSync(claimDir);
  fs.writeFileSync(path.join(claimDir, 'owner'), 'stale-claim\n');
  try {
    const result = await runCli(['--json', 'uninstall'], {
      env: { GLIDER_HOME: home, GLIDER_PORT: String(port) },
    });
    assert.equal(result.code, 1);
    assert.match(jsonFromStdout(result.stdout).error, /claim exists without a verified ownership record/);
  } finally {
    removeTree(home);
  }
});

test('daemon install cannot claim a standalone relay owned by another process', async (t) => {
  const home = makeTempGliderHome();
  const port = await getFreePort();
  const standalone = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'bserve.js')], {
    env: { ...process.env, GLIDER_PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (standalone.exitCode === null) {
      standalone.kill('SIGTERM');
      await new Promise((resolve) => standalone.once('close', resolve));
    }
    removeTree(home);
  });
  await waitForHttp(`http://127.0.0.1:${port}/status`);

  const result = await runCli(['--json', 'install'], {
    timeoutMs: 10000,
    env: { GLIDER_HOME: home, GLIDER_PORT: String(port) },
  });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /Daemon failed to start/);
});

test('live legacy daemon records fail safely instead of signaling an unverified PID', async (t) => {
  const ownerHome = makeTempGliderHome();
  const targetHome = makeTempGliderHome();
  const ownerPort = await getFreePort();
  const targetPort = await getFreePort();
  const daemonPath = path.join(__dirname, '..', 'lib', 'glider-daemon.sh');
  const daemon = spawn('/bin/bash', [daemonPath], {
    env: {
      ...process.env,
      GLIDER_HOME: ownerHome,
      GLIDER_NODE_BIN: process.execPath,
      GLIDER_PORT: String(ownerPort),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((resolve) => daemon.once('close', resolve));
    }
    removeTree(ownerHome);
    removeTree(targetHome);
  });
  await waitForHttp(`http://127.0.0.1:${ownerPort}/status`);
  fs.writeFileSync(path.join(targetHome, 'daemon.pid'), `${daemon.pid}\n`);

  const result = await runCli(['--json', 'uninstall'], {
    env: { GLIDER_HOME: targetHome, GLIDER_PORT: String(targetPort) },
  });
  assert.equal(result.code, 1);
  assert.match(jsonFromStdout(result.stdout).error, /lacks safe ownership metadata/);
  assert.doesNotThrow(() => process.kill(daemon.pid, 0));
});

test('status treats socket-only extension as unhealthy until worker pong', async (t) => {
  const relay = await createMockRelay({
    status: {
      extension: true,
      extensionWorkerAlive: false,
      extensionGeneration: 3,
      targets: 1,
      clients: 0,
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'status'], { env: { GLIDER_PORT: String(relay.port) } });
  assert.equal(result.code, 1);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.observation.extension, true);
  assert.equal(body.observation.extensionWorkerAlive, false);
  assert.match(body.error, /worker not alive/);
});

test('doctor reports nextAction when worker is dead', async (t) => {
  const relay = await createMockRelay({
    status: {
      extension: true,
      extensionWorkerAlive: false,
      extensionGeneration: 3,
      targets: 1,
      clients: 0,
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'doctor'], {
    env: { GLIDER_PORT: String(relay.port), GLIDER_EXTENSION_ID: 'njbidokkffhgpofcejgcfcgcinmeoalj' },
  });
  assert.equal(result.code, 1);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.observation.extensionWorkerAlive, false);
  assert.match(body.observation.nextAction, /glider heal/);
});

test('heal skips browser wake by default (GLIDER_BROWSER_UI off)', async (t) => {
  const relay = await createMockRelay({
    status: {
      extension: true,
      extensionWorkerAlive: false,
      extensionGeneration: 3,
      targets: 0,
      clients: 0,
    },
    targets: [],
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'heal'], {
    env: {
      GLIDER_PORT: String(relay.port),
      GLIDER_EXTENSION_ID: 'njbidokkffhgpofcejgcfcgcinmeoalj',
    },
  });
  assert.equal(result.code, 1);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, false);
  const wake = body.observation.actions.find((a) => a.step === 'wake_extension');
  assert.ok(wake);
  assert.equal(wake.attempted, false);
  assert.match(wake.reason, /GLIDER_BROWSER_UI|default off/i);
});

test('heal skips browser wake when GLIDER_HEAL_NO_WAKE=1', async (t) => {
  const relay = await createMockRelay({
    status: {
      extension: true,
      extensionWorkerAlive: false,
      extensionGeneration: 3,
      targets: 0,
      clients: 0,
    },
    targets: [],
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'heal'], {
    env: {
      GLIDER_PORT: String(relay.port),
      GLIDER_HEAL_NO_WAKE: '1',
      GLIDER_EXTENSION_ID: 'njbidokkffhgpofcejgcfcgcinmeoalj',
    },
  });
  assert.equal(result.code, 1);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, false);
  const wake = body.observation.actions.find((a) => a.step === 'wake_extension');
  assert.ok(wake);
  assert.equal(wake.attempted, false);
  assert.match(wake.reason, /GLIDER_HEAL_NO_WAKE/);
});

test('heal --clear-pin removes stale session pin', async (t) => {
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  fs.writeFileSync(path.join(home, 'config', 'active-session.json'), JSON.stringify({
    sessionId: 'session-stale',
    updated: new Date().toISOString(),
  }));
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const result = await runCli(['--json', 'heal', '--clear-pin'], {
    env: {
      GLIDER_HOME: home,
      GLIDER_PORT: String(relay.port),
      GLIDER_HEAL_NO_WAKE: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(fs.existsSync(path.join(home, 'config', 'active-session.json')), false);
  assert.ok(body.observation.actions.some((a) => a.step === 'clear_pin' && a.ok));
});

test('stale session pin heals to a live target on Session not found', async (t) => {
  const home = makeTempGliderHome();
  t.after(() => removeTree(home));
  fs.writeFileSync(path.join(home, 'config', 'active-session.json'), JSON.stringify({
    sessionId: 'session-dead',
    updated: new Date().toISOString(),
  }));
  const relay = await createMockRelay({
    targets: [{
      sessionId: 'session-live',
      targetId: 'target-live',
      targetInfo: {
        targetId: 'target-live',
        type: 'page',
        title: 'Live',
        url: 'http://fixture.test/live',
      },
    }],
    handler: async ({ req, res, body }) => {
      if (req.url === '/cdp' && body?.sessionId === 'session-dead') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return true;
      }
      if (req.url === '/cdp' && body?.method === 'Runtime.evaluate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { type: 'number', value: 2 } }));
        return true;
      }
      return false;
    },
  });
  t.after(() => relay.close());
  const result = await runCli(['--json', 'eval', '1+1'], {
    env: { GLIDER_HOME: home, GLIDER_PORT: String(relay.port) },
  });
  assert.equal(result.code, 0, result.stderr);
  const body = jsonFromStdout(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.observation, 2);
  const pin = JSON.parse(fs.readFileSync(path.join(home, 'config', 'active-session.json'), 'utf8'));
  assert.equal(pin.sessionId, 'session-live');
});

test('json output includes timing when GLIDER_TIMING=1', async (t) => {
  const relay = await createMockRelay();
  t.after(() => relay.close());
  const result = await runCli(['--json', 'status'], {
    env: { GLIDER_PORT: String(relay.port), GLIDER_TIMING: '1' },
  });
  assert.equal(result.code, 0);
  const body = jsonFromStdout(result.stdout);
  assert.equal(typeof body.timing.total_ms, 'number');
  assert.ok(body.timing.total_ms >= 0);
});

test('freeze and thaw forward CDP lifecycle commands through the relay', async (t) => {
  const calls = [];
  const relay = await createMockRelay({
    handler: async ({ req, res, body }) => {
      if (req.url === '/cdp') {
        calls.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (body?.method === 'Runtime.evaluate') {
          res.end(JSON.stringify({ result: { type: 'string', value: 'visible' } }));
        } else {
          res.end(JSON.stringify({}));
        }
        return true;
      }
      return false;
    },
  });
  t.after(() => relay.close());
  const env = { GLIDER_PORT: String(relay.port) };
  let result = await runCli(['--json', 'freeze', '--force'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(calls.some((call) => call?.method === 'Page.setWebLifecycleState'));
  result = await runCli(['--json', 'thaw'], { env });
  assert.equal(result.code, 0, result.stderr);
});
