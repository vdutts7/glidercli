'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const tls = require('node:tls');
const test = require('node:test');
const {
  SUBSCRIBER_API,
  CdpClient,
  CdpJournal,
  buildMitmproxyArgs,
  classifySourceMapReference,
  computeCertificateSpkiHash,
  finalizeProxyCapture,
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
  serializeCookies,
  stopProcess,
} = require('../lib/headless-runtime.js');
const { jsonFromStdout, runCli } = require('./helpers.js');

test('headless subscriber contract is relay-independent', async () => {
  const result = await runCli(
    ['headless', 'contract'],
    { env: { GLIDER_PORT: 'invalid' } },
  );
  assert.equal(result.code, 0, result.stderr);
  const contract = jsonFromStdout(result.stdout);
  assert.equal(contract.apiVersion, SUBSCRIBER_API);
  assert.match(contract.run, /run\(context/);
  assert.ok(contract.context.includes('markAuthenticated'));
  assert.ok(contract.context.includes('checkpoint'));
  assert.ok(contract.context.includes('captureMode'));
});

test('headless runtime arguments separate subscriber arguments', () => {
  const parsed = parseRuntimeArgs([
    'run',
    '/tmp/subscriber.mjs',
    '--out',
    '/tmp/output',
    '--no-cookie-export',
    '--',
    'submit',
    '--job-id',
    '123',
  ]);
  assert.equal(parsed.action, 'run');
  assert.equal(parsed.subscriber, '/tmp/subscriber.mjs');
  assert.equal(parsed.outputDir, '/tmp/output');
  assert.equal(parsed.cookieExport, false);
  assert.deepEqual(parsed.subscriberArgs, ['submit', '--job-id', '123']);
  assert.throws(
    () => parseRuntimeArgs([
      'run',
      '/tmp/subscriber.mjs',
      '--out',
      '--no-cookie-export',
      '--',
      'inspect',
    ]),
    /--out requires a value/,
  );
});

test('headless runtime uses an isolated CDP pipe, not a TCP debug port', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'headless-runtime.js'),
    'utf8',
  );
  assert.match(source, /--remote-debugging-pipe/);
  assert.doesNotMatch(source, /--remote-debugging-port/);
  assert.doesNotMatch(source, /--remote-debugging-address/);
});

test('CDP journal preserves every protocol frame with a digest', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-cdp-journal-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const journal = new CdpJournal(output);
  const outgoing = '{"id":1,"method":"Runtime.enable","params":{}}';
  const incoming = '{"id":1,"result":{}}';
  journal.record('out', outgoing);
  journal.record('in', incoming);
  const summary = journal.close();
  assert.equal(summary.messages, 2);
  assert.deepEqual(summary.directions, { in: 1, out: 1 });
  assert.equal(summary.methods['Runtime.enable'], 1);
  assert.equal(summary.methods.response, 1);
  assert.match(summary.sha256, /^[a-f0-9]{64}$/);
  const rows = fs.readFileSync(path.join(output, summary.artifact), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.raw), [outgoing, incoming]);
  assert.deepEqual(rows.map((row) => row.sequence), [1, 2]);
});

test('CDP pipe preserves UTF-8 characters split across chunks', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-cdp-utf8-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const commands = new PassThrough();
  const events = new PassThrough();
  const journal = new CdpJournal(output);
  const client = new CdpClient(commands, events, journal);
  await client.connect();
  let observed;
  client.on('Runtime.consoleAPICalled', (event) => {
    observed = event.text;
  });
  const frame = Buffer.from(JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { text: 'A😀B' },
  }));
  const emoji = Buffer.from('😀');
  const split = frame.indexOf(emoji) + 2;
  events.write(frame.subarray(0, split));
  events.write(Buffer.concat([frame.subarray(split), Buffer.from([0])]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed, 'A😀B');
  client.close();
  journal.close();
});

test('CDP journal failures reject active and future protocol calls', async () => {
  const commands = new PassThrough();
  const events = new PassThrough();
  const journal = {
    record(direction) {
      if (direction === 'in') throw new Error('journal storage failed');
      return 1;
    },
  };
  const client = new CdpClient(commands, events, journal);
  await client.connect();
  const pending = client.call('Runtime.enable');
  events.write(`${JSON.stringify({ id: 1, result: {} })}\0`);
  await assert.rejects(pending, /journal storage failed/);
  await assert.rejects(client.call('Page.enable'), /journal storage failed/);
  client.close();
});

test('response body expectation excludes bodyless protocol responses', () => {
  assert.equal(responseCanHaveBody({
    method: 'GET',
    response: { status: 200 },
  }), true);
  for (const status of [101, 204, 205, 304]) {
    assert.equal(responseCanHaveBody({
      method: 'GET',
      response: { status },
    }), false);
  }
  assert.equal(responseCanHaveBody({
    method: 'GET',
    response: { status: 300 },
  }), true);
  assert.equal(responseCanHaveBody({
    method: 'GET',
    response: { status: 200 },
    failure: { errorText: 'net::ERR_ABORTED' },
  }), true);
  assert.equal(responseCanHaveBody({
    method: 'GET',
    response: { status: 302 },
    redirectedTo: 'https://example.com/next',
  }), false);
  assert.equal(responseCanHaveBody({
    method: 'HEAD',
    response: { status: 200 },
  }), false);
});

test('Netscape cookie import preserves HttpOnly and expiry', () => {
  const source = [
    '# Netscape HTTP Cookie File',
    '.example.com\tTRUE\t/\tTRUE\t2000000000\tregular\tvalue',
    '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsession\tsecret',
    '',
  ].join('\n');
  const cookies = parseNetscapeCookieJar(source);
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies[0], {
    name: 'regular',
    value: 'value',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: false,
    expires: 2000000000,
  });
  assert.equal(cookies[1].httpOnly, true);
  assert.equal(cookies[1].name, 'session');
});

test('cookie sources support JSON, Netscape, and header formats', () => {
  const json = parseCookieSource(JSON.stringify([{
    name: 'sid',
    value: '1',
    domain: '.example.com',
    secure: true,
    expirationDate: 2000000000,
  }]));
  assert.equal(json.format, 'json');
  assert.equal(json.cookies[0].expires, 2000000000);

  const netscape = parseCookieSource(
    '.example.com\tTRUE\t/\tTRUE\t0\tsid\t1\n',
  );
  assert.equal(netscape.format, 'netscape');

  const header = parseCookieSource('sid=1; mode=test', 'example.com');
  assert.equal(header.format, 'header');
  assert.deepEqual(header.cookies.map((cookie) => cookie.name), ['sid', 'mode']);
});

test('cookie serialization preserves source format', () => {
  const cookies = [{
    name: 'session',
    value: 'secret',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    expires: 2000000000,
  }];
  assert.match(serializeCookies('netscape', cookies), /#HttpOnly_\.example\.com/);
  assert.deepEqual(JSON.parse(serializeCookies('json', cookies))[0], {
    name: 'session',
    value: 'secret',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    expirationDate: 2000000000,
  });
  assert.equal(serializeCookies('header', cookies), 'session=secret\n');
});

test('headless output is private and cannot reuse an existing directory', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.homedir(), '.glider-output-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'capture');
  const resolved = await prepareOutputDir(output);
  assert.equal(resolved, output);
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  await assert.rejects(() => prepareOutputDir(output), /already exists/);
});

test('headless child cleanup does not retain the escalation timer', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const started = Date.now();
  await stopProcess(child);
  assert.ok(Date.now() - started < 2_000, 'cleanup retained the five-second timer');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('proxy trust uses only the ephemeral CA SPKI allowlist', () => {
  const certificate = tls.rootCertificates[0];
  const x509 = new crypto.X509Certificate(certificate);
  const expected = crypto.createHash('sha256')
    .update(x509.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  assert.equal(computeCertificateSpkiHash(certificate), expected);
  const args = proxyBrowserArgs({ port: 43210, spkiHash: expected });
  assert.deepEqual(args, [
    '--proxy-server=http://127.0.0.1:43210',
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    `--ignore-certificate-errors-spki-list=${expected}`,
  ]);
  assert.ok(!args.includes('--ignore-certificate-errors'));
});

test('mitmproxy arguments keep capture private and browser-scoped', () => {
  const args = buildMitmproxyArgs({
    confDir: '/capture/proxy/conf',
    exactDir: '/capture/proxy/exact',
    addonPath: '/package/lib/mitmproxy-exact-capture.py',
    harPath: '/capture/proxy/traffic.har',
    flowPath: '/capture/proxy/flows.mitm',
  }, 45678);
  assert.deepEqual(args, [
    '--listen-host',
    '127.0.0.1',
    '--listen-port',
    '45678',
    '--set',
    'confdir=/capture/proxy/conf',
    '--set',
    'hardump=/capture/proxy/traffic.har',
    '--set',
    'termlog_verbosity=info',
    '--set',
    'websocket=true',
    '--set',
    'glider_capture_dir=/capture/proxy/exact',
    '-s',
    '/package/lib/mitmproxy-exact-capture.py',
    '-w',
    '/capture/proxy/flows.mitm',
  ]);
});

test('proxy startup fails closed when mitmdump cannot start', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-failure-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  await assert.rejects(
    () => startProxyCapture(output, {
      mitmdumpBinary: '/usr/bin/false',
      proxyCommandTimeoutMs: 1_000,
    }),
    /mitmdump version check failed/,
  );
  assert.equal(fs.statSync(path.join(output, 'proxy')).mode & 0o777, 0o700);
});

test('proxy startup and finalization are bounded with private artifacts', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-lifecycle-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'capture');
  fs.mkdirSync(output, { mode: 0o700 });
  const fakeMitmdump = path.join(parent, 'fake-mitmdump');
  fs.writeFileSync(fakeMitmdump, `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('Mitmproxy: 12.3.1');
  process.exit(0);
}
const valueAfter = name => args[args.indexOf(name) + 1];
const setting = name => {
  const value = valueAfter('--set');
  const settings = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--set') settings.push(args[index + 1]);
  }
  return settings.find(item => item.startsWith(name + '='))?.slice(name.length + 1);
};
const port = Number(valueAfter('--listen-port'));
const confdir = setting('confdir');
const hardump = setting('hardump');
const exactdir = setting('glider_capture_dir');
const flow = valueAfter('-w');
fs.mkdirSync(confdir, { recursive: true });
fs.mkdirSync(path.join(exactdir, 'bodies'), { recursive: true });
fs.writeFileSync(path.join(confdir, 'mitmproxy-ca-cert.pem'), tls.rootCertificates[0]);
fs.writeFileSync(path.join(exactdir, 'ready.json'), JSON.stringify({
  schema: 'glider-mitm-exact/v1',
}));
fs.writeFileSync(path.join(exactdir, 'flows.jsonl'), '');
const server = net.createServer(socket => socket.end());
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => {
  fs.writeFileSync(hardump, JSON.stringify({ log: { entries: [] } }));
  fs.writeFileSync(flow, 'native-flow');
  fs.writeFileSync(path.join(exactdir, 'final.json'), JSON.stringify({
    schema: 'glider-mitm-exact/v1',
    terminalCount: 0,
    responseCount: 0,
    errorCount: 0,
    captureErrorCount: 0,
  }));
  process.exit(0);
}));
`, { mode: 0o700 });
  const proxy = await startProxyCapture(output, {
    mitmdumpBinary: fakeMitmdump,
    proxyStartupTimeoutMs: 2_000,
  });
  assert.match(proxy.spkiHash, /^[A-Za-z0-9+/]+={0,2}$/);
  const summary = await finalizeProxyCapture(proxy, 2_000);
  assert.equal(summary.enabled, true);
  assert.equal(summary.version, '12.3.1');
  for (const artifact of [
    'mitmdump.log',
    'flows.mitm',
    'traffic.har',
    path.join('exact', 'flows.jsonl'),
  ]) {
    assert.equal(
      fs.statSync(path.join(output, 'proxy', artifact)).mode & 0o777,
      0o600,
    );
  }
  assert.equal(fs.statSync(path.join(output, 'proxy', 'conf')).mode & 0o777, 0o700);
});

test('byte-exact proxy index validates artifact hashes and lengths', async (t) => {
  const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-exact-'));
  t.after(() => fs.rmSync(exactDir, { recursive: true, force: true }));
  const bodyDir = path.join(exactDir, 'bodies');
  fs.mkdirSync(bodyDir, { mode: 0o700 });
  const body = Buffer.from([0, 255, 13, 10, 128]);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const artifact = `bodies/request-${digest}.body`;
  fs.writeFileSync(path.join(exactDir, artifact), body, { mode: 0o600 });
  const row = {
    schema: 'glider-mitm-exact/v1',
    flowId: 'flow-1',
    terminal: 'error',
    observedAt: new Date().toISOString(),
    method: 'POST',
    url: 'https://example.test/upload',
    status: null,
    timestamps: { requestStart: 1_700_000_000 },
    requestBody: {
      artifact,
      bytes: body.length,
      sha256: digest,
    },
    responseBody: null,
    error: { message: 'connection failed' },
  };
  fs.writeFileSync(
    path.join(exactDir, 'flows.jsonl'),
    `${JSON.stringify(row)}\n`,
    { mode: 0o600 },
  );
  const entries = await proxyExactEntries(exactDir, { terminalCount: 1 });
  assert.deepEqual(entries[0].requestBody.buffer, body);
  fs.writeFileSync(path.join(exactDir, artifact), Buffer.from('tampered'));
  await assert.rejects(
    () => proxyExactEntries(exactDir, { terminalCount: 1 }),
    /failed hash\/length validation/,
  );
});

function harDocument(entries) {
  return {
    log: {
      entries: entries.map((entry, index) => ({
        startedDateTime: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        request: {
          method: entry.method,
          url: entry.url,
          ...(entry.requestBody === undefined
            ? {}
            : {
              postData: {
                text: Buffer.from(entry.requestBody).toString('base64'),
                encoding: 'base64',
              },
            }),
        },
        response: {
          status: entry.status,
          statusText: entry.statusText || '',
          content: {
            text: Buffer.from(entry.body || '').toString('base64'),
            encoding: 'base64',
          },
        },
      })),
    },
  };
}

function exactEvidence(entries) {
  return entries.map((entry, index) => {
    const body = (value, kind) => {
      if (value === undefined) return null;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      return {
        artifact: `bodies/${kind}-${index}.body`,
        bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        buffer,
      };
    };
    return {
      index,
      flowId: `flow-${index}`,
      terminal: entry.terminal || 'response',
      observedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      method: entry.method,
      url: entry.url,
      status: entry.status ?? null,
      startedMilliseconds: 1_700_000_000_000 + index * 1_000,
      timestamps: {
        requestStart: 1_700_000_000 + index,
        responseEnd: 1_700_000_000.5 + index,
      },
      requestBody: body(entry.requestBody, 'request'),
      responseBody: body(entry.body, 'response'),
      error: entry.error || null,
    };
  });
}

test('byte-exact proxy evidence restores bodies and completed responses', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-reconcile-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const payloadState = { sequence: 0 };
  const network = [
    {
      key: 'font',
      method: 'GET',
      url: 'https://example.test/font.woff2',
      wallTime: 1,
      response: { status: 200 },
      responseBodyError: 'No data found',
    },
    {
      key: 'redirect',
      method: 'GET',
      url: 'https://example.test/old',
      wallTime: 2,
      response: { status: 302 },
      redirectedTo: 'https://example.test/new',
    },
    {
      key: 'post',
      method: 'POST',
      url: 'https://example.test/api',
      wallTime: 3,
      response: { status: 400 },
      captureEndedWhileOpen: true,
      request: { hasPostData: true },
      requestBodyError: 'multipart request body requires proxy evidence',
    },
    {
      key: 'destination',
      method: 'GET',
      url: 'https://example.test/new',
      wallTime: 4,
      response: { status: 200 },
      responseBody: { artifact: 'network/bodies/cdp.body', origin: 'cdp' },
    },
  ];
  const issues = [{
    surface: 'response-body',
    requestKey: 'font',
    error: 'No data found',
  }, {
    surface: 'request-body',
    requestKey: 'post',
    error: 'multipart request body requires proxy evidence',
  }];
  const entries = proxyHarEntries(harDocument([
    {
      method: 'GET',
      url: 'https://example.test/font.woff2',
      status: 200,
      body: 'font-bytes',
    },
    {
      method: 'GET',
      url: 'https://example.test/old',
      status: 302,
      body: 'redirect-hop',
    },
    {
      method: 'POST',
      url: 'https://example.test/api',
      status: 400,
      body: 'bad request',
      requestBody: 'compressed request bytes',
    },
    {
      method: 'GET',
      url: 'https://example.test/new',
      status: 200,
      body: 'destination-bytes',
    },
  ]));
  const exactRequest = Buffer.from([0, 255, 13, 10, 128, 1]);
  const exactEntries = exactEvidence([
    {
      method: 'GET',
      url: 'https://example.test/font.woff2',
      status: 200,
      body: 'font-bytes',
    },
    {
      method: 'GET',
      url: 'https://example.test/old',
      status: 302,
      body: 'redirect-hop',
    },
    {
      method: 'POST',
      url: 'https://example.test/api',
      status: 400,
      body: 'bad request',
      requestBody: exactRequest,
    },
    {
      method: 'GET',
      url: 'https://example.test/new',
      status: 200,
      body: 'destination-bytes',
    },
  ]);
  const summary = await reconcileNetworkWithProxyHar(
    output,
    payloadState,
    network,
    entries,
    exactEntries,
    issues,
  );
  assert.equal(summary.fallbackBodies, 2);
  assert.equal(summary.redirectBodies, 1);
  assert.equal(summary.requestBodies, 1);
  assert.equal(summary.closedResponses, 1);
  assert.equal(network[0].responseBody.origin, 'proxy-addon');
  assert.equal(issues[0].resolved, true);
  assert.equal(issues[1].resolved, true);
  assert.equal(
    fs.readFileSync(path.join(output, network[1].redirectResponseBody.artifact), 'utf8'),
    'redirect-hop',
  );
  assert.notEqual(
    fs.readFileSync(path.join(output, network[1].redirectResponseBody.artifact), 'utf8'),
    'destination-bytes',
  );
  assert.equal(network[2].captureEndedWhileOpen, undefined);
  assert.equal(network[2].proxyCompletion.completed, true);
  assert.equal(network[2].requestBody.origin, 'proxy-addon');
  assert.deepEqual(
    fs.readFileSync(path.join(output, network[2].requestBody.artifact)),
    exactRequest,
  );
  assert.equal(network[3].responseBody.origin, 'cdp');
});

test('HAR content alone cannot close an open response', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-har-not-terminal-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const network = [{
    key: 'open',
    method: 'POST',
    url: 'https://example.test/api',
    response: { status: 400 },
    captureEndedWhileOpen: true,
  }];
  const summary = await reconcileNetworkWithProxyHar(
    output,
    { sequence: 0 },
    network,
    proxyHarEntries(harDocument([{
      method: 'POST',
      url: 'https://example.test/api',
      status: 400,
      body: 'possibly partial HAR text',
    }])),
    [],
    [],
  );
  assert.equal(summary.closedResponses, 0);
  assert.equal(network[0].captureEndedWhileOpen, true);
  assert.equal(network[0].responseBody, undefined);
});

test('terminal proxy errors retain partial bytes without claiming completion', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-terminal-error-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const network = [{
    key: 'partial',
    method: 'GET',
    url: 'https://example.test/partial',
    wallTime: 1_700_000_000,
    response: { status: 200 },
    failure: { errorText: 'net::ERR_CONNECTION_RESET' },
    captureEndedWhileOpen: true,
  }];
  const issues = [{
    surface: 'response-transfer',
    requestKey: 'partial',
    error: 'net::ERR_CONNECTION_RESET',
  }];
  const summary = await reconcileNetworkWithProxyHar(
    output,
    { sequence: 0 },
    network,
    [],
    exactEvidence([{
      method: 'GET',
      url: 'https://example.test/partial',
      status: 200,
      terminal: 'error',
      body: Buffer.from([1, 2, 3, 4]),
      error: { message: 'upstream reset' },
    }]),
    issues,
  );
  assert.equal(summary.terminalErrors, 1);
  assert.equal(summary.partialResponseBodies, 1);
  assert.equal(network[0].captureEndedWhileOpen, true);
  assert.equal(network[0].responseBody, undefined);
  assert.equal(network[0].proxyCompletion, undefined);
  assert.equal(network[0].proxyTransfer.terminal, 'error');
  assert.equal(issues[0].resolved, undefined);
  assert.deepEqual(
    fs.readFileSync(
      path.join(output, network[0].proxyTransfer.partialResponseBody.artifact),
    ),
    Buffer.from([1, 2, 3, 4]),
  );
});

test('ambiguous byte-exact proxy occurrences remain explicit issues', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-ambiguous-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const network = [{
    key: 'only-record',
    method: 'GET',
    url: 'https://example.test/repeated',
    response: { status: 200 },
  }];
  const entries = proxyHarEntries(harDocument([
    { method: 'GET', url: 'https://example.test/repeated', status: 200, body: 'one' },
    { method: 'GET', url: 'https://example.test/repeated', status: 200, body: 'two' },
  ]));
  const issues = [];
  const summary = await reconcileNetworkWithProxyHar(
    output,
    { sequence: 0 },
    network,
    entries,
    exactEvidence([
      { method: 'GET', url: 'https://example.test/repeated', status: 200, body: 'one' },
      { method: 'GET', url: 'https://example.test/repeated', status: 200, body: 'two' },
    ]),
    issues,
  );
  assert.equal(summary.ambiguities, 1);
  assert.equal(network[0].responseBody, undefined);
  assert.equal(issues[0].surface, 'proxy-exact-correlation');
});

test('extra exact flows use a unique near-exact start-time match', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-proxy-nearest-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const network = [{
    key: 'cdp-record',
    method: 'POST',
    url: 'https://example.test/telemetry',
    wallTime: 1_700_000_000.001,
    response: { status: 200 },
    responseBody: { artifact: 'network/bodies/cdp.body', origin: 'cdp' },
  }];
  const issues = [];
  const summary = await reconcileNetworkWithProxyHar(
    output,
    { sequence: 0 },
    network,
    [],
    exactEvidence([
      {
        method: 'POST',
        url: 'https://example.test/telemetry',
        status: 200,
        body: '',
      },
      {
        method: 'POST',
        url: 'https://example.test/telemetry',
        status: 200,
        body: '',
      },
    ]),
    issues,
  );
  assert.equal(summary.ambiguities, 0);
  assert.equal(summary.coverageGaps, 0);
  assert.equal(summary.matchedRecords, 1);
  assert.equal(network[0].proxyCapture.flowId, 'flow-0');
  assert.deepEqual(issues, []);
});

test('source-map terminal HTTP dispositions retain status and body evidence', async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-source-map-disposition-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const startedAt = new Date(1_700_000_000_000).toISOString();
  const scripts = [{
    sessionId: 'session',
    scriptId: '1',
    url: 'https://example.test/app.js',
    sourceMapURL: 'app.js.map',
    sourceMapResolvedURL: 'https://example.test/app.js.map',
    sourceMapError: 'source-map load failed with HTTP 404',
    sourceMapAttempt: {
      id: 'attempt-1',
      startedAt,
      finishedAt: new Date(1_700_000_005_000).toISOString(),
      error: 'source-map load failed with HTTP 404',
    },
  }];
  const issues = [{
    surface: 'source-map',
    sourceMapAttemptId: 'attempt-1',
    sourceMapURL: 'https://example.test/app.js.map',
    error: scripts[0].sourceMapError,
  }];
  const entries = proxyHarEntries(harDocument([{
    method: 'GET',
    url: 'https://example.test/app.js.map',
    status: 404,
    statusText: 'Not Found',
    body: 'missing map evidence',
  }]));
  const summary = await reconcileSourceMapsWithProxyHar(
    output,
    { sequence: 0 },
    scripts,
    entries,
    exactEvidence([{
      method: 'GET',
      url: 'https://example.test/app.js.map',
      status: 404,
      body: 'missing map evidence',
    }]),
    issues,
  );
  assert.equal(summary.dispositions, 1);
  assert.equal(scripts[0].sourceMapResult.kind, 'http-terminal-disposition');
  assert.equal(scripts[0].sourceMapResult.status, 404);
  assert.equal(issues[0].resolved, true);
  assert.equal(
    fs.readFileSync(
      path.join(output, scripts[0].sourceMapResult.responseBody.artifact),
      'utf8',
    ),
    'missing map evidence',
  );
  assert.ok(fs.existsSync(path.join(output, scripts[0].sourceMapResult.artifact)));
});

test('webpack virtual source-map references are complete only with script bytes', () => {
  const captured = classifySourceMapReference({
    url: 'webpack://application/src/index.js',
    sourceMapURL: 'webpack://application/src/index.js.map',
    source: { artifact: 'scripts/000001.js' },
  });
  assert.equal(captured.result.kind, 'non-fetchable-virtual-reference');
  assert.equal(captured.result.scriptSourceArtifact, 'scripts/000001.js');
  assert.throws(
    () => classifySourceMapReference({
      url: 'webpack://application/src/index.js',
      sourceMapURL: 'webpack://application/src/index.js.map',
    }),
    /unsupported source-map protocol: webpack:/,
  );
});
