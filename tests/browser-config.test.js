'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { isBrowserInternalUrl, loadBrowserConfig } = require('../lib/browser-config.js');
const { makeTempGliderHome, removeTree, runCli } = require('./helpers.js');

test('browser config resolves an explicit Chromium application', () => {
  const home = makeTempGliderHome();
  try {
    const source = path.join(home, 'config', 'browser.json');
    fs.writeFileSync(source, JSON.stringify({
      name: 'Example Browser',
      path: '/Applications/Example Browser.app',
      processName: 'Example Browser',
      bootstrapUrl: 'https://example.test/',
    }));
    assert.deepEqual(loadBrowserConfig({ home }), {
      name: 'Example Browser',
      path: '/Applications/Example Browser.app',
      processName: 'Example Browser',
      bootstrapUrl: 'https://example.test/',
      use: null,
      source,
      registrySource: null,
      registry: {},
    });
  } finally {
    removeTree(home);
  }
});

test('browser config resolves a registry key from the same Glider home', () => {
  const home = makeTempGliderHome();
  try {
    fs.writeFileSync(path.join(home, 'config', 'browser.json'), '{"use":"edge"}\n');
    fs.writeFileSync(path.join(home, 'config', 'browsers-registry.json'), JSON.stringify({
      registry: {
        edge: {
          name: 'Microsoft Edge',
          path: '/Applications/Configured Browser.app',
          processName: 'Microsoft Edge',
        },
      },
    }));
    const config = loadBrowserConfig({ home });
    assert.equal(config.name, 'Microsoft Edge');
    assert.equal(config.use, 'edge');
    assert.equal(config.processName, 'Microsoft Edge');
  } finally {
    removeTree(home);
  }
});

test('browser config fails closed on invalid JSON and unknown registry keys', () => {
  const home = makeTempGliderHome();
  try {
    const configPath = path.join(home, 'config', 'browser.json');
    fs.writeFileSync(configPath, '{');
    assert.throws(() => loadBrowserConfig({ home }), /Invalid browser config JSON/);
    fs.writeFileSync(configPath, '{"use":"missing"}');
    assert.throws(() => loadBrowserConfig({ home }), /Unknown browser registry key "missing"/);
  } finally {
    removeTree(home);
  }
});

test('browser internal URL detection covers Chromium variants', () => {
  for (const url of [
    'about:blank',
    'arc://settings/',
    'brave://settings/',
    'chrome://extensions/',
    'chrome-extension://abc/page.html',
    'edge://extensions/',
    'helium://settings/',
    'opera://settings/',
    'vivaldi://settings/',
  ]) {
    assert.equal(isBrowserInternalUrl(url), true, url);
  }
  assert.equal(isBrowserInternalUrl('https://example.com/'), false);
});

test('glider config browser prints and writes commands, not registry-key jargon', async () => {
  const home = makeTempGliderHome();
  try {
    fs.copyFileSync(
      path.join(__dirname, '..', 'config', 'browsers-registry.json.example'),
      path.join(home, 'config', 'browsers-registry.json'),
    );
    const env = { GLIDER: home, CI: '1' };

    let result = await runCli(['config', 'browser'], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /glider config browser chrome/);
    assert.doesNotMatch(result.stdout + result.stderr, /registry key/i);

    result = await runCli(['config', 'browser', '-h'], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /glider config browser edge/);

    result = await runCli(['config', 'browser', 'chrome'], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /glider config browser chrome/);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'config', 'browser.json'), 'utf8'));
    assert.equal(written.use, 'chrome');

    result = await runCli(['config', 'browser', 'nope'], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown command: config browser nope/);
    assert.match(result.stderr + result.stdout, /glider config browser chrome/);
    assert.doesNotMatch(result.stderr + result.stdout, /G L I D E R/);

    result = await runCli(['not-a-command'], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Unknown command: not-a-command\s*$/m);
    assert.doesNotMatch(result.stdout + result.stderr, /G L I D E R/);
    assert.doesNotMatch(result.stdout + result.stderr, /USAGE/);
  } finally {
    removeTree(home);
  }
});
