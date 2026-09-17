'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { isBrowserInternalUrl, loadBrowserConfig } = require('../lib/browser-config.js');
const { makeTempGliderHome, removeTree } = require('./helpers.js');

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
    'opera://settings/',
    'vivaldi://settings/',
  ]) {
    assert.equal(isBrowserInternalUrl(url), true, url);
  }
  assert.equal(isBrowserInternalUrl('https://example.com/'), false);
});
