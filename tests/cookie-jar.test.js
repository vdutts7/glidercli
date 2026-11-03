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
