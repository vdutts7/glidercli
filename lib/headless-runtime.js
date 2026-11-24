'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { pathToFileURL } = require('node:url');

const SUBSCRIBER_API = 'headless-subscriber/v1';
const MITMPROXY_VERSION = '12.3.1';
const PROXY_EXACT_SCHEMA = 'glider-mitm-exact/v1';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs, description) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${description} timed out`);
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class CdpJournal {
  constructor(outputDir) {
    this.partialPath = path.join(outputDir, 'cdp-stream.jsonl.partial');
    this.finalPath = path.join(outputDir, 'cdp-stream.jsonl');
    this.fd = fs.openSync(this.partialPath, 'wx', 0o600);
    this.digest = crypto.createHash('sha256');
    this.count = 0;
    this.directionCounts = { in: 0, out: 0 };
    this.methodCounts = new Map();
    this.closed = false;
  }

  record(direction, raw) {
    if (this.closed) throw new Error('CDP journal is closed');
    const sequence = ++this.count;
    const observedAt = new Date().toISOString();
    const monotonicNanoseconds = process.hrtime.bigint().toString();
    const message = JSON.parse(raw);
    const method = message.method || (message.id !== undefined ? 'response' : 'unknown');
    this.directionCounts[direction] = (this.directionCounts[direction] || 0) + 1;
    this.methodCounts.set(method, (this.methodCounts.get(method) || 0) + 1);
    this.digest.update(direction);
    this.digest.update('\0');
    this.digest.update(raw);
    this.digest.update('\0');
    fs.writeSync(this.fd, `${JSON.stringify({
      sequence,
      observedAt,
      monotonicNanoseconds,
      direction,
      raw,
    })}\n`);
    return sequence;
  }

  close() {
    if (this.closed) throw new Error('CDP journal is already closed');
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    fs.renameSync(this.partialPath, this.finalPath);
    this.closed = true;
    return {
      artifact: path.basename(this.finalPath),
      messages: this.count,
      directions: this.directionCounts,
      methods: Object.fromEntries(
        [...this.methodCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      sha256: this.digest.digest('hex'),
    };
  }
}

class CdpClient {
  constructor(commandStream, eventStream, journal = null) {
    this.commandStream = commandStream;
    this.eventStream = eventStream;
    this.journal = journal;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.fatalError = null;
  }

  async connect() {
    const rejectPending = (error) => this.fail(error);
    this.eventStream.on('data', (chunk) => {
      if (this.fatalError) return;
      try {
        this.buffer += this.decoder.write(chunk);
        let delimiter;
        while ((delimiter = this.buffer.indexOf('\0')) !== -1) {
          const raw = this.buffer.slice(0, delimiter);
          this.buffer = this.buffer.slice(delimiter + 1);
          if (!raw) continue;
          const journalSequence = this.journal?.record('in', raw) || null;
          const message = JSON.parse(raw);
          this.handleMessage(message, { journalSequence });
        }
      } catch (error) {
        this.fail(error);
      }
    });
    this.eventStream.once('error', rejectPending);
    this.eventStream.once('close', () => {
      rejectPending(new Error('CDP pipe closed'));
    });
    this.commandStream.once('error', rejectPending);
  }

  fail(error) {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  handleMessage(message, envelope = {}) {
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params || {}, {
          method: message.method,
          sessionId: message.sessionId || null,
          cdpSequence: envelope.journalSequence || null,
        });
      }
  }

  call(method, params = {}, options = {}) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      const message = { id, method, params };
      const sessionId = Object.prototype.hasOwnProperty.call(options, 'sessionId')
        ? options.sessionId
        : options.browserCommand
          ? null
          : this.sessionId;
      if (sessionId) message.sessionId = sessionId;
      const raw = JSON.stringify(message);
      try {
        this.journal?.record('out', raw);
        this.commandStream.write(`${raw}\0`);
      } catch (error) {
        this.pending.delete(id);
        this.fail(error);
        reject(error);
      }
    });
  }

  useSession(sessionId) {
    this.sessionId = sessionId;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.commandStream?.end();
    this.eventStream?.destroy();
  }
}

function parseNetscapeCookieJar(text) {
  const cookies = [];
  for (const originalLine of text.split(/\r?\n/)) {
    if (!originalLine.trim()) continue;
    const httpOnly = originalLine.startsWith('#HttpOnly_');
    if (originalLine.startsWith('#') && !httpOnly) continue;
    const line = httpOnly ? originalLine.slice('#HttpOnly_'.length) : originalLine;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...valueParts] = fields;
    const cookie = {
      name,
      value: valueParts.join('\t'),
      domain,
      path: cookiePath || '/',
      secure: secure.toUpperCase() === 'TRUE',
      httpOnly,
    };
    const expiry = Number(expires);
    if (Number.isFinite(expiry) && expiry > 0) cookie.expires = expiry;
    cookies.push(cookie);
  }
  return cookies;
}

function chromeCookieToCdp(cookie, defaultDomain) {
  const domain = cookie.domain || defaultDomain;
  if (!domain) throw new Error(`cookie ${cookie.name || '<unnamed>'} has no domain`);
  const result = {
    name: cookie.name,
    value: cookie.value ?? '',
    domain,
    path: cookie.path || '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
  };
  const expires = cookie.expires ?? cookie.expirationDate;
  if (Number.isFinite(expires) && expires > 0) result.expires = expires;
  if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
    const normalized = String(cookie.sameSite).toLowerCase();
    result.sameSite = normalized === 'no_restriction'
      ? 'None'
      : normalized[0].toUpperCase() + normalized.slice(1);
  }
  return result;
}

function parseCookieSource(text, defaultDomain) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('cookie source is empty');
  if (trimmed.startsWith('[')) {
    const rows = JSON.parse(trimmed);
    if (!Array.isArray(rows)) throw new Error('cookie JSON must be an array');
    return {
      format: 'json',
      cookies: rows.map((cookie) => chromeCookieToCdp(cookie, defaultDomain)),
    };
  }
  const netscape = parseNetscapeCookieJar(text);
  if (netscape.length) return { format: 'netscape', cookies: netscape };
  if (!defaultDomain) {
    throw new Error('Cookie-header import requires cookieDomain');
  }
  const header = trimmed.replace(/^Cookie:\s*/i, '').split(/\r?\n/)[0];
  const cookies = header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    return {
      name: part.slice(0, separator).trim(),
      value: part.slice(separator + 1),
      domain: defaultDomain,
      path: '/',
      secure: true,
      httpOnly: false,
    };
  }).filter(Boolean);
  if (!cookies.length) throw new Error('cookie source has no parseable cookies');
  return { format: 'header', cookies };
}

function normalizedDomain(domain) {
  return String(domain || '').replace(/^\./, '').toLowerCase();
}

function cookieDomainAllowed(domain, allowedDomains) {
  const normalized = normalizedDomain(domain);
  return allowedDomains.some((allowed) => normalized === normalizedDomain(allowed));
}

function serializeCookies(format, cookies) {
  if (format === 'json') {
    return `${JSON.stringify(cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      sameSite: cookie.sameSite,
      expirationDate: Number.isFinite(cookie.expires) && cookie.expires > 0
        ? cookie.expires
        : undefined,
    })), null, 2)}\n`;
  }
  if (format === 'header') {
    return `${cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')}\n`;
  }
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Refreshed by Glider isolated headless runtime.',
    ...cookies.map((cookie) => {
      const prefix = cookie.httpOnly ? '#HttpOnly_' : '';
      const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expires = Number.isFinite(cookie.expires) && cookie.expires > 0
        ? Math.floor(cookie.expires)
        : 0;
      return [
        `${prefix}${cookie.domain}`,
        includeSubdomains,
        cookie.path || '/',
        secure,
        expires,
        cookie.name,
        cookie.value,
      ].join('\t');
    }),
    '',
  ];
  return lines.join('\n');
}

async function atomicWrite(filePath, data, mode = 0o600) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, data, { mode, flag: 'wx' });
  await fsp.rename(temporary, filePath);
}

async function prepareOutputDir(outputDir) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const enforcePosixPermissions = process.platform !== 'win32';
  const assertTrustedAncestors = async (target) => {
    let current = path.resolve(target);
    while (true) {
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`headless output ancestor is a symlink: ${current}`);
        }
        if (enforcePosixPermissions && (stat.mode & 0o022) !== 0) {
          throw new Error(`headless output ancestor is group/world writable: ${current}`);
        }
        if (uid != null && stat.uid !== uid && stat.uid !== 0) {
          throw new Error(`headless output ancestor has an untrusted owner: ${current}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  await assertTrustedAncestors(path.dirname(outputDir));
  try {
    await fsp.lstat(outputDir);
    throw new Error(`headless output directory already exists: ${outputDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  }
  const resolved = await fsp.realpath(outputDir);
  await assertTrustedAncestors(resolved);
  const stat = await fsp.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`headless output must be a real directory: ${resolved}`);
  }
  if (uid != null && stat.uid !== uid) {
    throw new Error(`headless output directory has an untrusted owner: ${resolved}`);
  }
  await fsp.chmod(resolved, 0o700);
  return resolved;
}

function browserCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

function resolveBrowserBinary(configured) {
  const resolved = configured
    ? path.resolve(configured)
    : browserCandidates().find((candidate) => candidate && fs.existsSync(candidate));
  if (!resolved) {
    throw new Error('no supported Chromium binary found; pass --browser or configure browserBinary');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`browser binary is not a file: ${resolved}`);
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child) return;
  const processGroup = child.gliderProcessGroup === true && process.platform !== 'win32';
  const groupRunning = () => {
    if (!processGroup) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (
        error.code === 'EPERM'
        && (child.exitCode !== null || child.signalCode !== null)
      ) {
        return false;
      }
      throw error;
    }
  };
  const signal = (name) => {
    if (processGroup) {
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code === 'EPERM' && child.exitCode === null && child.signalCode === null) {
          child.kill(name);
        } else if (error.code !== 'ESRCH' && error.code !== 'EPERM') {
          throw error;
        }
      }
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill(name);
    }
  };
  const waitUntilStopped = async (limitMs) => {
    const deadline = Date.now() + limitMs;
    while (groupRunning() && Date.now() < deadline) await delay(50);
    return !groupRunning();
  };
  if (!groupRunning()) return;
  signal('SIGTERM');
  const graceful = await waitUntilStopped(timeoutMs);
  if (!graceful) {
    signal('SIGKILL');
    if (!await waitUntilStopped(2_000)) {
      throw new Error('process shutdown after SIGKILL timed out after 2000ms');
    }
  }
}

function findExecutable(command, envPath = process.env.PATH || '') {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const resolved = path.resolve(command);
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  }
  for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return '';
}

async function runCommand(command, args, timeoutMs, description) {
  const child = spawn(command, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let outcome;
  try {
    outcome = await withTimeout(exit, timeoutMs, description);
  } catch (error) {
    await stopProcess(child, 1_000);
    throw error;
  }
  const result = {
    ...outcome,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
  if (result.code !== 0 || result.signal) {
    throw new Error(
      `${description} failed (${result.signal || `exit ${result.code}`}): ${
        (result.stderr || result.stdout).trim() || 'no output'
      }`,
    );
  }
  return result;
}

function resolveMitmproxyCommand(configured = {}) {
  const requestedMitmdump = configured.mitmdumpBinary || 'mitmdump';
  let mitmdump = '';
  try {
    mitmdump = findExecutable(requestedMitmdump);
  } catch (error) {
    if (configured.mitmdumpBinary) throw error;
  }
  if (mitmdump) {
    return {
      command: mitmdump,
      prefixArgs: [],
      source: 'installed-mitmdump',
      verifyVersion: true,
    };
  }
  const requestedUv = configured.uvBinary || 'uv';
  let uv = '';
  try {
    uv = findExecutable(requestedUv);
  } catch (error) {
    if (configured.uvBinary) throw error;
  }
  if (!uv) {
    throw new Error(
      `proxy capture requires mitmdump ${MITMPROXY_VERSION} or uv on PATH`,
    );
  }
  return {
    command: uv,
    prefixArgs: [
      'tool',
      'run',
      '--from',
      `mitmproxy==${MITMPROXY_VERSION}`,
      'mitmdump',
    ],
    source: 'uv-pinned-fallback',
    verifyVersion: false,
  };
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  if (!port) throw new Error('failed to reserve an ephemeral proxy port');
  return port;
}

function computeCertificateSpkiHash(pem) {
  const certificate = new crypto.X509Certificate(pem);
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('base64');
}

function buildMitmproxyArgs(paths, port, upstream = '') {
  const args = [
    '--listen-host',
    '127.0.0.1',
    '--listen-port',
    String(port),
    '--set',
    `confdir=${paths.confDir}`,
    '--set',
    `hardump=${paths.harPath}`,
    '--set',
    'termlog_verbosity=info',
    '--set',
    'websocket=true',
    '--set',
    `glider_capture_dir=${paths.exactDir}`,
    '-s',
    paths.addonPath,
    '-w',
    paths.flowPath,
  ];
  if (upstream) args.push('--mode', `upstream:${upstream}`);
  return args;
}

function proxyBrowserArgs(proxy) {
  if (!proxy?.port || !proxy?.spkiHash) {
    throw new Error('proxy browser arguments require a ready proxy and CA SPKI hash');
  }
  return [
    `--proxy-server=http://127.0.0.1:${proxy.port}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    `--ignore-certificate-errors-spki-list=${proxy.spkiHash}`,
  ];
}

function installProxyTerminationHandlers(proxy) {
  const handlers = new Map();
  let stopping = false;
  const restore = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (stopping) return;
      stopping = true;
      restore();
      stopProcess(proxy.child, 2_000)
        .catch(() => {})
        .finally(() => {
          process.kill(process.pid, signal);
        });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return restore;
}

async function waitForProxyReady(proxy, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'proxy did not accept a connection';
  while (Date.now() < deadline) {
    if (proxy.child.exitCode !== null || proxy.child.signalCode !== null) {
      throw new Error(
        `mitmproxy exited before readiness (${
          proxy.child.signalCode || `exit ${proxy.child.exitCode}`
        })`,
      );
    }
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: '127.0.0.1',
          port: proxy.port,
        });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('proxy readiness connection timed out'));
        }, 250);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.end();
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      await fsp.access(proxy.paths.caPath, fs.constants.R_OK);
      await fsp.access(proxy.paths.exactReadyPath, fs.constants.R_OK);
      return;
    } catch (error) {
      lastError = error.message;
      await delay(100);
    }
  }
  throw new Error(`mitmproxy readiness timed out after ${timeoutMs}ms: ${lastError}`);
}

async function enforcePrivateTree(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  await fsp.chmod(root, 0o700);
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`proxy artifact must not be a symlink: ${entryPath}`);
    }
    if (entry.isDirectory()) await enforcePrivateTree(entryPath);
    else if (entry.isFile()) await fsp.chmod(entryPath, 0o600);
  }
}

async function startProxyCapture(outputDir, configured = {}) {
  const rootDir = path.join(outputDir, 'proxy');
  const confDir = path.join(rootDir, 'conf');
  const exactDir = path.join(rootDir, 'exact');
  await Promise.all([
    fsp.mkdir(confDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(exactDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fsp.chmod(rootDir, 0o700),
    fsp.chmod(confDir, 0o700),
    fsp.chmod(exactDir, 0o700),
  ]);
  const paths = {
    rootDir,
    confDir,
    exactDir,
    addonPath: path.join(__dirname, 'mitmproxy-exact-capture.py'),
    caPath: path.join(confDir, 'mitmproxy-ca-cert.pem'),
    flowPath: path.join(rootDir, 'flows.mitm'),
    harPath: path.join(rootDir, 'traffic.har'),
    logPath: path.join(rootDir, 'mitmdump.log'),
    exactIndexPath: path.join(exactDir, 'flows.jsonl'),
    exactReadyPath: path.join(exactDir, 'ready.json'),
    exactFinalPath: path.join(exactDir, 'final.json'),
  };
  await fsp.access(paths.addonPath, fs.constants.R_OK);
  const upstream = Object.prototype.hasOwnProperty.call(configured, 'proxyUpstream')
    ? configured.proxyUpstream
    : process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || '';
  if (upstream) {
    const parsedUpstream = new URL(upstream);
    if (!['http:', 'https:'].includes(parsedUpstream.protocol)) {
      throw new Error(`unsupported mitmproxy upstream protocol: ${parsedUpstream.protocol}`);
    }
  }
  const command = resolveMitmproxyCommand(configured);
  if (command.verifyVersion) {
    const version = await runCommand(
      command.command,
      ['--version'],
      configured.proxyCommandTimeoutMs || 10_000,
      'mitmdump version check',
    );
    const reported = `${version.stdout}\n${version.stderr}`;
    if (!new RegExp(`\\b${MITMPROXY_VERSION.replace(/\./g, '\\.')}\\b`).test(reported)) {
      throw new Error(
        `installed mitmdump must be ${MITMPROXY_VERSION}; reported: ${reported.trim()}`,
      );
    }
  }
  const port = await reserveLoopbackPort();
  const logFd = fs.openSync(paths.logPath, 'wx', 0o600);
  const args = [...command.prefixArgs, ...buildMitmproxyArgs(paths, port, upstream)];
  const useProcessGroup = process.platform !== 'win32';
  const child = spawn(command.command, args, {
    detached: useProcessGroup,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  child.gliderProcessGroup = useProcessGroup;
  const proxy = {
    child,
    logFd,
    port,
    paths,
    command: {
      source: command.source,
      executable: command.command,
      version: MITMPROXY_VERSION,
    },
    upstream: upstream ? true : false,
  };
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  try {
    await waitForProxyReady(proxy, configured.proxyStartupTimeoutMs || 30_000);
    if (spawnError) throw spawnError;
    await enforcePrivateTree(rootDir);
    const caPem = await fsp.readFile(paths.caPath, 'utf8');
    proxy.spkiHash = computeCertificateSpkiHash(caPem);
    return proxy;
  } catch (error) {
    try {
      await stopProcess(child, 2_000);
    } finally {
      fs.closeSync(logFd);
      proxy.logClosed = true;
      await enforcePrivateTree(rootDir);
    }
    throw error;
  }
}

async function finalizeProxyCapture(proxy, timeoutMs = 15_000) {
  if (!proxy) return null;
  try {
    await stopProcess(proxy.child, timeoutMs);
  } finally {
    if (!proxy.logClosed) {
      fs.closeSync(proxy.logFd);
      proxy.logClosed = true;
    }
  }
  const requiredArtifacts = [
    proxy.paths.harPath,
    proxy.paths.flowPath,
    proxy.paths.exactIndexPath,
    proxy.paths.exactFinalPath,
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await Promise.all(requiredArtifacts.map(async (artifact) => {
      try {
        return (await fsp.stat(artifact)).isFile();
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }));
    if (present.every(Boolean)) break;
    await delay(50);
  }
  await enforcePrivateTree(proxy.paths.rootDir);
  const [harStat, flowStat, exactIndexStat, exactFinal] = await Promise.all([
    fsp.stat(proxy.paths.harPath),
    fsp.stat(proxy.paths.flowPath),
    fsp.stat(proxy.paths.exactIndexPath),
    fsp.readFile(proxy.paths.exactFinalPath, 'utf8').then(JSON.parse),
  ]);
  if (!harStat.isFile()) throw new Error('mitmproxy HAR was not finalized as a file');
  if (!flowStat.isFile()) throw new Error('mitmproxy flow capture was not finalized as a file');
  if (!exactIndexStat.isFile()) {
    throw new Error('mitmproxy exact flow index was not finalized as a file');
  }
  if (exactFinal.schema !== PROXY_EXACT_SCHEMA) {
    throw new Error(`unexpected mitmproxy exact capture schema: ${exactFinal.schema}`);
  }
  if (exactFinal.captureErrorCount !== 0) {
    throw new Error(
      `mitmproxy exact capture reported ${exactFinal.captureErrorCount} capture errors`,
    );
  }
  return {
    enabled: true,
    version: proxy.command.version,
    launch: proxy.command.source,
    endpoint: `127.0.0.1:${proxy.port}`,
    upstreamProxy: proxy.upstream,
    caTrust: {
      mechanism: 'chromium-spki-allowlist',
      sha256Base64: proxy.spkiHash,
    },
    artifacts: {
      log: path.relative(path.dirname(proxy.paths.rootDir), proxy.paths.logPath),
      flows: path.relative(path.dirname(proxy.paths.rootDir), proxy.paths.flowPath),
      har: path.relative(path.dirname(proxy.paths.rootDir), proxy.paths.harPath),
      confdir: path.relative(path.dirname(proxy.paths.rootDir), proxy.paths.confDir),
      exactIndex: path.relative(
        path.dirname(proxy.paths.rootDir),
        proxy.paths.exactIndexPath,
      ),
      exactBodies: path.relative(
        path.dirname(proxy.paths.rootDir),
        path.join(proxy.paths.exactDir, 'bodies'),
      ),
    },
    exactCapture: exactFinal,
  };
}

function parseRuntimeArgs(argv) {
  const separator = argv.indexOf('--');
  const runtimeArgs = separator === -1 ? argv : argv.slice(0, separator);
  const subscriberArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const options = {
    action: runtimeArgs[0] || 'help',
    subscriber: runtimeArgs[1] || '',
    outputDir: '',
    cookieJar: '',
    cookieDomain: '',
    browserBinary: '',
    cookieExport: true,
    subscriberArgs,
  };
  const valueAfter = (index, option) => {
    const value = runtimeArgs[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 2; index < runtimeArgs.length; index += 1) {
    const argument = runtimeArgs[index];
    if (argument === '--out') options.outputDir = path.resolve(valueAfter(index++, argument));
    else if (argument === '--cookie-jar') options.cookieJar = path.resolve(valueAfter(index++, argument));
    else if (argument === '--cookie-domain') options.cookieDomain = valueAfter(index++, argument);
    else if (argument === '--browser') options.browserBinary = valueAfter(index++, argument);
    else if (argument === '--no-cookie-export') options.cookieExport = false;
    else throw new Error(`unknown headless runtime argument: ${argument}`);
  }
  return options;
}

function headlessHelp() {
  return [
    'Usage: glider headless run <subscriber.mjs> [runtime options] -- [subscriber args]',
    '       glider headless contract',
    '',
    'Runtime options:',
    '  --out PATH              Override subscriber output directory',
    '  --cookie-jar PATH       Override subscriber cookie source',
    '  --cookie-domain HOST    Domain for Cookie-header sources',
    '  --browser PATH          Chromium-family browser binary',
    '  --no-cookie-export      Do not persist rotated cookies',
    '',
    `Subscriber API: ${SUBSCRIBER_API}`,
  ].join('\n');
}

async function loadSubscriber(modulePath) {
  const resolved = path.resolve(modulePath);
  if (!fs.existsSync(resolved)) throw new Error(`headless subscriber not found: ${resolved}`);
  const imported = await import(pathToFileURL(resolved).href);
  const subscriber = imported.default && typeof imported.default === 'object'
    ? imported.default
    : imported;
  if (subscriber.apiVersion !== SUBSCRIBER_API) {
    throw new Error(`subscriber must export apiVersion="${SUBSCRIBER_API}"`);
  }
  if (typeof subscriber.configure !== 'function' || typeof subscriber.run !== 'function') {
    throw new Error('subscriber must export configure() and run()');
  }
  return { subscriber, resolved };
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: false,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'evaluation failed';
    throw new Error(detail);
  }
  return result.result.value;
}

async function waitForExpression(client, expression, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(
      client,
      `(() => { try { return Boolean(${expression}); } catch { return false; } })()`,
    );
    if (lastValue) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${description}; last=${lastValue}`);
}

async function physicalClick(client, elementExpression, description) {
  const pointExpression = `(() => {
    const element = ${elementExpression};
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  let point = await evaluate(client, pointExpression);
  if (!point) throw new Error(`cannot click ${description}: element not visible`);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await delay(50);
  point = await evaluate(client, pointExpression);
  if (!point) throw new Error(`cannot click ${description}: element moved`);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse',
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
}

async function pressKey(client, key, code, virtualKeyCode) {
  await client.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
}

function compileBodyPatterns(patterns) {
  return (patterns || []).map((pattern) => (
    pattern instanceof RegExp ? pattern : new RegExp(pattern)
  ));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function responseCanHaveBody(record) {
  const status = Number(record.response?.status);
  return record.method !== 'HEAD'
    && status !== 101
    && status !== 204
    && status !== 205
    && status !== 304
    && !record.redirectedTo
    && !String(record.url || '').startsWith('data:');
}

function redirectCanHaveBody(record) {
  const status = Number(record.response?.status);
  return Boolean(record.redirectedTo)
    && record.method !== 'HEAD'
    && status !== 101
    && status !== 204
    && status !== 205
    && status !== 304
    && !String(record.url || '').startsWith('data:');
}

async function storePayload(outputDir, state, kind, value, options = {}) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : options.base64Encoded
      ? Buffer.from(value || '', 'base64')
      : Buffer.from(value || '', 'utf8');
  const digest = sha256(buffer);
  const sequence = String(++state.sequence).padStart(6, '0');
  const filename = `${sequence}-${kind}-${digest.slice(0, 16)}.body`;
  const relativePath = path.join('network', 'bodies', filename);
  await atomicWrite(path.join(outputDir, relativePath), buffer);
  return {
    artifact: relativePath,
    bytes: buffer.length,
    sha256: digest,
    cdpBase64Encoded: options.base64Encoded === true,
    origin: options.origin || 'cdp',
    ...(options.originMetadata || {}),
  };
}

function proxyHarEntries(document) {
  const entries = document?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('proxy HAR has no log.entries array');
  return entries.map((entry, index) => ({
    index,
    startedAt: entry.startedDateTime || null,
    startedMilliseconds: Number.isFinite(Date.parse(entry.startedDateTime))
      ? Date.parse(entry.startedDateTime)
      : null,
    method: String(entry.request?.method || ''),
    url: String(entry.request?.url || ''),
    status: Number(entry.response?.status),
    entry,
  }));
}

async function proxyExactEntries(exactDir, finalSummary = null) {
  const indexPath = path.join(exactDir, 'flows.jsonl');
  const text = await fsp.readFile(indexPath, 'utf8');
  const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid proxy exact index JSON at line ${index + 1}: ${error.message}`);
    }
  });
  if (
    finalSummary
    && Number(finalSummary.terminalCount) !== rows.length
  ) {
    throw new Error(
      `proxy exact index count ${rows.length} did not match terminal count ${
        finalSummary.terminalCount
      }`,
    );
  }
  const flowIds = new Set();
  const validateBody = async (body, rowIndex, kind) => {
    if (body == null) return null;
    if (
      typeof body.artifact !== 'string'
      || !Number.isInteger(body.bytes)
      || body.bytes < 0
      || !/^[a-f0-9]{64}$/.test(body.sha256 || '')
    ) {
      throw new Error(`invalid ${kind} body metadata in proxy exact index row ${rowIndex + 1}`);
    }
    const absolute = path.resolve(exactDir, body.artifact);
    if (!absolute.startsWith(`${path.resolve(exactDir)}${path.sep}`)) {
      throw new Error(`proxy exact body escapes capture directory: ${body.artifact}`);
    }
    const stat = await fsp.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`proxy exact body is not a regular file: ${body.artifact}`);
    }
    const buffer = await fsp.readFile(absolute);
    const digest = sha256(buffer);
    if (buffer.length !== body.bytes || digest !== body.sha256) {
      throw new Error(`proxy exact body failed hash/length validation: ${body.artifact}`);
    }
    return {
      ...body,
      buffer,
    };
  };
  return Promise.all(rows.map(async (row, index) => {
    if (row.schema !== PROXY_EXACT_SCHEMA) {
      throw new Error(`unexpected proxy exact schema in row ${index + 1}: ${row.schema}`);
    }
    if (!['response', 'error'].includes(row.terminal)) {
      throw new Error(`invalid proxy terminal state in row ${index + 1}: ${row.terminal}`);
    }
    if (!row.flowId || flowIds.has(row.flowId)) {
      throw new Error(`duplicate or missing proxy flow ID in row ${index + 1}`);
    }
    flowIds.add(row.flowId);
    if (!row.method || !row.url) {
      throw new Error(`proxy exact row ${index + 1} has no method or URL`);
    }
    const status = row.status == null ? null : Number(row.status);
    if (status != null && !Number.isFinite(status)) {
      throw new Error(`proxy exact row ${index + 1} has an invalid status`);
    }
    const requestBody = await validateBody(row.requestBody, index, 'request');
    const responseBody = await validateBody(row.responseBody, index, 'response');
    return {
      index,
      flowId: row.flowId,
      terminal: row.terminal,
      observedAt: row.observedAt || null,
      method: String(row.method),
      url: String(row.url),
      status,
      startedMilliseconds: Number.isFinite(Number(row.timestamps?.requestStart))
        ? Number(row.timestamps.requestStart) * 1_000
        : null,
      timestamps: row.timestamps || {},
      requestBody,
      responseBody,
      error: row.error || null,
    };
  }));
}

function networkHarKey(method, url, status) {
  return `${method}\0${url}\0${status == null ? '<none>' : Number(status)}`;
}

function resolveCaptureIssue(captureIssues, predicate, resolution) {
  for (const issue of captureIssues) {
    if (!issue.resolved && predicate(issue)) {
      issue.resolved = true;
      issue.resolution = resolution;
      issue.resolvedAt = new Date().toISOString();
    }
  }
}

function classifySourceMapReference(script) {
  if (script.sourceMapURL.startsWith('data:')) {
    return { resolvedURL: script.sourceMapURL };
  }
  const scriptUrl = new URL(script.url);
  const candidate = new URL(script.sourceMapURL, scriptUrl);
  if (['webpack:', 'webpack-internal:'].includes(candidate.protocol) && script.source) {
    return {
      result: {
        kind: 'non-fetchable-virtual-reference',
        protocol: candidate.protocol,
        reference: script.sourceMapURL,
        resolvedURL: candidate.href,
        reason: 'webpack virtual source-map reference retained with captured script source',
        scriptSourceArtifact: script.source.artifact,
      },
    };
  }
  if (!['http:', 'https:'].includes(candidate.protocol)) {
    throw new Error(`unsupported source-map protocol: ${candidate.protocol}`);
  }
  if (candidate.origin !== scriptUrl.origin) {
    throw new Error(
      `cross-origin source map is outside the loaded script origin: ${candidate.href}`,
    );
  }
  return { resolvedURL: candidate.href };
}

async function reconcileNetworkWithProxyHar(
  outputDir,
  payloadState,
  network,
  harEntries,
  exactEntries,
  captureIssues,
  artifacts = {},
) {
  const harArtifact = artifacts.harArtifact || path.join('proxy', 'traffic.har');
  const exactIndexArtifact = artifacts.exactIndexArtifact
    || path.join('proxy', 'exact', 'flows.jsonl');
  const recordGroups = new Map();
  for (const record of network) {
    const key = networkHarKey(record.method, record.url, record.response?.status ?? null);
    const group = recordGroups.get(key) || [];
    group.push(record);
    recordGroups.set(key, group);
  }
  const exactGroups = new Map();
  for (const entry of exactEntries) {
    if (!entry.method || !entry.url) continue;
    const key = networkHarKey(entry.method, entry.url, entry.status);
    const group = exactGroups.get(key) || [];
    group.push(entry);
    exactGroups.set(key, group);
  }
  let matchedRecords = 0;
  let fallbackBodies = 0;
  let redirectBodies = 0;
  let requestBodies = 0;
  let partialResponseBodies = 0;
  let closedResponses = 0;
  let terminalErrors = 0;
  let coverageGaps = 0;
  let ambiguities = 0;
  for (const [key, records] of recordGroups) {
    const candidates = exactGroups.get(key) || [];
    const needsProxy = records.filter((record) => (
      /^https?:\/\//i.test(record.url || '')
      ||
      (!record.responseBody && responseCanHaveBody(record))
      || (redirectCanHaveBody(record) && !record.redirectResponseBody)
      || record.captureEndedWhileOpen
      || (record.request?.hasPostData && (!record.requestBody || record.requestBodyError))
      || record.crossSessionEvents?.length
      || (record.failure && record.response)
    ));
    if (!needsProxy.length) continue;
    if (!candidates.length) {
      coverageGaps += needsProxy.length;
      captureIssues.push({
        surface: 'proxy-exact-coverage',
        key,
        recordKeys: needsProxy.map((record) => record.key),
        error: 'proxy-eligible CDP traffic had no byte-exact proxy flow',
      });
      continue;
    }
    if (records.length > candidates.length) {
      ambiguities += 1;
      captureIssues.push({
        surface: 'proxy-exact-correlation',
        key,
        recordKeys: records.map((record) => record.key),
        proxyFlowIds: candidates.map((entry) => entry.flowId),
        error: 'fewer exact proxy flows than matching CDP records',
      });
      continue;
    }
    if (
      records.length > 1
      && (
        records.some((record) => !Number.isFinite(Number(record.wallTime)))
        || candidates.some((candidate) => candidate.startedMilliseconds == null)
      )
    ) {
      ambiguities += 1;
      captureIssues.push({
        surface: 'proxy-exact-correlation',
        key,
        recordKeys: records.map((record) => record.key),
        proxyFlowIds: candidates.map((entry) => entry.flowId),
        error: 'repeated occurrences lacked comparable chronological timestamps',
      });
      continue;
    }
    const orderedRecords = [...records].sort((left, right) => (
      Number(left.wallTime || 0) - Number(right.wallTime || 0)
    ));
    let orderedCandidates = [...candidates].sort((left, right) => (
      (left.startedMilliseconds ?? 0) - (right.startedMilliseconds ?? 0)
      || left.index - right.index
    ));
    if (candidates.length > records.length) {
      const remaining = [...orderedCandidates];
      const matched = [];
      let unsafe = false;
      for (const record of orderedRecords) {
        const recordStart = Number(record.wallTime) * 1_000;
        if (!Number.isFinite(recordStart)) {
          unsafe = true;
          break;
        }
        const ranked = remaining
          .map((candidate) => ({
            candidate,
            delta: Math.abs(candidate.startedMilliseconds - recordStart),
          }))
          .sort((left, right) => left.delta - right.delta);
        if (
          !ranked.length
          || ranked[0].delta > 100
          || (ranked[1] && ranked[1].delta - ranked[0].delta < 10)
        ) {
          unsafe = true;
          break;
        }
        matched.push(ranked[0].candidate);
        remaining.splice(remaining.indexOf(ranked[0].candidate), 1);
      }
      if (unsafe) {
        ambiguities += 1;
        captureIssues.push({
          surface: 'proxy-exact-correlation',
          key,
          recordKeys: records.map((record) => record.key),
          proxyFlowIds: candidates.map((entry) => entry.flowId),
          error: 'extra exact proxy flows could not be uniquely matched by start time',
        });
        continue;
      }
      orderedCandidates = matched;
    }
    for (let index = 0; index < orderedRecords.length; index += 1) {
      const record = orderedRecords[index];
      const candidate = orderedCandidates[index];
      record.proxyCapture = {
        harArtifact,
        exactIndexArtifact,
        exactIndexRow: candidate.index,
        flowId: candidate.flowId,
        terminal: candidate.terminal,
        startedAt: candidate.timestamps.requestStart || null,
        method: candidate.method,
        url: candidate.url,
        status: candidate.status,
        responseBodyRetained: Boolean(candidate.responseBody),
        requestBodyRetained: Boolean(candidate.requestBody),
        error: candidate.error,
      };
      matchedRecords += 1;
      if (record.request?.hasPostData && candidate.requestBody) {
        const proxyRequestBody = await storePayload(
          outputDir,
          payloadState,
          'request-proxy-exact',
          candidate.requestBody.buffer,
          {
            origin: 'proxy-addon',
            originMetadata: {
              proxyExactIndexArtifact: exactIndexArtifact,
              proxyExactIndexRow: candidate.index,
              proxyFlowId: candidate.flowId,
              proxySourceArtifact: candidate.requestBody.artifact,
            },
          },
        );
        record.proxyCapture.requestBody = proxyRequestBody;
        if (record.requestBody) record.cdpRequestBody = record.requestBody;
        record.requestBody = proxyRequestBody;
        requestBodies += 1;
        resolveCaptureIssue(
          captureIssues,
          (issue) => issue.surface === 'request-body' && issue.requestKey === record.key,
          'byte-exact proxy addon supplied and validated the request body',
        );
      }
      let responsePayload = null;
      if (candidate.responseBody && (
        (redirectCanHaveBody(record) && !record.redirectResponseBody)
        || (!record.responseBody && responseCanHaveBody(record))
        || record.captureEndedWhileOpen
        || (record.failure && record.response)
      )) {
        responsePayload = await storePayload(
          outputDir,
          payloadState,
          candidate.terminal === 'response'
            ? record.redirectedTo
              ? 'redirect-proxy-exact'
              : 'response-proxy-exact'
            : 'response-proxy-partial',
          candidate.responseBody.buffer,
          {
            origin: 'proxy-addon',
            originMetadata: {
              proxyExactIndexArtifact: exactIndexArtifact,
              proxyExactIndexRow: candidate.index,
              proxyFlowId: candidate.flowId,
              proxySourceArtifact: candidate.responseBody.artifact,
              proxyTerminal: candidate.terminal,
            },
          },
        );
        record.proxyCapture.responseBody = responsePayload;
      }
      if (candidate.terminal === 'response') {
        if (redirectCanHaveBody(record) && responsePayload) {
          record.redirectResponseBody = responsePayload;
          redirectBodies += 1;
        } else if (
          !record.responseBody
          && responseCanHaveBody(record)
          && responsePayload
        ) {
          record.responseBody = responsePayload;
          fallbackBodies += 1;
          resolveCaptureIssue(
            captureIssues,
            (issue) => issue.surface === 'response-body' && issue.requestKey === record.key,
            'byte-exact proxy addon supplied a complete validated response body',
          );
        }
        const completeBody = responsePayload
          || (!responseCanHaveBody(record) && !redirectCanHaveBody(record));
        if (record.captureEndedWhileOpen && completeBody) {
          delete record.captureEndedWhileOpen;
          record.proxyCompletion = {
            exactIndexArtifact,
            exactIndexRow: candidate.index,
            flowId: candidate.flowId,
            terminal: 'response',
            completed: true,
          };
          record.completedAt ||= candidate.timestamps.responseEnd
            || candidate.observedAt
            || new Date().toISOString();
          closedResponses += 1;
        }
        if (record.failure && record.response && completeBody) {
          record.proxyCompletion ||= {
            exactIndexArtifact,
            exactIndexRow: candidate.index,
            flowId: candidate.flowId,
            terminal: 'response',
            completed: true,
          };
          resolveCaptureIssue(
            captureIssues,
            (issue) => (
              issue.surface === 'response-transfer'
              && issue.requestKey === record.key
            ),
            'byte-exact proxy addon proved a terminal complete response',
          );
        }
      } else {
        terminalErrors += 1;
        record.proxyTransfer = {
          exactIndexArtifact,
          exactIndexRow: candidate.index,
          flowId: candidate.flowId,
          terminal: 'error',
          error: candidate.error,
          partialResponseBody: responsePayload,
        };
        if (responsePayload) partialResponseBodies += 1;
      }
      resolveCaptureIssue(
        captureIssues,
        (issue) => (
          issue.surface === 'network-correlation'
          && issue.requestKey === record.key
        ),
        'validated byte-exact proxy flow proved the cross-session request identity',
      );
    }
  }
  return {
    harEntries: harEntries.length,
    exactEntries: exactEntries.length,
    matchedRecords,
    fallbackBodies,
    redirectBodies,
    requestBodies,
    partialResponseBodies,
    closedResponses,
    terminalErrors,
    coverageGaps,
    ambiguities,
  };
}

async function reconcileSourceMapsWithProxyHar(
  outputDir,
  payloadState,
  scripts,
  harEntries,
  exactEntries,
  captureIssues,
  artifacts = {},
) {
  const harArtifact = artifacts.harArtifact || path.join('proxy', 'traffic.har');
  const exactIndexArtifact = artifacts.exactIndexArtifact
    || path.join('proxy', 'exact', 'flows.jsonl');
  const groups = new Map();
  for (const script of scripts.filter((item) => (
    item.sourceMapAttempt
    && !item.sourceMap
    && !item.sourceMapResult
    && item.sourceMapResolvedURL
  ))) {
    const attempt = script.sourceMapAttempt;
    const key = `${script.sessionId}\0${script.sourceMapResolvedURL}\0${
      attempt.startedAt || ''
    }`;
    const group = groups.get(key) || {
      url: script.sourceMapResolvedURL,
      attempt,
      scripts: [],
    };
    group.scripts.push(script);
    groups.set(key, group);
  }
  let dispositions = 0;
  let terminalErrors = 0;
  let ambiguities = 0;
  let sequence = 0;
  for (const group of groups.values()) {
    const started = Date.parse(group.attempt.startedAt);
    const finished = Date.parse(group.attempt.finishedAt);
    const candidates = exactEntries.filter((entry) => (
      entry.method === 'GET'
      && entry.url === group.url
      && (
        !Number.isFinite(started)
        || entry.startedMilliseconds == null
        || (
          entry.startedMilliseconds >= started - 2_000
          && (!Number.isFinite(finished) || entry.startedMilliseconds <= finished + 2_000)
        )
      )
    ));
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        ambiguities += 1;
        captureIssues.push({
          surface: 'source-map-proxy-correlation',
          sourceMapURL: group.url,
          proxyFlowIds: candidates.map((entry) => entry.flowId),
          error: 'multiple byte-exact proxy flows matched the source-map attempt window',
        });
      }
      continue;
    }
    const candidate = candidates[0];
    if (!candidate.responseBody) continue;
    const responseBody = await storePayload(
      outputDir,
      payloadState,
      candidate.terminal === 'response'
        ? 'source-map-response-exact'
        : 'source-map-response-partial',
      candidate.responseBody.buffer,
      {
        origin: 'proxy-addon',
        originMetadata: {
          proxyExactIndexArtifact: exactIndexArtifact,
          proxyExactIndexRow: candidate.index,
          proxyFlowId: candidate.flowId,
          proxySourceArtifact: candidate.responseBody.artifact,
          proxyTerminal: candidate.terminal,
        },
      },
    );
    if (candidate.terminal !== 'response') {
      const transfer = {
        kind: 'terminal-proxy-error',
        url: group.url,
        method: candidate.method,
        status: candidate.status,
        proxyExactIndexArtifact: exactIndexArtifact,
        proxyExactIndexRow: candidate.index,
        proxyFlowId: candidate.flowId,
        error: candidate.error,
        partialResponseBody: responseBody,
        attemptedError: group.attempt.error,
      };
      for (const script of group.scripts) script.sourceMapTransfer = transfer;
      terminalErrors += 1;
      continue;
    }
    const disposition = {
      kind: 'http-terminal-disposition',
      url: group.url,
      method: candidate.method,
      status: candidate.status,
      startedAt: candidate.timestamps.requestStart || null,
      proxyHarArtifact: harArtifact,
      proxyExactIndexArtifact: exactIndexArtifact,
      proxyExactIndexRow: candidate.index,
      proxyFlowId: candidate.flowId,
      responseBody,
      attemptedError: group.attempt.error,
    };
    const digest = sha256(Buffer.from(JSON.stringify(disposition)));
    const relativePath = path.join(
      'source-maps',
      `${String(++sequence).padStart(6, '0')}-${digest.slice(0, 16)}-disposition.json`,
    );
    await atomicWrite(
      path.join(outputDir, relativePath),
      `${JSON.stringify(disposition, null, 2)}\n`,
    );
    const result = { ...disposition, artifact: relativePath };
    for (const script of group.scripts) script.sourceMapResult = result;
    resolveCaptureIssue(
      captureIssues,
      (issue) => (
        issue.surface === 'source-map'
        && issue.sourceMapAttemptId === group.attempt.id
        && !issue.resolved
      ),
      'byte-exact proxy addon retained the terminal HTTP disposition and body',
    );
    dispositions += 1;
  }
  return {
    harEntries: harEntries.length,
    exactEntries: exactEntries.length,
    dispositions,
    terminalErrors,
    ambiguities,
  };
}

function safeCheckpointName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) {
    throw new Error(`checkpoint name is invalid: ${name}`);
  }
  return name;
}

async function runSubscriber(options) {
  const { subscriber, resolved: subscriberPath } = await loadSubscriber(options.subscriber);
  const configured = await subscriber.configure({
    args: options.subscriberArgs,
    env: process.env,
    apiVersion: SUBSCRIBER_API,
  });
  if (configured?.help) {
    console.log(configured.help);
    return { skipped: true, reason: 'help' };
  }

  const configuredOutputDir = options.outputDir || configured.outputDir || '';
  if (!configuredOutputDir) {
    throw new Error('subscriber must configure outputDir or receive --out');
  }
  const outputDir = await prepareOutputDir(path.resolve(configuredOutputDir));
  const browserBinary = resolveBrowserBinary(options.browserBinary || configured.browserBinary);
  const cookieJar = options.cookieJar || configured.cookieJar || '';
  const cookieDomain = options.cookieDomain || configured.cookieDomain || '';
  const cookieExport = options.cookieExport && configured.cookieExport !== false;
  const bodyPatterns = compileBodyPatterns(configured.responseBodyPatterns);
  const requiredCookieNames = configured.requiredCookieNames || [];
  const captureMode = configured.captureMode || 'selective';
  if (!['selective', 'exhaustive'].includes(captureMode)) {
    throw new Error(`unsupported headless capture mode: ${captureMode}`);
  }
  const exhaustiveCapture = captureMode === 'exhaustive';
  const requireCompleteCapture = configured.requireCompleteCapture === true;
  const captureAdvertisedSourceMaps = configured.captureAdvertisedSourceMaps === true;
  const captureProxyTraffic = configured.captureProxyTraffic === true;
  if (captureProxyTraffic && !exhaustiveCapture) {
    throw new Error('captureProxyTraffic requires captureMode="exhaustive"');
  }
  const configuredBrowserArgs = configured.browserArgs || [];
  if (captureProxyTraffic) {
    const conflicting = configuredBrowserArgs.find((argument) => (
      argument === '--ignore-certificate-errors'
      || argument.startsWith('--ignore-certificate-errors=')
      || argument.startsWith('--ignore-certificate-errors-spki-list')
      || argument.startsWith('--proxy-server')
      || argument === '--no-proxy-server'
      || argument.startsWith('--proxy-pac-url')
      || argument.startsWith('--proxy-bypass-list')
      || argument === '--proxy-auto-detect'
    ));
    if (conflicting) {
      throw new Error(`captureProxyTraffic conflicts with browser argument: ${conflicting}`);
    }
  }

  const profileDir = path.join(outputDir, '.browser-profile');
  await fsp.mkdir(profileDir, { mode: 0o700 });
  const stderrPath = path.join(outputDir, 'browser.stderr.log');
  const stderrFd = fs.openSync(stderrPath, 'wx', 0o600);
  let stderrClosed = false;
  if (exhaustiveCapture) {
    await Promise.all([
      fsp.mkdir(path.join(outputDir, 'network', 'bodies'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(outputDir, 'scripts'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(outputDir, 'source-maps'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(outputDir, 'checkpoints'), { recursive: true, mode: 0o700 }),
    ]);
  }
  const journal = exhaustiveCapture ? new CdpJournal(outputDir) : null;
  let browser;
  let proxy;
  let proxySummary;
  let proxyReconciliation;
  let restoreProxyTerminationHandlers = () => {};
  let client;
  let primaryTargetId;
  let cookieSource;
  let browserVersion;
  let captureInitialized = false;
  let authenticated = false;
  let primaryError;
  let cleanupError;
  let journalSummary;
  const captureStartedAt = new Date().toISOString();
  const captureIssues = [];
  const checkpoints = [];
  const checkpointNames = new Set();
  const network = [];
  const requests = new Map();
  const networkExtraInfo = [];
  const pendingCaptureWork = new Set();
  const payloadState = { sequence: 0 };
  const scripts = [];
  const sessionTargets = new Map();
  let acceptCaptureEvents = true;
  let requestSequence = 0;
  let scriptSequence = 0;
  let collectSourceMaps = async () => {};
  try {
    if (captureProxyTraffic) {
      try {
        proxy = await startProxyCapture(outputDir, configured);
        restoreProxyTerminationHandlers = installProxyTerminationHandlers(proxy);
      } catch (error) {
        captureIssues.push({
          surface: 'proxy-startup',
          error: error.message,
        });
        throw error;
      }
    }
    browser = spawn(browserBinary, [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      ...configuredBrowserArgs,
      ...(proxy ? proxyBrowserArgs(proxy) : []),
    ], {
      detached: false,
      stdio: ['ignore', 'ignore', stderrFd, 'pipe', 'pipe'],
    });
    let spawnError;
    browser.once('error', (error) => { spawnError = error; });
    client = new CdpClient(browser.stdio[3], browser.stdio[4], journal);
    await client.connect();
    await delay(0);
    if (spawnError) throw spawnError;
    browserVersion = await client.call('Browser.getVersion', {}, { browserCommand: true });
    const target = await client.call(
      'Target.createTarget',
      { url: 'about:blank' },
      { browserCommand: true },
    );
    primaryTargetId = target.targetId;
    const attached = await client.call(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { browserCommand: true },
    );
    client.useSession(attached.sessionId);
    sessionTargets.set(attached.sessionId, {
      targetId: target.targetId,
      type: 'page',
    });
    const requestKey = (requestId, metadata = {}) => (
      exhaustiveCapture
        ? `${metadata.sessionId || attached.sessionId}:${requestId}`
        : requestId
    );
    const resolveOpenRequest = (requestId, metadata = {}) => {
      const directKey = requestKey(requestId, metadata);
      const direct = requests.get(directKey);
      if (direct) return { key: directKey, record: direct };
      const candidates = [...requests.entries()]
        .filter(([, record]) => record.requestId === requestId);
      if (candidates.length === 1) {
        const [key, record] = candidates[0];
        if (exhaustiveCapture) {
          record.crossSessionEvents ||= [];
          record.crossSessionEvents.push({
            sessionId: metadata.sessionId || attached.sessionId,
            cdpSequence: metadata.cdpSequence,
          });
          if (!record.crossSessionCorrelationIssue) {
            record.crossSessionCorrelationIssue = true;
            captureIssues.push({
              surface: 'network-correlation',
              requestId,
              requestKey: record.key,
              requestSessionId: record.sessionId,
              eventSessionId: metadata.sessionId || attached.sessionId,
              error: 'request event crossed target sessions and requires proxy proof',
            });
          }
        }
        return { key, record };
      }
      if (candidates.length > 1 && exhaustiveCapture) {
        captureIssues.push({
          surface: 'network-correlation',
          requestId,
          sessionId: metadata.sessionId || attached.sessionId,
          candidates: candidates.map(([key]) => key),
          error: 'request ID matched multiple open target sessions',
        });
      }
      return { key: directKey, record: null };
    };
    const trackCaptureWork = (promise) => {
      pendingCaptureWork.add(promise);
      promise.finally(() => pendingCaptureWork.delete(promise));
    };
    const captureRequestBody = (record, metadata) => {
      if (!exhaustiveCapture || !record.request?.hasPostData) return;
      const work = (async () => {
        try {
          const contentType = Object.entries(record.request.headers || {})
            .find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
          if (/^multipart\/form-data\b/i.test(contentType)) {
            throw new Error('multipart request body requires proxy evidence');
          }
          const entries = record.request.postDataEntries;
          let postData;
          let base64Encoded = false;
          if (
            Array.isArray(entries)
            && entries.length > 0
            && entries.every((entry) => typeof entry.bytes === 'string')
          ) {
            postData = Buffer.concat(
              entries.map((entry) => Buffer.from(entry.bytes, 'base64')),
            );
          } else if (record.request.postData !== undefined) {
            postData = record.request.postData;
          } else {
            const result = await client.call(
              'Network.getRequestPostData',
              { requestId: record.requestId },
              { sessionId: metadata.sessionId || attached.sessionId },
            );
            postData = result.postData;
            base64Encoded = result.base64Encoded === true;
          }
          record.requestBody = await storePayload(
            outputDir,
            payloadState,
            'request',
            postData,
            { base64Encoded },
          );
        } catch (error) {
          record.requestBodyError = error.message;
          captureIssues.push({
            surface: 'request-body',
            requestKey: record.key,
            error: error.message,
          });
        }
      })();
      trackCaptureWork(work);
    };
    const captureResponseBody = async (record, metadata) => {
      if (!record.response || !responseCanHaveBody(record)) return;
      const selected = exhaustiveCapture
        || bodyPatterns.some((pattern) => pattern.test(record.url || ''));
      if (!selected) return;
      try {
        const body = await client.call(
          'Network.getResponseBody',
          { requestId: record.requestId },
          { sessionId: metadata.sessionId || attached.sessionId },
        );
        if (exhaustiveCapture) {
          record.responseBody = await storePayload(
            outputDir,
            payloadState,
            'response',
            body.body,
            { base64Encoded: body.base64Encoded },
          );
        } else {
          record.response.body = body.body;
          record.response.base64Encoded = body.base64Encoded;
        }
      } catch (error) {
        if (exhaustiveCapture) {
          record.responseBodyError = error.message;
          captureIssues.push({
            surface: 'response-body',
            requestKey: record.key,
            error: error.message,
          });
        } else {
          record.response.bodyError = error.message;
        }
      }
    };
    const enableChildTarget = (event) => {
      if (!acceptCaptureEvents || !exhaustiveCapture) return;
      sessionTargets.set(event.sessionId, event.targetInfo || {});
      const work = (async () => {
        try {
          await client.call('Network.enable', {
            maxTotalBufferSize: 1_000_000_000,
            maxResourceBufferSize: 100_000_000,
            maxPostDataSize: 100_000_000,
          }, { sessionId: event.sessionId });
          await client.call(
            'Network.setCacheDisabled',
            { cacheDisabled: true },
            { sessionId: event.sessionId },
          );
          const domainCalls = [
            client.call('Runtime.enable', {}, { sessionId: event.sessionId }),
            client.call('Debugger.enable', {
              maxScriptsCacheSize: 100_000_000,
            }, { sessionId: event.sessionId }),
            client.call('Log.enable', {}, { sessionId: event.sessionId }),
            client.call('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            }, { sessionId: event.sessionId }),
          ];
          if (!String(event.targetInfo?.type || '').includes('worker')) {
            domainCalls.push(client.call('Page.enable', {}, { sessionId: event.sessionId }));
          }
          await Promise.all(domainCalls);
        } catch (error) {
          captureIssues.push({
            surface: 'child-target',
            targetId: event.targetInfo?.targetId,
            targetType: event.targetInfo?.type,
            error: error.message,
          });
        } finally {
          if (event.waitingForDebugger) {
            try {
              await client.call(
                'Runtime.runIfWaitingForDebugger',
                {},
                { sessionId: event.sessionId },
              );
            } catch (error) {
              captureIssues.push({
                surface: 'child-target-resume',
                targetId: event.targetInfo?.targetId,
                targetType: event.targetInfo?.type,
                error: error.message,
              });
            }
          }
        }
      })();
      trackCaptureWork(work);
    };

    client.on('Target.attachedToTarget', enableChildTarget);
    client.on('Network.requestWillBeSent', (event, metadata) => {
      if (!acceptCaptureEvents) return;
      const key = requestKey(event.requestId, metadata);
      if (event.redirectResponse) {
        const previous = requests.get(key);
        if (previous) {
          previous.response = exhaustiveCapture
            ? event.redirectResponse
            : {
              status: event.redirectResponse.status,
              statusText: event.redirectResponse.statusText,
              mimeType: event.redirectResponse.mimeType,
              protocol: event.redirectResponse.protocol,
              fromDiskCache: event.redirectResponse.fromDiskCache,
              fromServiceWorker: event.redirectResponse.fromServiceWorker,
            };
          previous.redirectedTo = event.request.url;
            if (exhaustiveCapture) previous.completedAt = new Date().toISOString();
          network.push(previous);
          requests.delete(key);
        }
      }
      const record = {
        requestId: event.requestId,
        timestamp: event.timestamp,
        wallTime: event.wallTime,
        type: event.type,
        method: event.request.method,
        url: event.request.url,
        postData: event.request.postData,
        initiator: event.initiator,
      };
      if (exhaustiveCapture) {
        Object.assign(record, {
          key: `${key}:${++requestSequence}`,
          sessionId: metadata.sessionId || attached.sessionId,
          requestCdpSequence: metadata.cdpSequence,
          documentURL: event.documentURL,
          frameId: event.frameId,
          loaderId: event.loaderId,
          request: event.request,
        });
      }
      requests.set(key, record);
      captureRequestBody(record, metadata);
    });
    client.on('Network.requestWillBeSentExtraInfo', (event, metadata) => {
      if (!acceptCaptureEvents || !exhaustiveCapture) return;
      networkExtraInfo.push({
        type: 'request',
        sessionId: metadata.sessionId || attached.sessionId,
        requestId: event.requestId,
        cdpSequence: metadata.cdpSequence,
        event,
      });
    });
    client.on('Network.responseReceivedExtraInfo', (event, metadata) => {
      if (!acceptCaptureEvents || !exhaustiveCapture) return;
      networkExtraInfo.push({
        type: 'response',
        sessionId: metadata.sessionId || attached.sessionId,
        requestId: event.requestId,
        cdpSequence: metadata.cdpSequence,
        event,
      });
    });
    client.on('Network.responseReceived', (event, metadata) => {
      if (!acceptCaptureEvents) return;
      const resolved = resolveOpenRequest(event.requestId, metadata);
      const key = resolved.key;
      const record = resolved.record || {
        requestId: event.requestId,
        url: event.response.url,
      };
      if (exhaustiveCapture) {
        record.key ||= `${key}:${++requestSequence}`;
        record.method ||= '';
        record.sessionId ||= metadata.sessionId || attached.sessionId;
        record.responseSessionId = metadata.sessionId || attached.sessionId;
        record.responseCdpSequence = metadata.cdpSequence;
        record.response = event.response;
      } else {
        record.response = {
          status: event.response.status,
          statusText: event.response.statusText,
          mimeType: event.response.mimeType,
          protocol: event.response.protocol,
          fromDiskCache: event.response.fromDiskCache,
          fromServiceWorker: event.response.fromServiceWorker,
        };
      }
      if (exhaustiveCapture) record.responseTimestamp = event.timestamp;
      requests.set(key, record);
    });
    client.on('Network.loadingFailed', (event, metadata) => {
      if (!acceptCaptureEvents) return;
      const resolved = resolveOpenRequest(event.requestId, metadata);
      const key = resolved.key;
      const record = resolved.record || {
        requestId: event.requestId,
      };
      record.failure = exhaustiveCapture
        ? {
          ...event,
          cdpSequence: metadata.cdpSequence,
          sessionId: metadata.sessionId || attached.sessionId,
        }
        : {
          errorText: event.errorText,
          canceled: event.canceled,
          blockedReason: event.blockedReason,
        };
      if (exhaustiveCapture) {
        record.key ||= `${key}:${++requestSequence}`;
        if (record.response) {
          record.transferIncomplete = true;
          captureIssues.push({
            surface: 'response-transfer',
            requestKey: record.key,
            method: record.method,
            url: record.url,
            status: record.response.status,
            error: event.errorText || 'response transfer failed after headers',
          });
        }
        record.completedAt = new Date().toISOString();
        network.push(record);
        requests.delete(key);
      } else {
        requests.set(key, record);
      }
    });
    client.on('Network.loadingFinished', (event, metadata) => {
      if (!acceptCaptureEvents) return;
      const resolved = resolveOpenRequest(event.requestId, metadata);
      const key = resolved.key;
      const work = (async () => {
        const record = resolved.record || requests.get(key);
        if (!record) return;
        if (exhaustiveCapture) record.loadingFinished = event;
        await captureResponseBody(record, metadata);
        if (exhaustiveCapture) record.completedAt = new Date().toISOString();
        network.push(record);
        requests.delete(key);
      })();
      trackCaptureWork(work);
    });
    client.on('Debugger.scriptParsed', (event, metadata) => {
      if (!acceptCaptureEvents) return;
      const script = {
        sequence: ++scriptSequence,
        sessionId: metadata.sessionId || attached.sessionId,
        ...event,
      };
      scripts.push(script);
      if (!exhaustiveCapture) return;
      const work = (async () => {
        try {
          const source = await client.call(
            'Debugger.getScriptSource',
            { scriptId: event.scriptId },
            { sessionId: metadata.sessionId || attached.sessionId },
          );
          const base64Encoded = typeof source.bytecode === 'string';
          const value = base64Encoded ? source.bytecode : source.scriptSource || '';
          const buffer = base64Encoded
            ? Buffer.from(value, 'base64')
            : Buffer.from(value, 'utf8');
          const digest = sha256(buffer);
          const filename = `${String(script.sequence).padStart(6, '0')}-${digest.slice(0, 16)}${
            base64Encoded ? '.wasm' : '.js'
          }`;
          const relativePath = path.join('scripts', filename);
          await atomicWrite(path.join(outputDir, relativePath), buffer);
          script.source = {
            artifact: relativePath,
            bytes: buffer.length,
            sha256: digest,
            cdpBase64Encoded: base64Encoded,
          };
        } catch (error) {
          script.sourceError = error.message;
          captureIssues.push({
            surface: 'script-source',
            scriptId: event.scriptId,
            url: event.url,
            error: error.message,
          });
        }
      })();
      trackCaptureWork(work);
    });
    collectSourceMaps = async () => {
      if (!exhaustiveCapture || !captureAdvertisedSourceMaps) return;
      const collectionDeadline = Date.now() + 60_000;
      const grouped = new Map();
      for (const script of scripts.filter((item) => item.sourceMapURL)) {
        let resolved;
        try {
          const classification = classifySourceMapReference(script);
          if (classification.result) {
            script.sourceMapResult = classification.result;
            continue;
          }
          resolved = classification.resolvedURL;
          script.sourceMapResolvedURL = resolved;
        } catch (error) {
          script.sourceMapError = error.message;
          captureIssues.push({
            surface: 'source-map',
            scriptId: script.scriptId,
            url: script.url,
            sourceMapURL: script.sourceMapURL,
            error: error.message,
          });
          continue;
        }
        const key = `${script.sessionId}\0${resolved}`;
        const group = grouped.get(key) || {
          sessionId: script.sessionId,
          sourceMapUrl: resolved,
          scripts: [],
        };
        group.scripts.push(script);
        grouped.set(key, group);
      }
      let sourceMapSequence = 0;
      for (const group of grouped.values()) {
        const { sessionId, sourceMapUrl, scripts: matchingScripts } = group;
        const attemptedAt = new Date().toISOString();
        const sourceMapAttemptId = `${sessionId}:${attemptedAt}:${sourceMapUrl}`;
        try {
          const mapDeadline = Math.min(collectionDeadline, Date.now() + 15_000);
          const remaining = () => mapDeadline - Date.now();
          if (remaining() <= 0) throw new Error('source-map collection deadline reached');
          let buffer;
          let httpStatusCode = null;
          if (sourceMapUrl.startsWith('data:')) {
            const separator = sourceMapUrl.indexOf(',');
            if (separator === -1) throw new Error('malformed data URL source map');
            const metadata = sourceMapUrl.slice(5, separator);
            const payload = sourceMapUrl.slice(separator + 1);
            buffer = metadata.split(';').includes('base64')
              ? Buffer.from(payload, 'base64')
              : Buffer.from(decodeURIComponent(payload), 'utf8');
          } else {
            const targetInfo = sessionTargets.get(sessionId) || {};
            const workerTarget = String(targetInfo.type || '').includes('worker')
              || String(targetInfo.type || '').includes('worklet');
            if (workerTarget) {
              const loaded = await withTimeout(client.call('Runtime.evaluate', {
                expression: `(async () => {
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), 10000);
                  try {
                    const response = await fetch(${JSON.stringify(sourceMapUrl)}, {
                      credentials: "include",
                      cache: "no-store",
                      signal: controller.signal,
                    });
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    let binary = "";
                    for (let offset = 0; offset < bytes.length; offset += 32768) {
                      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                    }
                    return {
                      ok: response.ok,
                      status: response.status,
                      body: btoa(binary),
                    };
                  } finally {
                    clearTimeout(timer);
                  }
                })()`,
                awaitPromise: true,
                returnByValue: true,
              }, { sessionId }), remaining(), 'worker source-map fetch');
              if (loaded.exceptionDetails) {
                throw new Error(
                  loaded.exceptionDetails.exception?.description
                  || loaded.exceptionDetails.text
                  || 'worker source-map fetch failed',
                );
              }
              const resource = loaded.result?.value;
              httpStatusCode = resource?.status ?? null;
              if (!resource?.ok || typeof resource.body !== 'string') {
                throw new Error(
                  `worker source-map load failed with HTTP ${httpStatusCode ?? 'unknown'}`,
                );
              }
              buffer = Buffer.from(resource.body, 'base64');
            } else {
              const frameTree = await withTimeout(client.call(
                'Page.getFrameTree',
                {},
                { sessionId },
              ), remaining(), 'source-map frame lookup');
              const frameId = frameTree.frameTree?.frame?.id;
              if (!frameId) throw new Error('source-map target has no frame ID');
              const loaded = await withTimeout(client.call(
                'Network.loadNetworkResource',
                {
                  frameId,
                  url: sourceMapUrl,
                  options: {
                    disableCache: true,
                    includeCredentials: true,
                  },
                },
                { sessionId },
              ), remaining(), 'source-map resource load');
              const resource = loaded.resource || {};
              httpStatusCode = resource.httpStatusCode ?? null;
              if (
                Number.isFinite(httpStatusCode)
                && (httpStatusCode < 200 || httpStatusCode >= 300)
              ) {
                throw new Error(`source-map load failed with HTTP ${httpStatusCode}`);
              }
              if (!resource.success || !resource.stream) {
                throw new Error(
                  resource.netErrorName
                  || `source-map load failed with HTTP ${httpStatusCode ?? 'unknown'}`,
                );
              }
              const chunks = [];
              try {
                while (true) {
                  const chunk = await withTimeout(client.call(
                    'IO.read',
                    { handle: resource.stream },
                    { sessionId },
                  ), remaining(), 'source-map stream read');
                  chunks.push(chunk.base64Encoded
                    ? Buffer.from(chunk.data || '', 'base64')
                    : Buffer.from(chunk.data || '', 'utf8'));
                  if (chunk.eof) break;
                }
              } finally {
                await withTimeout(client.call(
                  'IO.close',
                  { handle: resource.stream },
                  { sessionId },
                ), Math.max(1, Math.min(1_000, remaining())), 'source-map stream close');
              }
              buffer = Buffer.concat(chunks);
            }
          }
          const digest = sha256(buffer);
          const filename = `${String(++sourceMapSequence).padStart(6, '0')}-${
            digest.slice(0, 16)
          }.map`;
          const relativePath = path.join('source-maps', filename);
          await atomicWrite(path.join(outputDir, relativePath), buffer);
          const sourceMap = {
            url: sourceMapUrl,
            sessionId,
            targetType: sessionTargets.get(sessionId)?.type || null,
            artifact: relativePath,
            bytes: buffer.length,
            sha256: digest,
            httpStatusCode,
          };
          for (const script of matchingScripts) script.sourceMap = sourceMap;
        } catch (error) {
          const finishedAt = new Date().toISOString();
          for (const script of matchingScripts) {
            script.sourceMapError = error.message;
            script.sourceMapAttempt = {
              id: sourceMapAttemptId,
              startedAt: attemptedAt,
              finishedAt,
              error: error.message,
            };
          }
          captureIssues.push({
            surface: 'source-map',
            sourceMapAttemptId,
            sourceMapURL: sourceMapUrl,
            error: error.message,
          });
        }
      }
    };

    const domainEnables = [
      client.call('Page.enable'),
      client.call('Runtime.enable'),
      client.call('Network.enable', {
        maxTotalBufferSize: 1_000_000_000,
        maxResourceBufferSize: 100_000_000,
        maxPostDataSize: 100_000_000,
      }),
    ];
    if (exhaustiveCapture) {
      await client.call(
        'Target.setDiscoverTargets',
        { discover: true },
        { browserCommand: true },
      );
      domainEnables.push(
        client.call('Debugger.enable', {
        maxScriptsCacheSize: 100_000_000,
        }),
        client.call('Log.enable'),
        client.call('Performance.enable'),
        client.call('Security.enable'),
        client.call('ServiceWorker.enable'),
        client.call('DOM.enable'),
        client.call('Accessibility.enable'),
        client.call('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }),
      );
    }
    await Promise.all(domainEnables);
    if (exhaustiveCapture) {
      await client.call('Network.setCacheDisabled', { cacheDisabled: true });
    }
    captureInitialized = true;

    if (cookieJar) {
      cookieSource = parseCookieSource(
        await fsp.readFile(cookieJar, 'utf8'),
        cookieDomain,
      );
      await client.call('Network.setCookies', { cookies: cookieSource.cookies });
    }

    const artifactPath = (name) => {
      if (!name || path.basename(name) !== name) {
        throw new Error(`artifact name must be a flat filename: ${name}`);
      }
      const resolved = path.resolve(outputDir, name);
      if (resolved !== outputDir && !resolved.startsWith(`${outputDir}${path.sep}`)) {
        throw new Error(`artifact path escapes output directory: ${name}`);
      }
      return resolved;
    };
    const captureCheckpoint = async (name) => {
      if (!exhaustiveCapture) {
        throw new Error('checkpoints require captureMode="exhaustive"');
      }
      let safeName;
      try {
        safeName = safeCheckpointName(name);
      } catch (error) {
        captureIssues.push({
          surface: 'checkpoint',
          name,
          error: error.message,
        });
        throw error;
      }
      if (checkpointNames.has(safeName)) {
        const error = new Error(`checkpoint name already used: ${safeName}`);
        captureIssues.push({
          surface: 'checkpoint',
          name: safeName,
          error: error.message,
        });
        throw error;
      }
      checkpointNames.add(safeName);
      const observedAt = new Date().toISOString();
      const attempt = {
        name: safeName,
        observedAt,
        status: 'started',
      };
      checkpoints.push(attempt);
      try {
        const pageStateExpression = `(async () => {
        const capture = async operation => {
          try {
            return { ok: true, value: await operation() };
          } catch (error) {
            return {
              ok: false,
              error: {
                name: error?.name || "Error",
                message: error?.message || String(error),
              },
            };
          }
        };
        const storage = source => {
          const result = {};
          for (let index = 0; index < source.length; index += 1) {
            const key = source.key(index);
            result[key] = source.getItem(key);
          }
          return result;
        };
        return {
          observedAt: new Date().toISOString(),
          href: location.href,
          origin: location.origin,
          title: document.title,
          readyState: document.readyState,
          html: document.documentElement?.outerHTML || "",
          documentCookie: await capture(() => document.cookie),
          localStorage: await capture(() => storage(localStorage)),
          sessionStorage: await capture(() => storage(sessionStorage)),
          indexedDatabases: await capture(() =>
            typeof indexedDB.databases === "function" ? indexedDB.databases() : []
          ),
          cacheNames: await capture(() =>
            "caches" in globalThis ? caches.keys() : []
          ),
          scripts: [...document.scripts].map(script => ({
            src: script.src,
            type: script.type,
            integrity: script.integrity,
            crossOrigin: script.crossOrigin,
            text: script.src ? "" : script.textContent,
          })),
          stylesheets: [...document.styleSheets].map(sheet => ({
            href: sheet.href,
            disabled: sheet.disabled,
            media: sheet.media?.mediaText || "",
          })),
          forms: [...document.forms].map(form => ({
            action: form.action,
            method: form.method,
            elements: [...form.elements].map(element => ({
              tag: element.tagName,
              type: element.type,
              name: element.name,
              value: element.value,
              checked: element.checked,
              disabled: element.disabled,
              required: element.required,
              validity: element.validity ? {
                valid: element.validity.valid,
                valueMissing: element.validity.valueMissing,
                typeMismatch: element.validity.typeMismatch,
                patternMismatch: element.validity.patternMismatch,
                customError: element.validity.customError,
              } : null,
              validationMessage: element.validationMessage,
            })),
          })),
          performanceEntries: performance.getEntries().map(entry =>
            typeof entry.toJSON === "function" ? entry.toJSON() : {
              name: entry.name,
              entryType: entry.entryType,
              startTime: entry.startTime,
              duration: entry.duration,
            }
          ),
        };
      })()`;
      const [
        frameTree,
        navigationHistory,
        resourceTree,
        domSnapshot,
        accessibilityTree,
        performanceMetrics,
        cookies,
        pageState,
        mhtml,
      ] = await Promise.all([
        client.call('Page.getFrameTree'),
        client.call('Page.getNavigationHistory'),
        client.call('Page.getResourceTree'),
        client.call('DOMSnapshot.captureSnapshot', {
          computedStyles: [],
          includePaintOrder: true,
          includeDOMRects: true,
          includeBlendedBackgroundColors: true,
        }),
        client.call('Accessibility.getFullAXTree'),
        client.call('Performance.getMetrics'),
        client.call('Network.getAllCookies'),
        evaluate(client, pageStateExpression),
        client.call('Page.captureSnapshot', { format: 'mhtml' }),
      ]);
      const mhtmlBuffer = Buffer.from(mhtml.data || '', 'utf8');
      const mhtmlRelativePath = path.join('checkpoints', `${safeName}.mhtml`);
      await atomicWrite(path.join(outputDir, mhtmlRelativePath), mhtmlBuffer);
      const checkpoint = {
        name: safeName,
        observedAt,
        frameTree,
        navigationHistory,
        resourceTree,
        domSnapshot,
        accessibilityTree,
        performanceMetrics,
        cookies,
        pageState,
        mhtml: {
          artifact: mhtmlRelativePath,
          bytes: mhtmlBuffer.length,
          sha256: sha256(mhtmlBuffer),
        },
      };
      const relativePath = path.join('checkpoints', `${safeName}.json`);
      await atomicWrite(
        path.join(outputDir, relativePath),
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      );
      Object.assign(attempt, {
        status: 'captured',
        artifact: relativePath,
        mhtml: checkpoint.mhtml,
      });
      return checkpoint;
      } catch (error) {
        Object.assign(attempt, {
          status: 'failed',
          error: error.message,
        });
        captureIssues.push({
          surface: 'checkpoint',
          name: safeName,
          error: error.message,
        });
        throw error;
      }
    };
    const context = {
      apiVersion: SUBSCRIBER_API,
      subscriberPath,
      outputDir,
      captureMode,
      network,
      requests,
      delay,
      cdp: (method, params = {}) => client.call(method, params),
      evaluate: (expression, awaitPromise = true) => evaluate(client, expression, awaitPromise),
      waitFor: (expression, timeoutMs, description) => (
        waitForExpression(client, expression, timeoutMs, description)
      ),
      click: (expression, description) => physicalClick(client, expression, description),
      pressKey: (key, code, virtualKeyCode) => pressKey(client, key, code, virtualKeyCode),
      pressTab: () => pressKey(client, 'Tab', 'Tab', 9),
      markAuthenticated: () => { authenticated = true; },
      checkpoint: captureCheckpoint,
      artifactPath,
      writeArtifact: async (name, value) => {
        const payload = Buffer.isBuffer(value)
          ? value
          : typeof value === 'string'
            ? value
            : `${JSON.stringify(value, null, 2)}\n`;
        await atomicWrite(artifactPath(name), payload);
      },
      navigate: async (url, waitOptions = {}) => {
        await client.call('Page.navigate', { url });
        await waitForExpression(
          client,
          'document.readyState === "complete"',
          waitOptions.timeoutMs || 60_000,
          waitOptions.description || 'document readiness',
        );
        if (waitOptions.expression) {
          await waitForExpression(
            client,
            waitOptions.expression,
            waitOptions.timeoutMs || 60_000,
            waitOptions.description || 'navigation condition',
          );
        }
      },
      screenshot: async (name = 'page.png', options = {}) => {
        const screenshot = await client.call('Page.captureScreenshot', {
          format: options.format || 'png',
          captureBeyondViewport: options.captureBeyondViewport !== false,
          fromSurface: true,
        });
        await atomicWrite(
          artifactPath(name),
          Buffer.from(screenshot.data, 'base64'),
        );
      },
    };

    const result = await subscriber.run(context, configured.subscriberConfig ?? configured);
    await context.writeArtifact('result.json', {
      ok: true,
      subscriber: subscriberPath,
      result: result ?? null,
    });
    return { outputDir, result };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const rememberCleanupError = (error) => {
      if (!primaryError && !cleanupError) cleanupError = error;
      else console.error(`headless capture warning: ${error.message}`);
    };
    const drainCaptureWork = async (phase, timeoutMs, reportTimeout) => {
      const deadline = Date.now() + timeoutMs;
      while (pendingCaptureWork.size && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        await Promise.race([
          Promise.allSettled([...pendingCaptureWork]),
          delay(Math.min(250, remaining)),
        ]);
      }
      if (!pendingCaptureWork.size) return true;
      if (reportTimeout) {
        const error = new Error(
          `${phase} timed out with ${pendingCaptureWork.size} capture operations pending`,
        );
        if (exhaustiveCapture) {
          captureIssues.push({
            surface: 'capture-drain',
            phase,
            pending: pendingCaptureWork.size,
            error: error.message,
          });
        }
        rememberCleanupError(error);
      }
      return false;
    };
    if (client) {
      await drainCaptureWork('pre-boundary settle', 5_000, false);
      try {
        await collectSourceMaps();
      } catch (error) {
        captureIssues.push({
          surface: 'source-map-collection',
          error: error.message,
        });
      }
      await drainCaptureWork('source-map settle', 5_000, false);
      if (authenticated && cookieJar && cookieSource && cookieExport) {
        try {
          const result = await client.call('Network.getAllCookies');
          const allowedDomains = [...new Set(cookieSource.cookies.map((cookie) => cookie.domain))];
          const cookies = result.cookies
            .filter((cookie) => cookieDomainAllowed(cookie.domain, allowedDomains))
            .sort((left, right) => (
              `${left.domain}\t${left.path}\t${left.name}`
                .localeCompare(`${right.domain}\t${right.path}\t${right.name}`)
            ));
          for (const requiredName of requiredCookieNames) {
            if (!cookies.some((cookie) => cookie.name === requiredName)) {
              throw new Error(`refusing cookie export without required cookie: ${requiredName}`);
            }
          }
          await atomicWrite(cookieJar, serializeCookies(cookieSource.format, cookies));
        } catch (error) {
          if (exhaustiveCapture) {
            captureIssues.push({
              surface: 'cookie-export',
              error: error.message,
            });
          }
          rememberCleanupError(error);
        }
      }
      if (primaryTargetId) {
        try {
          const closed = await withTimeout(client.call(
            'Target.closeTarget',
            { targetId: primaryTargetId },
            { browserCommand: true },
          ), 5_000, 'capture target close');
          if (closed.success !== true) {
            throw new Error('capture target close returned success=false');
          }
          await delay(250);
        } catch (error) {
          if (exhaustiveCapture) {
            captureIssues.push({
              surface: 'capture-boundary',
              targetId: primaryTargetId,
              error: error.message,
            });
          }
          rememberCleanupError(error);
        }
      }
      await drainCaptureWork('post-boundary settle', 15_000, true);
      acceptCaptureEvents = false;
      client.close();
      await drainCaptureWork('post-client-close settle', 2_000, true);
    }
    try {
      await stopProcess(browser);
    } catch (error) {
      captureIssues.push({
        surface: 'browser-shutdown',
        error: error.message,
      });
      rememberCleanupError(error);
    }
    if (!stderrClosed) {
      fs.closeSync(stderrFd);
      stderrClosed = true;
    }
    if (client) {
      for (const record of requests.values()) {
        record.captureEndedWhileOpen = true;
        network.push(record);
      }
      requests.clear();
    }
    if (proxy) {
      try {
        proxySummary = await finalizeProxyCapture(
          proxy,
          configured.proxyShutdownTimeoutMs || 15_000,
        );
        const harDocument = JSON.parse(await fsp.readFile(proxy.paths.harPath, 'utf8'));
        const harEntries = proxyHarEntries(harDocument);
        const exactEntries = await proxyExactEntries(
          proxy.paths.exactDir,
          proxySummary.exactCapture,
        );
        proxyReconciliation = {
          network: await reconcileNetworkWithProxyHar(
            outputDir,
            payloadState,
            network,
            harEntries,
            exactEntries,
            captureIssues,
          ),
          sourceMaps: await reconcileSourceMapsWithProxyHar(
            outputDir,
            payloadState,
            scripts,
            harEntries,
            exactEntries,
            captureIssues,
          ),
        };
      } catch (error) {
        captureIssues.push({
          surface: 'proxy-finalization',
          error: error.message,
        });
        rememberCleanupError(error);
      } finally {
        restoreProxyTerminationHandlers();
      }
    }
    try {
      await atomicWrite(
        path.join(outputDir, 'network.json'),
        `${JSON.stringify(network, null, 2)}\n`,
      );
      if (exhaustiveCapture) {
        await Promise.all([
          atomicWrite(
            path.join(outputDir, 'network-extra-info.json'),
            `${JSON.stringify(networkExtraInfo, null, 2)}\n`,
          ),
          atomicWrite(
            path.join(outputDir, 'scripts', 'index.json'),
            `${JSON.stringify(scripts, null, 2)}\n`,
          ),
        ]);
      }
    } catch (error) {
      captureIssues.push({
        surface: 'artifact-finalization',
        artifact: 'capture indexes',
        error: error.message,
      });
      rememberCleanupError(error);
    }
    if (journal) {
      try {
        journalSummary = journal.close();
      } catch (error) {
        captureIssues.push({
          surface: 'cdp-journal',
          error: error.message,
        });
        rememberCleanupError(error);
      }
    }
    if (exhaustiveCapture) {
      try {
        const responseBodyGaps = network
          .filter((record) => (
            record.response
            && responseCanHaveBody(record)
            && !record.responseBody
          ))
          .map((record) => ({
            key: record.key,
            method: record.method,
            url: record.url,
            status: record.response?.status,
            error: record.responseBodyError || 'response body was not captured',
          }));
        const requestBodyGaps = network
          .filter((record) => (
            record.request?.hasPostData
            && !record.requestBody
          ))
          .map((record) => ({
            key: record.key,
            method: record.method,
            url: record.url,
            error: record.requestBodyError || 'request body was not captured',
          }));
        const redirectBodyGaps = network
          .filter((record) => redirectCanHaveBody(record) && !record.redirectResponseBody)
          .map((record) => ({
            key: record.key,
            method: record.method,
            url: record.url,
            status: record.response?.status,
            redirectedTo: record.redirectedTo,
            error: 'CDP reuses the request ID before exposing the redirect response body',
          }));
        const scriptSourceGaps = scripts
          .filter((script) => !script.source)
          .map((script) => ({
            sessionId: script.sessionId,
            scriptId: script.scriptId,
            url: script.url,
            error: script.sourceError || 'script source was not captured',
          }));
        const sourceMapGaps = captureAdvertisedSourceMaps
          ? scripts
            .filter((script) => (
              script.sourceMapURL
              && !script.sourceMap
              && !script.sourceMapResult
            ))
            .map((script) => ({
              sessionId: script.sessionId,
              scriptId: script.scriptId,
              url: script.url,
              sourceMapURL: script.sourceMapURL,
              error: script.sourceMapError || 'advertised source map was not captured',
            }))
          : [];
        const openRequests = network
          .filter((record) => record.captureEndedWhileOpen)
          .map((record) => ({
            key: record.key,
            method: record.method,
            url: record.url,
          }));
        const failedTransfers = network
          .filter((record) => (
            record.failure
            && record.response
            && record.proxyCompletion?.completed !== true
          ))
          .map((record) => ({
            key: record.key,
            method: record.method,
            url: record.url,
            status: record.response.status,
            failure: record.failure,
            proxyTransfer: record.proxyTransfer || null,
          }));
        const unresolvedIssues = captureIssues.filter((issue) => !issue.resolved);
        const resolvedIssues = captureIssues.filter((issue) => issue.resolved);
        const complete = captureInitialized
          && !primaryError
          && Boolean(journalSummary?.messages)
          && (!captureProxyTraffic || Boolean(proxySummary && proxyReconciliation))
          && unresolvedIssues.length === 0
          && responseBodyGaps.length === 0
          && requestBodyGaps.length === 0
          && redirectBodyGaps.length === 0
          && scriptSourceGaps.length === 0
          && sourceMapGaps.length === 0
          && openRequests.length === 0
          && failedTransfers.length === 0;
        const manifest = {
        apiVersion: SUBSCRIBER_API,
        mode: captureMode,
        subscriber: subscriberPath,
        startedAt: captureStartedAt,
        finishedAt: new Date().toISOString(),
        captureInitialized,
        complete,
        browser: {
          binary: browserBinary,
          version: browserVersion || null,
          disposableProfile: true,
          transport: 'remote-debugging-pipe',
          cacheDisabled: true,
        },
        proxy: captureProxyTraffic
          ? {
            ...(proxySummary || { enabled: false }),
            reconciliation: proxyReconciliation || null,
          }
          : { enabled: false },
        journal: journalSummary || null,
        network: {
          records: network.length,
          payloadArtifacts: payloadState.sequence,
          responseBodyGaps,
          requestBodyGaps,
          redirectBodyGaps,
          openAtCaptureEnd: openRequests,
          failedTransfers,
        },
        scripts: {
          parsed: scripts.length,
          sourceArtifacts: scripts.filter((script) => script.source).length,
          sourceMapArtifacts: new Set(
            scripts
              .filter((script) => script.sourceMap)
              .map((script) => script.sourceMap.artifact),
          ).size,
          sourceMapReferences: scripts
            .filter((script) => script.sourceMapURL)
            .map((script) => ({
              url: script.url,
              sourceMapURL: script.sourceMapURL,
              resolvedURL: script.sourceMapResolvedURL || null,
              result: script.sourceMap
                ? { kind: 'captured-map', ...script.sourceMap }
                : script.sourceMapResult || null,
            })),
          scriptSourceGaps,
          sourceMapGaps,
        },
        checkpoints,
        issues: unresolvedIssues,
        resolvedIssues,
        observedBoundary: {
          included: [
            'all CDP commands, responses, and events for the isolated browser sessions',
            'obtainable HTTP request and response payloads after browser protocol decoding',
            'byte-exact HTTP request and response bodies plus terminal proxy flow state',
            'loaded script sources and configured captures of advertised source maps',
            'subscriber-requested page checkpoints and browser stderr',
          ],
          excluded: [
            'raw TLS records and transport packets',
            'server-side and service-to-service activity not exposed to the browser',
          ],
        },
        runError: primaryError ? primaryError.message : null,
        };
        await atomicWrite(
          path.join(outputDir, 'capture-manifest.json'),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        if (requireCompleteCapture && !complete) {
          rememberCleanupError(new Error(
            `exhaustive capture incomplete: ${unresolvedIssues.length} unresolved issues, `
            + `${responseBodyGaps.length} response-body gaps, `
            + `${requestBodyGaps.length} request-body gaps, `
            + `${redirectBodyGaps.length} redirect-body gaps, `
            + `${scriptSourceGaps.length} script-source gaps, `
            + `${sourceMapGaps.length} source-map gaps, `
            + `${openRequests.length} open requests, `
            + `${failedTransfers.length} failed transfers; see capture-manifest.json`,
          ));
        }
      } catch (error) {
        rememberCleanupError(error);
      }
    }
    await fsp.rm(profileDir, { recursive: true, force: true });
    if (!primaryError && cleanupError) throw cleanupError;
    if (
      !primaryError &&
      browser &&
      browser.exitCode !== 0 &&
      browser.signalCode == null
    ) {
      throw new Error(`headless browser exited with code ${browser.exitCode}`);
    }
  }
}

async function cmdHeadless(argv) {
  const options = parseRuntimeArgs(argv);
  if (options.action === 'help' || options.action === '--help' || options.action === '-h') {
    console.log(headlessHelp());
    return;
  }
  if (options.action === 'contract') {
    console.log(JSON.stringify({
      apiVersion: SUBSCRIBER_API,
      configure: 'configure({ args, env, apiVersion }) -> runtime configuration',
      run: 'run(context, subscriberConfig) -> JSON-serializable result',
      context: [
        'cdp', 'evaluate', 'waitFor', 'click', 'pressKey', 'pressTab',
        'navigate', 'screenshot', 'checkpoint', 'writeArtifact',
        'markAuthenticated', 'captureMode', 'network', 'requests', 'delay',
      ],
    }, null, 2));
    return;
  }
  if (options.action !== 'run' || !options.subscriber) {
    throw new Error(headlessHelp());
  }
  const outcome = await runSubscriber(options);
  if (!outcome.skipped) console.log(outcome.outputDir);
}

module.exports = {
  SUBSCRIBER_API,
  CdpClient,
  CdpJournal,
  atomicWrite,
  buildMitmproxyArgs,
  classifySourceMapReference,
  cmdHeadless,
  computeCertificateSpkiHash,
  finalizeProxyCapture,
  headlessHelp,
  parseCookieSource,
  parseNetscapeCookieJar,
  parseRuntimeArgs,
  prepareOutputDir,
  proxyBrowserArgs,
  proxyExactEntries,
  proxyHarEntries,
  reconcileNetworkWithProxyHar,
  reconcileSourceMapsWithProxyHar,
  responseCanHaveBody,
  startProxyCapture,
  runSubscriber,
  serializeCookies,
  stopProcess,
};
