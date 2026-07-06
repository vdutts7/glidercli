<div align="center">

<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp" alt="glider" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" alt="chrome" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/claude.webp" alt="claude" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/ralph-wiggum.webp" alt="ralph" width="80" height="80" />

<h1 align="center">glider CLI</h1>
<p align="center"><i><b>Browser automation CLI with autonomous loop execution</b></i></p>

<a href="https://github.com/vdutts7/glidercli"><img src="./assets/badges/github.badge.svg" alt="GitHub" height="34" /></a>
<a href="https://www.npmjs.com/package/glidercli"><img src="./assets/badges/npm.badge.svg" alt="glidercli on npm" height="34" /></a>

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
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" width="16" alt=""> | Google Chrome | default for `glider connect` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/arc.webp" width="16" alt=""> | Arc | [`config/browser.json.example`](config/browser.json.example) |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/microsoft/microsoft-edge.webp" width="16" alt=""> | Microsoft Edge | registry key `edge` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/brave.webp" width="16" alt=""> | Brave | registry key `brave` |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/vivaldi.webp" width="16" alt=""> | Vivaldi | registry key `vivaldi` |

Not supported today: Firefox/Safari/WebKit/Gecko, DuckDuckGo, browsers without Chrome Web Store extension path.

### Browser config

Priority: `~/.glider/config/browser.json` → default Google Chrome.

Registry key (recommended):

```json
{ "use": "arc" }
```

Registry file: `~/.glider/config/browsers-registry.json`

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
| `AGREGISTRY` | unset | optional registry root → warch at `$AGREGISTRY/warch/HOST/` |

Copy `config/domains.template.json` into `~/.glider/config/domains.json` to seed the host index.

---

## Gotchas

| problem | fix | stability | why |
|---------|-----|-----------|-----|
| extension not connected | click Glider icon in toolbar → `glider connect` | per Chrome launch | relay waits on extension WS |
| wrong tab targeted | `glider targets` → `glider use-session session-6` | session-stable | multi-tab needs explicit session |
| explore HAR empty bodies | replay in-tab with auth hook on XHR/fetch | site-specific | some SPAs never expose bearer in storage |
| `resolve` misses host | add `~/.glider/warch/HOST/glider.json` or set `AGREGISTRY` | file-stable | optional per-host capture hints |

---

## Commands

| Command | Description |
|---------|-------------|
| `glider install` / `uninstall` | daemon at login |
| `glider connect` | attach relay to browser |
| `glider status` | server, extension, tabs |
| `glider goto` / `eval` / `click` / `type` | page ops |
| `glider screenshot` | PNG capture |
| `glider explore` | crawl + HAR |
| `glider resolve` | host → local warch intel (`--json`) |
| `glider run` / `loop` | YAML task / Ralph loop |

Full surface: `glider --help`

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

[![`vd7.io`](https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910810/readme-badges/readme-badge-vd7.png)](https://vd7.io)

[![`@vdutts7`](https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910817/readme-badges/readme-badge-x.png)](https://x.com/vdutts7)
