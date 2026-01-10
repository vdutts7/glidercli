# 🚀 @vd7/glider

Browser automation CLI with autonomous loop execution. Control Chrome via CDP, run YAML task files, execute in Ralph Wiggum loops.

## Install

```bash
npm install -g @vd7/glider
```

### Requirements

- Node.js 18+
- [bserve](https://github.com/vdutts/glider-crx) relay server
- Glider Chrome extension

## Quick Start

```bash
# Check status
glider status

# Navigate
glider goto "https://google.com"

# Execute JavaScript
glider eval "document.title"

# Run a task file
glider run mytask.yaml

# Run in autonomous loop
glider loop mytask.yaml -n 20
```

## Commands

### Server
| Command | Description |
|---------|-------------|
| `glider status` | Check server, extension, tabs |
| `glider start` | Start relay server |
| `glider stop` | Stop relay server |

### Navigation
| Command | Description |
|---------|-------------|
| `glider goto <url>` | Navigate to URL |
| `glider eval <js>` | Execute JavaScript |
| `glider click <selector>` | Click element |
| `glider type <sel> <text>` | Type into input |
| `glider screenshot [path]` | Take screenshot |
| `glider text` | Get page text |

### Automation
| Command | Description |
|---------|-------------|
| `glider run <task.yaml>` | Execute YAML task file |
| `glider loop <task> [opts]` | Run in Ralph Wiggum loop |

## Task File Format

```yaml
name: "Get page data"
steps:
  - goto: "https://example.com"
  - wait: 2
  - eval: "document.title"
  - click: "button.submit"
  - type: ["#input", "hello world"]
  - screenshot: "/tmp/shot.png"
  - assert: "document.title.includes('Example')"
  - log: "Done"
```

## Ralph Wiggum Loop

The `loop` command implements autonomous execution:

```bash
glider loop mytask.yaml -n 20 -t 600 -m "DONE"
```

Options:
- `-n, --max-iterations N` - Max iterations (default: 10)
- `-t, --timeout N` - Max runtime in seconds (default: 3600)
- `-m, --marker STRING` - Completion marker (default: LOOP_COMPLETE)

The loop:
1. Executes task steps repeatedly
2. Checks for completion marker in output or task file
3. Stops when marker found or limits reached
4. Saves state to `/tmp/glider-state.json`
5. Implements exponential backoff on errors

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  glider CLI │────▶│   bserve    │────▶│  Extension  │
│  (this pkg) │     │  (relay)    │     │  (Chrome)   │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │   Browser   │
                    │    (CDP)    │
                    └─────────────┘
```

## License

MIT
