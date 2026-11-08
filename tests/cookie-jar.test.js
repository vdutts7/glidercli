'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

test('parseHeaderLine strips Cookie prefix and ANSI', () => {
  const { parseHeaderLine } = require('../lib/cookie-jar.js');
  assert.equal(parseHeaderLine('Cookie: a=1; b=2'), 'a=1; b=2');
  assert.equal(parseHeaderLine('\x1b[32mfoo=bar\x1b[0m'), 'foo=bar');
});

test('parseHeaderPairs splits name=value list', () => {
  const { parseHeaderPairs } = require('../lib/cookie-jar.js');
  assert.deepEqual(parseHeaderPairs('Cookie: a=1; b=two=2'), [
    { name: 'a', value: '1' },
    { name: 'b', value: 'two=2' },
  ]);
});

test('buildInjectDetails prefers cookies.json attrs and pins storeId', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-cj-'));
  const prev = process.env.GLIDER;
  process.env.GLIDER = home;
  try {
    const cj = require('../lib/cookie-jar.js');
    const dir = path.join(home, 'cookies', 'example.com');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'header.txt'), 'a=1; auth_token=secret');
    fs.writeFileSync(
      path.join(dir, 'cookies.json'),
      JSON.stringify([
        {
          name: 'auth_token',
          value: 'secret',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
        },
      ]),
    );
    const details = cj.buildInjectDetails('example.com', { storeId: '1' });
    assert.equal(details.length, 1);
    assert.equal(details[0].name, 'auth_token');
    assert.equal(details[0].httpOnly, true);
    assert.equal(details[0].storeId, '1');
    assert.equal(details[0].url, 'https://example.com/');
  } finally {
    if (prev === undefined) delete process.env.GLIDER;
    else process.env.GLIDER = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('buildInjectDetails falls back to header.txt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-cj-'));
  const prev = process.env.GLIDER;
  process.env.GLIDER = home;
  try {
    const cj = require('../lib/cookie-jar.js');
    const dir = path.join(home, 'cookies', 'example.com');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'header.txt'), 'ct0=abc; auth_token=tok');
    const details = cj.buildInjectDetails('example.com', { storeId: '9' });
    assert.equal(details.length, 2);
    const byName = Object.fromEntries(details.map((d) => [d.name, d]));
    assert.equal(byName.ct0.httpOnly, false);
    assert.equal(byName.auth_token.httpOnly, true);
    assert.equal(byName.auth_token.storeId, '9');
  } finally {
    if (prev === undefined) delete process.env.GLIDER;
    else process.env.GLIDER = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('injectDomain calls setCookieFn once per cookie', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-cj-'));
  const prev = process.env.GLIDER;
  process.env.GLIDER = home;
  try {
    const cj = require('../lib/cookie-jar.js');
    const dir = path.join(home, 'cookies', 'example.com');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'header.txt'), 'a=1; b=2');
    const calls = [];
    const r = await cj.injectDomain('example.com', async (details) => {
      calls.push(details.name);
      return { name: details.name };
    }, { storeId: '0' });
    assert.equal(r.count, 2);
    assert.deepEqual(calls, ['a', 'b']);
  } finally {
    if (prev === undefined) delete process.env.GLIDER;
    else process.env.GLIDER = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rebuild and add persist domains.json under GLIDER', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-cj-'));
  const prev = process.env.GLIDER;
  process.env.GLIDER = home;
  try {
    const warch = path.join(home, 'warch', 'example.com');
    fs.mkdirSync(warch, { recursive: true });
    fs.writeFileSync(
      path.join(warch, 'glider.json'),
      JSON.stringify({ host: 'example.com', cookie_jar: { enabled: true } }),
    );
    const cj = require('../lib/cookie-jar.js');
    const r = cj.rebuildDomains();
    assert.ok(r.count >= 1);
    const r2 = cj.addDomain('other.test');
    assert.equal(r2.added, true);
    const names = cj.listDomainNames();
    assert.ok(names.includes('example.com'));
    assert.ok(names.includes('other.test'));
    cj.rmDomain('other.test');
    assert.ok(!cj.listDomainNames().includes('other.test'));
  } finally {
    if (prev === undefined) delete process.env.GLIDER;
    else process.env.GLIDER = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('glider cookie-jar list works offline', async () => {
  const { runCli, makeTempGliderHome, removeTree } = require('./helpers.js');
  const home = makeTempGliderHome();
  fs.mkdirSync(path.join(home, 'cookies'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'cookies', 'domains.json'),
    JSON.stringify({ domains: ['fixture.local'] }, null, 2),
  );
  const result = await runCli(['cookie-jar', 'list'], { env: { GLIDER: home } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fixture\.local/);
  removeTree(home);
});
