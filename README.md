# glidercli

Browser automation with autonomous loops. Run tasks until done.

```bash
npm i -g glidercli
```

## What it does

Control Chrome from terminal. Run YAML tasks. Loop until complete (Ralph Wiggum pattern).

```bash
glider status                    # check connection
glider goto "https://x.com"      # navigate
glider eval "document.title"     # run JS
glider run task.yaml             # execute task file
glider loop task.yaml -n 50      # autonomous loop
```

## The Loop

The `loop` command runs your task repeatedly until:
- Completion marker found (`LOOP_COMPLETE` or `DONE`)
- Max iterations reached
- Timeout hit

```bash
glider loop scrape-feed.yaml -n 100 -t 3600
```

Safety: max iterations, timeout, exponential backoff on errors, state persistence.

## Task Files

```yaml
name: "Get timeline"
steps:
  - goto: "https://x.com/home"
  - wait: 3
  - eval: "document.querySelectorAll('article').length"
  - screenshot: "/tmp/timeline.png"
```

## Commands

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

## Requirements

- Node 18+
- Chrome with Glider extension
- bserve relay server

## Install

```bash
npm i -g glidercli
# or
npm i -g @vd7/glider
```

Both install the `glider` command.

## License

MIT
