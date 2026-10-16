'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const { REPO_ROOT } = require('./helpers.js');

const CWS_URL = 'https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj';

function addPackageEntry(files, relativePath) {
  const normalized = relativePath.replace(/\/+$/, '');
  const absolute = path.resolve(REPO_ROOT, normalized);
  assert.equal(
    path.relative(REPO_ROOT, absolute).startsWith('..'),
    false,
    `package entry escapes repository: ${relativePath}`
  );
  assert.equal(fs.existsSync(absolute), true, `package entry does not exist: ${relativePath}`);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory()) {
    files.add(normalized.split(path.sep).join('/'));
    return;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    addPackageEntry(files, path.join(normalized, entry.name));
  }
}

function packageFiles(packageJson) {
  assert.equal(Array.isArray(packageJson.files), true, 'package.json files whitelist is required');
  const files = new Set(['package.json']);
  for (const entry of packageJson.files) {
    assert.equal(typeof entry, 'string', 'package files entries must be strings');
    addPackageEntry(files, entry);
  }
  return files;
}

test('package whitelist contains the complete consumer plane and excludes maintainer files', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const files = packageFiles(packageJson);
  for (const required of [
    'README.md',
    'package.json',
    'bin/glider.js',
    'lib/bserve.js',
    'lib/browser-config.js',
    'lib/relay-config.js',
    'lib/guard.js',
    'lib/paths.js',
    'lib/tab-tui.js',
    'lib/tab-map.js',
    'config/browser.json.example',
  ]) {
    assert.equal(files.has(required), true, `missing ${required}`);
  }
  for (const excluded of [
    'tests/',
    'scripts/',
    'claude-sidebar-har-capture.js',
    'linkedin-har-capture.js',
  ]) {
    for (const entry of files) {
      assert.equal(
        entry === excluded || entry.startsWith(excluded),
        false,
        `maintainer file leaked: ${entry}`
      );
    }
  }

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

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'glidercli-consumer-'));
  try {
    for (const entry of files) {
      const destination = path.join(stage, entry);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, entry), destination);
    }
    const output = execFileSync(process.execPath, ['bin/glider.js', '--version'], {
      cwd: stage,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI: '1',
        GLIDER_NO_UPDATE: '1',
        NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
      },
    });
    assert.equal(output.trim(), packageJson.version, 'staged consumer CLI did not report package version');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
