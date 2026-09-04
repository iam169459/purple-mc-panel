# 🟣 PurpleMC Panel

A self-hosted, web-based control panel for your Minecraft (Paper) server — with a neon sci-fi interface. Manage the full server lifecycle, watch live metrics, browse the console, install plugins, edit files, schedule tasks, and update the panel itself — all from the browser.

Built with **Node.js**, **Express**, **Socket.IO**, and a single-page frontend. No database required.

---

## ✨ Features

### 🖥️ Dashboard
- Live status, player, CPU, RAM, TPS and uptime cards with a holographic HUD look
- Circular SVG gauges with glow, animated CPU/RAM/TPS sparkline history
- Telemetry ticker, reactor-core status indicator and subsystem LEDs
- Storage breakdown per folder (click any folder to open it in the File Explorer), backups panel, and quick actions (broadcast, save-all, check TPS)

### 💬 Live Console
- Real-time streaming terminal over Socket.IO (color-coded log types)
- Filter chips (errors / warnings / chat / join-leave / system), live search, and line counter
- Command history with ↑/↓, one-click quick commands, copy & clear
- Smart auto-scroll with a "resume scroll" pause, memory-capped output

### 🗂️ File Manager
- Browse and edit server files in a built-in code editor (text files only)
- Create folders/files, upload to any folder, rename, delete with confirmation
- **Storage-aware browsing**: folders show their real recursive size (and file count on hover), sort the list by name or size, and a storage bar shows how much of the host disk the server uses
- Download single files or **any folder as a `.zip`** (worlds, plugins/, logs/ — streamed, no temp copy on disk)
- One-click jumps to every top-level folder — all worlds, plugins, config, logs, crash-reports, datapacks and more — so every in-game file is reachable in two clicks

### 🧩 Marketplace & Plugins
- Search Modrinth for Paper-compatible plugins right from the panel
- **Serialized install queue** — install several plugins safely, one at a time, with live speed/ETA
- Essential starter pack (LuckPerms, WorldEdit, EssentialsX, PlaceholderAPI, CoreProtect)
- Upload your own `.jar`s; installs work while the server is running (they load on restart)

### 👥 Players
- Live player list with locate, teleport-to-you, OP toggle, kick (with reason), and ban (with reason)

### ⏰ Scheduled Tasks
- Automate console commands, server restarts, and zip backups on any interval (persisted in `config/tasks.json`)

### 🚀 Server Management
- Start / stop / restart / kill, automatic restart after crashes
- Auto-downloads the latest Paper build and accepts the EULA on first boot
- server.properties editor (motd, difficulty, gamemode, ports…) with live apply
- Zip backups of worlds + plugins (retention pruning), crash-log viewer
- Port allocation and reachability checks (25565, 19132, etc.)

### 🔄 Self-Updating Panel
- The panel updates itself straight from this GitHub repository — **no local git clone required**
- Version checks compare **`version.json`** against the copy in the repo
- Updates stream live progress into the UI, preserve your `server/`, `config/`, `backups/` and `node_modules/`, prune obsolete files, and re-run `npm install` only when dependencies changed
- Runs under PM2? It restarts itself automatically after an update

---

## 📋 Requirements

| Dependency | Notes |
|---|---|
| **Node.js ≥ 18** | Node 20 LTS recommended (installed automatically by `install.sh`) |
| **Java 17+** | Required to run the Minecraft server (auto-detected) |
| **`zip` + `tar`** | Used for backups and panel updates (present on macOS/Linux; Git Bash on Windows has `tar`) |
| **~2 GB free RAM** | The Minecraft server itself needs 1–2 GB depending on settings |

> Windows: the panel runs, but Minecraft server hosting is best on Linux/macOS.

---

## 🚀 Installation

### Option A — Automated installer (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/iam169459/purple-mc-panel/main/install.sh | sudo bash
```

Useful flags: `--port 8080`, `--pm2-name my-panel`, `--no-pm2`, `--no-autostart`. Installs Node 20 if missing, sets up PM2 as `purple-mc-panel`, and writes a `.env` with your chosen port.

The installer also makes everything **come back on its own after a reboot or power cut**: it registers PM2 with the init system (`pm2 startup` + `pm2 save`, so the panel starts when the machine powers on, and crashes auto-restart with back-off) and enables the Minecraft server's auto-start so it launches with the panel. Skip that behaviour with `--no-autostart`, or toggle the Minecraft auto-start later in the panel's Settings.

### Option B — Manual (any OS)

```bash
git clone https://github.com/iam169459/purple-mc-panel.git
cd purple-mc-panel
npm install
npm start          # serves the panel on http://localhost:3000
```

On first boot the panel automatically downloads the latest **Paper** server jar into `server/`, accepts the EULA, and you're ready to hit **Start Server**.

### One script to manage it all

`install.sh` is the unified CLI (it replaces the old `install.sh` + `update.sh` pair). With no arguments it opens an **animated interactive menu**; every action also works as a direct command:

```bash
./install.sh            # interactive menu
./install.sh setup      # guided first-time setup on a brand-new server/PC (asks dir, port, PM2, Java)
sudo ./install.sh       # one-shot install (new or reinstall, auto-detected)
./install.sh update     # sync latest code from GitHub, keep config/worlds/backups
./install.sh status     # service + code version
./install.sh logs       # tail panel logs
./install.sh start|stop|restart
```

---

## 🎮 Using the panel

1. Open `http://<host>:3000` (change the port with the `PORT` env var, e.g. `PORT=8080 npm start`).
2. Go to **Console** and click **Start Server**.
3. Open **Marketplace** to install plugins, or drop a world into `server/world` and manage everything from the browser.

> ⚠️ The panel binds `0.0.0.0` and has **no built-in authentication** — run it behind a reverse proxy with auth (or a firewall/VPN) if it's exposed beyond your local network.

---

## 🔄 Updating the panel

Updates are checked against this repository's **`version.json`** — the same file this install ships with.

1. To publish a new version, bump `"version"` in `version.json` (e.g. `1.0.1`) and push to `main`.
2. Installed panels click **Check for Updates** in the *System Update Manager*; when a newer version exists, **Install System Update** streams the deployment (download archive → verify → install, preserving your runtime data → restart).
3. Offline checks and archive problems are reported clearly; the panel never downgrades or "updates" to an equal version.

Manual CLI updates are also available: run `./install.sh update` from the panel directory (syncs the latest code, keeps config/worlds/backups, and restarts the service).

### Testing updates against a mirror

Point the updater at any server serving `version.json` + a `.tar.gz` of the source:

```bash
PANEL_UPDATE_RAW_URL=http://localhost:9000/version.json \
PANEL_UPDATE_ARCHIVE_URL=http://localhost:9000/source.tar.gz \
npm start
```

---

## 📁 Project structure

```
app.js            Thin entry point — middleware, route wiring, boot sequence
src/              Backend modules — process control, sockets, updater, files, plugins,
                  backups, tasks, disk/metrics, settings, graceful shutdown
routes/           REST endpoints (status, server, files, plugins, backups, tasks,
                  settings, network, updates)
public/index.html Frontend — the entire panel UI (Tailwind + Font Awesome, no build step)
install.sh        Unified manager — install / update / status / logs / uninstall + interactive menu
version.json      Version manifest used for self-updates
server/           Minecraft server directory (worlds, plugins, server.jar) — gitignored
config/           Runtime state: settings.json, tasks.json, network allocations, crash log
backups/          Zip backups of worlds + plugins
```

## 🔌 API & events

REST endpoints live under `/api/*` — server control, files, plugins, players, tasks, backups, network, settings, and update check/install. Live data (console, stats, TPS, plugin progress, task runs, update progress) streams over Socket.IO so multiple browser tabs stay in sync.

---

## 🛠️ Troubleshooting

- **Server won't start / "Place a server.jar in the server/ directory"** — the background Paper download failed (offline or blocked); drop a Paper jar into `server/` yourself.
- **Backup fails with "Nothing to back up yet"** — start the server once so a `world/` folder exists.
- **Update says "Update Source Unavailable"** — the panel couldn't fetch `version.json` from the repo; check network access to `raw.githubusercontent.com`.
- **Panels don't see a new version** — `version.json` wasn't bumped; the file must be committed and pushed.
- **Plugins don't load after installing** — installs land while the server runs and load on the *next* restart (the UI tells you this).

---

## 📄 License

No license specified — see the repository owner. PurpleMC Panel is not affiliated with Mojang or Microsoft.
