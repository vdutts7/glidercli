'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SUBSCRIBER_API = 'headless-subscriber/v1';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpClient {
  constructor(commandStream, eventStream) {
    this.commandStream = commandStream;
    this.eventStream = eventStream;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.buffer = '';
  }

  async connect() {
    const rejectPending = (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.eventStream.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let delimiter;
      while ((delimiter = this.buffer.indexOf('\0')) !== -1) {
        const raw = this.buffer.slice(0, delimiter);
        this.buffer = this.buffer.slice(delimiter + 1);
        if (!raw) continue;
        const message = JSON.parse(raw);
        this.handleMessage(message);
      }
    });
    this.eventStream.once('error', rejectPending);
    this.eventStream.once('close', () => {
      rejectPending(new Error('CDP pipe closed'));
    });
    this.commandStream.once('error', rejectPending);
  }

  handleMessage(message) {
      if (message.id) {
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
        listener(message.params || {});
      }
  }

  call(method, params = {}, options = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      const message = { id, method, params };
      const sessionId = options.browserCommand ? null : this.sessionId;
      if (sessionId) message.sessionId = sessionId;
      this.commandStream.write(`${JSON.stringify(message)}\0`);
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
  const assertTrustedAncestors = async (target) => {
    let current = path.resolve(target);
    while (true) {
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`headless output ancestor is a symlink: ${current}`);
        }
        if ((stat.mode & 0o022) !== 0) {
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

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
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

  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glider-headless-'));
  const stderrPath = path.join(outputDir, 'browser.stderr.log');
  const stderrFd = fs.openSync(stderrPath, 'wx', 0o600);
  let browser;
  let client;
  let cookieSource;
  let authenticated = false;
  let primaryError;
  let cleanupError;
  const network = [];
  const requests = new Map();
  const pendingBodyReads = new Set();
  try {
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
      ...(configured.browserArgs || []),
    ], {
      detached: false,
      stdio: ['ignore', 'ignore', stderrFd, 'pipe', 'pipe'],
    });
    let spawnError;
    browser.once('error', (error) => { spawnError = error; });
    client = new CdpClient(browser.stdio[3], browser.stdio[4]);
    await client.connect();
    await delay(0);
    if (spawnError) throw spawnError;
    const target = await client.call(
      'Target.createTarget',
      { url: 'about:blank' },
      { browserCommand: true },
    );
    const attached = await client.call(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { browserCommand: true },
    );
    client.useSession(attached.sessionId);
    await Promise.all([
      client.call('Page.enable'),
      client.call('Runtime.enable'),
      client.call('Network.enable', {
        maxTotalBufferSize: 100_000_000,
        maxResourceBufferSize: 10_000_000,
        maxPostDataSize: 10_000_000,
      }),
    ]);

    client.on('Network.requestWillBeSent', (event) => {
      if (event.redirectResponse) {
        const previous = requests.get(event.requestId);
        if (previous) {
          previous.response = {
            status: event.redirectResponse.status,
            statusText: event.redirectResponse.statusText,
            mimeType: event.redirectResponse.mimeType,
            protocol: event.redirectResponse.protocol,
            fromDiskCache: event.redirectResponse.fromDiskCache,
            fromServiceWorker: event.redirectResponse.fromServiceWorker,
          };
          previous.redirectedTo = event.request.url;
          network.push(previous);
          requests.delete(event.requestId);
        }
      }
      requests.set(event.requestId, {
        requestId: event.requestId,
        timestamp: event.timestamp,
        wallTime: event.wallTime,
        type: event.type,
        method: event.request.method,
        url: event.request.url,
        postData: event.request.postData,
        initiator: event.initiator,
      });
    });
    client.on('Network.responseReceived', (event) => {
      const record = requests.get(event.requestId) || {
        requestId: event.requestId,
        url: event.response.url,
      };
      record.response = {
        status: event.response.status,
        statusText: event.response.statusText,
        mimeType: event.response.mimeType,
        protocol: event.response.protocol,
        fromDiskCache: event.response.fromDiskCache,
        fromServiceWorker: event.response.fromServiceWorker,
      };
      requests.set(event.requestId, record);
    });
    client.on('Network.loadingFailed', (event) => {
      const record = requests.get(event.requestId) || { requestId: event.requestId };
      record.failure = {
        errorText: event.errorText,
        canceled: event.canceled,
        blockedReason: event.blockedReason,
      };
      requests.set(event.requestId, record);
    });
    client.on('Network.loadingFinished', (event) => {
      const work = (async () => {
        const record = requests.get(event.requestId);
        if (!record) return;
        if (record.response && bodyPatterns.some((pattern) => pattern.test(record.url || ''))) {
          try {
            const body = await client.call('Network.getResponseBody', {
              requestId: event.requestId,
            });
            record.response.body = body.body;
            record.response.base64Encoded = body.base64Encoded;
          } catch (error) {
            record.response.bodyError = error.message;
          }
        }
        network.push(record);
        requests.delete(event.requestId);
      })();
      pendingBodyReads.add(work);
      work.finally(() => pendingBodyReads.delete(work));
    });

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
    const context = {
      apiVersion: SUBSCRIBER_API,
      subscriberPath,
      outputDir,
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
    if (client) {
      await Promise.allSettled([...pendingBodyReads]);
      for (const record of requests.values()) network.push(record);
      try {
        await atomicWrite(
          path.join(outputDir, 'network.json'),
          `${JSON.stringify(network, null, 2)}\n`,
        );
      } catch (error) {
        if (!primaryError) cleanupError = error;
        else console.error(`headless capture warning: ${error.message}`);
      }
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
          if (!primaryError) cleanupError = error;
          else console.error(`headless cookie export warning: ${error.message}`);
        }
      }
      client.close();
    }
    await stopProcess(browser);
    fs.closeSync(stderrFd);
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
        'navigate', 'screenshot', 'writeArtifact', 'markAuthenticated',
        'network', 'requests', 'delay',
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
  atomicWrite,
  cmdHeadless,
  headlessHelp,
  parseCookieSource,
  parseNetscapeCookieJar,
  parseRuntimeArgs,
  prepareOutputDir,
  runSubscriber,
  serializeCookies,
  stopProcess,
};
