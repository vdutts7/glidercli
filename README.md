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

## Table of Contents

<ol>
    <a href="#about">📝 About</a><br/>
    <a href="#install">💻 Install</a><br/>
    <a href="#usage">🚀 Usage</a><br/>
    <a href="#the-loop">🔄 The Loop</a><br/>
    <a href="#task-files">📄 Task Files</a><br/>
    <a href="#commands">⚡ Commands</a><br/>
    <a href="#roadmap">🗺️ Roadmap</a><br/>
    <a href="#tools-used">🔧 Tools used</a><br/>
    <a href="#contact">👤 Contact</a>
</ol>

<br/>

## 📝About

Control Chrome from terminal. Run YAML tasks. Loop until complete (Ralph Wiggum pattern).

- **CDP-based** - Direct Chrome DevTools Protocol control
- **YAML tasks** - Define automation steps declaratively  
- **Autonomous loops** - Run until completion marker found
- **Safety guards** - Max iterations, timeout, exponential backoff

## 💻Install

```bash
npm i -g glidercli
glider install    # start daemon (runs forever, auto-restarts)
```

### Requirements

1. **Node 18+**

2. **Glider Chrome Extension** - [glider](https://github.com/vdutts/glider) *(Chrome Web Store pending)*
   - Clone repo, load unpacked in `chrome://extensions`

## 🚀Usage

```bash
glider connect                   # connect to browser
glider status                    # check connection
glider goto "https://x.com"      # navigate
glider eval "document.title"     # run JS
glider run task.yaml             # execute task file
glider loop task.yaml -n 50      # autonomous loop
```

### Daemon

The daemon keeps the relay server running 24/7. Auto-restarts on crash.

```bash
glider install     # install daemon (runs at login)
glider uninstall   # remove daemon
```

Logs: `~/.glider/daemon.log`

## 🔄The Loop

The `loop` (or `ralph`) command runs your task repeatedly until:
- Completion marker found (`LOOP_COMPLETE` or `DONE`)
- Max iterations reached
- Timeout hit

```bash
glider loop scrape-feed.yaml -n 100 -t 3600
glider ralph task.yaml  # same thing
```

Safety: max iterations, timeout, exponential backoff on errors, state persistence.

## 📄Task Files

```yaml
name: "Get timeline"
steps:
  - goto: "https://x.com/home"
  - wait: 3
  - eval: "document.querySelectorAll('article').length"
  - screenshot: "/tmp/timeline.png"
```

## ⚡Commands

| Command | What |
|---------|------|
| `glider install` | Install daemon (runs at login) |
| `glider uninstall` | Remove daemon |
| `glider connect` | Connect to browser |
| `glider status` | Server/extension/tab status |
| `glider start` | Start relay server |
| `glider goto <url>` | Navigate |
| `glider eval <js>` | Execute JavaScript |
| `glider click <sel>` | Click element |
| `glider type <sel> <text>` | Type into input |
| `glider screenshot` | Capture page |
| `glider html <sel>` | Get element HTML |
| `glider title` | Get page title |
| `glider run <file>` | Run YAML task |
| `glider loop <file>` | Autonomous loop |
| `glider ralph <file>` | Alias for loop |
| `glider test` | Run diagnostics |

## 🗺️Roadmap

- [x] CDP-based browser control via relay
- [x] YAML task file execution
- [x] Ralph Wiggum autonomous loop pattern
- [x] Daemon mode (auto-start, auto-restart)
- [x] macOS notifications
- [ ] Chrome Web Store extension publish
- [ ] Linux support
- [ ] Windows support
- [ ] Headless mode
- [ ] Multi-tab orchestration
- [ ] Task chaining (output of one -> input of next)
- [ ] Built-in scraping templates
- [ ] Session recording/playback
- [ ] AI-assisted task generation
- [ ] Web dashboard for monitoring loops

## 🔧Tools Used

[![Claude][claude-badge]][claude-url]
[![Node.js][nodejs-badge]][nodejs-url]
[![Chrome DevTools Protocol][cdp-badge]][cdp-url]

## 👤Contact

[![Email][email]][email-url]
[![Twitter][twitter]][twitter-url]

<!-- BADGES -->
[github]: https://img.shields.io/badge/💻_glidercli-000000?style=for-the-badge
[github-url]: https://github.com/vdutts7/glidercli
[npm]: https://img.shields.io/badge/npm-glidercli-CB3837?style=for-the-badge&logo=npm
[npm-url]: https://www.npmjs.com/package/glidercli
[claude-badge]: https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white
[claude-url]: https://claude.ai
[nodejs-badge]: https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white
[nodejs-url]: https://nodejs.org
[cdp-badge]: https://img.shields.io/badge/Chrome_DevTools_Protocol-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white
[cdp-url]: https://chromedevtools.github.io/devtools-protocol/
[email]: https://img.shields.io/badge/Email-000000?style=for-the-badge&logo=Gmail&logoColor=white
[email-url]: mailto:me@vd7.io
[twitter]: https://img.shields.io/badge/Twitter-000000?style=for-the-badge&logo=Twitter&logoColor=white
[twitter-url]: https://x.com/vdutts7
