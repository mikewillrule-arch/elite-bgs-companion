# Elite BGS Companion

A lightweight Windows desktop app that sits in your system tray while you play Elite Dangerous and keeps your squadron's Background Simulation (BGS) dashboard up to date in real time.

## What It Does

Elite BGS Companion watches your Elite Dangerous journal directory for game events missions completed, combat, trade, exploration, faction influence changes  and forwards them to your squadron's BGS dashboard as they happen. You get a small overlay window that stays on top of the game, showing the live dashboard without needing to alt-tab.

That's it. It reads files. It sends what it reads to your server. Nothing else.


## What Files It Reads

Elite Dangerous writes a set of well-documented files to your journal directory as you play. This app reads those files and nothing else:

| File | Contents |
|------|----------|
| `Journal.*.log` | Main event log  missions, combat, docking, jumps, etc. |
| `Market.json` | Commodity prices at the current station |
| `Status.json` | Current ship/pilot status |
| `NavRoute.json` | Plotted navigation route |
| `Outfitting.json` | Ship modules available at the current station |
| `Shipyard.json` | Ships available at the current station |
| `Cargo.json` | Current cargo manifest |

All of these are standard files that Elite Dangerous itself writes. The companion only reads them  it never writes to them or modifies them in any way.

## Features

- **System tray icon** — runs quietly in the background, accessible from the taskbar notification area
- **Global hotkey** — press `Ctrl+Shift+B` at any time to show or hide the overlay
- **Auto-detection** — the overlay appears automatically when Elite Dangerous is running and hides itself 5 minutes after the game closes
- **Draggable overlay** — position it anywhere on screen; the position is saved between sessions
- **Adjustable opacity** — tune how transparent the overlay is so it doesn't distract from the game
- **First-run setup wizard** — walks you through entering your squadron slug and confirming the journal directory

## Building from Source

If you prefer to build the app yourself rather than using a release binary:

```bash
# Clone the repository
git clone https://github.com/your-org/elite-bgs-companion.git
cd elite-bgs-companion

# Install dependencies
npm install

# Build a distributable installer
npm run build
```

The build uses [electron-builder](https://www.electron.build/) and produces a standard Windows installer in the `dist/` folder. You can audit every line of source before building.

## Tech Stack

- [Electron](https://www.electronjs.org/) cross-platform desktop shell
- Node.js — file watching, HTTP forwarding
- No bundled AI, no bundled browser extensions, no third-party analytics

The renderer (overlay) loads your squadron's BGS dashboard directly from the configured server URL  it is just a normal web page displayed in an Electron window, the same content you would see if you opened that URL in a browser.

## Security and Privacy

This app is deliberately minimal in what it touches:

- **Local file access** is limited to the Elite Dangerous journal directory (configurable) and the app's own config file stored in your user data folder (`%APPDATA%\elite-bgs-companion\`).
- **Network access** consists of a single outbound HTTP connection to the configured BGS server URL (default: `https://elite-bgs.store`). No other network calls are made. No telemetry, no analytics, no third-party services.
- **No elevated privileges** are required. The app runs as a normal user-space process.
- **The full source code is in this repository.** Every line of what runs on your machine is here for you to read. If something looks wrong, open an issue or submit a PR.

If you are cautious about running third-party software alongside a game — which is a perfectly reasonable position  the fastest way to verify the app's behaviour is to read `main.js`, `preload.js`, and `journal-watcher.js`. Those three files contain everything the app does.

## Configuration

On first launch the setup wizard will ask for:

1. **Squadron slug** — the short identifier for your squadron on the BGS dashboard (e.g. `my-squadron`)
2. **Server URL** — defaults to `https://elite-bgs.store`; change this if you are self-hosting
3. **Journal directory** — auto-detected on most systems; you can override it manually if needed

Settings are stored in `%APPDATA%\elite-bgs-companion\config.json`.

## License

MIT — see [LICENSE](LICENSE) for details.
