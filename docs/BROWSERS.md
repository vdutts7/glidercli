# Glider browser support and configuration

| | |
|---|---|
| **Install / usage** | [README](../README.md) |
| **How it works** | Chrome extension → WebSocket relay → CDP. Browser must support that extension (Chromium-based). |

---

## Browser support

Icons: `https://raw.githubusercontent.com/vdutts7/squircle/main/webp/{slug}.webp` ([squircle](https://github.com/vdutts7/squircle)).

**Extension:** Install [Glider](https://chromewebstore.google.com/detail/glider/njbidokkffhgpofcejgcfcgcinmeoalj) from the Chrome Web Store — same for every browser in this table.

| | Browser | Config |
|:---:|--------|--------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chrome.webp" width="16" alt=""> | Google Chrome | Default for `glider connect`. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/arc.webp" width="16" alt=""> | Arc | `GLIDER_BROWSER=Arc` or [browser.json](../config/browser.json.example). |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/microsoft/microsoft-edge.webp" width="16" alt=""> | Microsoft Edge | — |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/brave.webp" width="16" alt=""> | Brave | — |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/opera-gx.webp" width="16" alt=""> | Opera | — |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/vivaldi.webp" width="16" alt=""> | Vivaldi | — |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/duckduckgo.webp" width="16" alt=""> | DuckDuckGo Desktop | — |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chromium.webp" width="16" alt=""> | Other Chromium | Must support installing extensions from the Chrome Web Store. |

See **[Future](#future)** for browsers not supported today.

---

## Future

Not supported today: Glider needs a **Chromium-based** browser that can install the extension from the **Chrome Web Store**. No timeline implied; listed for clarity.

Same icon base as above: `https://raw.githubusercontent.com/vdutts7/squircle/main/webp/{slug}.webp`.

| | Browser | Notes |
|:---:|--------|--------|
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/firefox.webp" width="16" alt=""> | Firefox | **Gecko** (Firefox engine). Not Chromium; Glider uses a Chrome Web Store extension + CDP. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/librewolf.webp" width="16" alt=""> | LibreWolf | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/waterfox.webp" width="16" alt=""> | Waterfox | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/zen.webp" width="16" alt=""> | Zen | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/floorp.webp" width="16" alt=""> | Floorp | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/tor-browser.webp" width="16" alt=""> | Tor Browser | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/mullvad-browser.webp" width="16" alt=""> | Mullvad Browser | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/icecat.webp" width="16" alt=""> | IceCat | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/firefox-focus.webp" width="16" alt=""> | Firefox Focus | Gecko — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/firefox.webp" width="16" alt=""> | Firefox Klar | Gecko (Focus branding in some regions) — same constraints as Firefox. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/safari.webp" width="16" alt="">  | Safari | WebKit (Apple desktop). Not Chromium. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/orion.webp" width="16" alt=""> | Orion | WebKit-based desktop browser. Not Chromium. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chatgpt-atlas.webp" width="16" alt=""> | ChatGPT Atlas | AI-first browser; not in Glider’s supported Chromium + CWS model today. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/perplexity-comet.webp" width="16" alt=""> | Perplexity Comet | AI-first browser; not in Glider’s supported Chromium + CWS model today. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/bromite.webp" width="16" alt=""> | Bromite | Chromium-derived; no practical Chrome Web Store path for Glider. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/chromium.webp" width="16" alt=""> | Chromite | Chromium-derived; no practical Chrome Web Store path for Glider. |
| <img src="https://raw.githubusercontent.com/vdutts7/squircle/main/webp/grapheneos.webp" width="16" alt=""> | Vanadium | Chromium-derived (GrapheneOS); no practical Chrome Web Store path for Glider. |

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

### Config file: `$HOME/.glider/config/browser.json`

Same keys as env, or use a **registry key**. Env overrides file.

**Option A — Registry key (recommended):**

Set browser by key from the browsers registry. Run `glider use <key>` to write this.

```json
{
  "use": "arc"
}
```

Registry is loaded from (first found): `GLIDER_BROWSERS_REGISTRY` env, `$HOME/.glider/config/browsers-registry.json`, `$HOME/.glider/config/browsers-registry.json`. Keys are predefined (e.g. `arc`, `brave`, `chrome`, `edge`, `opera`, `vivaldi`, `duckduckgo`, `chromium`). Edit the registry to add or change paths.

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
| Not supported | See [Future](#future). |
| Configure | `$HOME/.glider/config/browser.json` (use key or name/path) and/or `GLIDER_BROWSER*`. Registry: `$HOME/.glider/config/browsers-registry.json` or `GLIDER_BROWSERS_REGISTRY`. |
| Switch | `glider use <key>` (e.g. `glider use arc`, `glider use brave`). |
| Path | Optional; use when app is not in default location. |

---

[← README](../README.md)
