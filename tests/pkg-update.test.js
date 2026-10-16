'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, npmIsNewer } = require('../lib/pkg-update.js');

test('0.4.17 is newer than npm 0.4.16', () => {
  assert.equal(compareVersions('0.4.17', '0.4.16'), 1);
  assert.equal(npmIsNewer('0.4.17', '0.4.16'), false);
  assert.equal(npmIsNewer('0.4.16', '0.4.17'), true);
  assert.equal(npmIsNewer('0.4.16', '0.4.16'), false);
});
