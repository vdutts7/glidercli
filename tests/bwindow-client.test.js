'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WindowManager } = require('../lib/bwindow.js');

test('window managers use distinct relay client identities', () => {
  const first = new WindowManager();
  const second = new WindowManager();
  assert.notEqual(first.relayUrl, second.relayUrl);
  assert.match(first.relayUrl, /\/cdp\/window-\d+-\d+$/);
  assert.match(second.relayUrl, /\/cdp\/window-\d+-\d+$/);
});
