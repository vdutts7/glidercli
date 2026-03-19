# Glider browser support and configuration

| | |
|---|---|
| **Install / usage** | [README](../README.md) |
| **How it works** | Chrome extension → WebSocket relay → CDP. Browser must support that extension (Chromium-based). |

---

## Browser support

| | Browser | Config |
|:---:|--------|--------|
| ✅ | Google Chrome | Default. Install extension from [Chrome Web Store](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj). |
| ✅ | Arc | `GLIDER_BROWSER=Arc` or [browser.json](../config/browser.json.example). Install extension from Chrome Web Store. |
| ✅ | Microsoft Edge | Install extension from Chrome Web Store. |
| ✅ | Brave | Install extension from Chrome Web Store. |
| ✅ | Opera | Install extension from Chrome Web Store. |
| ✅ | Vivaldi | Install extension from Chrome Web Store. |
| ✅ | DuckDuckGo Desktop | Install extension from Chrome Web Store. |
| ✅ | Other Chromium | Must support Chrome Web Store extensions. |

Chromium-based only; Firefox and Safari are not supported.

---

## Configuring the browser

**Priority (highest first):** env vars → config file → default `Google Chrome`.

### Environment variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `GLIDER_BROWSER` | App name (`open -a`, AppleScript) | `Arc`, `Google Chrome`, `Microsoft Edge` |
| `GLIDER_BROWSER_PATH` | (Optional) Path to app bundle | `/Applications/My Apps/Chrome.app` |
| `GLIDER_BROWSER_PROCESS` | (Optional) Process name for `pgrep` | Defaults to same as `GLIDER_BROWSER` |

**Examples:**

| Use case | Command |
|----------|---------|
| Arc | `export GLIDER_BROWSER=Arc` then `glider connect` |
| Custom Chrome path | `export GLIDER_BROWSER="Google Chrome"` and `export GLIDER_BROWSER_PATH="/Applications/My Apps/Google Chrome.app"` |

### Config file: `~/.glider/config/browser.json`

Same keys as env, or use a **registry key**. Env overrides file.

**Option A — Registry key (recommended):**

Set browser by key from the browsers registry. Run `glider use <key>` to write this.

```json
{
  "use": "arc"
}
```

Registry is loaded from (first found): `GLIDER_BROWSERS_REGISTRY` env, `~/.glider/config/browsers-registry.json`, `~/.glider/config/browsers-registry.json`. Keys are predefined (e.g. `arc`, `brave`, `chrome`, `edge`, `opera`, `vivaldi`, `duckduckgo`, `chromium`). Edit the registry to add or change paths.

**Option B — Explicit name/path:**

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
| Edge | `Microsoft Edge` | — | `Microsoft Edge` |
| Chrome (custom) | `Google Chrome` | `/Users/me/Applications/Google Chrome.app` | `Google Chrome` |
| DuckDuckGo | `DuckDuckGo` | — | `DuckDuckGo` |

Check app name in Finder/Spotlight; process name: `ps aux | grep -i <name>`.

---

## Browser registry (keymap)

A single registry file can define all Chromium browsers; Glider picks one by key.

**Registry location (first found):**

- `GLIDER_BROWSERS_REGISTRY` (env, path to JSON file)
- `~/.glider/config/browsers-registry.json`
- `~/.glider/config/browsers-registry.json`

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
| `glider use arc` | Set `~/.glider/config/browser.json` to `{ "use": "arc" }` (resolved from registry). |
| `glider use brave` | Switch to Brave. |
| `glider use` | Show current key and list of registry keys. |
| `glider browser` | Show resolved name, path, processName (and `use` key if set). |

Add or edit entries in the registry to match your machine (e.g. custom install paths). Keys are stable; point Glider at one by name.

---

## Platform

| Platform | Behavior |
|----------|----------|
| macOS | `open -a "<name>"` or `open "<path>"`; AppleScript for tab/window. `name` = exact app name. |
| Linux / Windows | Not fully implemented. Future: `path` may be executable. |

---

## Summary

| Topic | Detail |
|-------|--------|
| Supported | Chromium-based + Chrome Web Store extension (see table above). |
| Not supported | Firefox, Safari, non-Chromium. |
| Configure | `~/.glider/config/browser.json` (use key or name/path) and/or `GLIDER_BROWSER*`. Registry: `~/.glider/config/browsers-registry.json` or `GLIDER_BROWSERS_REGISTRY`. |
| Switch | `glider use <key>` (e.g. `glider use arc`, `glider use brave`). |
| Path | Optional; use when app is not in default location. |

---

[← README](../README.md)
