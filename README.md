<div align="center">

<img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1768050242/gh-repos/glidercli/code.png" alt="logo" width="80" height="80" />
<img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1768050244/gh-repos/glidercli/github.png" alt="logo" width="80" height="80" />

<h1 align="center">glidercli</h1>
<p align="center"><i><b>Browser automation CLI with autonomous loop execution.</b></i></p>

[![Github][github]][github-url]
[![npm][npm]][npm-url]

<img src="https://res.cloudinary.com/ddyc1es5v/image/upload/v1768050244/gh-repos/glidercli/social-preview.png" />

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
```

### Requirements

- Node 18+
- Chrome with Glider extension
- bserve relay server

## 🚀Usage

```bash
glider status                    # check connection
glider goto "https://x.com"      # navigate
glider eval "document.title"     # run JS
glider run task.yaml             # execute task file
glider loop task.yaml -n 50      # autonomous loop
```

## 🔄The Loop

The `loop` command runs your task repeatedly until:
- Completion marker found (`LOOP_COMPLETE` or `DONE`)
- Max iterations reached
- Timeout hit

```bash
glider loop scrape-feed.yaml -n 100 -t 3600
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
| `glider status` | Server/extension/tab status |
| `glider start` | Start relay server |
| `glider goto <url>` | Navigate |
| `glider eval <js>` | Execute JavaScript |
| `glider click <sel>` | Click element |
| `glider type <sel> <text>` | Type into input |
| `glider screenshot` | Capture page |
| `glider run <file>` | Run YAML task |
| `glider loop <file>` | Autonomous loop |

## 🔧Tools Used

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
[nodejs-badge]: https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white
[nodejs-url]: https://nodejs.org
[cdp-badge]: https://img.shields.io/badge/Chrome_DevTools_Protocol-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white
[cdp-url]: https://chromedevtools.github.io/devtools-protocol/
[email]: https://img.shields.io/badge/Email-000000?style=for-the-badge&logo=Gmail&logoColor=white
[email-url]: mailto:me@vd7.io
[twitter]: https://img.shields.io/badge/Twitter-000000?style=for-the-badge&logo=Twitter&logoColor=white
[twitter-url]: https://twitter.com/vaboratory
