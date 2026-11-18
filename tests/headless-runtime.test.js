'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  SUBSCRIBER_API,
  parseCookieSource,
  parseNetscapeCookieJar,
  parseRuntimeArgs,
  prepareOutputDir,
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
