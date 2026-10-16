'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  catalogLooksLive,
  lstartToMs,
  relayBinaryStale,
  shouldRecycleRelay,
  shouldHealExtension,
} = require('../lib/relay-heal.js');

test('catalogLooksLive requires windows array and no error', () => {
  assert.equal(catalogLooksLive(null), false);
  assert.equal(catalogLooksLive({ error: 'x', windows: [] }), false);
  assert.equal(catalogLooksLive({ windows: [] }), true);
});

test('recycle when catalog missing or unadvertised or disk newer than process', () => {
  assert.equal(shouldRecycleRelay({ catalogOk: false }).reason, 'catalog_missing');
  assert.equal(shouldRecycleRelay({ catalogAdvertised: false }).reason, 'catalog_unadvertised');
  assert.equal(shouldRecycleRelay({
    catalogOk: false,
    catalogAdvertised: true,
  }).recycle, false);
  assert.equal(shouldRecycleRelay({
    catalogOk: true,
    catalogAdvertised: true,
    entryMtimeMs: 5000,
    processStartMs: 1000,
  }).reason, 'binary_stale');
  assert.equal(shouldRecycleRelay({
    catalogOk: true,
    catalogAdvertised: true,
    entryMtimeMs: 1000,
    processStartMs: 5000,
  }).recycle, false);
});

test('binary stale uses skew so clock jitter does not recycle', () => {
  assert.equal(relayBinaryStale({ entryMtimeMs: 1100, processStartMs: 1000, skewMs: 2000 }), false);
  assert.equal(relayBinaryStale({ entryMtimeMs: 4000, processStartMs: 1000, skewMs: 2000 }), true);
});

test('extension heal: wake on dead worker; reload only when listTabs fails', () => {
  assert.equal(shouldHealExtension({ extensionConnected: false }).step, 'wake');
  assert.equal(shouldHealExtension({ extensionConnected: true, workerAlive: false }).step, 'wake');
  assert.equal(shouldHealExtension({
    extensionConnected: true,
    workerAlive: true,
    listTabsOk: false,
  }).step, 'reload');
  assert.equal(shouldHealExtension({
    extensionConnected: true,
    workerAlive: true,
    listTabsOk: true,
  }).heal, false);
});

test('lstartToMs parses ps UTC lstart', () => {
  const ms = lstartToMs('Fri Oct 16 14:00:00 2026');
  assert.equal(Number.isFinite(ms), true);
});
