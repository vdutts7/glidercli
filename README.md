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
    <a href="#hidden-constraint">Hidden constraint</a><br/>
    <a href="#approach">Approach</a><br/>
    <a href="#setup">Setup</a><br/>
    <a href="#browsers">Browsers</a><br/>
    <a href="#commands">Commands</a><br/>
    <a href="#contact">Contact</a>
</ol>

<br/>

`glidercli` → relay at `ws://127.0.0.1:19988` → [`Glider extension`](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) → CDP on your tab.

## Problem

Two failures show up the first time an agent tries to drive a real browser:

**1. Access.** Headless CDP / Playwright launch a cold profile. SSO, MFA, and corp cookies are not there. The agent spends the session on a login wall.

**2. Tokens.** Even after you are in the page, [Playwright MCP](https://playwright.dev/docs/getting-started-mcp) still dumps the accessibility tree into the model on every navigate/click/type (structured snapshots, not pixels; every tool result includes the tree). That is not a screenshot problem. It is a context problem.

Measured Playwright MCP ([quote](https://dev.to/ji_ai/playwright-mcp-token-usage-9-tool-calls-62-of-my-context-4on2)):

- one app-screen `browser_snapshot`: **~13,800 tokens**
- nine tool calls in one signup flow: **124,300 tokens**
- that is **62% of a 200K window** before the agent finishes the form
- two of the nine snapshots were byte-identical

On large pages the same MCP has returned **50KB to 540KB** snapshots; two or three visits overflow the prompt ([quote](https://github.com/microsoft/playwright-mcp/issues/1233)).

Agent windows in use:

| Window | Who | 9 Playwright MCP calls (124,300 tok) |
|--------|-----|--------------------------------------|
| 200K | common agent default ([quote](https://platform.claude.com/docs/en/build-with-claude/context-windows)) | **62% gone** |
| 1M | current Sonnet/Opus class ([quote](https://claude.com/blog/1m-context-ga)) | **12% gone** on one form, still compounding every later click |

A bigger window delays the crash. It does not stop the tree from being copied into the chat on every action.

## Hidden constraint

[Playwright MCP](https://playwright.dev/docs/getting-started-mcp) presents as "use the browser." Under the hood it couples **action** to **full page state** ([quote](https://playwright.dev/docs/getting-started-mcp)):

| | Path | What the model receives | Cost to context |
|:---:|------|-------------------------|-----------------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/playwright.webp?v=1791987543" width="40" height="40" alt=""> | Playwright MCP | YAML a11y tree + `ref=` handles, every tool result ([quote](https://playwright.dev/docs/getting-started-mcp)) | ~13.8K tok/snapshot; 124.3K tok / 9 calls ([quote](https://dev.to/ji_ai/playwright-mcp-token-usage-9-tool-calls-62-of-my-context-4on2)) |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp?v=1791987543" width="40" height="40" alt=""> | glider | `glider snapshot`: url, title, up to 200 interactive nodes | cap **16,142 chars ≈ 4,036 tok** (chars/4) at 200 nodes |

**Core insight**: the token floor is attached to returning the whole tree, not to driving Chromium.

Glider snapshot is capped at 200 visible interactive nodes in [`lib/bsnapshot.js`](lib/bsnapshot.js). At the cap: 16,142 chars. Nine such snapshots ≤ **~36K tok** vs 124K tok for the same-length Playwright MCP loop.

| Loop (9 page reads) | 200K window | 1M window |
|---------------------|-------------|-----------|
| Playwright MCP 124,300 tok | 62% | 12% |
| glider snapshot at cap ~36,324 tok | 18% | 4% |

## Approach

| | Step | What | Fixes |
|:---:|------|------|-------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp?v=1791987543" width="40" height="40" alt=""> | 1 | [`Glider` extension](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) in the profile you already use | SSO/MFA/cookies stay. No cold profile. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp?v=1791987543" width="40" height="40" alt=""> | 2 | CLI talks to the relay (`ws://127.0.0.1:19988`), not to an MCP a11y dump | Agent sees `glider eval`, `glider snapshot`, YAML `glider loop`. Not 13.8K tok/click. |

Same Chromium. Logged-in tab. Compact page index when you ask for it.

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

## Gotchas

| problem | fix | stability | why |
|---------|-----|-----------|-----|
| extension not connected | install/enable [`Glider` on Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) in selected browser profile; click Glider icon, then run `glider connect` | per browser launch | relay waits on extension WS |
| extension socket up but worker dead | click Glider icon or `glider reload` | MV3 worker | status refuses healthy until pong |
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
| `glider heal` | wake SW, reattach |
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
npm test                 # unit, CLI regression, relay integration, tarball boundary
npm run test:live        # isolated live-browser fixture against the connected extension
npm run test:syntax      # package JavaScript syntax gate
```

Live smoke creates + closes its own browser window.

Incomplete event-stream features fail closed: `wait --network-idle`, console streaming, response fulfillment. No success-shaped fallback.

---

## Roadmap

| status | item |
|--------|------|
| done | CDP relay, YAML tasks, loop, daemon, multi-tab, `resolve` |
| planned | Linux and Windows browser launch |
| | headless cloud mode |
| | task chaining |

---

## Contact

<a href="https://vd7.io"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910810/readme-badges/readme-badge-vd7.png?v=1791987543" alt="vd7.io" height="40" /></a> &nbsp; <a href="https://x.com/vdutts7"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910817/readme-badges/readme-badge-x.png?v=1791987543" alt="/vdutts7" height="40" /></a>
