'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

test('one path: no GLIDER_HOME, no registry key, no glider use, no glider browser verb', () => {
  const files = [
    'README.md',
    'bin/glider.js',
    'docs/setup.json',
    'config/domains.template.json',
    'lib/paths.js',
  ];
  for (const rel of files) {
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(t, /GLIDER_HOME/, rel);
    assert.doesNotMatch(t, /registry key/i, rel);
  }
  const cli = fs.readFileSync(path.join(ROOT, 'bin/glider.js'), 'utf8');
  for (const verb of ['use', 'browser', 'ralph', 'rex', 'navigate', 'unfreeze', 'wake', 'reload-ext', 'reload-extension', 'win', 'js', 'sleep', 'echo', 'registry']) {
    assert.doesNotMatch(cli, new RegExp(`case '${verb}'`), verb);
  }
  assert.doesNotMatch(cli, /function cmdUse\(/);
  assert.doesNotMatch(cli, /Alias for/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /glider use(?!-session)/);
  assert.doesNotMatch(readme, /`glider browser`/);
  assert.doesNotMatch(readme, /`[^`]+` \/ `/);
  assert.doesNotMatch(readme, /alias/i);
});
