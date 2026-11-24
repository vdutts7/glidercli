'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const { REPO_ROOT } = require('./helpers.js');

const CWS_URL = 'https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj';

function gitTrackedFiles() {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
  return new Set(out.split('\0').filter(Boolean));
}

function npmPackedFiles() {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glidercli-pack-'));
  try {
    const name = execFileSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\s+/).pop();
    const tgz = path.join(packDir, name);
    const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^package\//, ''))
      .filter((line) => line && line !== '.' && !line.endsWith('/'));
    return { tgz, listing };
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

test('npm pack ships only git-tracked consumer-plane files', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(Array.isArray(packageJson.files), true, 'package.json files whitelist is required');
  assert.equal(Object.hasOwn(packageJson, 'main'), false, 'CLI-only package must not declare a missing module entry');

  const tracked = gitTrackedFiles();
  const { listing } = npmPackedFiles();
  assert.ok(listing.length > 0, 'npm pack produced empty listing');

  for (const entry of listing) {
    assert.equal(
      tracked.has(entry),
      true,
      `untracked/generated path packed: ${entry}`,
    );
  }

  for (const required of [
    'README.md',
    'package.json',
    'bin/glider.js',
    'lib/bserve.js',
    'lib/browser-config.js',
    'lib/relay-config.js',
    'lib/guard.js',
    'lib/paths.js',
    'lib/cookie-jar.js',
    'lib/headless-runtime.js',
    'lib/status-model.js',
    'lib/target-registry.js',
    'lib/tab-tui.js',
    'lib/tab-map.js',
    'config/browser.json.example',
  ]) {
    assert.equal(listing.includes(required), true, `missing ${required}`);
  }

  for (const entry of listing) {
    assert.equal(entry.startsWith('tests/'), false, `tests leaked: ${entry}`);
    assert.equal(entry.startsWith('scripts/'), false, `scripts leaked: ${entry}`);
  }

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
    for (const entry of listing) {
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
