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

## ToC

<ol>
    <a href="#about">About</a><br/>
    <a href="#install">Install</a><br/>
    <a href="#usage">Usage</a><br/>
    <a href="#the-loop">The loop</a><br/>
    <a href="#task-files">Task files</a><br/>
    <a href="#commands">Commands</a><br/>
    <a href="#roadmap">Roadmap</a><br/>
    <a href="#tools-used">Tools</a><br/>
    <a href="#contact">Contact</a>
</ol>

<br/>

## About

Control Chrome from terminal. Run YAML tasks. Loop until complete (Ralph Wiggum pattern).

- **CDP-based** - Direct Chrome DevTools Protocol (CDP) control
- **YAML tasks** - Define automation steps declaratively  
- **Autonomous loops** - Run until completion marker found
- **Safety guards** - Max iterations, timeout, exponential backoff

## Install

```bash
npm i -g glidercli
glider install    # start daemon (runs forever, auto-restarts)
```

### Requirements

1. **Node 18+**

2. **Glider Chrome extension** - [Install from Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj)

## Usage

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

## The loop

The `loop` (or `ralph`) command runs your task repeatedly until:
- Completion marker found (`LOOP_COMPLETE` or `DONE`)
- Max iterations reached
- Timeout hit

```bash
glider loop scrape-feed.yaml -n 100 -t 3600
glider ralph task.yaml  # same thing
```

Safety: max iterations, timeout, exponential backoff on errors, state persistence.

## Task files

```yaml
name: "Get timeline"
steps:
  - goto: "https://x.com/home"
  - wait: 3
  - eval: "document.querySelectorAll('article').length"
  - screenshot: "/tmp/timeline.png"
```

## Commands

### Setup
| Command | What |
|---------|------|
| `glider install` | Install daemon (runs at login) |
| `glider uninstall` | Remove daemon |
| `glider connect` | Connect to browser |
| `glider status` | Server/extension/tab status |
| `glider test` | Run diagnostics |

### Navigation
| Command | What |
|---------|------|
| `glider goto <url>` | Navigate |
| `glider eval <js>` | Execute JavaScript |
| `glider click <sel>` | Click element |
| `glider type <sel> <text>` | Type into input |
| `glider screenshot` | Capture page |
| `glider html <sel>` | Get element HTML |
| `glider title` | Get page title |
| `glider text` | Get page text |

### Multi-tab
| Command | What |
|---------|------|
| `glider fetch <url>` | Fetch URL with browser session (authenticated) |
| `glider spawn <urls...>` | Open multiple tabs |
| `glider extract [opts]` | Extract content from all connected tabs |
| `glider explore <url>` | Crawl site, capture links/network |

### Automation
| Command | What |
|---------|------|
| `glider run <file>` | Run YAML task |
| `glider loop <file>` | Autonomous loop |
| `glider ralph <file>` | Alias for loop |

## Roadmap

- [x] CDP-based browser control via relay
- [x] YAML task file execution
- [x] Ralph Wiggum autonomous loop pattern
- [x] Daemon mode (auto-start, auto-restart)
- [x] macOS notifications
- [x] Multi-tab orchestration (spawn, extract)
- [x] Authenticated fetch via browser session
- [x] Site exploration/crawling
- [x] Chrome Web Store extension publish
- [ ] Linux support
- [ ] Windows support
- [ ] Headless mode
- [ ] Task chaining (output of one -> input of next)
- [ ] Built-in scraping templates
- [ ] Session recording/playback
- [ ] AI-assisted task generation
- [ ] Web dashboard for monitoring loops

## Tools

[![Claude Code][claudecode-badge]][claudecode-url]
[![Claude][claude-badge]][claude-url]
[![Node.js][nodejs-badge]][nodejs-url]
[![Chrome DevTools Protocol][cdp-badge]][cdp-url]

## Contact


<a href="https://vd7.io"><img src="https://img.shields.io/badge/website-000000?style=for-the-badge&logo=data:image/webp;base64,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&logoColor=white" alt="website" /></a>
<a href="https://x.com/vdutts7"><img src="https://img.shields.io/badge/vdutts7-000000?style=for-the-badge&logo=X&logoColor=white" alt="Twitter" /></a>


<!-- BADGES -->
[github]: https://img.shields.io/badge/glidercli-000000?style=for-the-badge&logo=github
[github-url]: https://github.com/vdutts7/glidercli
[npm]: https://img.shields.io/badge/npm%20i%20--g%20glidercli-CB3837?style=for-the-badge&logo=npm
[npm-url]: https://www.npmjs.com/package/glidercli
[claudecode-badge]: https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white
[claudecode-url]: https://claude.ai/code
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
