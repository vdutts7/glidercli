'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const { REPO_ROOT } = require('./helpers.js');

const CWS_URL = 'https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj';

test('npm tarball contains the complete consumer plane and excludes maintainer tests', () => {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const pack = JSON.parse(raw)[0];
  const files = new Set(pack.files.map((entry) => entry.path));
  for (const required of [
    'README.md',
    'package.json',
    'bin/glider.js',
    'lib/bserve.js',
    'lib/browser-config.js',
    'lib/relay-config.js',
    'config/browser.json.example',
  ]) {
    assert.equal(files.has(required), true, `missing ${required}`);
  }
  for (const entry of files) {
    assert.equal(entry.startsWith('tests/'), false, `maintainer test leaked: ${entry}`);
    assert.equal(entry.startsWith('scripts/'), false, `maintainer script leaked: ${entry}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(packageJson, 'main'), false, 'CLI-only package must not declare a missing module entry');

  const setup = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'setup.json'), 'utf8'));
  assert.deepEqual(setup.install.extension, {
    cws: CWS_URL,
    source: 'https://github.com/vdutts7/glider',
  });
  assert.deepEqual(setup.architecture.relay_port_environment, ['GLIDER_PORT', 'RELAY_PORT']);
  assert.equal(setup.architecture.extension_relay_port, 19988);
  assert.equal(setup.architecture.custom_port_requires_matching_extension_build, true);

  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'glider.js'), 'utf8');
  for (const publicSurface of [readme, cli, JSON.stringify(setup)]) {
    assert.equal(publicSurface.includes(CWS_URL), true, 'public extension install path must remain Chrome Web Store');
  }
});
