<div align="center">

<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp?v=1791987543" alt="glider" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp?v=1791987543" alt="chrome" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/claude.webp?v=1791987543" alt="claude" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/ralph-wiggum.webp?v=1791987543" alt="ralph" width="80" height="80" />

<h1 align="center">glider CLI</h1>
<p align="center"><i>Attach to the logged-in Chromium tab. Keep the page out of the agent context window.</i></p>

<a href="https://github.com/vdutts7/glidercli"><img src="./assets/badges/github.badge.svg?v=1791987543" alt="GitHub" height="40" /></a>
<a href="https://www.npmjs.com/package/glidercli"><img src="./assets/badges/npm.badge.svg?v=1791987543" alt="glidercli on npm" height="40" /></a>

</div>

<br/>

## Table of Contents

<ol>
    <a href="#problem">Problem</a><br/>
    <a href="#approach">Approach</a><br/>
    <a href="#setup">Setup</a><br/>
    <a href="#browsers">Browsers</a><br/>
    <a href="#commands">Commands</a><br/>
    <a href="#contact">Contact</a>
</ol>

<br/>

`glidercli` → relay at `ws://127.0.0.1:19988` → [`Glider extension`](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) → CDP on your tab.

## Problem

| | | [Playwright MCP](https://playwright.dev/docs/getting-started-mcp) | glider |
|:---:|---|---|---|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp?v=1791987543" width="40" height="40" alt=""> | access | cold profile. no SSO/MFA/cookies | [`Glider` extension](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) on the tab you already logged into |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/playwright.webp?v=1791987543" width="40" height="40" alt=""> | tokens | a11y tree on every navigate/click/type ([quote](https://playwright.dev/docs/getting-started-mcp)) | `glider snapshot` when asked. 200-node cap ([`bsnapshot.js`](lib/bsnapshot.js)) |

| | 1 snapshot | 9 calls | 200K window ([quote](https://platform.claude.com/docs/en/build-with-claude/context-windows)) | 1M window ([quote](https://claude.com/blog/1m-context-ga)) |
|---|---|---|---|---|
| Playwright MCP | ~13.8K tok | 124.3K tok ([quote](https://dev.to/ji_ai/playwright-mcp-token-usage-9-tool-calls-62-of-my-context-4on2)) | 62% | 12% |
| glider (cap) | ~4.0K tok (16,142 chars/4) | ~36.3K tok | 18% | 4% |

- large-page MCP snapshots: 50KB-540KB; 2-3 visits overflow ([quote](https://github.com/microsoft/playwright-mcp/issues/1233))
- 2 of 9 Playwright snapshots in that signup flow were byte-identical ([quote](https://dev.to/ji_ai/playwright-mcp-token-usage-9-tool-calls-62-of-my-context-4on2))

## Approach

| | Step | What |
|:---:|------|------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp?v=1791987543" width="40" height="40" alt=""> | 1 | extension in the live profile |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp?v=1791987543" width="40" height="40" alt=""> | 2 | CLI -> relay `ws://127.0.0.1:19988`. `glider eval`, `glider snapshot`, `glider loop` |

---

## Setup

```bash
npm i -g glidercli
glider install
glider connect
```

| Step | Action |
|------|--------|
| CLI | `npm i -g glidercli` |
| Extension | [`Glider` on Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) in the profile you automate |
| Daemon | `glider install` |
| Session | `glider connect` (once per browser launch) |

Node 18+. Chromium-based browser with the extension enabled (see Browsers).

---

## Browsers

Extension + relay model uses Chromium + Glider extension from Chrome Web Store in the same profile as `glider connect`.

| | Browser | Config |
|:---:|--------|--------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp?v=1791987543" width="40" height="40" alt=""> | Google Chrome | `glider config browser chrome` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/microsoft-edge.webp?v=1791987543" width="40" height="40" alt=""> | Microsoft Edge | `glider config browser edge` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/brave.webp?v=1791987543" width="40" height="40" alt=""> | Brave | `glider config browser brave` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/opera-gx.webp?v=1791987543" width="40" height="40" alt=""> | Opera | `glider config browser opera` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/vivaldi.webp?v=1791987543" width="40" height="40" alt=""> | Vivaldi | `glider config browser vivaldi` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/helium.webp?v=1791987543" width="40" height="40" alt=""> | Helium | `glider config browser helium` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/arc.webp?v=1791987543" width="40" height="40" alt=""> | Arc | `glider config browser arc` |

Not supported today: Firefox/Safari/WebKit/Gecko, DuckDuckGo, browsers without Chrome Web Store extension path.

### Browser config

CLI or the file. One shape.

```bash
glider config browser chrome
```

writes `{ "use": "chrome" }` to `$GLIDER/config/browser.json`. Chrome is the default. `glider config browser` lists the same commands.

macOS launch. Linux/Windows: planned.

---

## Task files

```yaml
name: hn-front
steps:
  goto: "https://news.ycombinator.com"
  wait: 2
  eval: "document.title"
  screenshot: "/tmp/hn.png"
```

---

## Usage

```bash
glider config browser chrome
glider install
glider connect
glider goto "https://news.ycombinator.com"
glider tabs
glider loop hn-scrape.yaml
```

| Output | Path |
|--------|------|
| daemon log | `~/.glider/daemon.log` |
| domain index | `~/.glider/config/domains.json` |
| per-host intel | `~/.glider/warch/HOST/glider.json` |
| explore cache | `~/.glider/bexplore/HOST/` |

| Env | Default | Role |
|-----|---------|------|
| `GLIDER` | `~/.glider` | home: config, cache, warch |

Copy `config/domains.template.json` into `~/.glider/config/domains.json` to seed the host index.

---

## Tabs

`glider tabs` is the visible Helium rail, not the debugger map. TUI (0.4.20): `[n]` title, URL, then `status: attached` (lime) or `status: not attached` (dim). Debugger-only rows `status: attached`; dropped map rows `status: stale`. Machines: `glider --json tabs` (`attached` boolean on each window tab).

1. current window `chrome.tabs` (live title/url, including `chrome://newtab`)
2. other windows
3. attached: CDP session not in `chrome.tabs`
4. stale: `tabId` gone from `chrome.tabs`; dropped from the relay map

Incognito is Chromium `windows.Window.incognito` and `tabs.Tab.incognito` only. TUI: `window N (current, incognito)`. Enable Allow in Incognito on the extension. CDP `browserContextId` is not that flag.

`glider targets` stays the raw CDP session list.

Old relay without GET `/catalog` is recycled by `glider start`, `glider heal`, and the daemon (SIGTERM the child; supervisor respawns current `bserve.js`). `listTabs` fail reloads the extension and attach-all.

CLI 0.4.18 expects an extension with `listTabs` plus `incognito` on tabs/windows (github [`vdutts7/glider`](https://github.com/vdutts7/glider) 1.0.10, or Chrome Web Store after that upload). Store 1.0.9 lacks `listTabs`; windows stay empty and live CDP rows sit under attached.

---

## Gotchas

| problem | fix | stability | why |
|---------|-----|-----------|-----|
| extension not connected | install/enable [`Glider` on Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) in selected browser profile; click Glider icon, then run `glider connect` | per browser launch | relay waits on extension WS |
| extension socket up but worker dead | click Glider icon or `glider reload` | MV3 worker | status refuses healthy until pong |
| daemon / `glider start` refuses after a killed supervisor | run `glider start` or `glider install` again (0.4.15+ reaps dead claim tombstones when nothing listens) | session-stable | crash/SIGKILL left `daemon-*.claim` without a live owner |
| `glider tabs` dumps old CDP pages | `glider start` or `glider heal` (0.4.17 recycles a relay that does not advertise `/catalog`) | session | node does not hot-load `bserve.js` |
| `glider tabs` has empty windows | load Glider 1.0.10 from [`vdutts7/glider`](https://github.com/vdutts7/glider) or CWS after upload (needs `listTabs`) | until CWS 1.0.10 | Chrome Web Store 1.0.9 lacks that RPC |
| incognito window has no `(incognito)` tag | Allow in Incognito on the extension, then reload; CLI 0.4.18 | per profile | Chromium hides those windows until that toggle |
| custom relay port has no extension | stay on `19988` with Chrome Web Store build | install-stable | published extension connects to `ws://localhost:19988/extension` |
| wrong tab targeted | `glider targets` → `glider use-session session-6` | session-stable | multi-tab needs explicit session |
| explore HAR empty bodies | replay in-tab with auth hook on XHR/fetch | site-specific | some SPAs never expose bearer in storage |
| `resolve` misses host | add `~/.glider/warch/HOST/glider.json` | file-stable | per-host capture hints |

---

## Commands

| Command | Description |
|---------|-------------|
| `glider install` | background relay supervisor |
| `glider uninstall` | remove supervisor |
| `glider config browser chrome` | set browser |
| `glider connect` | attach relay to browser |
| `glider status` | server + extension + tabs |
| `glider doctor` | relay + SW + targets |
| `glider tabs` | chrome.tabs by window (incognito tag), then attached, then stale |
| `glider heal` | recycle stale relay, wake SW, reattach |
| `glider reload` | pin extension |
| `glider goto` | navigate |
| `glider eval` | run JS |
| `glider click` | click |
| `glider type` | type |
| `glider screenshot` | PNG |
| `glider frozen` | detect frozen tab |
| `glider thaw` | unfreeze tab |
| `glider explore` | crawl + HAR |
| `glider resolve` | host warch |
| `glider run` | YAML task |
| `glider loop` | loop until marker |

---

## Verification

```bash
node --check bin/glider.js && node --check lib/bserve.js
node --test tests/*.test.js
node tests/live-browser.smoke.js  # isolated live-browser fixture
```

Live smoke creates + closes its own browser window.

Incomplete event-stream features fail closed: `wait --network-idle`, console streaming, response fulfillment. No success-shaped fallback.

---

## Roadmap

| status | item |
|--------|------|
| done | CDP relay, YAML tasks, loop, daemon, multi-tab, `resolve`, `glider tabs` catalog |
| planned | Linux and Windows browser launch |
| | headless cloud mode |
| | task chaining |

---

## Contact

<a href="https://vd7.io"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910810/readme-badges/readme-badge-vd7.png?v=1791987543" alt="vd7.io" height="40" /></a> &nbsp; <a href="https://x.com/vdutts7"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910817/readme-badges/readme-badge-x.png?v=1791987543" alt="/vdutts7" height="40" /></a>
