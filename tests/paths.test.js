'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('runtime artifact dirs live under $GLIDER and are created on demand', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-paths-'));
  const prev = process.env.GLIDER;
  process.env.GLIDER = home;
  try {
    const { stateDir, capturesDir, scratchDir } = require('../lib/paths.js');
    assert.strictEqual(stateDir(), path.join(home, 'state'));
    assert.strictEqual(capturesDir(), path.join(home, 'captures'));
    assert.strictEqual(capturesDir('explore'), path.join(home, 'captures', 'explore'));
    assert.strictEqual(scratchDir(), path.join(home, 'tmp'));
    for (const d of ['state', 'captures', 'captures/explore', 'tmp']) {
      assert.ok(fs.statSync(path.join(home, d)).isDirectory(), d);
    }
  } finally {
    if (prev === undefined) delete process.env.GLIDER; else process.env.GLIDER = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runtime code has no hardcoded /tmp output defaults', () => {
  const files = [path.join(ROOT, 'bin', 'glider.js')]
    .concat(fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'lib', f)));
  const offenders = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (/['"`]\/tmp\//.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, []);
});
