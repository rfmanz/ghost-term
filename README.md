# ghost-term

A cyberpunk web terminal with looping video backgrounds, CRT effects, multi-tab support, and Claude Code auto-launch. Runs as a local Node.js server and opens in Chrome's `--app` mode for a clean, fullscreen terminal experience.

![aesthetic](https://img.shields.io/badge/aesthetic-cyberpunk-00e5ff?style=flat-square) ![platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)

https://github.com/user-attachments/assets/7dc27d11-256a-4331-8928-a8699b401eb1

## What it does

- **Web-based terminal** using xterm.js over WebSocket, backed by `node-pty`
- **Video backgrounds** — looping `.mp4` clips behind the terminal with scanlines, vignette, and CRT-style post-processing
- **Multi-tab** — create, close, and switch between terminal sessions (Alt+1-9, Alt+T, Ctrl+W)
- **Claude Code integration** — auto-launches `claude` on startup; tabs pulse purple while Claude is thinking, amber when waiting for input
- **Markdown renderer** — converts `.md` files to styled HTML with the same cyberpunk aesthetic (`node render.js`)
- **Hot-swappable clips** — switch background video at runtime via API or Claude Code slash command

## Prerequisites

- **Node.js** 18+ (for the server)
- **Google Chrome** (opened in `--app` mode for borderless fullscreen)
- **Git LFS** (video clips are stored with LFS)
- **Windows** (launch script is a `.bat` file; the server itself is cross-platform)

## Setup

```bash
# 1. Clone the repo (LFS pulls video clips automatically)
git clone https://github.com/rfmanz/ghost-term.git
cd ghost-term

# 2. Install dependencies
npm install

# 3. (Optional) Create a Start Menu shortcut
powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
```

### Video clips

Clips live in `clips/` and are tracked by Git LFS. After cloning, verify they downloaded:

```bash
git lfs pull          # if clips show as pointer files
ls -lh clips/         # should show actual file sizes (9 MB – 344 MB)
```

To add your own clips, drop an `.mp4` into `clips/`. LFS tracking is already configured for `clips/*.mp4`.

## Configuration

Edit `config.json` in the project root:

```jsonc
{
  "port": 3000,                                          // server port
  "shell": "C:\\Program Files\\Git\\usr\\bin\\bash.exe", // shell executable
  "shellArgs": ["-l"],                                   // shell arguments
  "video": "clips/gits_combined.mp4",                    // default background clip (relative to project root)
  "autoCommand": "claude --effort max"                   // command auto-typed into first tab on launch (remove to disable)
}
```

| Field | Description |
|---|---|
| `port` | HTTP/WebSocket port. Default `3000`. |
| `shell` | Absolute path to shell binary. Use Git Bash on Windows, `/bin/bash` on Linux/macOS. |
| `shellArgs` | Arguments passed to the shell. `["-l"]` gives a login shell. |
| `video` | Path to the default `.mp4` background clip (relative or absolute). |
| `autoCommand` | A command to auto-type after the shell prompt appears. Set to `""` or remove to disable. |

## Usage

### Quick start

Double-click **`launch.bat`** (or use the Start Menu shortcut).

This script handles everything:
1. If the server is already running and a browser window is connected → opens a **new tab** in the existing window
2. If the server is running but no browser → opens a **new Chrome window**
3. If the server is not running → kills any stale process on port 3000, starts the server, waits for it to be healthy, then opens Chrome

### Start Menu shortcut

Running `create-shortcut.ps1` places a **Ghost Term** shortcut in your Windows Start Menu (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Ghost Term.lnk`) that points to `launch.bat`. This means you can press **Win**, type **Ghost Term**, and hit Enter to launch.

The shortcut runs `launch.bat`, which is smart about the current state:

| State | What happens |
|---|---|
| Server running + browser connected | Opens a **new tab** in the existing window (via `/api/new-tab`) |
| Server running + no browser | Opens a **new Chrome window** in `--app` mode |
| Server not running | Kills any stale process on port 3000, starts the server in the background, waits for it to be healthy, then opens Chrome |

Chrome is launched with `--app` (borderless), `--start-fullscreen`, and a dedicated `--user-data-dir` so it doesn't interfere with your normal Chrome profile.

### Manual start

```bash
# Start the server
node server.js
# → ghost-term running at http://localhost:3000

# Open Chrome in app mode
chrome --app=http://localhost:3000 --start-fullscreen --force-device-scale-factor=1.75
```

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt + 1–9 | Switch to tab N |
| Alt + T | New tab |
| Ctrl + W | Close current tab |
| Shift + Up/Down | Scroll by line |
| Shift + PageUp/PageDown | Scroll by page |
| Ctrl + R / F5 | Reload |
| F11 | Toggle fullscreen |
| Alt + A | Send Ctrl+A (readline: beginning of line) |
| Alt + K | Send Ctrl+K (readline: kill to end of line) |

### Switching background video

**From Claude Code** (if working directory is this repo):

```
/background-video
```

**Via API:**

```bash
# List available clips
curl http://localhost:3000/api/videos

# Switch clip
curl -X POST http://localhost:3000/api/set-video \
  -H "Content-Type: application/json" \
  -d '{"clip":"matrix_clip.mp4"}'
```

**Included clips:**

| Clip | Filename | Size |
|---|---|---|
| Ghost in the Shell (full) | `gits-full.mp4` | ~344 MB |
| Frieren: Beyond Journey's End | `Amazing Shots of FRIEREN： BEYOND JOURNEY'S END.mp4` | ~124 MB |
| The Matrix | `matrix_clip.mp4` | ~17 MB |
| GITS (combined short) | `gits_combined.mp4` | ~16 MB |

### Markdown renderer

Convert any `.md` file to a styled HTML page with the same cyberpunk aesthetic:

```bash
# Output to stdout
node render.js notes.md

# Write to file
node render.js notes.md output.html

# Write to output/ and open in Chrome fullscreen
node render.js notes.md --open
```

## API reference

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check — returns `{ ok, pid, clients }` |
| `/config` | GET | Public config (just `{ video: bool }`) |
| `/video` | GET | Stream the current background video (supports range requests) |
| `/api/videos` | GET | List available clips and current selection |
| `/api/set-video` | POST | Switch background video — body: `{ "clip": "filename.mp4" }` |
| `/api/new-tab` | POST | Open a new tab in all connected browsers — body: `{ "name": "tab-name" }` |
| `/api/rename-tab` | POST | Rename a tab — body: `{ "name": "new-name", "index": 0 }` |
| `/events` | GET | SSE stream for real-time browser notifications |

## Architecture

```
ghost-term/
├── server.js          # Express + WebSocket + node-pty server
├── config.json        # Runtime configuration
├── launch.bat         # Windows launcher (handles server lifecycle + Chrome)
├── create-shortcut.ps1 # Creates a Start Menu shortcut
├── render.js          # Markdown → cyberpunk HTML converter
├── package.json
├── public/
│   ├── index.html     # Terminal UI shell
│   ├── style.css      # CRT effects, tab bar, theme
│   ├── terminal.js    # xterm.js setup, tabs, keyboard, SSE, state detection
│   └── favicon.svg
├── templates/
│   └── narrative.html # Template for rendered markdown pages
├── clips/             # Background video clips (Git LFS)
│   ├── gits-full.mp4
│   ├── matrix_clip.mp4
│   └── ...
└── .claude/
    └── commands/
        └── background-video.md  # /background-video slash command
```

## Setting up on a new machine

```bash
# 1. Install prerequisites
#    - Node.js 18+: https://nodejs.org
#    - Git LFS:     git lfs install
#    - Chrome:      https://google.com/chrome

# 2. Clone and install
git clone https://github.com/rfmanz/ghost-term.git
cd ghost-term
npm install

# 3. Configure your shell path in config.json
#    Windows (Git Bash): "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
#    Linux/macOS:        "/bin/bash" or "/bin/zsh"

# 4. (Optional) Adjust autoCommand — set to "" to disable Claude auto-launch
#    "autoCommand": "claude --effort max"

# 5. Verify LFS clips downloaded
git lfs pull
ls -lh clips/

# 6. Launch
#    Windows: double-click launch.bat
#    Other:   node server.js, then open http://localhost:3000 in Chrome

# 7. (Optional) Create Start Menu shortcut (Windows)
powershell -ExecutionPolicy Bypass -File create-shortcut.ps1

# 8. (Optional) Install the /background-video Claude Code command globally
#    Copy .claude/commands/background-video.md to ~/.claude/commands/
```
