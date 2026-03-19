<div align="center">

<img src="assets/icons/glider-blue-squircle.webp" alt="glider" width="80" height="80" />
<img src="assets/icons/chrome.webp" alt="chrome" width="80" height="80" />
<img src="assets/icons/claude.webp" alt="claude" width="80" height="80" />
<img src="assets/icons/ralph-wiggum.webp" alt="ralph" width="80" height="80" />

<h1 align="center">glidercli</h1>
<p align="center"><i><b>Browser automation CLI with autonomous loop execution.</b></i></p>

[![Github][github]][github-url]
[![npm][npm]][npm-url]

</div>

<br/>

## About

| | |
|---|---|
| **What** | Control a Chromium-based browser from the terminal via CDP; run YAML tasks; loop until done (Ralph Wiggum pattern). |
| **CDP** | Chrome DevTools Protocol via relay + browser extension |
| **Tasks** | Declarative steps: `goto`, `click`, `explore`, `eval`, `screenshot` |
| **Loops** | Run until completion marker or max iterations / timeout |
| **Safety** | Max iterations, timeout, backoff |

---

## Install

| Step | Action |
|------|--------|
| **1. CLI** | `npm i -g glidercli` |
| **2. Extension** | [Install Glider from Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) (required; bridges relay ↔ tab). |
| **3. Daemon** | `glider install` then `glider connect` |
| **4. (Optional) Browser** | Default: Chrome. For Arc/Edge/Brave: [BROWSERS.md](docs/BROWSERS.md) or `export GLIDER_BROWSER=Arc` |


## Requirements

| Requirement | Minimum |
|-------------|---------|
| Node | 18+ |
| Browser | Chromium-based (Chrome, Arc, Edge, Brave, Opera, Vivaldi, DuckDuckGo). No Firefox/Safari → [BROWSERS.md](docs/BROWSERS.md) |

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

Full list: `glider --help`.

---

## Docs

| Doc | Contents |
|-----|----------|
| This README | Install, usage, commands |
| [docs/BROWSERS.md](docs/BROWSERS.md) | Which browsers work; browser name/path (env or `~/.glider/config/browser.json`) |
| [config/browser.json.example](config/browser.json.example) | Example browser config |

---

## Roadmap

| Status | Area |
|--------|------|
| Done | CDP relay + extension, YAML tasks, loop, daemon, multi-tab |
| Todo | Linux / Windows, headless, task chaining, scraping templates |

---

## Contact

<a href="https://vd7.io"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910810/readme-badges/readme-badge-vd7.png" alt="vd7.io" height="40" /></a> &nbsp; <a href="https://x.com/vdutts7"><img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1773910817/readme-badges/readme-badge-x.png" alt="/vdutts7" height="40" /></a>


<!-- BADGES -->
[github]: https://img.shields.io/badge/glidercli-000000?style=for-the-badge&logo=github
[github-url]: https://github.com/vdutts7/glidercli
[npm]: https://img.shields.io/badge/npm%20i%20--g%20glidercli-CB3837?style=for-the-badge&logo=npm
[npm-url]: https://www.npmjs.com/package/glidercli
