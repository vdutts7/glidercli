'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolvePin, partition } = require('../lib/pin-machine.js');

function page(id, sid, url) {
  return { sessionId: sid, targetId: id, targetInfo: { type: 'page', url, targetId: id, title: url } };
}
function iframe(id, sid, url, parentId) {
  return {
    sessionId: sid,
    targetId: id,
    targetInfo: { type: 'iframe', url, targetId: id, parentFrameId: parentId, title: url },
  };
}

const gpt = page('Tpage', 'session-100', 'https://chatgpt.com/c/abc');
const dil = iframe('Tifr', 'IFRAME1', 'https://cdn.platform.openai.com/deployments/dil/v14/runner.html', 'Tpage');
const claude = page('Tcl', 'session-1', 'https://claude.ai/chat/x');

test('never pins iframe; DIL host pins parent page', () => {
  const r = resolvePin({ targets: [claude, dil, gpt], host: 'cdn.platform.openai.com' });
  assert.equal(r.state, 'S4_pin');
  assert.equal(r.pin.sessionId, 'session-100');
  assert.equal(r.pin.reason, 'parent_of_oopif');
});

test('chatgpt.com pins type=page not iframe', () => {
  const r = resolvePin({ targets: [claude, dil, gpt], host: 'chatgpt.com' });
  assert.equal(r.pin.sessionId, 'session-100');
  assert.equal(r.pin.reason, 'page_url');
});

test('explicit iframe session promotes to parent', () => {
  const r = resolvePin({ targets: [dil, gpt], sessionId: 'IFRAME1' });
  assert.equal(r.pin.sessionId, 'session-100');
  assert.equal(r.pin.reason, 'parent_of_oopif');
});

test('no want does not fall through to targets[0]', () => {
  const r = resolvePin({ targets: [claude, gpt] });
  assert.equal(r.state, 'F_need_context');
  assert.equal(r.pin, null);
});

test('session churn recovers by targetId', () => {
  const r = resolvePin({
    targets: [page('Tpage', 'session-101', 'https://chatgpt.com/')],
    targetId: 'Tpage',
  });
  assert.equal(r.pin.sessionId, 'session-101');
  assert.equal(r.pin.reason, 'same_tab_new_session');
});

test('ambiguous two pages same host halts', () => {
  const r = resolvePin({
    targets: [
      page('A', 's1', 'https://chatgpt.com/a'),
      page('B', 's2', 'https://chatgpt.com/b'),
    ],
    host: 'chatgpt.com',
  });
  assert.equal(r.state, 'F_ambiguous');
  assert.equal(r.pin, null);
});

test('partition nests iframe under parent', () => {
  const p = partition([gpt, dil]);
  assert.equal(p.pages.length, 1);
  assert.equal(p.iframes[0].parent_sessionId, 'session-100');
});
