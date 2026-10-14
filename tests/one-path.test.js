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
  assert.doesNotMatch(cli, /case 'use'/);
  assert.doesNotMatch(cli, /case 'browser'/);
  assert.doesNotMatch(cli, /function cmdUse\(/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /glider use(?!-session)/);
  assert.doesNotMatch(readme, /`glider browser`/);
});
