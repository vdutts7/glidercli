'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  reconcileAttachedTarget,
  updateTargetInfo,
} = require('../lib/target-registry.js');

function attached(sessionId, targetId, tabId, extra = {}) {
  return {
    sessionId,
    tabId,
    targetInfo: {
      targetId,
      tabId,
      type: 'page',
      url: `https://fixture.test/${tabId}`,
      ...extra,
    },
  };
}

test('real page target replaces a synthetic record for the same tab', () => {
  const targets = new Map();
  reconcileAttachedTarget(targets, attached('synthetic-session', 'tab-42', 42, { synthetic: true }));
  const outcome = reconcileAttachedTarget(targets, attached('real-session', 'REAL-TARGET', 42));

  assert.deepEqual(outcome.removedSessionIds, ['synthetic-session']);
  assert.equal(targets.size, 1);
  assert.equal(targets.has('synthetic-session'), false);
  assert.equal(targets.get('real-session').targetId, 'REAL-TARGET');
});

test('synthetic page target cannot displace an existing real target', () => {
  const targets = new Map();
  reconcileAttachedTarget(targets, attached('real-session', 'REAL-TARGET', 42));
  const outcome = reconcileAttachedTarget(
    targets,
    attached('synthetic-session', 'tab-42', 42, { synthetic: true }),
  );

  assert.equal(outcome.ignored, true);
  assert.equal(targets.size, 1);
  assert.equal(targets.get('real-session').targetId, 'REAL-TARGET');
});

test('targetInfoChanged upgrades a synthetic record in place by session', () => {
  const targets = new Map();
  reconcileAttachedTarget(targets, attached('parent-session', 'tab-42', 42, { synthetic: true }));

  const updated = updateTargetInfo(targets, {
    sessionId: 'parent-session',
    tabId: 42,
    targetInfo: {
      targetId: 'REAL-TARGET',
      tabId: 42,
      type: 'page',
      title: 'Canonical page',
      url: 'https://fixture.test/42',
      synthetic: false,
    },
  });

  assert.equal(targets.size, 1);
  assert.equal(updated.targetId, 'REAL-TARGET');
  assert.equal(updated.targetInfo.synthetic, false);
  assert.equal(updated.targetInfo.title, 'Canonical page');
});

test('worker targets remain distinct even without tab ids', () => {
  const targets = new Map();
  reconcileAttachedTarget(targets, {
    sessionId: 'worker-1',
    targetInfo: { targetId: 'W1', type: 'worker', url: 'blob:https://fixture.test/1' },
  });
  reconcileAttachedTarget(targets, {
    sessionId: 'worker-2',
    targetInfo: { targetId: 'W2', type: 'worker', url: 'blob:https://fixture.test/2' },
  });
  assert.equal(targets.size, 2);
});
