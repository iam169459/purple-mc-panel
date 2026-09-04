/**
 * ================================================================
 * PurpleMC Panel — Production Control System
 * Senior Node.js Implementation | Express + Socket.io + Process Control
 * ================================================================
 */

// ================================================================
// PHASE 1: CORE IMPORTS & ROOT CONSTANTS
// Must be at the absolute top — no path references before ROOT_DIR
// ================================================================

const ROOT_DIR = __dirname;




const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const os = require('os');
const pidusage = require('pidusage');
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const axios = require('axios');
const multer = require('multer');

const SERVER_DIR = path.join(ROOT_DIR, 'server');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const NETWORK_DB_PATH = path.join(CONFIG_DIR, 'network-allocations.json');
const SETTINGS_DB_PATH = path.join(CONFIG_DIR, 'settings.json');
const JAR_PATH = path.join(SERVER_DIR, 'server.jar');
const EULA_PATH = path.join(SERVER_DIR, 'eula.txt');
const SERVER_PROPS_PATH = path.join(SERVER_DIR, 'server.properties');
const CRASH_LOG_PATH = path.join(CONFIG_DIR, 'crash.log');
const VERSION_FILE = path.join(ROOT_DIR, 'version.json');
const GITHUB_OWNER = 'iam169459';
const GITHUB_REPO = 'purple-mc-panel';
const GITHUB_BRANCH = 'main'; // default — probed and cached at runtime
// Env overrides let ops point the updater at a mirror (used in tests too).
const UPDATE_RAW_URL = process.env.PANEL_UPDATE_RAW_URL || null;
const UPDATE_ARCHIVE_URL = process.env.PANEL_UPDATE_ARCHIVE_URL || null;

const PORT = process.env.PORT || 3000;
const PAPER_VERSIONS = {
    '1.20.4': 'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/499/downloads/paper-1.20.4-499.jar',
    '1.20.2': 'https://api.papermc.io/v2/projects/paper/versions/1.20.2/builds/317/downloads/paper-1.20.2-317.jar',
    '1.19.4': 'https://api.papermc.io/v2/projects/paper/versions/1.19.4/builds/557/downloads/paper-1.19.4-557.jar'
};
const DEFAULT_VERSION = '1.20.4';
const DEFAULT_RAM = '2G';
const DEFAULT_SETTINGS = {
    autoResource: true,
    maxRam: '2G',
    javaPath: 'java',
    javaArgs: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true',
    serverVersion: '1.20.4',
    serverPort: 25565,
    autoRestart: true,
    autoStart: false,
    panelPort: 3000,
    backupEnabled: false,
    backupInterval: 24,
    backupMaxKeep: 7,
    backupWorlds: 'world',
    consoleMaxLines: 500,
    maxPlayers: 20,
    motd: 'A PurpleMC Server',
    difficulty: 'easy',
    gamemode: 'survival',
    pvp: true,
    onlineMode: true,
    whitelist: false,
    viewDistance: 10,
    spawnProtection: 16
};

const GIT_REMOTE_URL = 'https://github.com/iam169459/purple-mc-panel.git';
const PAPER_API = 'https://fill.papermc.io/v3';
const USER_AGENT = 'PurpleMC-Panel/1.0 (https://github.com/iam169459/purple-mc-panel)';

const COLORS = {
    reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
    yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m'
};

// ================================================================
// PHASE 2: SERVER STATE & PROCESS MANAGEMENT
// ================================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ================================================================
// PHASE 2b: PERSISTENT ROLLING LOG BUFFER
// A fixed-size circular buffer that never grows beyond MAX_LOG_LINES.
// All Minecraft server output (stdout + stderr) flows through here.
// When a new client connects, we dump this entire backlog to them
// so they immediately see historical context before live data starts.
// ================================================================

let logBufferMax = 500;
const logBuffer = [];

function pushToLogBuffer(rawChunk, type) {
    const text = rawChunk.toString ? rawChunk.toString('utf8') : String(rawChunk);
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const trimmed = lineText.trim();

        if (trimmed === '' && lineText === '') continue;

        parsePlayerEvents(lineText);
        parseTpsEvents(lineText);

        const entry = {
            raw: lineText,
            text: stripAnsi(lineText),
            type: classifyLine(lineText),
            timestamp: new Date().toISOString()
        };

        logBuffer.push(entry);

        const s = loadSettings();
        const maxLines = Math.max(100, Math.min(5000, s.consoleMaxLines || 500));
        if (logBuffer.length > maxLines) {
            logBuffer.shift();
        }
    }
}

function stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][0-9;]*[a-zA-Z]/g, '');
}

function classifyLine(line) {
    const lower = line.toLowerCase();
    if (lower.includes('[error]') || lower.includes('exception') || lower.includes('fatal') || lower.includes('[fatal]')) return 'error';
    if (lower.includes('[warn]') || lower.includes('[warning]')) return 'warn';
    if (lower.includes('[info]')) return 'info';
    if (lower.includes(' done (') || lower.includes('done in ')) return 'success';
    if (lower.includes('complete') || lower.includes('success')) return 'success';
    if (lower.includes('system') || lower.includes('[system]')) return 'system';
    if (lower.startsWith('$')) return 'command';
    if (lower.includes('joined the game')) return 'join';
    if (lower.includes('left the game')) return 'leave';
    if (lower.includes('logged in')) return 'join';
    if (lower.includes('logged out')) return 'leave';
    if (lower.includes('was slain by') || lower.includes('was shot by') || lower.includes('was killed') || lower.includes('drowned') || lower.includes('fell from') || lower.includes('blew up') || lower.includes('hit the ground') || lower.includes('went up in flames') || lower.includes('burned to death') || lower.includes('was burned') || lower.includes('was struck by lightning') || lower.includes('was pricked to death') || lower.includes('suffocated') || lower.includes('starved') || lower.includes('was poked') || lower.includes('died')) return 'death';
    if (lower.includes('has made the advancement') || lower.includes('has completed the challenge') || lower.includes('has reached the goal')) return 'advancement';
    if (lower.includes('<') && (lower.includes('>') || lower.includes('»'))) return 'chat';
    if (lower.includes('mspt') || lower.includes('tps:') || lower.includes('memory:') || lower.includes('tick:')) return 'tick';
    if (lower.includes('[debug]') || lower.includes('[fine]') || lower.includes('[finer]') || lower.includes('[finest]')) return 'debug';
    if (lower.includes('started') || lower.includes('running on') || lower.includes('preparing spawn') || lower.includes('loading world') || lower.includes('loaded world') || lower.includes('default game type') || lower.includes('setting spawn')) return 'success';
    return 'default';
}

// ================================================================
// PHASE 2c: PROCESS STATE FLAGS
// ================================================================

let mcProcess = null;
let processPid = null;
let isStarting = false;
let isStopping = false;
let serverStartTime = null;
let restartPending = false;

let isUpdateRunning = false;

// True once SIGINT/SIGTERM/self-update shutdown begins — used to keep the
// Minecraft crash-restart logic from fighting a deliberate panel shutdown.
let shuttingDown = false;

// Player tracking
let onlinePlayers = [];
let playerLocations = {};

function parsePlayerEvents(text) {
    const clean = stripAnsi(text).trim();
    // Join: "Steve joined the game"
    const joinMatch = clean.match(/^(\w{3,16}) joined the game$/);
    if (joinMatch) {
        const name = joinMatch[1];
        if (!onlinePlayers.find(p => p.name === name)) {
            onlinePlayers.push({ name, joinedAt: new Date().toISOString() });
            io.emit('players', onlinePlayers);
            log(`Player joined: ${name}`, 'info');
        }
        return;
    }
    // Leave: "Steve left the game"
    const leaveMatch = clean.match(/^(\w{3,16}) left the game$/);
    if (leaveMatch) {
        const name = leaveMatch[1];
        onlinePlayers = onlinePlayers.filter(p => p.name !== name);
        delete playerLocations[name];
        io.emit('players', onlinePlayers);
        log(`Player left: ${name}`, 'info');
        return;
    }
    // Parse /list output: "There are X of Y players online: player1, player2, ..."
    const listMatch = clean.match(/^There are (\d+) of a max of \d+ players online:\s*(.*)$/);
    if (listMatch) {
        const names = listMatch[2] ? listMatch[2].split(',').map(n => n.trim()).filter(Boolean) : [];
        onlinePlayers = names.map(name => {
            const existing = onlinePlayers.find(p => p.name === name);
            return existing || { name, joinedAt: new Date().toISOString() };
        });
        io.emit('players', onlinePlayers);
        return;
    }
    // Parse /data get entity <player> Pos response: "Steve has the following entity data: [123.456d, 64.0d, 789.012d]"
    const locMatch = clean.match(/^(\w{3,16}) has the following entity data: \[(-?[\d.]+)d?, (-?[\d.]+)d?, (-?[\d.]+)d?\]/);
    if (locMatch) {
        const name = locMatch[1];
        const coords = {
            x: parseFloat(locMatch[2]),
            y: parseFloat(locMatch[3]),
            z: parseFloat(locMatch[4]),
            updatedAt: new Date().toISOString()
        };
        playerLocations[name] = coords;
        // Update player entry with location
        const player = onlinePlayers.find(p => p.name === name);
        if (player) {
            player.location = coords;
            io.emit('players', onlinePlayers);
            io.emit('player-location', { name, location: coords });
        }
        return;
    }
}

// ================================================================
// PHASE 2d: LIVE TPS / MSPT PARSING
// Parses vanilla/Paper `/tps` and `/mspt` output so the panel can
// stream tick performance to connected clients in real time.
// ================================================================

let lastTps = null;
let lastMspt = null;

function parseTpsEvents(text) {
    const clean = stripAnsi(text);
    const tpsMatch = clean.match(/TPS from last 5s: ([\d.]+), 1m: ([\d.]+), 5m: ([\d.]+)/);
    if (tpsMatch) {
        lastTps = {
            tps5s: parseFloat(tpsMatch[1]),
            tps1m: parseFloat(tpsMatch[2]),
            tps5m: parseFloat(tpsMatch[3]),
            timestamp: new Date().toISOString()
        };
        emitTpsUpdate();
        return;
    }
    const msptMatch = clean.match(/Server tick times: ([\d.]+) average/);
    if (msptMatch) {
        lastMspt = parseFloat(msptMatch[1]);
        emitTpsUpdate();
    }
}

function emitTpsUpdate() {
    try {
        if (io && io.engine && io.engine.clientsCount > 0) {
            io.emit('tps', { tps: lastTps, mspt: lastMspt });
        }
    } catch {}
}

// ================================================================
// PHASE 3: VERSION & CONFIGURATION
// ================================================================

const CURRENT_VERSION = '1.0.0';

function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = type === 'error' ? `${COLORS.red}[ERROR]${COLORS.reset}` :
                   type === 'warn'  ? `${COLORS.yellow}[WARN]${COLORS.reset}`  :
                   `${COLORS.cyan}[PurpleMC]${COLORS.reset}`;
    console.log(`${prefix} ${message}`);
}

function ensureDirectories() {
    [SERVER_DIR, BACKUPS_DIR, CONFIG_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            log(`Created directory: ${dir}`, 'info');
        }
    });
}

function downloadFile(url, dest, onProgress, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        let timer;
        let stalled;
        let settled = false;
        let downloadedBytes = 0;
        let lastEmit = 0;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(stalled);
            file.close();
            try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
            reject(err);
        };
        // Hard cap so a slow or hung transfer can never wedge the panel.
        timer = setTimeout(() => fail(new Error('Download timed out after 300s')), 300000);

        // Support http:// mirrors as well as https:// so the updater can be
        // pointed at a local test server via PANEL_UPDATE_*_URL.
        const client = String(url).startsWith('http:') ? http : https;
        const req = client.get(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
            // Follow redirects (up to 3 hops) — CDN links often bounce.
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
                clearTimeout(timer);
                file.close();
                const nextUrl = new URL(response.headers.location, url).toString();
                downloadFile(nextUrl, dest, onProgress, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                fail(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            const contentLength = parseInt(response.headers['content-length'] || '0', 10) || 0;
            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                clearTimeout(stalled);
                stalled = setTimeout(() => fail(new Error('Download stalled — no data for 60s')), 60000);
                const now = Date.now();
                // Smooth, throttled progress callbacks (~2/sec).
                if (onProgress && now - lastEmit >= 500) {
                    lastEmit = now;
                    onProgress(downloadedBytes, contentLength);
                }
            });
            response.pipe(file);
            file.on('finish', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(stalled);
                file.close();
                if (onProgress) onProgress(downloadedBytes, contentLength);
                resolve();
            });
        });
        req.on('error', fail);
    });
}

/**
 * resolvePaperDownloadUrl — asks the current PaperMC downloads service
 * (fill.papermc.io/v3) for the latest stable build of a Minecraft version
 * and returns its direct download URL. Returns null on any failure so
 * callers can fall back to the hardcoded URL table.
 */
async function resolvePaperDownloadUrl(version) {
    try {
        const res = await axios.get(`${PAPER_API}/projects/paper/versions/${encodeURIComponent(version)}/builds`, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 15000
        });
        const builds = res.data;
        if (Array.isArray(builds)) {
            const pick = builds.find(b => b.channel === 'STABLE' && b.downloads && b.downloads['server:default'] && b.downloads['server:default'].url)
                || builds.find(b => b.downloads && b.downloads['server:default'] && b.downloads['server:default'].url);
            if (pick) return pick.downloads['server:default'].url;
        }
    } catch (err) {
        log(`PaperMC API lookup failed for ${version}: ${err.message}`, 'warn');
    }
    return null;
}

async function checkAndDownloadServer() {
    if (!fs.existsSync(JAR_PATH)) {
        const settings = loadSettings();
        let version = settings.serverVersion || DEFAULT_VERSION;
        log(`Server JAR not found. Downloading PaperMC ${version}...`, 'warn');
        let url = PAPER_VERSIONS[version];
        if (!url) {
            log(`No download URL for version ${version}, falling back to ${DEFAULT_VERSION}`, 'warn');
            version = DEFAULT_VERSION;
            url = PAPER_VERSIONS[DEFAULT_VERSION];
        }

        // Prefer the live PaperMC downloads API; fall back to the static table.
        const liveUrl = await resolvePaperDownloadUrl(version);
        if (liveUrl) {
            log(`Resolved latest PaperMC build for ${version}`, 'info');
            url = liveUrl;
        } else if (!url) {
            throw new Error(`No download URL available for version ${version}`);
        }

        try {
            const onProgress = (got, total) => {
                const pct = total > 0 ? Math.round((got / total) * 100) : 0;
                const gotMB = (got / 1024 / 1024).toFixed(1);
                const totMB = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';
                const msg = `Downloading PaperMC ${version} ${total > 0 ? pct + '%' : gotMB + ' MB'} (${gotMB}/${totMB} MB)`;
                pushToLogBuffer(`[SYSTEM] ${msg}`, 'system');
                emitConsoleSafe(`\n${COLORS.cyan}[DOWNLOAD]${COLORS.reset} ${msg}\n`);
            };
            await downloadFile(url, JAR_PATH, onProgress);
            const jarSize = (fs.statSync(JAR_PATH).size / 1024 / 1024).toFixed(1);
            fs.writeFileSync(EULA_PATH, 'eula=true');
            const doneMsg = `Server JAR ready (${jarSize} MB)`;
            pushToLogBuffer(`[SYSTEM] ${doneMsg}`, 'system');
            emitConsoleSafe(`\n${COLORS.green}[DOWNLOAD]${COLORS.reset} ${doneMsg}\n`);
            log(`Server JAR downloaded and eula.txt created (${jarSize} MB)`, 'info');
        } catch (err) {
            log(`Failed to download server: ${err.message}`, 'error');
            throw err;
        }
    }
    if (!fs.existsSync(EULA_PATH)) {
        fs.writeFileSync(EULA_PATH, 'eula=true');
    }
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ================================================================
// PHASE 4: SERVER PROCESS CONTROL (ENHANCED SPAWN)
// ================================================================

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_DB_PATH)) {
            const saved = JSON.parse(fs.readFileSync(SETTINGS_DB_PATH, 'utf8'));
            return { ...DEFAULT_SETTINGS, ...saved };
        }
    } catch (err) {
        log(`Failed to load settings: ${err.message}`, 'warn');
    }
    return { ...DEFAULT_SETTINGS };
}

let crashCount = 0;
const CRASH_THROTTLE_MAX = 5;
const CRASH_THROTTLE_WINDOW = 120000;
let crashWindowStart = 0;
const CRASH_LOG_MAX = 100;

function writeCrashLog(entry) {
    try {
        const logs = [];
        if (fs.existsSync(CRASH_LOG_PATH)) {
            const raw = fs.readFileSync(CRASH_LOG_PATH, 'utf8').trim();
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) logs.push(...parsed);
            }
        }
        logs.push(entry);
        while (logs.length > CRASH_LOG_MAX) logs.shift();
        fs.writeFileSync(CRASH_LOG_PATH, JSON.stringify(logs, null, 2), 'utf8');
    } catch {}
}

function diagnoseCrash(code, recentLines) {
    const combined = recentLines.join('\n').toLowerCase();
    const diagnosis = { reason: 'unknown', severity: 'warning', repairs: [] };

    if (code === null || code === undefined) {
        diagnosis.reason = 'process_killed';
        diagnosis.severity = 'info';
    } else if (code === 137 || code === 143) {
        diagnosis.reason = 'out_of_memory';
        diagnosis.severity = 'critical';
        diagnosis.repairs.push({ action: 'reduce_ram', label: 'Reduce max RAM or check for memory leaks', auto: false });
    } else if (code === 1 && combined.includes('outofmemory')) {
        diagnosis.reason = 'out_of_memory';
        diagnosis.severity = 'critical';
        diagnosis.repairs.push({ action: 'reduce_ram', label: 'Reduce max RAM or check for memory leaks', auto: false });
    } else if (combined.includes('unable to load') && (combined.includes('world') || combined.includes('level'))) {
        diagnosis.reason = 'world_corruption';
        diagnosis.severity = 'critical';
        diagnosis.repairs.push({ action: 'backup_world', label: 'World data may be corrupted — restore from backup', auto: false });
    } else if (combined.includes('error loading plugin') || combined.includes('plugins')) {
        diagnosis.reason = 'plugin_failure';
        diagnosis.severity = 'high';
        diagnosis.repairs.push({ action: 'disable_plugins', label: 'A plugin failed to load — remove recently added plugins', auto: false });
    } else if (combined.includes('java.lang.nosuchmethod') || combined.includes('classcastexception')) {
        diagnosis.reason = 'plugin_incompatibility';
        diagnosis.severity = 'high';
        diagnosis.repairs.push({ action: 'update_plugins', label: 'Plugin incompatibility detected — update all plugins', auto: false });
    } else if (combined.includes('bindException') || combined.includes('address already in use')) {
        diagnosis.reason = 'port_conflict';
        diagnosis.severity = 'high';
        diagnosis.repairs.push({ action: 'change_port', label: 'Port already in use — change server-port in settings', auto: false });
    } else if (code === 1) {
        diagnosis.reason = 'generic_error';
        diagnosis.severity = 'warning';
        diagnosis.repairs.push({ action: 'check_logs', label: 'Check console output above for error details', auto: false });
    }

    return diagnosis;
}

function captureCrashSnapshot(code) {
    const recentLines = logBuffer.slice(-50).map(e => e.text);
    const diagnosis = diagnoseCrash(code, recentLines);
    const snapshot = {
        timestamp: new Date().toISOString(),
        exitCode: code,
        reason: diagnosis.reason,
        severity: diagnosis.severity,
        repairs: diagnosis.repairs,
        recentOutput: recentLines.slice(-20)
    };

    writeCrashLog(snapshot);
    log(`Crash logged: ${diagnosis.reason} (code: ${code}, severity: ${diagnosis.severity})`, diagnosis.severity === 'critical' ? 'error' : 'warn');
    return snapshot;
}

async function startServer() {
    if (mcProcess || isStarting || isStopping) {
        return { success: false, error: 'Server already running, starting, or stopping' };
    }
    isStarting = true;
    emitConsoleSafe(`\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Starting Minecraft server...\n`);

    try {
        const settings = loadSettings();
        await checkAndDownloadServer(settings);
        const ram = settings.autoResource ? calculateRecommendedRam() : (settings.maxRam || DEFAULT_RAM);
        const javaExe = settings.javaPath || 'java';

        const javaFallbacks = [...new Set([javaExe, 'java', '/usr/bin/java', '/usr/local/bin/java', '/opt/java/bin/java'].filter(Boolean))];

        let spawned = false;
        let lastError = null;
        let spawnedProcess = null;

        for (const javaPathCandidate of javaFallbacks) {
            try {
                const extraArgs = settings.javaArgs ? settings.javaArgs.split(' ').filter(Boolean) : [];
                const proc = spawn(javaPathCandidate, ['-Xmx' + ram, '-Xms' + ram, ...extraArgs, '-jar', 'server.jar', 'nogui'], {
                    cwd: SERVER_DIR,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: false
                });

                const testResult = await Promise.race([
                    new Promise((resolve) => proc.on('spawn', () => resolve({ ok: true }))),
                    new Promise((resolve) => proc.on('error', (err) => resolve({ ok: false, err }))),
                    new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500))
                ]);

                if (testResult.ok === false) {
                    proc.kill();
                    lastError = testResult.err;
                    continue;
                }

                spawnedProcess = proc;
                spawned = true;
                log(`Server spawn using: ${javaPathCandidate}`, 'info');
                break;
            } catch (spawnErr) {
                lastError = spawnErr;
                continue;
            }
        }

        if (!spawned || !spawnedProcess) {
            isStarting = false;
            const msg = `Failed to spawn Java process. Tried: ${javaFallbacks.join(', ')}. Last error: ${lastError?.message || 'unknown'}`;
            log(msg, 'error');
            emitConsoleSafe(`\n${COLORS.red}[SYSTEM ERROR]${COLORS.reset} ${msg}\n`);
            return { success: false, error: msg };
        }

        mcProcess = spawnedProcess;
        processPid = mcProcess.pid;
        serverStartTime = Date.now();
        isStarting = false;
        crashCount = 0;
        log(`Server started with PID: ${processPid}`, 'info');
        io.emit('status', 'online');
        pushToLogBuffer(`[SYSTEM] Minecraft server started (PID: ${processPid})`, 'system');

        mcProcess.stdout.on('data', (chunk) => {
            const text = stripAnsi(chunk.toString());
            pushToLogBuffer(text, 'stdout');
            io.emit('console', text);
        });

        mcProcess.stderr.on('data', (chunk) => {
            const text = stripAnsi(chunk.toString());
            pushToLogBuffer(`[STDERR] ${text}`, 'stderr');
            io.emit('console', `\n${COLORS.red}[ERROR]${COLORS.reset} ${text}`);
        });

        mcProcess.on('close', (code) => {
            const wasRunning = mcProcess !== null;
            mcProcess = null;
            processPid = null;
            serverStartTime = null;
            onlinePlayers = [];
            io.emit('status', 'offline');
            io.emit('players', []);
            isStopping = false;

            pushToLogBuffer(`[SYSTEM] Minecraft server stopped (exit code: ${code})`, 'system');

            if (restartPending) {
                restartPending = false;
                log('Restart pending, starting server...', 'warn');
                setTimeout(() => startServer(), 2000);
                return;
            }

            if (shuttingDown) {
                log(`Minecraft server stopped during panel shutdown (exit code: ${code}) — not auto-restarting.`, 'info');
                return;
            }

            if (wasRunning && code !== 0) {
                const crashInfo = captureCrashSnapshot(code);
                const crashMsg = crashInfo.reason === 'out_of_memory'
                    ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}Out of memory detected!${COLORS.reset} Try reducing max RAM or adding more swap.`
                    : crashInfo.reason === 'world_corruption'
                    ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}World corruption detected!${COLORS.reset} Restore from backup or run world repair.`
                    : crashInfo.reason === 'plugin_failure'
                    ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}Plugin failure detected!${COLORS.reset} Remove recently added plugins and restart.`
                    : `${COLORS.red}[CRASH]${COLORS.reset} Server exited with code ${code}`;

                emitConsoleSafe(`\n${crashMsg}\n`);

                const s = loadSettings();
                if (s.autoRestart) {
                    const now = Date.now();
                    if (now - crashWindowStart > CRASH_THROTTLE_WINDOW) {
                        crashWindowStart = now;
                        crashCount = 0;
                    }
                    crashCount++;
                    const delay = Math.min(30, crashCount * 5);
                    emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Auto-restart in ${delay}s (attempt ${crashCount}/${CRASH_THROTTLE_MAX})\n`);
                    log(`Server crashed (code: ${code}, reason: ${crashInfo.reason}), auto-restart #${crashCount} in ${delay}s`, 'warn');
                    if (crashCount <= CRASH_THROTTLE_MAX) {
                        setTimeout(() => startServer(), delay * 1000);
                    } else {
                        emitConsoleSafe(`\n${COLORS.red}[SYSTEM]${COLORS.reset} Auto-restart throttled: too many crashes. Manual restart required.\n`);
                        log('Auto-restart throttled after ' + CRASH_THROTTLE_MAX + ' consecutive crashes', 'error');
                    }
                } else {
                    emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Server stopped (code: ${code})\n`);
                }
            }
        });

        mcProcess.on('error', (err) => {
            isStarting = false;
            log(`Process error: ${err.message}`, 'error');
            emitConsoleSafe(`\n${COLORS.red}[SYSTEM ERROR]${COLORS.reset} ${err.message}\n`);
            pushToLogBuffer(`[SYSTEM ERROR] ${err.message}`, 'error');
        });

        return { success: true };
    } catch (err) {
        isStarting = false;
        log(`Failed to start: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
}

function emitConsoleSafe(msg) {
    try { io.emit('console', msg); } catch {}
}

function stopServer() {
    if (!mcProcess || isStopping) {
        return { success: false, error: 'Server not running' };
    }
    isStopping = true;
    log('Stopping server gracefully...', 'info');
    io.emit('console', `\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Stopping server...\n`);
    pushToLogBuffer('[SYSTEM] Stopping Minecraft server...', 'system');
    try {
        mcProcess.stdin.write('stop\n');
        setTimeout(() => { isStopping = false; }, 15000);
        return { success: true };
    } catch (err) {
        isStopping = false;
        return { success: false, error: err.message };
    }
}

function killServer() {
    if (!mcProcess) {
        return { success: false, error: 'Server not running' };
    }
    log('Force killing server...', 'warn');
    io.emit('console', `\n${COLORS.red}[SYSTEM]${COLORS.reset} Force killing server...\n`);
    pushToLogBuffer('[SYSTEM] Force killing Minecraft server...', 'error');
    try {
        mcProcess.kill('SIGKILL');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function restartServer() {
    if (!mcProcess) {
        return { success: false, error: 'Server not running' };
    }
    restartPending = true;
    log('Restart requested', 'info');
    io.emit('console', `\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Restarting server...\n`);
    stopServer();
    return { success: true, message: 'Restart initiated' };
}

function sendCommand(command) {
    if (!mcProcess || !command || !command.trim()) {
        return { success: false, error: 'No server running or empty command' };
    }
    try {
        mcProcess.stdin.write(command.trim() + '\n');
        pushToLogBuffer(`$ ${command.trim()}`, 'command');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function getProcessStats() {
    if (!processPid) {
        return { cpu: 0, memory: 0, uptime: 0 };
    }
    try {
        const stats = await pidusage(processPid);
        return {
            cpu: Math.round(stats.cpu),
            memory: Math.round(stats.memory / 1024 / 1024),
            uptime: serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0
        };
    } catch {
        return { cpu: 0, memory: 0, uptime: 0 };
    }
}

// ================================================================
// PHASE 5: ADVANCED METRICS ENGINE (CPU, RAM, DISK)
// ================================================================

const diskCache = new Map();
const DISK_CACHE_TTL = 30000;

function getDiskUsage(dirPath) {
    const key = path.resolve(dirPath);
    const now = Date.now();
    const cached = diskCache.get(key);
    if (cached && now - cached.time < DISK_CACHE_TTL) {
        return cached.result;
    }
    try {
        const stats = fs.statSync(dirPath);
        let totalSize = 0;
        let fileCount = 0;
        let dirCount = 0;

        function calculateSize(dir) {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                try {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        dirCount++;
                        calculateSize(fullPath);
                    } else {
                        fileCount++;
                        totalSize += fs.statSync(fullPath).size;
                    }
                } catch {
                    // Skip inaccessible files
                }
            }
        }

        calculateSize(dirPath);

        const result = {
            totalBytes: totalSize,
            totalMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
            totalGB: Math.round(totalSize / 1024 / 1024 / 1024 * 100) / 100,
            fileCount,
            dirCount
        };
        diskCache.set(key, { result, time: now });
        return result;
    } catch (err) {
        return { totalBytes: 0, totalMB: 0, totalGB: 0, fileCount: 0, dirCount: 0, error: err.message };
    }
}

/**
 * getDiskBreakdown — returns size statistics for each top-level
 * directory inside the server folder (world, plugins, logs, ...)
 * sorted largest-first. Powers the dashboard storage breakdown card.
 */
function getDiskBreakdown() {
    const breakdown = [];
    try {
        const entries = fs.readdirSync(SERVER_DIR, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(SERVER_DIR, entry.name);
            if (entry.isDirectory()) {
                const usage = getDiskUsage(fullPath);
                if (usage && !usage.error) {
                    breakdown.push({ name: entry.name, ...usage });
                }
            }
        }
    } catch (err) {
        log(`Disk breakdown error: ${err.message}`, 'warn');
    }
    return breakdown.sort((a, b) => b.totalBytes - a.totalBytes);
}

/**
 * getHostDiskInfo — free/total bytes of the filesystem that hosts the
 * server directory (statfs). Returns null when unsupported (old Node
 * without fs.statfsSync) so callers can degrade gracefully.
 */
function getHostDiskInfo() {
    try {
        if (typeof fs.statfsSync !== 'function') return null;
        const s = fs.statfsSync(SERVER_DIR);
        if (!s || !s.bsize) return null;
        const totalBytes = s.blocks * s.bsize;
        const freeBytes = s.bavail * s.bsize;
        const usedBytes = totalBytes - freeBytes;
        return {
            totalBytes,
            freeBytes,
            usedBytes,
            totalGB: Math.round(totalBytes / 1024 / 1024 / 1024 * 100) / 100,
            freeGB: Math.round(freeBytes / 1024 / 1024 / 1024 * 100) / 100,
            usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
        };
    } catch {
        return null;
    }
}

function getSystemMetrics() {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const cpus = os.cpus();
        const loadAvg = os.loadavg();

        return {
            cpu: {
                cores: cpus.length,
                model: cpus[0]?.model || 'Unknown',
                loadAvg1m: Math.round(loadAvg[0] * 100) / 100,
                loadAvg5m: Math.round(loadAvg[1] * 100) / 100,
                loadAvg15m: Math.round(loadAvg[2] * 100) / 100
            },
            ram: {
                totalBytes: totalMem,
                totalMB: Math.round(totalMem / 1024 / 1024),
                totalGB: Math.round(totalMem / 1024 / 1024 / 1024 * 100) / 100,
                freeBytes: freeMem,
                freeMB: Math.round(freeMem / 1024 / 1024),
                freeGB: Math.round(freeMem / 1024 / 1024 / 1024 * 100) / 100,
                usedBytes: usedMem,
                usedMB: Math.round(usedMem / 1024 / 1024),
                usedGB: Math.round(usedMem / 1024 / 1024 / 1024 * 100) / 100,
                usagePercent: Math.round((usedMem / totalMem) * 100)
            },
            hostname: os.hostname(),
            platform: os.platform(),
            uptime: os.uptime(),
            type: os.type()
        };
    } catch (err) {
        return { error: err.message };
    }
}

function calculateRecommendedRam() {
    try {
        const totalGB = Math.floor(os.totalmem() / 1024 / 1024 / 1024);
        if (totalGB <= 1) return '1G';
        const recommended = Math.max(1, Math.floor(totalGB * 0.75));
        return recommended + 'G';
    } catch {
        return DEFAULT_RAM;
    }
}

// ================================================================
// PHASE 6: MIDDLEWARE
// ================================================================

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const pluginUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(SERVER_DIR, 'plugins');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const safe = file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '_');
            cb(null, safe);
        }
    }),
    fileFilter: (req, file, cb) => {
        if (!file.originalname.endsWith('.jar')) {
            return cb(new Error('Only .jar files are allowed'), false);
        }
        cb(null, true);
    },
    limits: { fileSize: 100 * 1024 * 1024 }
});

// Uploads are staged in the OS temp dir first; the route handler moves
// them into the (sanitized) target directory once the full body —
// including the `path` field — has been parsed.
const fileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, os.tmpdir()),
        filename: (req, file, cb) => {
            const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._ -]/g, '_');
            if (!safe) return cb(new Error('Invalid filename'));
            cb(null, safe);
        }
    }),
    limits: { fileSize: 500 * 1024 * 1024 }
});

function sendError(res, message, status = 400) {
    res.status(status).json({ error: message });
}

// ================================================================
// PHASE 7: CONSOLE MODULE — API ROUTES
// ================================================================

app.get('/api/status', async (req, res) => {
    const stats = await getProcessStats();
    const disk = getDiskUsage(SERVER_DIR);
    const settings = loadSettings();
    res.json({
        running: !!mcProcess,
        pid: processPid,
        uptime: stats.uptime,
        cpu: stats.cpu,
        memory: stats.memory,
        players: onlinePlayers,
        disk,
        allocation: { maxRam: settings.autoResource ? calculateRecommendedRam() : (settings.maxRam || DEFAULT_RAM), autoResource: settings.autoResource }
    });
});

app.post('/api/server/start', async (req, res) => {
    const result = await startServer();
    res.json(result);
});

app.post('/api/server/stop', (req, res) => {
    res.json(stopServer());
});

app.post('/api/server/kill', (req, res) => {
    res.json(killServer());
});

app.post('/api/server/restart', (req, res) => {
    res.json(restartServer());
});

app.post('/api/command', (req, res) => {
    const { cmd } = req.body;
    const result = sendCommand(cmd);
    res.json(result);
});

app.get('/api/players', (req, res) => {
    const playersWithLocation = onlinePlayers.map(p => ({
        ...p,
        location: playerLocations[p.name] || null
    }));
    res.json({ success: true, count: playersWithLocation.length, players: playersWithLocation });
});

app.get('/api/server/usage', async (req, res) => {
    try {
        const processStats = await getProcessStats();
        const sysMetrics = getSystemMetrics();
        const diskUsage = getDiskUsage(SERVER_DIR);
        const settings = loadSettings();

        res.json({
            process: {
                cpu: processStats.cpu,
                memory: processStats.memory,
                uptime: processStats.uptime,
                running: !!mcProcess,
                pid: processPid
            },
            system: sysMetrics,
            disk: diskUsage,
            allocation: {
                maxRam: settings.autoResource ? calculateRecommendedRam() : (settings.maxRam || DEFAULT_RAM),
                javaPath: settings.javaPath || 'java',
                autoResource: settings.autoResource
            }
        });
    } catch (err) {
        log(`Usage metrics error: ${err.message}`, 'error');
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/server/disk-breakdown', (req, res) => {
    const breakdown = getDiskBreakdown();
    const total = getDiskUsage(SERVER_DIR);
    res.json({ success: true, total, folders: breakdown });
});

// ================================================================
// PHASE 8: SECURE FILE MANAGER MODULE
// ================================================================

function sanitizePath(basePath, userPath) {
    const safeBase = path.resolve(basePath);
    const rawNormalized = path.normalize(userPath || '.');
    let resolved;
    if (path.isAbsolute(rawNormalized)) {
        resolved = path.resolve(safeBase, '.' + rawNormalized);
    } else {
        resolved = path.resolve(safeBase, rawNormalized);
    }
    const normalizedBase = path.resolve(safeBase);
    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
        throw new Error('PATH_TRAVERSAL_DETECTED');
    }
    return resolved;
}

function safeReadDir(dirPath) {
    const items = [];
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.dat' || entry.name.endsWith('.lock')) continue;
            try {
                const fullPath = path.join(dirPath, entry.name);
                const stat = fs.statSync(fullPath);
                items.push({
                    name: entry.name,
                    isDirectory: entry.isDirectory(),
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    extension: path.extname(entry.name).toLowerCase()
                });
            } catch {
                items.push({ name: entry.name, isDirectory: entry.isDirectory(), size: 0, modified: null, extension: '' });
            }
        }
    } catch (err) {
        log(`safeReadDir error: ${err.message}`, 'error');
    }
    return items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

function safeReadFile(filePath, maxSize = 5 * 1024 * 1024) {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) throw new Error('FILE_TOO_LARGE');
    return fs.readFileSync(filePath, 'utf8');
}

const EDITABLE_EXTENSIONS = ['.txt', '.yml', '.yaml', '.properties', '.json', '.xml', '.cfg', '.conf', '.log', '.md', '.sh', '.bat', '.toml', '.env'];

app.get('/api/files/list', (req, res) => {
    const { path: userPath } = req.query;
    try {
        const filePath = sanitizePath(SERVER_DIR, userPath || '');
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
            return sendError(res, 'Directory not found', 404);
        }
        const files = safeReadDir(filePath);
        // Attach recursive sizes + file counts to folders (cached by
        // getDiskUsage, invalidated on mutation) so the explorer doubles
        // as a storage-triage view — worlds show their real footprint.
        for (const f of files) {
            if (f.isDirectory) {
                const usage = getDiskUsage(path.join(filePath, f.name));
                f.size = usage && !usage.error ? usage.totalBytes : 0;
                f.fileCount = usage && !usage.error ? usage.fileCount : 0;
            }
        }
        res.json({ success: true, path: userPath || '', files });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') {
            log(`Directory traversal attempt blocked: ${userPath}`, 'error');
            return sendError(res, 'Access denied', 403);
        }
        log(`List directory error: ${err.message}`, 'error');
        sendError(res, err.message);
    }
});

app.get('/api/files/read', (req, res) => {
    const { file: userPath } = req.query;
    if (!userPath) return sendError(res, 'file parameter is required');

    try {
        const filePath = sanitizePath(SERVER_DIR, userPath);
        if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
        if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot read a directory', 400);

        const ext = path.extname(filePath).toLowerCase();
        const isEditable = EDITABLE_EXTENSIONS.includes(ext);

        try {
            const content = safeReadFile(filePath);
            res.json({ success: true, path: userPath, name: path.basename(filePath), extension: ext, isEditable, content });
        } catch (readErr) {
            if (readErr.message === 'FILE_TOO_LARGE') return sendError(res, 'File too large to read (>5MB)', 413);
            throw readErr;
        }
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') {
            log(`Directory traversal attempt blocked: ${userPath}`, 'error');
            return sendError(res, 'Access denied', 403);
        }
        log(`Read file error: ${err.message}`, 'error');
        sendError(res, err.message);
    }
});

app.post('/api/files/save', (req, res) => {
    const { path: userPath, content } = req.body;
    if (!userPath) return sendError(res, 'path is required');
    if (typeof content !== 'string') return sendError(res, 'content must be a string');
    if (content.length > 5 * 1024 * 1024) return sendError(res, 'Content exceeds 5MB limit', 413);

    try {
        const filePath = sanitizePath(SERVER_DIR, userPath);
        if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
        if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot write to a directory', 400);

        const ext = path.extname(filePath).toLowerCase();
        if (!EDITABLE_EXTENSIONS.includes(ext)) {
            return sendError(res, `Editing .${ext.replace('.', '')} files is not allowed`, 403);
        }

        fs.writeFileSync(filePath, content, 'utf8');
        diskCache.clear();
        log(`File saved: ${userPath}`, 'info');
        res.json({ success: true, path: userPath });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') {
            log(`Directory traversal attempt blocked: ${userPath}`, 'error');
            return sendError(res, 'Access denied', 403);
        }
        log(`Save file error: ${err.message}`, 'error');
        sendError(res, err.message);
    }
});

app.post('/api/files/create', (req, res) => {
    const { name, type, path: dir } = req.body;
    if (!name || !/^[a-zA-Z0-9._ -]+$/.test(name) || name.includes('..')) {
        return sendError(res, 'Invalid name');
    }
    if (!['folder', 'file'].includes(type)) return sendError(res, 'Invalid type');

    try {
        const targetDir = sanitizePath(SERVER_DIR, dir || '');
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            return sendError(res, 'Target directory not found', 404);
        }
        const target = sanitizePath(targetDir, name);

        if (type === 'folder') {
            fs.mkdirSync(target, { recursive: true });
        } else {
            const ext = path.extname(name).toLowerCase();
            if (!EDITABLE_EXTENSIONS.includes(ext)) {
                return sendError(res, 'Cannot create files with this extension', 403);
            }
            fs.writeFileSync(target, '');
        }
        diskCache.clear();
        log(`Created ${type}: ${name} in ${dir || '/'}`, 'info');
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') return sendError(res, 'Access denied', 403);
        sendError(res, err.message);
    }
});

app.put('/api/files/:path(*)', (req, res) => {
    const { content } = req.body;
    try {
        const filePath = sanitizePath(SERVER_DIR, decodeURIComponent(req.params.path));
        if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
        if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot write to directory', 400);

        const ext = path.extname(filePath).toLowerCase();
        if (!EDITABLE_EXTENSIONS.includes(ext)) return sendError(res, 'Editing not allowed', 403);
        if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) return sendError(res, 'Invalid content', 413);

        fs.writeFileSync(filePath, content, 'utf8');
        diskCache.clear();
        log(`File updated: ${req.params.path}`, 'info');
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') return sendError(res, 'Access denied', 403);
        sendError(res, err.message);
    }
});

app.delete('/api/files/:path(*)', (req, res) => {
    try {
        const filePath = sanitizePath(SERVER_DIR, decodeURIComponent(req.params.path));
        if (!fs.existsSync(filePath)) return sendError(res, 'Not found', 404);
        if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(filePath);
        }
        diskCache.clear();
        log(`Deleted: ${req.params.path}`, 'info');
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') return sendError(res, 'Access denied', 403);
        sendError(res, err.message);
    }
});

app.get('/api/files/download', (req, res) => {
    const { file: userPath } = req.query;
    if (!userPath) return sendError(res, 'file parameter is required');

    try {
        const filePath = sanitizePath(SERVER_DIR, userPath);
        if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
        if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot download a directory', 400);

        log(`File downloaded: ${userPath}`, 'info');
        res.download(filePath, path.basename(filePath));
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') {
            log(`Directory traversal attempt blocked: ${userPath}`, 'error');
            return sendError(res, 'Access denied', 403);
        }
        sendError(res, err.message);
    }
});

// Combined storage overview for the file explorer header: recursive
// server usage, host-disk free space, and per-folder breakdown.
app.get('/api/files/storage', (req, res) => {
    const server = getDiskUsage(SERVER_DIR);
    const host = getHostDiskInfo();
    const folders = getDiskBreakdown().slice(0, 14);
    res.json({ success: true, server, host, folders });
});

// Stream any folder (a world, plugins/, logs/, ...) as a zip archive.
// Uses the same system `zip` the backup engine relies on; the archive is
// piped straight to the client so multi-GB worlds never touch disk twice.
function dirHasFiles(dirPath) {
    try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            const full = path.join(dirPath, entry.name);
            if (!entry.isDirectory()) return true;
            if (dirHasFiles(full)) return true;
        }
    } catch {}
    return false;
}

app.get('/api/files/download-dir', (req, res) => {
    const { path: userPath } = req.query;
    if (!userPath) return sendError(res, 'path parameter is required');
    try {
        const filePath = sanitizePath(SERVER_DIR, userPath);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
            return sendError(res, 'Folder not found', 404);
        }
        if (!dirHasFiles(filePath)) return sendError(res, 'Folder is empty', 400);
        const baseName = String(path.basename(filePath) || 'server').replace(/"/g, '');
        const child = spawn('zip', ['-r', '-', '.'], { cwd: filePath, stdio: ['ignore', 'pipe', 'pipe'] });
        let done = false;
        const fail = (message, status) => {
            done = true;
            try { child.kill('SIGKILL'); } catch {}
            if (!res.headersSent) return sendError(res, message, status);
            try { res.destroy(); } catch {} // partial stream — abort the download
        };
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
        child.on('error', (err) => {
            fail(`Folder download failed — the 'zip' utility is not installed (${err.message})`, 500);
        });
        child.on('close', (code) => {
            if (code !== 0 && !done) fail(`Folder download failed (zip exit code ${code})`, 500);
            if (code === 0 && !res.writableEnded) res.end();
        });
        child.stdout.pipe(res);
        log(`Folder download requested: ${userPath}`, 'info');
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') {
            log(`Directory traversal attempt blocked: ${userPath}`, 'error');
            return sendError(res, 'Access denied', 403);
        }
        sendError(res, err.message);
    }
});

// Rename a file or folder inside its current directory.
app.post('/api/files/rename', (req, res) => {
    const { path: userPath, name: newName } = req.body;
    if (!userPath || typeof newName !== 'string' || !newName.trim()) {
        return sendError(res, 'path and name are required');
    }
    const clean = newName.trim();
    if (!/^[a-zA-Z0-9._ -]+$/.test(clean) || clean.includes('..')) {
        return sendError(res, 'Invalid name — use letters, numbers, dots, spaces, _ and - only');
    }
    try {
        const oldPath = sanitizePath(SERVER_DIR, userPath);
        if (!fs.existsSync(oldPath)) return sendError(res, 'Not found', 404);
        if (path.resolve(oldPath) === path.resolve(SERVER_DIR)) {
            return sendError(res, 'Cannot rename the server root', 400);
        }
        const target = sanitizePath(path.dirname(oldPath), clean);
        if (path.resolve(target) === path.resolve(oldPath)) return res.json({ success: true });
        if (fs.existsSync(target)) {
            return sendError(res, `A file or folder named "${clean}" already exists`, 409);
        }
        fs.renameSync(oldPath, target);
        diskCache.clear();
        const rel = path.relative(path.resolve(SERVER_DIR), target).split(path.sep).join('/');
        log(`Renamed: ${userPath} → ${rel}`, 'info');
        res.json({ success: true, newPath: rel });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') {
            log(`Directory traversal attempt blocked: ${userPath}`, 'error');
            return sendError(res, 'Access denied', 403);
        }
        sendError(res, err.message);
    }
});

app.post('/api/files/upload', (req, res) => {
    fileUpload.single('file')(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 'File exceeds 500MB limit', 413);
                return sendError(res, err.message, 400);
            }
            return sendError(res, err.message, 400);
        }
        if (!req.file) return sendError(res, 'No file uploaded', 400);

        // Resolve and validate the target directory AFTER multer has
        // fully parsed the multipart body (including the path field).
        let targetDir;
        try {
            targetDir = sanitizePath(SERVER_DIR, req.body.path || '');
            if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
                throw new Error('Target directory not found');
            }
        } catch (sanitizeErr) {
            fs.unlinkSync(req.file.path);
            if (sanitizeErr.message === 'PATH_TRAVERSAL_DETECTED') {
                log(`Directory traversal attempt blocked: ${req.body.path || ''}`, 'error');
                return sendError(res, 'Access denied', 403);
            }
            return sendError(res, sanitizeErr.message, 400);
        }

        const targetPath = path.join(targetDir, req.file.filename);
        try {
            if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
                throw new Error('A folder with that name already exists');
            }
            fs.renameSync(req.file.path, targetPath);
        } catch (moveErr) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return sendError(res, moveErr.message || 'Failed to save file', 500);
        }

        const relDir = path.relative(path.resolve(SERVER_DIR), path.resolve(targetDir)).replace(/\\/g, '/');
        const relPath = (relDir && relDir !== '.' ? relDir + '/' : '') + req.file.filename;
        diskCache.clear();
        log(`File uploaded: ${relPath} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`, 'info');
        res.json({ success: true, path: relPath, name: req.file.filename, size: req.file.size });
    });
});

// ================================================================
// PHASE 9: SERVER PROPERTIES (DYNAMIC GAME CONFIGURATION)
// ================================================================

function parseServerProperties() {
    try {
        if (!fs.existsSync(SERVER_PROPS_PATH)) {
            return { error: 'server.properties not found', properties: {} };
        }
        const content = fs.readFileSync(SERVER_PROPS_PATH, 'utf8');
        const properties = {};
        const comments = [];
        let currentComment = '';

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) {
                currentComment += trimmed + '\n';
            } else if (trimmed.includes('=')) {
                const eqIndex = trimmed.indexOf('=');
                const key = trimmed.substring(0, eqIndex).trim();
                let value = trimmed.substring(eqIndex + 1).trim();
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                } else if (value.startsWith("'") && value.endsWith("'")) {
                    value = value.slice(1, -1);
                }
                properties[key] = {
                    value,
                    comment: currentComment.trim(),
                    raw: line
                };
                currentComment = '';
            } else if (trimmed !== '') {
                currentComment = '';
            }
        }

        return { properties, comment: currentComment };
    } catch (err) {
        return { error: err.message, properties: {} };
    }
}

function serializeServerProperties(propertiesMap) {
    const lines = [];
    for (const [key, data] of Object.entries(propertiesMap)) {
        if (data.comment) {
            const comments = data.comment.split('\n').filter(c => c.trim());
            for (const comment of comments) {
                lines.push(comment);
            }
        }
        let value = data.value;
        if (value.includes(' ') || value.includes('#') || value.includes('=')) {
            value = '"' + value + '"';
        }
        lines.push(key + '=' + value);
    }
    return lines.join('\n');
}

app.get('/api/server/properties', (req, res) => {
    try {
        const result = parseServerProperties();
        if (result.error) {
            return res.status(404).json({ error: result.error });
        }

        const properties = {};
        for (const [key, data] of Object.entries(result.properties)) {
            properties[key] = data.value;
        }

        res.json({
            success: true,
            file: 'server.properties',
            properties,
            raw: fs.existsSync(SERVER_PROPS_PATH) ? fs.readFileSync(SERVER_PROPS_PATH, 'utf8') : ''
        });
    } catch (err) {
        log(`Properties read error: ${err.message}`, 'error');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/server/properties/update', (req, res) => {
    try {
        const { properties } = req.body;

        if (!properties || typeof properties !== 'object') {
            return sendError(res, 'properties object is required');
        }

        const result = parseServerProperties();
        if (result.error) {
            return res.status(404).json({ error: result.error });
        }

        const updated = { ...result.properties };

        for (const [key, value] of Object.entries(properties)) {
            const stringValue = String(value);
            if (updated[key]) {
                updated[key].value = stringValue;
            } else {
                updated[key] = { value: stringValue, comment: '', raw: key + '=' + stringValue };
            }
        }

        const content = serializeServerProperties(updated);
        fs.writeFileSync(SERVER_PROPS_PATH, content, 'utf8');

        log(`Server properties updated: ${Object.keys(properties).join(', ')}`, 'info');

        if (mcProcess) {
            io.emit('console', `\n${COLORS.yellow}[SYSTEM]${COLORS.reset} server.properties updated. Restart server to apply changes.\n`);
        }

        res.json({
            success: true,
            message: 'Properties updated. Restart server to apply.',
            updated: Object.keys(properties)
        });
    } catch (err) {
        log(`Properties update error: ${err.message}`, 'error');
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// PHASE 10: NETWORK & PORT MAPPER MODULE
// ================================================================

function checkPort(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        const timeout = setTimeout(() => { srv.close(); resolve(false); }, 3000);
        srv.once('error', () => { clearTimeout(timeout); resolve(false); });
        srv.once('listening', () => { clearTimeout(timeout); srv.close(); resolve(true); });
        srv.listen(port, '0.0.0.0');
    });
}

async function getPublicIP() {
    try {
        const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
        return response.data.ip;
    } catch (err) {
        log(`Failed to get public IP: ${err.message}`, 'warn');
        return null;
    }
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return { address: iface.address, mac: iface.mac };
            }
        }
    }
    return { address: '127.0.0.1', mac: null };
}

async function getNetworkStatus() {
    const localIP = getLocalIP();
    const publicIP = await getPublicIP();

    const defaultPorts = [
        { port: 25565, service: 'Minecraft Primary' },
        { port: 25566, service: 'Minecraft Secondary' },
        { port: 8123, service: 'Dynmap Web' },
        { port: 19132, service: 'Minecraft Bedrock' },
        { port: 25577, service: 'RCON' }
    ];

    const portChecks = await Promise.all(
        defaultPorts.map(async ({ port, service }) => {
            const available = await checkPort(port);
            return { port, service, status: available ? 'free' : 'in-use' };
        })
    );

    let allocations = [];
    try {
        if (fs.existsSync(NETWORK_DB_PATH)) {
            allocations = JSON.parse(fs.readFileSync(NETWORK_DB_PATH, 'utf8'));
        }
    } catch (err) {
        log(`Failed to load allocations: ${err.message}`, 'warn');
    }

    const activeAllocations = allocations.filter(a => a.status === 'active');

    return {
        publicIP,
        localIP: localIP.address,
        hostname: os.hostname(),
        mac: localIP.mac,
        defaultPorts: portChecks,
        allocations: activeAllocations,
        timestamp: new Date().toISOString()
    };
}

app.get('/api/network/status', async (req, res) => {
    try {
        log('Network status scan requested', 'info');
        const status = await getNetworkStatus();
        res.json(status);
    } catch (err) {
        log(`Network status error: ${err.message}`, 'error');
        res.status(500).json({ error: 'Failed to get network status' });
    }
});

app.get('/api/network', (req, res) => {
    res.json({ ip: getLocalIP().address, hostname: os.hostname() });
});

app.post('/api/network/allocate', async (req, res) => {
    const { port, service, description } = req.body;

    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
        return sendError(res, 'Invalid port number (1-65535 required)');
    }

    try {
        const available = await checkPort(port);
        if (!available) {
            log(`Port ${port} allocation failed — port in use`, 'warn');
            return res.status(409).json({ error: 'Port is already in use', port, status: 'in-use' });
        }

        ensureDirectories();
        let allocations = [];
        try {
            if (fs.existsSync(NETWORK_DB_PATH)) {
                allocations = JSON.parse(fs.readFileSync(NETWORK_DB_PATH, 'utf8'));
            }
        } catch {
            // Empty array
        }

        const existingIndex = allocations.findIndex(a => a.port === port);
        const newEntry = {
            id: `alloc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            port,
            service: service || 'Unknown',
            description: description || '',
            status: 'active',
            allocatedAt: new Date().toISOString()
        };

        if (existingIndex !== -1) {
            allocations[existingIndex] = newEntry;
        } else {
            allocations.push(newEntry);
        }

        fs.writeFileSync(NETWORK_DB_PATH, JSON.stringify(allocations, null, 2));
        log(`Port ${port} allocated for ${service || 'Unknown'}`, 'info');
        res.json({ success: true, port, service, message: 'Port allocated successfully' });
    } catch (err) {
        log(`Port allocation error: ${err.message}`, 'error');
        res.status(500).json({ error: 'Failed to allocate port' });
    }
});

app.delete('/api/network/allocate/:port', async (req, res) => {
    const port = parseInt(req.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        return sendError(res, 'Invalid port number');
    }

    try {
        let allocations = [];
        if (fs.existsSync(NETWORK_DB_PATH)) {
            allocations = JSON.parse(fs.readFileSync(NETWORK_DB_PATH, 'utf8'));
        }
        const index = allocations.findIndex(a => a.port === port);
        if (index === -1) return sendError(res, 'Port allocation not found', 404);

        allocations.splice(index, 1);
        fs.writeFileSync(NETWORK_DB_PATH, JSON.stringify(allocations, null, 2));
        log(`Port ${port} deallocated`, 'info');
        res.json({ success: true, port, message: 'Port deallocated successfully' });
    } catch (err) {
        log(`Port deallocation error: ${err.message}`, 'error');
        res.status(500).json({ error: 'Failed to deallocate port' });
    }
});

// ================================================================
// PHASE 11: PLUGIN MARKETPLACE MODULE
// ================================================================

const SPIGET_API = 'https://api.spiget.org/v2';
const MODRINTH_API = 'https://api.modrinth.com/v2';

// Every entry is verified to have Paper/Spigot builds on Modrinth, so a
// one-click install always succeeds.
const ESSENTIAL_PLUGINS = [
    { id: 'luckperms', name: 'LuckPerms', description: 'Advanced permissions management with support for groups, contexts, and extensive inheritance trees.', icon: 'https://cdn.modrinth.com/data/luckperms/icon.png', author: 'Luck', source: 'modrinth' },
    { id: 'worldedit', name: 'WorldEdit', description: 'In-game world editing utility with brushes, schematics, and millions of builds at your fingertips.', icon: 'https://cdn.modrinth.com/data/worldedit/icon.png', author: 'EngineHub', source: 'modrinth' },
    { id: 'essentialsx', name: 'EssentialsX', description: 'Essential server management featuring teleportation, economy, warps, kits, and more.', icon: 'https://cdn.modrinth.com/data/essentialsx/icon.png', author: 'EssentialsX Team', source: 'modrinth' },
    { id: 'placeholderapi', name: 'PlaceholderAPI', description: 'Flexible placeholder text system used by thousands of plugins — no more hardcoded text.', icon: 'https://cdn.modrinth.com/data/placeholderapi/icon.png', author: 'PlaceholderAPI Team', source: 'modrinth' },
    { id: 'coreprotect', name: 'CoreProtect', description: 'Fast block logging and anti-griefing. Inspect changes and roll back griefing with ease.', icon: 'https://cdn.modrinth.com/data/coreprotect/icon.png', author: 'Intelli' , source: 'modrinth' }
];

app.get('/api/plugins/essential', (req, res) => {
    res.json({ success: true, plugins: ESSENTIAL_PLUGINS });
});

app.get('/api/plugins/search', async (req, res) => {
    const { q = '', page = 1, per_page = 24 } = req.query;
    if (!q || q.trim().length < 2) return sendError(res, 'Search query must be at least 2 characters', 400);

    const maxResults = Math.min(parseInt(per_page, 10) || 24, 48);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    log(`Plugin search: "${q}" page ${pageNum}`, 'info');

    try {
        // Primary source: Modrinth API with proper facets filtering
        const mrRes = await axios.get(`${MODRINTH_API}/search`, {
            params: {
                query: q.trim(),
                offset: (pageNum - 1) * maxResults,
                limit: maxResults,
                facets: JSON.stringify([['project_type:plugin']])
            },
            timeout: 10000,
            headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
        });

        let plugins = [];
        if (mrRes.data && mrRes.data.hits && mrRes.data.hits.length > 0) {
            const hits = mrRes.data.hits.slice(0, maxResults);
            const versionPromises = hits.map(async (p) => {
                try {
                    const vRes = await axios.get(`${MODRINTH_API}/project/${p.project_id}/version`, {
                        params: { loaders: JSON.stringify(['paper', 'purpur', 'spigot', 'bukkit']) },
                        timeout: 5000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                    });
                    const versions = vRes.data || [];
                    // Find first Paper-compatible version with a download
                    let found = null;
                    for (const v of versions) {
                        if (v.files && v.files[0] && v.files[0].url) { found = v; break; }
                    }
                    return {
                        id: p.project_id, name: p.title || 'Unknown', tag: p.slug || '',
                        description: p.description ? p.description.substring(0, 200) : '',
                        icon: p.icon_url || null, downloads: p.downloads || 0,
                        likes: 0, premium: false, price: 0,
                        version: found ? found.version_number : 'N/A',
                        author: p.author || 'Unknown', source: 'modrinth',
                        downloadUrl: found ? found.files[0].url : null
                    };
                } catch { return null; }
            });
            const results = await Promise.all(versionPromises);
            plugins = results.filter(p => p && p.downloadUrl);
        }

        // Fallback: Spiget API when Modrinth returns no results
        if (plugins.length === 0) {
            try {
                const spigetUrl = `${SPIGET_API}/search/resources/${encodeURIComponent(q.trim())}?page=${pageNum - 1}&size=${maxResults}&fields=id,name,tag,description,icon,downloads,likes,premium,price,version,author,file`;
                const spRes = await axios.get(spigetUrl, { timeout: 10000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' } });
                plugins = (spRes.data || []).map(p => ({
                    id: String(p.id), name: p.name || 'Unknown Plugin', tag: p.tag || '',
                    description: p.description ? p.description.replace(/<[^>]*>/g, '').substring(0, 200) : '',
                    icon: p.icon ? (p.icon.url || p.icon) : null,
                    downloads: p.downloads || 0, likes: p.likes || 0,
                    premium: p.premium || false, price: p.price || 0,
                    version: p.version || 'N/A',
                    author: (p.author && p.author.name) ? p.author.name : 'Unknown',
                    source: 'spigot',
                    downloadUrl: p.file ? `${SPIGET_API}/resources/${p.id}/download` : null
                })).filter(p => p.downloadUrl);
            } catch (spErr) {
                log(`Spigot fallback search failed: ${spErr.message}`, 'warn');
            }
        }

        res.json({ success: true, query: q, page: pageNum, perPage: maxResults, count: plugins.length, plugins });
    } catch (err) {
        log(`Plugin search error: ${err.message}`, 'error');
        res.status(502).json({ success: false, error: 'Search service unavailable', plugins: [] });
    }
});

app.get('/api/plugins/installed', (req, res) => {
    const pluginsDir = path.join(SERVER_DIR, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
        return res.json({ success: true, plugins: [] });
    }
    try {
        const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.jar')).map(f => {
            const stat = fs.statSync(path.join(pluginsDir, f));
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
        });
        res.json({ success: true, plugins: files });
    } catch (err) {
        log(`List installed plugins error: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

// ----------------------------------------------------------------
// Plugin install queue — installs run strictly one at a time so
// multiple marketplace installs never contend for bandwidth or the
// plugins folder. Requests are chained server-side, which also keeps
// parallel browser tabs from starting simultaneous downloads.
// ----------------------------------------------------------------
let pluginInstallTail = Promise.resolve();
let pluginInstallQueue = [];

function emitPluginQueue() {
    try {
        if (io && io.engine && io.engine.clientsCount > 0) {
            io.emit('plugin-queue', {
                active: pluginInstallQueue.length > 0 ? 1 : 0,
                queued: Math.max(pluginInstallQueue.length - 1, 0),
                queue: pluginInstallQueue.slice(0, 10)
            });
        }
    } catch {}
}

function emitProgressNow(pluginId, stage, percent, message, speed) {
    try {
        io.emit('plugin-progress', { pluginId, stage, percent, message, speed: speed || null });
    } catch {}
}

app.post('/api/plugins/install', (req, res) => {
    const { resourceId, source, name } = req.body;
    if (!resourceId || !source) return sendError(res, 'resourceId and source are required');

    // Installs are allowed while the server runs — Paper picks new jars up
    // on the next restart. We just make sure the user is told.
    if (mcProcess) {
        log(`Plugin install requested while server is running (${resourceId}) — will load on restart`, 'warn');
    }

    const position = pluginInstallQueue.length + 1;
    pluginInstallQueue.push(resourceId);
    emitPluginQueue();

    if (position > 1) {
        emitProgressNow(resourceId, 'queued', 0, `Queued behind ${position - 1} install(s)...`);
    }

    const run = pluginInstallTail
        .then(() => runPluginInstall(req, res, resourceId, source, name))
        .catch((err) => {
            // A thrown job must never break the queue.
            log(`Plugin install job error: ${err.message}`, 'error');
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err.message });
            }
        })
        .finally(() => {
            pluginInstallQueue = pluginInstallQueue.filter((id) => id !== resourceId);
            emitPluginQueue();
        });
    pluginInstallTail = run;
});

async function runPluginInstall(req, res, resourceId, source, name) {
    const pluginsDir = path.join(SERVER_DIR, 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    log(`Installing plugin from ${source}:${resourceId}`, 'info');

    let downloadUrl;
    let suggestedName = name || `plugin-${resourceId}.jar`;

    const emitProgress = (stage, percent, message, speed) => {
        emitProgressNow(resourceId, stage, percent, message, speed);
    };

    emitProgress('resolving', 0, 'Resolving download URL...');

    try {
        // Resolve download URL from the appropriate source
        if (source === 'modrinth') {
            // Loader-filtered first: Modrinth deduplicates the response to the
            // relevant builds, which keeps big projects (WorldEdit: 185
            // versions) small enough to scan client-side.
            let versions = null;
            try {
                const vRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
                    params: { loaders: JSON.stringify(['paper', 'purpur', 'spigot', 'bukkit']) },
                    timeout: 10000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                });
                versions = vRes.data;
            } catch {}
            if (!versions || versions.length === 0) {
                // Fallback: try without loader filter
                try {
                    const fallbackRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
                        timeout: 10000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                    });
                    versions = fallbackRes.data;
                } catch {}
            }
            versions = versions || [];

            // Plugin jar for the running Minecraft version. Many plugins ship
            // ONE polyglot jar that supports 1.8→1.21+, listing the oldest
            // supported version first — so we must match the target against
            // the WHOLE supported list, never just game_versions[0]. Stable
            // builds beat betas; newer patch beats older. If the filtered
            // list somehow lacks a build for the target, re-fetch unfiltered
            // and scan that instead (dedup can hide a compatible build).
            const serverSettings = loadSettings();
            const targetVer = (serverSettings.serverVersion || '').trim();
            const isPluginBuild = (v) => {
                if (!v.files || !v.files[0] || !v.files[0].url) return false;
                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                return loaders.some(l => ['paper', 'purpur', 'spigot', 'bukkit'].includes(l));
            };
            const supports = (v) => {
                if (!targetVer) return true; // no configured target → newest works
                return (v.game_versions || []).includes(targetVer);
            };
            const stableOrder = (v) => /(-|^)(beta|alpha|pre|rc|snapshot)/i.test(v.version_number || '') ? 1 : 0;
            const newer = (a, b) => { // prefer stable over beta, then list order (newest first)
                const s = stableOrder(a) - stableOrder(b);
                return s !== 0 ? s : 0;
            };

            let compatible = versions.filter(v => isPluginBuild(v) && supports(v));
            if (!targetVer) compatible = compatible.sort(newer);
            let best = compatible[0] || null;

            // The filtered scan missed → widen with the full version list.
            if (!best && targetVer) {
                try {
                    const wideRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
                        timeout: 15000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                    });
                    compatible = (wideRes.data || []).filter(v => isPluginBuild(v) && supports(v));
                    best = compatible[0] || null;
                } catch {}
            }
            if (!best) {
                // Explain WHY resolution failed so the user can act on it.
                const loaderSet = new Set();
                for (const v of versions) {
                    for (const l of (v.loaders || [])) loaderSet.add(l);
                }
                const loaderList = [...loaderSet].slice(0, 5).join(', ');
                const msg = versions.length === 0
                    ? 'This plugin has no downloadable versions on Modrinth.'
                    : `This plugin has no Paper/Spigot build on Modrinth (only: ${loaderList || 'other loaders'}). Try searching Spigot instead.`;
                emitProgress('error', 0, msg);
                return sendError(res, msg, 404);
            }
            downloadUrl = best.files[0].url;
            suggestedName = best.files[0].filename || suggestedName;
        } else if (source === 'spigot') {
            const infoRes = await axios.get(`${SPIGET_API}/resources/${resourceId}?fields=id,name`, {
                timeout: 10000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
            });
            downloadUrl = `${SPIGET_API}/resources/${resourceId}/download`;
            suggestedName = (infoRes.data.name || suggestedName).replace(/[^a-zA-Z0-9._ -]/g, '_') + '.jar';
        } else {
            emitProgress('error', 0, 'Invalid plugin source');
            return sendError(res, 'Invalid source. Use "modrinth" or "spigot"', 400);
        }

        if (!suggestedName.endsWith('.jar') || suggestedName.length > 255) {
            emitProgress('error', 0, 'Invalid filename generated');
            return sendError(res, 'Invalid filename generated');
        }

        const targetPath = path.join(pluginsDir, suggestedName);
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

        // Stream download with real-time progress tracking via Socket.io
        emitProgress('downloading', 0, 'Starting download...');

        const response = await axios({
            method: 'GET', url: downloadUrl, responseType: 'stream',
            timeout: 120000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
        });

        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        const startTime = Date.now();
        let downloadedBytes = 0;
        let lastEmitTime = 0;
        let lastEmitBytes = 0;
        const writer = fs.createWriteStream(targetPath);

        // Abort the transfer if the upstream stalls for 60s — a hung
        // download should never leave the panel waiting forever.
        let stalledTimer = setTimeout(() => {
            response.data.destroy(new Error('Download stalled — no data received for 60s'));
        }, 60000);

        const emitDownloadProgress = (force) => {
            const now = Date.now();
            const elapsed = Math.max((now - startTime) / 1000, 0.1);
            const windowSec = Math.max((now - lastEmitTime) / 1000, 0.001);
            // Instant speed over the last window, blended with the overall
            // average so the readout stays stable instead of jumping around.
            const instantBps = (downloadedBytes - lastEmitBytes) / windowSec;
            const overallBps = downloadedBytes / elapsed;
            const speedBps = Math.max(instantBps, overallBps * 0.5);
            const speedMBps = speedBps / 1024 / 1024;

            const percent = contentLength > 0 ? Math.min(Math.round((downloadedBytes / contentLength) * 100), 99) : 0;
            const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
            const totalMB = contentLength > 0 ? (contentLength / 1024 / 1024).toFixed(1) : '?';

            let eta = '';
            if (contentLength > 0 && speedBps > 0) {
                const remaining = Math.max(contentLength - downloadedBytes, 0);
                eta = ` · ETA ${Math.ceil(remaining / speedBps)}s`;
            }

            const msg = contentLength > 0
                ? `${percent}% (${downloadedMB}/${totalMB} MB) @ ${speedMBps.toFixed(1)} MB/s${eta}`
                : `${downloadedMB} MB @ ${speedMBps.toFixed(1)} MB/s`;
            emitProgress('downloading', percent, `Downloading... ${msg}`, speedMBps);
            lastEmitBytes = downloadedBytes;
            lastEmitTime = now;
        };

        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            clearTimeout(stalledTimer);
            stalledTimer = setTimeout(() => {
                response.data.destroy(new Error('Download stalled — no data received for 60s'));
            }, 60000);

            const now = Date.now();
            // Throttle progress updates to ~1/sec for smooth, non-spammy UI.
            if (now - lastEmitTime >= 1000) {
                emitDownloadProgress(false);
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            response.data.on('error', (err) => {
                clearTimeout(stalledTimer);
                try { writer.destroy(); } catch {}
                try { fs.unlinkSync(targetPath); } catch {}
                reject(new Error(`Download error: ${err.message}`));
            });
            writer.on('finish', () => {
                clearTimeout(stalledTimer);
                emitDownloadProgress(true); // final 99%+ readout before verify
                resolve();
            });
            writer.on('error', (err) => {
                clearTimeout(stalledTimer);
                try { fs.unlinkSync(targetPath); } catch {}
                reject(new Error(`Write failed: ${err.message}`));
            });
        });

        // Verification phase
        emitProgress('verifying', 100, 'Verifying downloaded file...');

        const stat = fs.statSync(targetPath);
        diskCache.clear(); // plugins/ changed — folder sizes must refresh
        if (stat.size < 1000) {
            fs.unlinkSync(targetPath);
            emitProgress('error', 0, 'Downloaded file is too small, may be corrupted');
            return sendError(res, 'Downloaded file is too small, may be corrupted', 502);
        }

        const needsRestart = !!mcProcess;
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        emitProgress('complete', 100, `${suggestedName} installed successfully (${sizeMB} MB)${needsRestart ? ' — restart to load' : ''}`);
        log(`Plugin installed: ${suggestedName} (${sizeMB} MB)`, 'info');
        io.emit('console', `\n${COLORS.green}[PLUGIN]${COLORS.reset} Installed: ${suggestedName}\n`);
        if (needsRestart) {
            emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Restart the server to load ${suggestedName}\n`);
        }
        res.json({ success: true, name: suggestedName, size: stat.size, needsRestart });

    } catch (err) {
        log(`Plugin install error: ${err.message}`, 'error');
        emitProgress('error', 0, `Install failed: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
}

app.post('/api/plugins/upload', (req, res) => {
    pluginUpload.single('plugin')(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 'File exceeds 100MB limit', 413);
                return sendError(res, err.message, 400);
            }
            return sendError(res, err.message, 400);
        }
        if (!req.file) return sendError(res, 'No file uploaded', 400);

        const { filename, size, path: filePath } = req.file;
        diskCache.clear();
        log(`Plugin uploaded: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`, 'info');
        io.emit('console', `\n[PLUGIN] Uploaded: ${filename}\n`);
        const needsRestart = !!mcProcess;
        if (needsRestart) {
            emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Restart the server to load ${filename}\n`);
        }
        res.json({ success: true, name: filename, size, needsRestart });
    });
});

app.delete('/api/plugins/:name', (req, res) => {
    const name = req.params.name;
    if (!name.endsWith('.jar') || !/^[a-zA-Z0-9._ -]+$/.test(name)) {
        return sendError(res, 'Invalid plugin name');
    }
    try {
        const pluginPath = path.join(SERVER_DIR, 'plugins', name);
        if (fs.existsSync(pluginPath)) {
            fs.unlinkSync(pluginPath);
            diskCache.clear();
            log(`Plugin deleted: ${name}`, 'info');
            res.json({ success: true });
        } else {
            res.json({ error: 'Not found' });
        }
    } catch (err) {
        sendError(res, 'Failed to delete plugin');
    }
});

// ================================================================
// PHASE 12: PANEL SETTINGS MODULE
// ================================================================

function saveSettings(settings) {
    try {
        ensureDirectories();
        fs.writeFileSync(SETTINGS_DB_PATH, JSON.stringify(settings, null, 2));
        return true;
    } catch (err) {
        log(`Failed to save settings: ${err.message}`, 'error');
        return false;
    }
}

app.get('/api/settings', (req, res) => {
    const settings = loadSettings();
    res.json({ success: true, settings });
});

const SETTINGS_TO_PROPS = {
    motd: 'motd',
    maxPlayers: 'max-players',
    difficulty: 'difficulty',
    gamemode: 'gamemode',
    pvp: 'pvp',
    onlineMode: 'online-mode',
    whitelist: 'white-list',
    viewDistance: 'view-distance',
    spawnProtection: 'spawn-protection',
    serverPort: 'server-port'
};

app.post('/api/settings/save', (req, res) => {
    const current = loadSettings();
    const allowedKeys = Object.keys(DEFAULT_SETTINGS);
    let changed = [];

    for (const key of allowedKeys) {
        if (req.body[key] !== undefined) {
            current[key] = req.body[key];
            changed.push(key);
        }
    }

    if (saveSettings(current)) {
        // Sync compatible settings to server.properties
        try {
            if (fs.existsSync(SERVER_PROPS_PATH)) {
                let propsContent = fs.readFileSync(SERVER_PROPS_PATH, 'utf8');
                let propsModified = false;
                for (const [key, propKey] of Object.entries(SETTINGS_TO_PROPS)) {
                    if (req.body[key] !== undefined && changed.includes(key)) {
                        const val = String(req.body[key]);
                        const re = new RegExp(`^${escapeRegex(propKey)}=.*$`, 'm');
                        if (re.test(propsContent)) {
                            propsContent = propsContent.replace(re, `${propKey}=${val}`);
                        } else {
                            propsContent += `\n${propKey}=${val}`;
                        }
                        propsModified = true;
                    }
                }
                if (propsModified) {
                    fs.writeFileSync(SERVER_PROPS_PATH, propsContent, 'utf8');
                    log('server.properties synced from settings', 'info');
                }
            }
        } catch (propsErr) {
            log(`Failed to sync server.properties: ${propsErr.message}`, 'warn');
        }

        log(`Settings saved: ${changed.join(', ')}`, 'info');
        res.json({ success: true, settings: current });
    } else {
        res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
});

// ================================================================
// PHASE 13: BACKUPS MODULE
// ================================================================

app.get('/api/backups', (req, res) => {
    if (!fs.existsSync(BACKUPS_DIR)) return res.json([]);
    try {
        const files = fs.readdirSync(BACKUPS_DIR)
            .filter(f => f.endsWith('.zip'))
            .map(f => ({
                name: f,
                size: Math.round(fs.statSync(path.join(BACKUPS_DIR, f)).size / 1024 / 1024),
                date: fs.statSync(path.join(BACKUPS_DIR, f)).mtime
            }));
        res.json(files.sort((a, b) => b.date - a.date));
    } catch (err) {
        res.json([]);
    }
});

function createBackupZip(callback) {
    const backupName = `backup-${Date.now()}.zip`;
    const backupPath = path.join(BACKUPS_DIR, backupName);
    const s = loadSettings();
    const worlds = (s.backupWorlds || 'world').split(',').map(w => w.trim()).filter(Boolean);

    // Only zip paths that actually exist — a brand-new server has no world/
    // folder yet, and zip exits with "Nothing to do!" (code 12) when handed
    // only missing inputs, which made backups fail mysteriously.
    const targets = [];
    for (const t of [...worlds, 'plugins', 'server.properties']) {
        const safe = String(t).replace(/^\/+|\/+$/g, '').replace(/\/\//g, '/');
        if (!safe || safe.includes('..')) continue;
        if (fs.existsSync(path.join(SERVER_DIR, safe))) targets.push(safe);
    }
    if (targets.length === 0) {
        return callback(new Error('Nothing to back up yet — no world folder or plugins found. Start the server once to generate a world.'));
    }

    const args = ['-r', backupPath, ...targets];

    const child = spawn('zip', args, {
        cwd: SERVER_DIR,
        stdio: 'ignore'
    });
    child.on('error', (err) => {
        callback(new Error(`Backup failed — the 'zip' utility is not installed on this system (${err.message})`));
    });
    child.on('close', (code) => {
        if (code === 0) {
            checkScheduledBackups(); // Prune excess after creation
            callback(null, backupName);
        } else {
            callback(new Error(`Backup failed (zip exit code ${code})`));
        }
    });
}

app.post('/api/backups/create', (req, res) => {
    createBackupZip((err, backupName) => {
        if (err) return sendError(res, err.message, 500);
        res.json({ success: true, name: backupName });
    });
});

app.delete('/api/backups/:name', (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9._-]+\.zip$/.test(name)) {
        return sendError(res, 'Invalid backup name');
    }
    const backupPath = path.resolve(BACKUPS_DIR, name);
    if (!backupPath.startsWith(path.resolve(BACKUPS_DIR) + path.sep)) {
        return sendError(res, 'Invalid path');
    }
    try {
        if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
            res.json({ success: true });
        } else {
            res.json({ error: 'Not found' });
        }
    } catch (err) {
        sendError(res, 'Failed to delete backup');
    }
});

// ================================================================
// CRASH LOG API
// ================================================================

app.get('/api/crash-log', (req, res) => {
    try {
        if (fs.existsSync(CRASH_LOG_PATH)) {
            const raw = fs.readFileSync(CRASH_LOG_PATH, 'utf8').trim();
            if (raw) {
                const logs = JSON.parse(raw);
                return res.json({ success: true, logs: Array.isArray(logs) ? logs : [] });
            }
        }
        res.json({ success: true, logs: [] });
    } catch (err) {
        res.json({ success: true, logs: [] });
    }
});

app.post('/api/crash-log/clear', (req, res) => {
    try {
        fs.writeFileSync(CRASH_LOG_PATH, '[]', 'utf8');
        res.json({ success: true });
    } catch (err) {
        sendError(res, 'Failed to clear crash log');
    }
});

// ================================================================
// PHASE 13b: SCHEDULED TASKS MODULE
// Tasks live in config/tasks.json and run on a 30s heartbeat:
//   command  -> send a console command to the running server
//   restart  -> gracefully restart the server (if running)
//   backup   -> create a zip backup of the configured worlds
// ================================================================

const TASKS_DB_PATH = path.join(CONFIG_DIR, 'tasks.json');

function loadTasks() {
    try {
        if (fs.existsSync(TASKS_DB_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(TASKS_DB_PATH, 'utf8'));
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (err) {
        log(`Failed to load tasks: ${err.message}`, 'warn');
    }
    return [];
}

function saveTasks(tasks) {
    try {
        ensureDirectories();
        fs.writeFileSync(TASKS_DB_PATH, JSON.stringify(tasks, null, 2), 'utf8');
        return true;
    } catch (err) {
        log(`Failed to save tasks: ${err.message}`, 'error');
        return false;
    }
}

app.get('/api/tasks', (req, res) => {
    res.json({ success: true, tasks: loadTasks() });
});

app.post('/api/tasks', (req, res) => {
    const { name, type, command, intervalMinutes, enabled } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
        return sendError(res, 'Task name is required');
    }
    if (!['command', 'restart', 'backup'].includes(type)) {
        return sendError(res, 'Invalid task type');
    }
    const interval = parseInt(intervalMinutes, 10);
    if (isNaN(interval) || interval < 1 || interval > 24 * 60) {
        return sendError(res, 'Interval must be between 1 and 1440 minutes');
    }
    if (type === 'command' && (!command || !command.trim())) {
        return sendError(res, 'Command is required for command tasks');
    }

    const tasks = loadTasks();
    const task = {
        id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        name: name.trim().slice(0, 100),
        type,
        command: type === 'command' ? command.trim().slice(0, 500) : '',
        intervalMinutes: interval,
        enabled: enabled !== false,
        lastRun: null,
        createdAt: new Date().toISOString()
    };
    tasks.push(task);
    if (!saveTasks(tasks)) return sendError(res, 'Failed to save task', 500);

    log(`Task created: ${task.name} (${type} every ${interval}min)`, 'info');
    res.json({ success: true, task });
});

app.delete('/api/tasks/:id', (req, res) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return sendError(res, 'Task not found', 404);
    tasks.splice(idx, 1);
    if (!saveTasks(tasks)) return sendError(res, 'Failed to save tasks', 500);
    res.json({ success: true });
});

app.post('/api/tasks/:id/toggle', (req, res) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return sendError(res, 'Task not found', 404);
    task.enabled = !task.enabled;
    if (!saveTasks(tasks)) return sendError(res, 'Failed to save tasks', 500);
    res.json({ success: true, enabled: task.enabled });
});

function runTask(task) {
    if (task.type === 'command') {
        const result = sendCommand(task.command);
        log(`[Task] Ran command "${task.command}" — ${result.success ? 'ok' : result.error}`, 'info');
    } else if (task.type === 'restart') {
        if (mcProcess) {
            restartServer();
            log('[Task] Scheduled restart triggered', 'warn');
        } else {
            log('[Task] Restart skipped — server not running', 'warn');
        }
    } else if (task.type === 'backup') {
        createBackupZip((err, backupName) => {
            log(`[Task] Scheduled backup ${err ? 'failed: ' + err.message : 'completed: ' + backupName}`, err ? 'error' : 'info');
            emitConsoleSafe(`\n${COLORS.cyan}[TASK]${COLORS.reset} Scheduled backup ${err ? 'failed' : 'completed: ' + backupName}\n`);
        });
    }
}

// Task heartbeat — check every 30 seconds for due tasks.
setInterval(() => {
    const tasks = loadTasks();
    const now = Date.now();
    let changed = false;
    for (const task of tasks) {
        if (!task.enabled) continue;
        const intervalMs = (task.intervalMinutes || 0) * 60 * 1000;
        if (intervalMs <= 0) continue;
        const lastRun = task.lastRun ? new Date(task.lastRun).getTime() : 0;
        if (now - lastRun >= intervalMs) {
            task.lastRun = new Date().toISOString();
            changed = true;
            try {
                if (io && io.engine && io.engine.clientsCount > 0) {
                    io.emit('task-ran', { id: task.id, name: task.name, type: task.type });
                }
            } catch {}
            runTask(task);
        }
    }
    if (changed) saveTasks(tasks);
}, 30000);

// ================================================================
// PHASE 14: GITHUB UPDATE ENGINE (version.json driven)
// The panel updates itself by downloading the latest source archive
// from GitHub. Version comparison uses version.json — the same file
// lives in this install and at the repository root — so updates work
// with or without a local git clone.
// ================================================================

const UPDATE_CHECK_TTL = 5 * 60 * 1000; // re-query GitHub at most every 5 min
let updateCheckCache = null;
let lastKnownBranch = null;

// Directories/files the updater must never touch.
const UPDATE_PROTECTED = new Set(['.git', 'node_modules', 'server', 'config', 'backups', 'uploads', '.env']);

function rawVersionUrl(branch) {
    if (UPDATE_RAW_URL) return UPDATE_RAW_URL;
    return `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/version.json`;
}

function archiveUrl(branch) {
    if (UPDATE_ARCHIVE_URL) return UPDATE_ARCHIVE_URL;
    return `https://codeload.github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tar.gz/refs/heads/${branch}`;
}

function normalizeVersion(v) {
    const s = String(v || '').trim().replace(/^v/i, '');
    return s || null;
}

/** Numeric dotted comparison (1.0.10 > 1.0.9). Returns -1 | 0 | 1. */
function compareVersions(a, b) {
    const pa = normalizeVersion(a) ? normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0) : [0];
    const pb = normalizeVersion(b) ? normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0) : [0];
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

function parseVersionJson(text) {
    // Handles both raw file strings and already-parsed objects
    // (axios auto-JSON-parses its responses).
    try {
        const data = (typeof text === 'object' && text !== null) ? text : JSON.parse(text);
        const v = normalizeVersion(data && (data.version || data.latest || data.build));
        if (v) return v;
    } catch { /* fall through to the regex */ }
    if (typeof text === 'object') return null;
    const m = String(text || '').match(/(\d+(?:\.\d+){1,3})/);
    return m ? m[1] : null;
}

/** The version of this install: version.json → package.json → hardcoded fallback. */
function getLocalVersion() {
    try {
        if (fs.existsSync(VERSION_FILE)) {
            const v = parseVersionJson(fs.readFileSync(VERSION_FILE, 'utf8'));
            if (v) return v;
        }
        const pkg = require(path.join(ROOT_DIR, 'package.json'));
        if (pkg && pkg.version) {
            const v = normalizeVersion(pkg.version);
            if (v) return v;
        }
    } catch { /* ignore */ }
    return CURRENT_VERSION;
}

function emitUpdateEvent(level, text) {
    try {
        io.emit('update-progress', { text, level, timestamp: new Date().toISOString() });
    } catch { /* ignore */ }
}

/** Fetches { version, branch } for one branch, or null when unreachable/404. */
async function fetchRemoteVersion(branch) {
    try {
        const res = await axios.get(rawVersionUrl(branch), {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000,
            validateStatus: s => s >= 200 && s < 300
        });
        const version = parseVersionJson(res.data);
        return version ? { version, branch } : null;
    } catch (err) {
        log(`fetchRemoteVersion(${branch}) failed: ${err.message}`, 'warn');
        return null;
    }
}

/** Resolves the live remote version (last-known branch, then main, then master). */
async function resolveRemoteVersion() {
    const candidates = [];
    if (lastKnownBranch) candidates.push(lastKnownBranch);
    for (const b of [GITHUB_BRANCH, 'master']) {
        if (!candidates.includes(b)) candidates.push(b);
    }
    for (const branch of candidates) {
        const remote = await fetchRemoteVersion(branch);
        if (remote) {
            lastKnownBranch = branch;
            return remote;
        }
    }
    return null;
}

app.get('/api/update/check', async (req, res) => {
    try {
        const now = Date.now();
        if (updateCheckCache && now - updateCheckCache.at < UPDATE_CHECK_TTL) {
            return res.json({ ...updateCheckCache.payload, fromCache: true });
        }

        const currentVersion = getLocalVersion();
        const remote = await resolveRemoteVersion();
        const newer = remote ? compareVersions(remote.version, currentVersion) : 0;

        const payload = {
            method: 'github',
            source: 'version.json',
            gitRepoUrl: GIT_REMOTE_URL,
            branch: remote ? remote.branch : (lastKnownBranch || GITHUB_BRANCH),
            checkedAt: new Date().toISOString(),
            currentVersion,
            latestVersion: remote ? remote.version : currentVersion,
            updateAvailable: newer > 0,
            checkBlocked: !remote,
            message: !remote
                ? 'Could not fetch version.json from the GitHub repository. Push version.json to the repo (main or master) and make sure the panel can reach the network.'
                : (newer === 0
                    ? `This install matches the repository (v${currentVersion}).`
                    : (newer < 0
                        ? `The repository is at v${remote.version} — older than this install (v${currentVersion}). No downgrade performed.`
                        : `A newer release (v${remote.version}) is available on GitHub.`))
        };
        updateCheckCache = { at: now, payload };
        res.json(payload);
    } catch (err) {
        log(`Update check failed: ${err.message}`, 'error');
        res.status(500).json({
            error: 'Failed to check for updates on GitHub',
            method: 'github',
            source: 'version.json',
            currentVersion: getLocalVersion(),
            gitRepoUrl: GIT_REMOTE_URL
        });
    }
});

app.post('/api/update/install', (req, res) => {
    if (isUpdateRunning) {
        return res.status(409).json({ error: 'An update is already running. Please wait.' });
    }

    // Respond immediately; the async runner streams progress over Socket.io.
    res.json({ success: true, status: 'github_update_initiated', method: 'github', source: 'version.json' });

    // Drop the cached check result so the next check reflects the installed version.
    updateCheckCache = null;
    isUpdateRunning = true;
    log('GitHub update initiated (version.json source)', 'info');
    runGithubUpdate()
        .catch(err => {
            log(`Update failed: ${err.message}`, 'error');
            emitUpdateEvent('error', `[GIT ERROR] ${err.message}`);
            try { io.emit('update-complete', { success: false, message: err.message }); } catch { /* ignore */ }
        })
        .finally(() => {
            isUpdateRunning = false;
        });
});

function extractTarGz(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'ignore' });
        child.on('error', () => reject(new Error('tar could not be started — this system needs the tar utility to install updates.')));
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`Archive extraction failed (tar exit code ${code}).`)));
    });
}

function findStagedRoot(stageDir) {
    try {
        for (const entry of fs.readdirSync(stageDir)) {
            const p = path.join(stageDir, entry);
            if (!fs.statSync(p).isDirectory()) continue;
            if (fs.existsSync(path.join(p, 'app.js')) && fs.existsSync(path.join(p, 'package.json'))) return p;
        }
    } catch { /* fall through */ }
    return null;
}

function filesDiffer(aPath, bPath) {
    try {
        return fs.readFileSync(aPath, 'utf8') !== fs.readFileSync(bPath, 'utf8');
    } catch {
        return true;
    }
}

function runNpmInstall() {
    return new Promise((resolve, reject) => {
        const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
            cwd: ROOT_DIR,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let tail = '';
        child.stdout.on('data', c => { tail = (tail + c.toString()).slice(-400); });
        child.stderr.on('data', c => { tail = (tail + c.toString()).slice(-400); });
        child.on('error', () => reject(new Error('npm could not be started while installing dependencies.')));
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`npm install failed (exit code ${code}). ${tail.split('\n').slice(-3).join(' ')}`)));
    });
}

function restartPanel() {
    return new Promise(resolve => {
        if (process.env.pm_id !== undefined || process.env.PM2_HOME) {
            // Under PM2, exit through the graceful-shutdown path so a running
            // Minecraft server is stopped (world saved) instead of orphaned
            // mid-session; the non-zero exit makes PM2 auto-restart the panel
            // with the freshly-installed code.
            log('Panel runs under PM2 — shutting down for automatic restart with the new version', 'info');
            requestShutdown('self-update restart');
            return resolve(true);
        }
        const child = spawn('pm2', ['restart', 'purple-mc-panel'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('close', code => resolve(code === 0));
    });
}

async function runGithubUpdate() {
    const stageBase = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-update-'));
    const archivePath = path.join(stageBase, 'source.tar.gz');

    try {
        // ── 1 · resolve remote version from version.json ────────────────
        emitUpdateEvent('system', '[STEP 1] Checking version.json against the GitHub repository...');
        const remote = await resolveRemoteVersion();
        if (!remote) throw new Error('Could not fetch version.json from GitHub — the update was not installed.');
        const currentVersion = getLocalVersion();
        const cmp = compareVersions(remote.version, currentVersion);
        if (cmp === 0) throw new Error(`No newer version available — the repository is at v${remote.version}, same as this install.`);
        if (cmp < 0) throw new Error(`Repository version v${remote.version} is older than this install (v${currentVersion}). Refusing to downgrade.`);
        emitUpdateEvent('info', `[STEP 1] v${currentVersion} → v${remote.version} on branch ${remote.branch} — updating.`);

        // ── 2 · download the source archive ─────────────────────────────
        emitUpdateEvent('system', '[STEP 2] Downloading the latest source from GitHub...');
        let lastProgress = 0;
        await downloadFile(archiveUrl(remote.branch), archivePath, (got, total) => {
            const now = Date.now();
            if (now - lastProgress < 1000) return;
            lastProgress = now;
            const pct = total > 0 ? Math.round((got / total) * 100) : Math.round(got / 1024);
            emitUpdateEvent('info', `[STEP 2] ${total > 0 ? pct + '%' : got + ' bytes downloaded'}`);
        });

        // ── 3 · extract and validate ────────────────────────────────────
        emitUpdateEvent('system', '[STEP 3] Extracting and validating the archive...');
        await extractTarGz(archivePath, stageBase);
        const stageRoot = findStagedRoot(stageBase);
        if (!stageRoot) throw new Error('Downloaded archive does not look like the panel source (version.json / app.js / package.json missing). Nothing was changed.');
        const stagedVersion = parseVersionJson(fs.readFileSync(path.join(stageRoot, 'version.json'), 'utf8')) || remote.version;
        emitUpdateEvent('info', `[STEP 3] Archive verified — staged version ${stagedVersion}.`);

        // ── 4 · install new files, preserving runtime data ──────────────
        emitUpdateEvent('system', '[STEP 4] Installing new files (server/, config/, backups/, node_modules/ are preserved)...');
        const stagedEntries = new Set(fs.readdirSync(stageRoot));
        for (const entry of stagedEntries) {
            if (UPDATE_PROTECTED.has(entry)) continue;
            const src = path.join(stageRoot, entry);
            const dst = path.join(ROOT_DIR, entry);
            fs.rmSync(dst, { recursive: true, force: true });
            fs.cpSync(src, dst, { recursive: true });
        }
        // Remove top-level files/dirs that no longer exist in the new release.
        for (const entry of fs.readdirSync(ROOT_DIR)) {
            if (UPDATE_PROTECTED.has(entry) || stagedEntries.has(entry)) continue;
            emitUpdateEvent('warn', `[STEP 4] Removing obsolete file: ${entry}`);
            fs.rmSync(path.join(ROOT_DIR, entry), { recursive: true, force: true });
        }
        fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: stagedVersion }, null, 2) + '\n');
        emitUpdateEvent('success', `[STEP 4] New files installed — version.json now reports v${stagedVersion}.`);

        // ── 5 · dependencies (only when package files changed) ──────────
        if (filesDiffer(path.join(ROOT_DIR, 'package.json'), path.join(stageRoot, 'package.json'))) {
            emitUpdateEvent('system', '[STEP 5] Package files changed — installing dependencies (can take a minute)...');
            await runNpmInstall();
        } else {
            emitUpdateEvent('info', '[STEP 5] Dependencies unchanged — skipping npm install.');
        }
        try { if (fs.existsSync(path.join(ROOT_DIR, 'install.sh'))) fs.chmodSync(path.join(ROOT_DIR, 'install.sh'), 0o755); } catch { /* ignore */ }

        // ── 6 · restart the panel ────────────────────────────────────────
        emitUpdateEvent('system', '[STEP 6] Restarting the panel to load the new version...');
        const restarted = await restartPanel();
        const doneMsg = `Update applied — now running v${stagedVersion}.`;
        emitUpdateEvent('success', '[GIT SUCCESS] ' + doneMsg);
        try {
            io.emit('update-complete', {
                success: true,
                message: restarted
                    ? doneMsg + ' The panel is restarting.'
                    : doneMsg + ' Restart the panel process (pm2 restart purple-mc-panel) to finish.'
            });
        } catch { /* ignore */ }
    } finally {
        try { fs.rmSync(stageBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// ================================================================
// PHASE 15: SYSTEM INFO & RESOURCE DETECTION
// ================================================================

app.get('/api/system', (req, res) => {
    const stats = os.totalmem();
    res.json({
        cpu: { cores: os.cpus().length, load: os.loadavg() },
        memory: { total: stats, free: os.freemem(), used: stats - os.freemem() },
        uptime: os.uptime()
    });
});

app.get('/api/system/resources', (req, res) => {
    const metrics = getSystemMetrics();
    const recommended = calculateRecommendedRam();
    const settings = loadSettings();
    res.json({
        success: true,
        system: metrics,
        recommended: { maxRam: recommended },
        allocation: {
            mode: settings.autoResource ? 'auto' : 'manual',
            currentMaxRam: settings.maxRam || DEFAULT_RAM,
            recommendedMaxRam: recommended
        }
    });
});

// ================================================================
// PHASE 16: SOCKET.IO EVENT HANDLERS
// ================================================================

io.on('connection', (socket) => {
    log(`Client connected: ${socket.id}`, 'info');

    // Immediately dump the rolling log buffer to the new client.
    // This ensures a browser refresh instantly populates the terminal
    // with the last 500 lines of historical Minecraft server output.
    socket.emit('console-history', logBuffer.map(entry => ({
        text: entry.text,
        type: entry.type,
        timestamp: entry.timestamp
    })));

    // Inform client of current server status
    socket.emit('status', mcProcess ? 'online' : 'offline');

    socket.on('action', async (action) => {
        switch (action) {
            case 'start':
                if (!mcProcess && !isStarting) await startServer();
                break;
            case 'stop':
                if (mcProcess) stopServer();
                break;
            case 'kill':
                if (mcProcess) killServer();
                break;
            case 'restart':
                if (mcProcess) restartServer();
                break;
        }
    });

    socket.on('command', (cmd) => {
        sendCommand(cmd);
    });

    socket.on('locate-player', (playerName) => {
        if (playerName && typeof playerName === 'string') {
            log(`Locating player: ${playerName}`, 'info');
            sendCommand(`data get entity ${playerName} Pos`);
            // Also send a /list to trigger player list sync
            sendCommand('list');
        }
    });

    socket.on('disconnect', () => {
        log(`Client disconnected: ${socket.id}`, 'info');
    });
});

// ================================================================
// PHASE 17: ENHANCED MONITORING LOOP
// ================================================================

setInterval(async () => {
    const settings = loadSettings();
    const recommendedRam = calculateRecommendedRam();
    const maxRam = settings.autoResource ? recommendedRam : (settings.maxRam || DEFAULT_RAM);
    const clientCount = io?.engine?.clientsCount ?? 0;
    if (clientCount === 0) return;

    if (mcProcess && processPid) {
        try {
            const stats = await pidusage(processPid);
            const diskUsage = getDiskUsage(SERVER_DIR);
            const sysMetrics = getSystemMetrics();

            io.emit('stats', {
                cpu: Math.round(stats.cpu),
                memory: Math.round(stats.memory / 1024 / 1024),
                uptime: serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0,
                disk: diskUsage,
                system: sysMetrics,
                allocation: { maxRam, recommended: recommendedRam, autoResource: settings.autoResource }
            });
        } catch {
            io.emit('stats', { cpu: 0, memory: 0, uptime: 0, disk: null, system: null, allocation: { maxRam, recommended: recommendedRam, autoResource: settings.autoResource } });
        }
    } else {
        const sysMetrics = getSystemMetrics();
        io.emit('stats', { cpu: 0, memory: 0, uptime: 0, disk: null, system: sysMetrics, allocation: { maxRam, recommended: recommendedRam, autoResource: settings.autoResource } });
    }
}, 2000);

// ================================================================
// SCHEDULED BACKUPS
// ================================================================

function checkScheduledBackups() {
    const s = loadSettings();
    if (!s.backupEnabled) return;

    const intervalMs = (s.backupInterval || 24) * 60 * 60 * 1000;
    const backupsDir = BACKUPS_DIR;
    if (!fs.existsSync(backupsDir)) return;

    const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.zip'));
    const maxKeep = s.backupMaxKeep || 7;

    // Remove excess backups
    if (files.length >= maxKeep) {
        const sorted = files.map(f => ({ name: f, time: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        while (sorted.length >= maxKeep) {
            const oldest = sorted.pop();
            try { fs.unlinkSync(path.join(backupsDir, oldest.name)); } catch {}
        }
    }
}

// Check backups every 30 minutes
setInterval(checkScheduledBackups, 30 * 60 * 1000);

// ================================================================
// PHASE 18: GRACEFUL SHUTDOWN (PM2 / SIGTERM / SIGINT / updates)
// ================================================================
// When the panel is stopped or restarted (pm2 restart/stop, host reboot,
// self-update) PM2 sends SIGINT/SIGTERM and escalates to SIGKILL only after
// kill_timeout. Without handlers a running Minecraft server would be orphaned
// mid-session, so on shutdown we first tell it to stop cleanly ('stop' →
// world save) and only exit once it is gone. With autoStart enabled, the
// server then comes right back when PM2 starts the panel again.
//
// Under PM2 we must NOT exit 0: PM2 reads a clean code-0 exit as an
// intentional stop and leaves the app "stopped", while an exit that looks
// like a crash (non-zero) triggers autorestart and the panel heals itself.
// Plain `npm start` users still get a clean 0.
const PANEL_EXIT_CODE = (process.env.pm_id !== undefined || process.env.PM2_HOME) ? 1 : 0;

function requestShutdown(reason) {
    if (shuttingDown) {
        // Second signal while stopping — don't block the reboot/restart.
        log(`Second shutdown signal while stopping — force-killing the Minecraft server.`, 'error');
        try { if (mcProcess) mcProcess.kill('SIGKILL'); } catch {}
        process.exit(1);
        return;
    }
    shuttingDown = true;
    if (!mcProcess) {
        log(`Shutdown requested (${reason}) — no Minecraft server running, exiting.`, 'info');
        // Short grace so in-flight socket events (e.g. update progress) flush.
        setTimeout(() => process.exit(PANEL_EXIT_CODE), 1200);
        return;
    }
    log(`Shutdown requested (${reason}) — stopping the Minecraft server cleanly...`, 'warn');
    try {
        emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Panel is shutting down — saving the world and stopping the Minecraft server...\n`);
        mcProcess.stdin.write('stop\n');
    } catch {}
    // Hard cap so a hung server can never block a reboot or update forever.
    // Keep this UNDER the ecosystem kill_timeout (30s) so we force-kill the
    // Minecraft server and exit cleanly before PM2 escalates to SIGKILL.
    const deadline = setTimeout(() => {
        log('Minecraft server did not stop within 20s — force-killing it and exiting.', 'error');
        try { if (mcProcess) mcProcess.kill('SIGKILL'); } catch {}
        process.exit(PANEL_EXIT_CODE);
    }, 20000);
    const watcher = setInterval(() => {
        if (!mcProcess) {
            clearInterval(watcher);
            clearTimeout(deadline);
            log('Minecraft server stopped — panel exiting.', 'info');
            process.exit(PANEL_EXIT_CODE);
        }
    }, 500);
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

// ================================================================
// PHASE 19: SERVER INITIALIZATION
// ================================================================

async function init() {
    ensureDirectories();

    // Kick off a background server-JAR download (if one is needed) so the
    // panel comes up instantly and is never blocked on the network.
    // startServer() also awaits checkAndDownloadServer() before spawning.
    checkAndDownloadServer().then(
        () => log('Server JAR ready', 'info'),
        (err) => {
            log(`Server JAR unavailable: ${err.message}`, 'error');
            log('Place a server.jar in the server/ directory to start the Minecraft server.', 'warn');
        }
    );

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log(`Port ${PORT} in use. Try: PORT=3001 npm start`, 'error');
            process.exit(1);
        }
        throw err;
    });

    server.listen(PORT, () => {
        log(`PurpleMC Panel running on port ${PORT}`, 'info');
        log(`Server directory: ${SERVER_DIR}`, 'info');
        log(`Current version: ${CURRENT_VERSION}`, 'info');

        // Auto-start server if configured
        const s = loadSettings();
        if (s.autoStart) {
            log('Auto-start enabled, starting server...', 'info');
            setTimeout(() => startServer(), 2000);
        }
    });
}

init().catch(err => {
    log(`Initialization failed: ${err.message}`, 'error');
    process.exit(1);
});

module.exports = { app, server, io };
