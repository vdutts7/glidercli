'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const { parseDomainList, hostMatchesPattern, urlAllowed } = require('../lib/guard.js');
const { gliderHome, registryMode, warchDirForHost } = require('../lib/paths.js');
const { buildSnapshotExpression, formatSnapshotText } = require('../lib/bsnapshot.js');
const { relayHttpUrl, relayPort, relayWebSocketUrl } = require('../lib/relay-config.js');
const { makeTempGliderHome, removeTree } = require('./helpers.js');

test('relay config uses one validated port socket across HTTP and WebSocket clients', () => {
  const env = { GLIDER_PORT: '24444', RELAY_PORT: '25555' };
  assert.equal(relayPort(env), 24444);
  assert.equal(relayHttpUrl(env), 'http://127.0.0.1:24444');
  assert.equal(relayWebSocketUrl(env), 'ws://127.0.0.1:24444/cdp');
  assert.throws(() => relayPort({ GLIDER_PORT: '0' }), /Invalid relay port/);
  assert.throws(() => relayPort({ GLIDER_PORT: 'abc' }), /Invalid relay port/);
});

test('domain guards parse, wildcard-match, and fail closed for malformed URLs', () => {
  assert.deepEqual(parseDomainList('example.com, *.example.net'), ['example.com', '*.example.net']);
  assert.equal(hostMatchesPattern('api.example.com', 'example.com'), true);
  assert.equal(hostMatchesPattern('a.example.net', '*.example.net'), true);
  assert.equal(urlAllowed('https://api.example.com/x', ['example.com']), true);
  assert.equal(urlAllowed('not a url', ['example.com']), false);
});

test('GLIDER_HOME controls runtime and standalone registry paths', () => {
  const previous = process.env.GLIDER_HOME;
  const home = makeTempGliderHome();
  try {
    process.env.GLIDER_HOME = home;
    delete process.env.AGREGISTRY;
    assert.equal(gliderHome(), home);
    assert.equal(registryMode(), 'standalone');
    assert.equal(warchDirForHost('example.com', {}), path.join(home, 'warch', 'example.com'));
  } finally {
    if (previous === undefined) delete process.env.GLIDER_HOME;
    else process.env.GLIDER_HOME = previous;
    removeTree(home);
  }
});

test('snapshot helpers emit a deterministic agent-facing shape', () => {
  const expression = buildSnapshotExpression(true);
  assert.match(expression, /interactiveOnly\s*=\s*true/);
  const text = formatSnapshotText({
    url: 'https://example.com/',
    title: 'Example',
    text: 'Hello',
    elements: [{ index: 1, tag: 'button', text: 'Go', selector: '#go' }],
  });
  assert.match(text, /Example/);
  assert.match(text, /#go/);
});
