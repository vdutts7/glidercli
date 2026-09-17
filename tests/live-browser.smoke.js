#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  jsonFromStdout,
  makeTempGliderHome,
  removeTree,
  runCli,
} = require('./helpers.js');

const RELAY_PORT = Number.parseInt(process.env.GLIDER_PORT || process.env.RELAY_PORT || '19988', 10);
const RELAY_HTTP = `http://127.0.0.1:${RELAY_PORT}`;
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const reportArg = process.argv.findIndex((arg) => arg === '--report');
const REPORT_PATH = process.env.GLIDER_LIVE_REPORT
  || (reportArg >= 0 ? process.argv[reportArg + 1] : null);

function requestJson(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, RELAY_HTTP);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : undefined,
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} ${pathname}: ${parsed?.error || raw}`));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${pathname}`)));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

function startFixtureServer() {
  const mainHtml = fs.readFileSync(path.join(FIXTURE_DIR, 'capabilities.html'));
  const frameHtml = fs.readFileSync(path.join(FIXTURE_DIR, 'frame.html'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(mainHtml);
    }
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(frameHtml);
    }
    if (url.pathname === '/api') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'fixture_server=ok; Path=/; HttpOnly; SameSite=Lax',
      });
      return res.end(JSON.stringify({ ok: true, method: req.method }));
    }
    if (url.pathname === '/page2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Fixture Page 2</title><h1 id="page2">Page 2</h1>');
    }
    if (url.pathname === '/download') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="fixture.txt"',
      });
      return res.end('fixture download');
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
      });
    });
  });
}

function findFrameId(frameTree, suffix) {
  if (!frameTree) return null;
  if (frameTree.frame?.url?.endsWith(suffix)) return frameTree.frame.id;
  for (const child of frameTree.childFrames || []) {
    const found = findFrameId(child, suffix);
    if (found) return found;
  }
  return null;
}

async function main() {
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    relay: RELAY_HTTP,
    browser: null,
    target: null,
    results: {},
    summary: {},
  };
  const gliderHome = makeTempGliderHome();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glider-live-'));
  let fixture;
  let targetId = null;
  let sessionId = null;

  const record = async (id, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      report.results[id] = { status: 'PASS', durationMs: Date.now() - started, detail: detail ?? null };
      return detail;
    } catch (error) {
      report.results[id] = { status: 'FAIL', durationMs: Date.now() - started, error: error.message };
      return null;
    }
  };
  const classify = (id, status, detail) => {
    report.results[id] = { status, durationMs: 0, detail };
  };
  const cliEnv = () => ({
    GLIDER_HOME: gliderHome,
    GLIDER_PORT: String(RELAY_PORT),
  });
  const runJson = async (args, allowedCodes = [0], timeoutMs = 15000) => {
    const prefix = sessionId ? ['--session', sessionId] : [];
    const result = await runCli([...prefix, '--json', ...args], { env: cliEnv(), timeoutMs });
    if (!allowedCodes.includes(result.code)) {
      throw new Error(`${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`);
    }
    let body;
    try { body = jsonFromStdout(result.stdout); } catch {
      throw new Error(`${args.join(' ')} did not emit JSON: ${result.stdout}`);
    }
    return { ...result, body };
  };
  const pageEval = async (expression) => {
    const { body } = await runJson(['eval', expression]);
    assert.equal(body.ok, true, body.error);
    return body.observation;
  };

  try {
    const operatorGliderHome = process.env.GLIDER_HOME || path.join(os.homedir(), '.glider');
    for (const name of ['browser.json', 'browsers-registry.json']) {
      const source = path.join(operatorGliderHome, 'config', name);
      const destination = path.join(gliderHome, 'config', name);
      if (fs.existsSync(source)) fs.copyFileSync(source, destination);
    }

    const status = await requestJson('GET', '/status');
    assert.equal(status.extension, true, 'extension WebSocket is not connected');
    // Extension-only is enough: Target.createTarget works with zero prior attached tabs.

    const browserResult = await runCli(['--json', 'browser'], { env: cliEnv() });
    assert.equal(browserResult.code, 0, browserResult.stderr);
    report.browser = jsonFromStdout(browserResult.stdout).observation;

    fixture = await startFixtureServer();
    let create;
    try {
      create = await requestJson('POST', '/cdp', {
        method: 'Target.createTarget',
        params: { url: `${fixture.baseUrl}/`, newWindow: true },
      });
    } catch (error) {
      throw new Error(
        `Target.createTarget failed (${error.message}). `
        + 'Extension socket may be up while the MV3 service worker is dead; click the Glider icon or reload the extension, then retry.'
      );
    }
    targetId = create.targetId;
    assert.ok(targetId, 'Target.createTarget did not return targetId');

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const targets = await requestJson('GET', '/targets');
      const target = targets.find((entry) => entry.targetId === targetId);
      if (target) {
        sessionId = target.sessionId;
        report.target = {
          targetId,
          sessionId,
          url: target.targetInfo?.url,
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(sessionId, `target ${targetId} never appeared in relay target list`);

    await record('relay_cdp_round_trip', async () => {
      const result = await requestJson('POST', '/cdp', {
        sessionId,
        method: 'Runtime.evaluate',
        params: { expression: '1+1', returnByValue: true },
      });
      assert.equal(result.result.value, 2);
      return { value: 2 };
    });

    await record('tab_thaw', async () => {
      const { body } = await runJson(['thaw', '--verify']);
      assert.equal(body.ok, true, body.error);
      assert.equal(body.observation.asyncAlive, true);
      return body.observation;
    });

    await record('page_title', async () => {
      const { body } = await runJson(['title']);
      assert.equal(body.observation, 'Glider Capability Fixture');
    });
    await record('page_url', async () => {
      const { body } = await runJson(['url']);
      assert.equal(body.observation.url, `${fixture.baseUrl}/`);
    });
    await record('page_text', async () => {
      const { body } = await runJson(['text']);
      assert.match(body.observation, /Capability Fixture/);
    });
    await record('page_html', async () => {
      const { body } = await runJson(['html', '#heading']);
      assert.match(body.observation, /data-kind="hero"/);
    });
    await record('page_snapshot', async () => {
      const { body } = await runJson(['snapshot', '--interactive-only']);
      assert.equal(body.ok, true);
      assert.ok(body.observation.elements.some((element) => element.selector === '#click-target'));
      return { elements: body.observation.elements.length };
    });

    const readCases = [
      ['read_element_text', ['read', '#heading', '--text'], 'Capability Fixture'],
      ['read_element_attr', ['read', '#heading', '--attr=data-kind'], 'hero'],
      ['read_element_prop', ['read', '#heading', '--prop=id'], 'heading'],
      ['read_element_html', ['read', '#heading', '--html'], /<h1/],
      ['count_elements', ['read', 'button', '--count'], (value) => assert.ok(value >= 4)],
      ['element_exists', ['read', '#heading', '--exists'], true],
      ['element_visible', ['read', '#heading', '--visible'], true],
      ['element_enabled', ['read', '#disabled-target', '--enabled'], false],
    ];
    for (const [id, args, expected] of readCases) {
      await record(id, async () => {
        const { body } = await runJson(args);
        if (expected instanceof RegExp) assert.match(body.observation, expected);
        else if (typeof expected === 'function') expected(body.observation);
        else assert.equal(body.observation, expected);
        return body.observation;
      });
    }

    await record('click_by_text', async () => {
      await runJson(['click', '--text=Click me']);
      assert.equal(await pageEval('fixtureState.clicks'), 1);
    });
    await record('click_scroll_into_view', async () => {
      await runJson(['click', '#click-target', '--scroll-into-view']);
      assert.equal(await pageEval('fixtureState.clicks'), 2);
    });
    await record('hover_element', async () => {
      await runJson(['hover', '#hover-target']);
      assert.ok(await pageEval('fixtureState.hovers') >= 1);
    });
    await record('right_click', async () => {
      await runJson(['right-click', '#right-target']);
      assert.ok(await pageEval('fixtureState.rightClicks') >= 1);
    });
    await record('double_click', async () => {
      await runJson(['double-click', '#double-target']);
      assert.ok(await pageEval('fixtureState.doubleClicks') >= 1);
    });
    await record('click_at_coord', async () => {
      const point = await pageEval(`(() => {
        const r = document.querySelector('#click-target').getBoundingClientRect();
        return [Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)];
      })()`);
      await runJson(['click-at', `${point[0]},${point[1]}`]);
      assert.ok(await pageEval('fixtureState.clicks') >= 3);
    });
    await record('drag_drop', async () => {
      const result = await runJson(['drag', '#drag-source', '--to=#drop-target', '--steps=4']);
      const lastMouse = await pageEval('fixtureState.lastMouse');
      const drops = await pageEval('fixtureState.drops');
      assert.ok(Array.isArray(lastMouse));
      assert.equal(drops, 1, 'drag must deliver exactly one drop event');
      return { lastMouse, drops, mechanism: result.body.observation.mechanism };
    });

    await record('rich_editor_write', async () => {
      await runJson(['type', '#text-input', 'Alpha', '--clear-first']);
      assert.equal(await pageEval(`document.querySelector('#text-input').value`), 'Alpha');
    });
    await record('rich_editor_append', async () => {
      await runJson(['type', '#text-input', 'Beta']);
      assert.equal(await pageEval(`document.querySelector('#text-input').value`), 'AlphaBeta');
    });
    await record('rich_editor_clear', async () => {
      await runJson(['type', '#textarea', 'Cleared', '--editor=textarea', '--clear-first']);
      assert.equal(await pageEval(`document.querySelector('#textarea').value`), 'Cleared');
    });
    await record('rich_editor_insert_code', async () => {
      await runJson(['type', '#editable', 'const x = 1;', '--editor=contentEditable', '--clear-first', '--code', '--lang=js']);
      assert.match(await pageEval(`document.querySelector('#editable').innerHTML`), /<pre>/);
    });
    await record('rich_editor_insert_at_cursor', async () => {
      await runJson(['type', '#editable', 'tail', '--editor=contentEditable']);
      assert.match(await pageEval(`document.querySelector('#editable').innerText`), /tail/);
    });

    await record('keyboard_unicode_paste', async () => {
      await runJson(['focus', '#text-input']);
      await runJson(['key', '--text=Ω']);
      assert.match(await pageEval(`document.querySelector('#text-input').value`), /Ω/);
    });
    await record('keyboard_chord', async () => {
      await runJson(['key', 'Ctrl+Enter']);
      const events = await pageEval('fixtureState.keydowns');
      assert.ok(events.some((event) => event.key === 'Enter' && event.ctrl));
    });
    await record('keyboard_sequence', async () => {
      await runJson(['key', 'ArrowDown', 'x2']);
      const events = await pageEval('fixtureState.keydowns');
      assert.ok(events.filter((event) => event.key === 'ArrowDown').length >= 2);
    });
    await record('select_dropdown_by_text', async () => {
      await runJson(['select', '#select-target', '--by-text=Two']);
      assert.equal(await pageEval(`document.querySelector('#select-target').value`), 'two');
    });
    await record('toggle_switch', async () => {
      await runJson(['click', '#switch-target']);
      assert.equal(await pageEval(`document.querySelector('#switch-target').checked`), true);
    });

    await record('upload_file', async () => {
      const upload = path.join(scratch, 'upload.txt');
      fs.writeFileSync(upload, 'upload fixture\n');
      await runJson(['upload', '#upload-target', upload]);
      assert.equal(await pageEval(`document.querySelector('#upload-target').files[0].name`), 'upload.txt');
    });

    await record('wait_until_selector_matches', async () => {
      await runJson(['wait', '--selector=#delayed-target', '--text=Ready', '--timeout=3000', '--poll=50']);
    });
    await record('wait_until_gone', async () => {
      await runJson(['wait', '--gone=#remove-target', '--timeout=3000', '--poll=50']);
    });
    await record('wait_until_matches_js', async () => {
      await runJson(['wait', '--matches=fixtureState.clicks >= 3', '--timeout=1000']);
    });
    await record('wait_until_stable', async () => {
      await runJson(['wait', '--selector=#heading', '--stable=100', '--timeout=2000', '--poll=25']);
    });
    await record('wait_url_matches', async () => {
      await runJson(['wait', `--url-matches=127\\.0\\.0\\.1:${new URL(fixture.baseUrl).port}`, '--timeout=1000']);
    });
    classify('wait_network_idle', 'PARTIAL', 'CLI now fails closed with exit 2 until relay Network event state is implemented');

    let frameId = null;
    await record('list_frames', async () => {
      const { body } = await runJson(['frames']);
      frameId = findFrameId(body.observation, '/frame');
      assert.ok(frameId, 'fixture child frame missing');
      return { frameId };
    });
    await record('iframe_scope_eval', async () => {
      assert.ok(frameId, 'frame ID unavailable');
      const { body } = await runJson(['frame-eval', frameId, `document.querySelector('#frame-value').innerText`]);
      assert.equal(body.observation, 'Frame value');
    });
    await record('shadow_root_sync_read', async () => {
      assert.equal(await pageEval(`document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-value').innerText`), 'Shadow value');
    });

    await record('a11y_snapshot', async () => {
      const { body } = await runJson(['a11y']);
      assert.ok(Array.isArray(body.observation));
      assert.ok(body.observation.length > 0);
      return { nodes: body.observation.length };
    });

    await record('safe_eval_args', async () => {
      const { body } = await runJson(['eval', '${K} + "!"', '--arg=K=value']);
      assert.equal(body.observation, 'value!');
    });
    await record('eval_await_promise', async () => {
      const { body } = await runJson(['eval', 'Promise.resolve("awaited")', '--await']);
      assert.equal(body.observation, 'awaited');
    });
    await record('run_cdp_on_backgrounded_tab', async () => {
      assert.equal(await pageEval('document.title'), 'Glider Capability Fixture');
    });

    await record('storage_set_get', async () => {
      await runJson(['storage', 'set', 'fixture-key', 'fixture value']);
      let result = await runJson(['storage', 'get', 'fixture-key']);
      assert.equal(result.body.observation, 'fixture value');
      result = await runJson(['storage', 'jar']);
      assert.equal(result.body.observation['fixture-key'], 'fixture value');
      result = await runJson(['storage', 'keys']);
      assert.ok(result.body.observation.includes('fixture-key'));
      await runJson(['storage', 'delete', 'fixture-key']);
      assert.equal(await pageEval(`localStorage.getItem('fixture-key')`), null);
    });

    await record('set_cookie', async () => {
      await runJson(['cookies', '--set=fixture_write=ok', `--url=${fixture.baseUrl}/`]);
      const { body } = await runJson(['cookies', `${fixture.baseUrl}/`, '--name', 'fixture_write', '--value']);
      assert.ok(body.observation.cookies.some((cookie) => cookie.name === 'fixture_write' && cookie.value === 'ok'));
    });
    await record('get_httponly_cookies', async () => {
      await requestJson('POST', '/extension', {
        method: 'setCookie',
        params: {
          url: `${fixture.baseUrl}/`,
          name: 'fixture_http_only',
          value: 'secret',
          httpOnly: true,
        },
      });
      const { body } = await runJson(['cookies', `${fixture.baseUrl}/`, '--name', 'fixture_http_only', '--value']);
      const cookie = body.observation.cookies.find((entry) => entry.name === 'fixture_http_only');
      assert.equal(cookie.value, 'secret');
      assert.equal(cookie.httpOnly, true);
    });
    await record('delete_cookie', async () => {
      await runJson(['cookies', '--delete=fixture_write', `--url=${fixture.baseUrl}/`]);
      const { body } = await runJson(['cookies', `${fixture.baseUrl}/`, '--name', 'fixture_write', '--value']);
      assert.equal(body.observation.cookies.length, 0);
    });

    await record('in_page_fetch', async () => {
      const { body } = await runJson(['fetch', `${fixture.baseUrl}/api`]);
      assert.equal(body.observation.data.ok, true);
    });
    await record('extension_cors_fetch', async () => {
      const { body } = await runJson(['cfetch', `${fixture.baseUrl}/api`]);
      assert.equal(body.observation.status, 200);
      assert.equal(body.observation.data.ok, true);
    });

    await record('dialog_auto_handle', async () => {
      await runJson(['dialog', 'auto', 'accept']);
      assert.equal(await pageEval(`confirm('fixture')`), true);
      await runJson(['dialog', 'auto', 'dismiss']);
      assert.equal(await pageEval(`confirm('fixture')`), false);
    });

    await record('history_back', async () => {
      await runJson(['goto', `${fixture.baseUrl}/page2`]);
      await runJson(['wait', '--selector=#page2', '--timeout=3000']);
      await runJson(['history', 'back']);
      await runJson(['wait', '--url-matches=/$', '--timeout=3000', '--poll=50']);
      assert.equal(await pageEval('document.title'), 'Glider Capability Fixture');
    });

    await record('emulate_timezone', async () => {
      await runJson(['emulate', 'tz', 'Asia/Tokyo']);
      assert.equal(await pageEval(`Intl.DateTimeFormat().resolvedOptions().timeZone`), 'Asia/Tokyo');
    });
    await record('emulate_geolocation', async () => {
      await runJson(['emulate', 'geo', '35.6762,139.6503,10']);
    });
    await record('emulate_viewport', async () => {
      await runJson(['emulate', 'viewport', '640x480,1,false']);
      assert.ok(await pageEval('window.innerWidth') <= 640);
    });
    await record('emulate_offline', async () => {
      await runJson(['emulate', 'offline', 'false']);
    });
    await record('emulate_ua', async () => {
      await runJson(['emulate', 'ua', 'GliderFixture/1.0']);
      assert.equal(await pageEval('navigator.userAgent'), 'GliderFixture/1.0');
    });
    await record('emulate_color_scheme', async () => {
      await runJson(['emulate', 'color-scheme', 'dark']);
      assert.equal(await pageEval(`matchMedia('(prefers-color-scheme: dark)').matches`), true);
    });

    await record('element_screenshot', async () => {
      const output = path.join(scratch, 'element.png');
      await runJson(['screenshot', output, '--selector=#heading']);
      assert.ok(fs.statSync(output).size > 100);
      return { bytes: fs.statSync(output).size };
    });
    await record('clip_screenshot', async () => {
      const output = path.join(scratch, 'clip.png');
      await runJson(['screenshot', output, '--clip=0,0,120,120']);
      assert.ok(fs.statSync(output).size > 100);
      return { bytes: fs.statSync(output).size };
    });
    await record('full_page_screenshot', async () => {
      const output = path.join(scratch, 'full.png');
      await runJson(['screenshot', output, '--full-page']);
      assert.ok(fs.statSync(output).size > 100);
      return { bytes: fs.statSync(output).size };
    });
    await record('pdf_export', async () => {
      const output = path.join(scratch, 'fixture.pdf');
      await runJson(['pdf', output, '--scale=0.8']);
      assert.ok(fs.statSync(output).size > 100);
      return { bytes: fs.statSync(output).size };
    });

    await record('session_liveness_probe', async () => {
      let result = await runJson(['use-session', sessionId]);
      assert.equal(result.body.observation.sessionId, sessionId);
      result = await runJson(['use-session', `--url=127.0.0.1:${new URL(fixture.baseUrl).port}`]);
      assert.equal(result.body.observation.sessionId, sessionId);
    });

    await record('attach_all_tabs', async () => {
      const result = await requestJson('POST', '/extension', {
        method: 'attachAllTabs',
        params: { urlSubstring: `127.0.0.1:${new URL(fixture.baseUrl).port}` },
      });
      assert.equal(typeof result.total_connected, 'number');
      return result;
    });
    classify('discard_hidden_tabs', 'SKIPPED_SAFETY', 'Global discard can affect operator tabs and is intentionally excluded from live smoke');

    await record('capture_har', async () => {
      const output = path.join(scratch, 'fixture.har');
      await runJson(['har', 'start', `${fixture.baseUrl}/`, '--session-id', sessionId]);
      const dump = await runJson(['har', 'dump', output], [0], 70000);
      assert.ok(fs.existsSync(output));
      const har = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.ok(Array.isArray(har.log.entries));
      return { entries: har.log.entries.length, command: dump.body.observation };
    });
    classify('replay_request', 'NOT_IMPLEMENTED', 'No public replay verb exists');
    classify('mock_response', 'PARTIAL', 'CLI fails closed with exit 2 until Fetch.requestPaused events are routed');
    classify('intercept_download', 'NOT_IMPLEMENTED', 'No public download interception verb exists');
    classify('console_tail', 'PARTIAL', 'CLI fails closed with exit 2 until Runtime.consoleAPICalled events are routed');

    await record('detect_frozen_tab', async () => {
      const result = await runJson(['frozen'], [0, 1]);
      assert.equal(result.body.ok, true);
      return result.body.observation;
    });
    await record('halt_background_tab_freeze', async () => {
      const result = await runJson(['freeze', '--force', '--verify']);
      assert.equal(result.body.ok, true, result.body.error);
      return result.body.observation;
    });
    await record('thaw_after_freeze', async () => {
      const result = await runJson(['thaw', '--verify']);
      assert.equal(result.body.ok, true, result.body.error);
      assert.equal(result.body.observation.asyncAlive, true);
      return result.body.observation;
    });
    await record('target_cleanup', async () => {
      const closingTarget = targetId;
      const result = await requestJson('POST', '/cdp', {
        method: 'Target.closeTarget',
        params: { targetId: closingTarget },
      });
      assert.equal(result.success, true);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const targets = await requestJson('GET', '/targets');
        if (!targets.some((target) => target.targetId === closingTarget)) {
          targetId = null;
          return { targetId: closingTarget, removedFromRelay: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`closed target remained in relay state: ${closingTarget}`);
    });
    {
      const before = await requestJson('GET', '/status');
      const raw = await runCli(['--json', 'reload-ext'], { env: cliEnv(), timeoutMs: 25000 });
      let body = null;
      try { body = jsonFromStdout(raw.stdout); } catch { body = null; }
      const after = await requestJson('GET', '/status');
      const err = body?.error || raw.stderr || '';
      if (
        raw.code === 0
        && body?.ok
        && after.extensionGeneration > before.extensionGeneration
      ) {
        report.results.extension_reload_self = {
          status: 'PASS',
          durationMs: 0,
          detail: {
            generationBefore: before.extensionGeneration,
            generationAfter: after.extensionGeneration,
            targets: after.targets,
          },
        };
      } else if (/connection never dropped|did not reload/i.test(String(err))) {
        // Some Chromium builds/profiles ack reloadSelf but never drop the WS
        // (policy / unpacked / Helium). CLI fail-closed is correct; live gate is env.
        classify(
          'extension_reload_self',
          'PARTIAL',
          'extension stayed connected after reloadSelf; chrome.runtime.reload may be blocked here'
        );
      } else {
        report.results.extension_reload_self = {
          status: 'FAIL',
          durationMs: 0,
          error: err || `reload-ext exited ${raw.code}`,
        };
      }
    }
  } finally {
    if (targetId) {
      try {
        await requestJson('POST', '/cdp', {
          method: 'Target.closeTarget',
          params: { targetId },
        });
      } catch {}
    }
    if (fixture) await fixture.close().catch(() => {});
    removeTree(gliderHome);
    removeTree(scratch);
  }

  const values = Object.values(report.results);
  report.finishedAt = new Date().toISOString();
  report.summary = values.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, { total: values.length });

  const rendered = JSON.stringify(report, null, 2) + '\n';
  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(path.resolve(REPORT_PATH)), { recursive: true });
    fs.writeFileSync(REPORT_PATH, rendered);
  }
  process.stdout.write(rendered);
  if (report.summary.FAIL) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
