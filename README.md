<div align="center">

<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp" alt="glider" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" alt="chrome" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/claude.webp" alt="claude" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/ralph-wiggum.webp" alt="ralph" width="80" height="80" />

<h1 align="center">glider CLI</h1>
<p align="center"><i><b>Browser automation CLI with autonomous loop execution</b></i></p>

<a href="https://github.com/vdutts7/glidercli"><img src="./assets/badges/github.badge.svg" alt="GitHub" height="40" /></a>
<a href="https://www.npmjs.com/package/glidercli"><img src="./assets/badges/npm.badge.svg" alt="glidercli on npm" height="40" /></a>

</div>

<br/>

---

| | headless CDP | extension relay (glider) |
|---|--------------|---------------------------|
| logged-in tab / SSO | ❌ cold profile | ✅ attach to open tab |
| corp / MFA sessions | ❌ re-auth wall | ✅ reuse browser cookies |
| loop until done | manual glue | ✅ `glider loop` + markers |

`glidercli` → relay at `ws://127.0.0.1:19988` → [`Glider extension`](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) → CDP on your tab.

---

## Issue

| failure mode | symptom |
|--------------|---------|
| ❌ cold profile launch | SSO/MFA breaks on internal sites; no logged-in tab to drive |
| ❌ raw CDP without bridge | extension must relay debugger traffic from real Chromium profile |
| ❌ cookie-only terminal fetch | cross-origin API hosts often 401 without in-tab bearer |
| ❌ one-shot scripts only | no first-class loop with iteration cap, timeout, completion marker |

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
|---|--------|--------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" width="40" height="40" alt=""> | Google Chrome | default for `glider connect` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/arc.webp" width="40" height="40" alt=""> | Arc | [`config/browser.json.example`](config/browser.json.example) |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/microsoft/microsoft-edge.webp" width="40" height="40" alt=""> | Microsoft Edge | registry key `edge` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/brave.webp" width="40" height="40" alt=""> | Brave | registry key `brave` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/vivaldi.webp" width="40" height="40" alt=""> | Vivaldi | registry key `vivaldi` |

Not supported today: Firefox/Safari/WebKit/Gecko, DuckDuckGo, browsers without Chrome Web Store extension path.

### Browser config

Priority: `$GLIDER_HOME/config/browser.json` → `$GLIDER_HOME/browser.json` → default Google Chrome.

Registry key (recommended):

```json
{ "use": "arc" }
```

Registry file: `$GLIDER_HOME/config/browsers-registry.json`

```bash
glider use arc
glider browser
```

Explicit name/path:

```json
{
  "name": "Arc",
  "path": "/Applications/Arc.app",
  "processName": "Arc"
}
```

| Command | Effect |
|---------|--------|
| `glider use arc` | write `{ "use": "arc" }` to `browser.json` |
| `glider use` | list registry keys |
| `glider browser` | show resolved name, path, process |

macOS: `open -a` / AppleScript. Linux/Windows: partial, on roadmap.

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
glider connect
glider status
glider goto "https://news.ycombinator.com"
glider eval "document.title"
glider run `hn-scrape.yaml`
glider loop `hn-scrape.yaml` -n 50 -m hn_scrape_done
```

```bash
# per-host capture hints (optional)
glider resolve https://news.ycombinator.com --json
```

| Output | Path |
|--------|------|
| daemon log | `~/.glider/daemon.log` |
| domain index | `~/.glider/config/domains.json` |
| per-host intel | `~/.glider/warch/HOST/glider.json` |
| explore cache | `~/.glider/bexplore/HOST/` |

| Env | Default | Role |
|-----|---------|------|
| `GLIDER_HOME` | `~/.glider` | config, cache, warch tree |
| `GLIDER_PORT` | `19988` | relay port for CLI + helpers; non-default values require matching extension configuration |
| `GLIDER_NODE_BIN` | auto-detected | Node.js 18+ executable for background relay supervisor |
| `GLIDER_RELOAD_TIMEOUT_MS` | `15000` | extension reload/reconnect deadline |
| `GLIDER_CDP_TIMEOUT_MS` | `30000` | per-request CDP/extension timeout |
| `GLIDER_RELAY_RECONNECT_GRACE_MS` | `10000` | keep cached targets while extension WS flaps |
| `GLIDER_RELAY_COMMAND_RECONNECT_WAIT_MS` | `3000` | wait for extension before failing a command |
| `GLIDER_RELAY_MAX_PENDING` | `256` | max in-flight extension requests |
| `GLIDER_TIMING` | unset | set `1` to always attach `timing` on `--json` output |
| `AGREGISTRY` | unset | optional registry root → warch at `AGREGISTRY/warch/HOST/` |

Copy `config/domains.template.json` into `~/.glider/config/domains.json` to seed the host index.

---

## Gotchas

| problem | fix | stability | why |
|---------|-----|-----------|-----|
| extension not connected | install/enable [`Glider` on Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) in selected browser profile; click Glider icon, then run `glider connect` | per browser launch | relay waits on extension WS |
| extension socket up but worker dead | `glider heal` (opens extension URL to wake SW); else click Glider icon / `glider reload-ext`; `glider doctor --json` shows `nextAction` | MV3 worker | status refuses healthy until pong |
| custom relay port has no extension | use `19988` with Chrome Web Store build | install-stable | published extension connects to `ws://localhost:19988/extension` |
| wrong tab targeted | `glider targets` → `glider use-session session-6` | session-stable | multi-tab needs explicit session |
| explore HAR empty bodies | replay in-tab with auth hook on XHR/fetch | site-specific | some SPAs never expose bearer in storage |
| `resolve` misses host | add `~/.glider/warch/HOST/glider.json` or set `AGREGISTRY` | file-stable | optional per-host capture hints |

---

## Commands

| Command | Description |
|---------|-------------|
| `glider install` / `uninstall` | background relay supervisor |
| `glider connect` | attach relay to browser |
| `glider status` | server + extension + tabs; nonzero unless full stack is healthy |
| `glider doctor` | relay + SW + targets + one next action (`--json`) |
| `glider heal` | ensure relay, best-effort SW wake, optional `--clear-pin` |
| `glider test` | relay + extension + target + live CDP `1+1` diagnostic |
| `glider goto` / `eval` / `click` / `type` | page ops |
| `glider frozen` / `thaw` | detect / un-throttle a hidden (macrotask-frozen) tab in place |
| `glider screenshot` | PNG capture |
| `glider explore` | crawl + HAR |
| `glider resolve` | host → local warch intel (`--json`) |
| `glider run` / `loop` | YAML task / Ralph loop |

Full surface: `glider --help`

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

<a href="https://vd7.io"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910810/readme-badges/readme-badge-vd7.png" alt="vd7.io" height="40" /></a> &nbsp; <a href="https://x.com/vdutts7"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910817/readme-badges/readme-badge-x.png" alt="/vdutts7" height="40" /></a>
