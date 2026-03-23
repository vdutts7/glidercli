<div align="center">

<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/glider.webp" alt="glider" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" alt="chrome" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/claude.webp" alt="claude" width="80" height="80" />
<img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/ralph-wiggum.webp" alt="ralph" width="80" height="80" />

<h1 align="center">glider CLI</h1>
<p align="center"><i><b>Browser automation CLI with autonomous loop execution</b></i></p>

<a href="https://github.com/vdutts7/glidercli"><img src="./assets/badges/github.badge.svg" alt="GitHub" height="34" /></a> &nbsp; <a href="https://www.npmjs.com/package/glidercli"><img src="./assets/badges/npm.badge.svg" alt="npm install" height="34" /></a>

</div>

<br/>

## About

| | |
|---|---|
| **What** | Control a **Chromium-based** browser from the terminal via CDP, run YAML tasks, and loop until done (Ralph Wiggum pattern) |
| **CDP** | Chrome DevTools Protocol via relay + browser extension |
| **Tasks** | Declarative steps: `goto`, `click`, `explore`, `eval`, `screenshot` |
| **Loops** | Run until completion marker or max iterations / timeout |
| **Safety** | Max iterations, timeout, backoff |

---

## Install

| Step | Action |
|------|--------|
| **1. CLI** | `npm i -g glidercli` |
| **2. Extension** | [Install Glider from Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) in the same browser/profile you will automate (required, bridges relay ↔ tab) |
| **3. Daemon** | `glider install` then `glider connect` |
| **4. Browser (required setup)** | Configure supported browser/profile + extension in the **Browsers** section below. |


## Requirements

| Requirement | Minimum |
|-------------|---------|
| Node | 18+ |
| Browser | Chromium-based (Chrome, Arc, Edge, Brave, Opera, Vivaldi) with the Glider extension installed/enabled in that browser profile. No Firefox/Safari/DuckDuckGo |

---

## Browsers

| | |
|---|---|
| **How it works** | Chrome extension → WebSocket relay → CDP. Browser must support that extension (Chromium-based). |

### Browser support

**Extension:** Install [Glider](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) from the Chrome Web Store in each browser/profile you plan to automate

| | Browser | Config |
|:---:|--------|--------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" width="16" alt=""> | Google Chrome | Default for `glider connect`|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/arc.webp" width="16" alt=""> | Arc | [browser.json](config/browser.json.example) (`{ "use": "arc" }`) |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/microsoft/microsoft-edge.webp" width="16" alt=""> | Microsoft Edge | n/a |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/brave.webp" width="16" alt=""> | Brave | n/a |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/operagx.webp" width="16" alt=""> | Opera | n/a |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/vivaldi.webp" width="16" alt=""> | Vivaldi | n/a |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chromium.webp" width="16" alt=""> | Other Chromium | Must support installing extensions from the Chrome Web Store. |

### Future

- not supported today
- Glider needs a **Chromium-based** browser that can install the extension from the **Chrome Web Store**
- no timeline implied- listed for clarity


| | Browser | Notes |
|:---:|--------|--------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/firefox.webp" width="16" alt=""> | Firefox | **Gecko** (Firefox engine). Not Chromium, Glider uses a Chrome Web Store extension + CDP |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/firefox-focus.webp" width="16" alt=""> | Firefox Focus | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/firefox.webp" width="16" alt=""> | Firefox Klar | Gecko (Focus branding in some regions)- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/librewolf.webp" width="16" alt=""> | LibreWolf | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/waterfox.webp" width="16" alt=""> | Waterfox | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/zen.webp" width="16" alt=""> | Zen | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/floorp.webp" width="16" alt=""> | Floorp | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/tor-browser.webp" width="16" alt=""> | Tor Browser | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/mullvad-browser.webp" width="16" alt=""> | Mullvad Browser | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/icecat.webp" width="16" alt=""> | IceCat | Gecko- same constraints as Firefox |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/safari.webp" width="16" alt=""> | Safari | WebKit (Apple desktop). Not Chromium |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/orion.webp" width="16" alt=""> | Orion | WebKit-based desktop browser. Not Chromium |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chatgpt-atlas.webp" width="16" alt=""> | ChatGPT Atlas | AI-first browser, not in Glider’s supported Chromium + CWS model today |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/perplexity-comet.webp" width="16" alt=""> | Perplexity Comet | AI-first browser, not in Glider’s supported Chromium + CWS model today |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/bromite.webp" width="16" alt=""> | Bromite | Chromium-derived, no practical Chrome Web Store path for Glider |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chromium.webp" width="16" alt=""> | Chromite | Chromium-derived, no practical Chrome Web Store path for Glider |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/grapheneos.webp" width="16" alt=""> | Vanadium | Chromium-derived (GrapheneOS), no practical Chrome Web Store path for Glider |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/duckduckgo.webp" width="16" alt=""> | DuckDuckGo | No practical Chrome Web Store extension install path for Glider |

### Configuring the browser

**Priority (highest first):** config file -> default `Google Chrome`

#### Config file: `$HOME/.glider/config/browser.json`

Use a **registry key** or explicit name/path in the file

**Option A- Registry key (recommended):**

Set browser by key from the browsers registry. Run `glider use <key>` to write this.

```json
{
  "use": "arc"
}
```

Registry is loaded from (first found): `$HOME/.glider/config/browsers-registry.json`, `$HOME/.glider/config/browsers-registry.json`. Keys are predefined (e.g. `arc`, `brave`, `chrome`, `edge`, `opera`, `vivaldi`, `chromium`). Edit the registry to add or change paths

**Option B- Explicit name/path:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `name` | Yes* | App name for `open -a` / AppleScript. Must match system (e.g. `Arc`, `Google Chrome`). |
| `path` | No | If set, use `open "<path>"` instead of `open -a "<name>"`. For non-default install location. |
| `processName` | No | For `pgrep -x`. Defaults to `name`. |

\* Omit `name` when using `use` (registry key).

**Example:**

```json
{
  "name": "Arc",
  "path": "/Applications/Arc.app",
  "processName": "Arc"
}
```

**By browser:**

| Browser | `name` | `path` (optional) | `processName` (optional) |
|---------|--------|-------------------|---------------------------|
| Arc | `Arc` | `/Applications/Arc.app` | `Arc` |
| Edge | `Microsoft Edge` | n/a | `Microsoft Edge` |
| Chrome (custom) | `Google Chrome` | `/Users/me/Applications/Google Chrome.app` | `Google Chrome` |

Check app name in Finder/Spotlight, process name: `ps aux | grep -i <name>`

### Browser registry (keymap)

A single registry file can define all Chromium browsers, Glider picks one by **key**

**Registry location (first found):**

- `$HOME/.glider/config/browsers-registry.json`
- `$HOME/.glider/config/browsers-registry.json`

**Registry format:**

```json
{
  "version": "1.0",
  "registry": {
    "arc": { "name": "Arc", "path": "/Applications/Arc.app", "processName": "Arc" },
    "brave": { "name": "Brave Browser", "path": "/Applications/Brave Browser.app", "processName": "Brave Browser" },
    "chrome": { "name": "Google Chrome", "path": "/Applications/Google Chrome.app", "processName": "Google Chrome" },
    "edge": { "name": "Microsoft Edge", "path": "/Applications/Microsoft Edge.app", "processName": "Microsoft Edge" }
  }
}
```

**Commands:**

| Command | Effect |
|---------|--------|
| `glider use arc` | Set `$HOME/.glider/config/browser.json` to `{ "use": "arc" }` (resolved from registry). |
| `glider use brave` | Switch to Brave. |
| `glider use` | Show current key and list of registry keys. |
| `glider browser` | Show resolved name, path, processName (and `use` key if set). |

Add or edit entries in the registry to match your machine (e.g. custom install paths). Keys are stable, point Glider at one by name.

### Platform

| Platform | Behavior |
|----------|----------|
| macOS | `open -a "<name>"` or `open "<path>"`, AppleScript for tab/window. `name` = exact app name |
| Linux / Windows | Not fully implemented. Future: `path` may be executable. |

### Browser summary

| Topic | Detail |
|-------|--------|
| Supported | Chromium-based + Chrome Web Store extension (see table above). |
| Not supported | See **Future** in this README. |
| Configure | `$HOME/.glider/config/browser.json` (use key or name/path). Registry: `$HOME/.glider/config/browsers-registry.json` or `$HOME/.glider/config/browsers-registry.json` |
| Switch | `glider use <key>` (e.g. `glider use arc`, `glider use brave`). |
| Path | Optional, use when app is not in default location |

---

## Usage

```bash
glider connect
glider status
glider goto "https://reddit.com"
glider eval "document.title"
glider run task.yaml
glider loop task.yaml -n 50
```

| Daemon | Logs |
|--------|------|
| `glider install` / `glider uninstall` | `~/.glider/daemon.log` |

---

## Task files

```yaml
name: "Reddit"
steps:
 - goto: "https://reddit.com"
 - wait: 2
 - eval: "document.title"
 - screenshot: "/tmp/out.png"
```

---

## Commands

| Command | Description |
|---------|-------------|
| `glider install` | Install daemon (relay at login) |
| `glider uninstall` | Remove daemon |
| `glider connect` | Connect to browser |
| `glider status` | Server / extension / tabs |
| `glider browser` | Show browser config (name, path) |
| `glider goto <url>` | Navigate |
| `glider eval <js>` | Run JS in page |
| `glider click <sel>` | Click element |
| `glider type <sel> <text>` | Type into input |
| `glider screenshot [path]` | Capture page |
| `glider run <file>` | Run YAML task |
| `glider loop <file> [-n N]` | Loop until done or limit |

Full list: `glider --help`

---

## Docs

| Doc | Contents |
|-----|----------|
| This README | Install, usage, commands, full browser support/config |
| [config/browser.json.example](config/browser.json.example) | Example browser config |

---

## Roadmap

- [x] CDP relay + extension, YAML tasks, loop, daemon, multi-tab
- [ ] Linux / Windows
- [ ] headless (cloud)
- [ ] task chaining
- [ ] crawling templates

---

## Contact

<a href="https://vd7.io"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910810/readme-badges/readme-badge-vd7.png" alt="vd7.io" height="40" /></a> &nbsp; <a href="https://x.com/vdutts7"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910817/readme-badges/readme-badge-x.png" alt="/vdutts7" height="40" /></a>
