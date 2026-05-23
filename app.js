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
const UPDATE_SCRIPT = path.join(ROOT_DIR, 'update.sh');
const CRASH_LOG_PATH = path.join(CONFIG_DIR, 'crash.log');

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

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            reject(err);
        });
    });
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
        try {
            await downloadFile(url, JAR_PATH);
            fs.writeFileSync(EULA_PATH, 'eula=true');
            log('Server JAR downloaded and eula.txt created', 'info');
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

function stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][0-9;]*[a-zA-Z]/g, '');
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

let diskCache = null;
let diskCacheTime = 0;
const DISK_CACHE_TTL = 30000;

function getDiskUsage(dirPath) {
    const now = Date.now();
    if (diskCache && now - diskCacheTime < DISK_CACHE_TTL) {
        return diskCache;
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
        diskCache = result;
        diskCacheTime = now;
        return result;
    } catch (err) {
        return { totalBytes: 0, totalMB: 0, totalGB: 0, fileCount: 0, dirCount: 0, error: err.message };
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
        log(`Deleted: ${req.params.path}`, 'info');
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'PATH_TRAVERSAL_DETECTED') return sendError(res, 'Access denied', 403);
        sendError(res, err.message);
    }
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

const ESSENTIAL_PLUGINS = [
    { id: 'GeyserMC', name: 'GeyserMC', description: 'Allows Bedrock players to join your Java server, enabling cross-play between Java and Bedrock editions.', icon: 'https://cdn.modrinth.com/data/GeyserMC/icon.png', author: 'GeyserMC Team', source: 'modrinth' },
    { id: 'floodgate', name: 'Floodgate', description: 'Allows Bedrock players to join without a Java Edition account, simplifying the join process for Bedrock clients.', icon: 'https://cdn.modrinth.com/data/floodgate/icon.png', author: 'GeyserMC Team', source: 'modrinth' },
    { id: 'luckperms', name: 'LuckPerms', description: 'Advanced permissions management with support for groups, contexts, and extensive inheritance trees.', icon: 'https://cdn.modrinth.com/data/luckperms/icon.png', author: 'Luck', source: 'modrinth' },
    { id: 'worldedit', name: 'WorldEdit', description: 'In-game world editing utility with brushes, schematics, and millions of builds at your fingertips.', icon: 'https://cdn.modrinth.com/data/worldedit/icon.png', author: 'EngineHub', source: 'modrinth' },
    { id: 'essentialsx', name: 'EssentialsX', description: 'Essential server management featuring teleportation, economy, warps, kits, and more.', icon: 'https://cdn.modrinth.com/data/essentialsx/icon.png', author: 'EssentialsX Team', source: 'modrinth' }
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

app.post('/api/plugins/install', async (req, res) => {
    if (mcProcess) return sendError(res, 'Stop the server before installing plugins', 409);

    const { resourceId, source, name } = req.body;
    if (!resourceId || !source) return sendError(res, 'resourceId and source are required');

    const pluginsDir = path.join(SERVER_DIR, 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    log(`Installing plugin from ${source}:${resourceId}`, 'info');

    let downloadUrl;
    let suggestedName = name || `plugin-${resourceId}.jar`;

    const emitProgress = (stage, percent, message) => {
        io.emit('plugin-progress', { pluginId: resourceId, stage, percent, message });
    };

    emitProgress('resolving', 0, 'Resolving download URL...');

    try {
        // Resolve download URL from the appropriate source
        if (source === 'modrinth') {
            const vRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
                params: { loaders: JSON.stringify(['paper', 'purpur', 'spigot', 'bukkit']) },
                timeout: 10000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
            });
            let versions = vRes.data;
            if (!versions || versions.length === 0) {
                // Fallback: try without loader filter
                const fallbackRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
                    timeout: 10000, headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                });
                versions = fallbackRes.data;
            }
            // Find first version with a downloadable file, preferring Paper-compatible loaders
            let best = null;
            const serverSettings = loadSettings();
            const targetVer = serverSettings.serverVersion || '';
            for (const v of versions) {
                if (!v.files || !v.files[0] || !v.files[0].url) continue;
                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                const isPlugin = loaders.some(l => ['paper', 'purpur', 'spigot', 'bukkit'].includes(l));
                if (!isPlugin) continue;
                const gameVer = (v.game_versions || [])[0] || '';
                // Prefer exact version match, then any Paper-compatible
                if (targetVer && gameVer === targetVer) { best = v; break; }
                if (!best) best = v;
            }
            if (!best) {
                emitProgress('error', 0, 'No Paper-compatible plugin version found');
                return sendError(res, 'No Paper-compatible version found for this plugin', 404);
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
            headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
        });

        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        let lastPercent = -1;
        const writer = fs.createWriteStream(targetPath);

        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (contentLength > 0) {
                const percent = Math.min(Math.round((downloadedBytes / contentLength) * 100), 99);
                if (percent !== lastPercent) {
                    lastPercent = percent;
                    const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
                    const totalMB = (contentLength / 1024 / 1024).toFixed(1);
                    emitProgress('downloading', percent, `Downloading... ${percent}% (${downloadedMB} MB / ${totalMB} MB)`);
                }
            } else {
                const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
                emitProgress('downloading', 0, `Downloading... ${downloadedMB} MB`);
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => reject(new Error(`Write failed: ${err.message}`)));
        });

        // Verification phase
        emitProgress('verifying', 100, 'Verifying downloaded file...');

        const stat = fs.statSync(targetPath);
        if (stat.size < 1000) {
            fs.unlinkSync(targetPath);
            emitProgress('error', 0, 'Downloaded file is too small, may be corrupted');
            return sendError(res, 'Downloaded file is too small, may be corrupted', 502);
        }

        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        emitProgress('complete', 100, `${suggestedName} installed successfully (${sizeMB} MB)`);
        log(`Plugin installed: ${suggestedName} (${sizeMB} MB)`, 'info');
        io.emit('console', `\n${COLORS.green}[PLUGIN]${COLORS.reset} Installed: ${suggestedName}\n`);
        res.json({ success: true, name: suggestedName, size: stat.size });

    } catch (err) {
        log(`Plugin install error: ${err.message}`, 'error');
        emitProgress('error', 0, `Install failed: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
});

app.post('/api/plugins/upload', (req, res) => {
    if (mcProcess) {
        return sendError(res, 'Stop the server before installing plugins', 409);
    }
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
        log(`Plugin uploaded: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`, 'info');
        io.emit('console', `\n[PLUGIN] Uploaded: ${filename}\n`);
        res.json({ success: true, name: filename, size });
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

app.post('/api/backups/create', (req, res) => {
    const backupName = `backup-${Date.now()}.zip`;
    const backupPath = path.join(BACKUPS_DIR, backupName);
    const s = loadSettings();
    const worlds = (s.backupWorlds || 'world').split(',').map(w => w.trim()).filter(Boolean);
    const args = ['-r', backupPath, ...worlds, 'plugins', 'server.properties'];

    spawn('zip', args, {
        cwd: SERVER_DIR,
        stdio: 'ignore'
    }).on('close', (code) => {
        if (code === 0) {
            checkScheduledBackups(); // Prune excess after creation
            res.json({ success: true, name: backupName });
        } else {
            sendError(res, 'Backup failed', 500);
        }
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
// PHASE 14: GIT-BASED ATOMIC UPDATE ENGINE
// ================================================================

/**
 * Executes a git command and returns trimmed stdout.
 * Silently returns null on failure (no exceptions thrown).
 */
function gitExec(args, options = {}) {
    try {
        const result = require('child_process').execFileSync('git', args, {
            cwd: ROOT_DIR,
            encoding: 'utf8',
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...options
        });
        return (result.stdout || result).toString().trim();
    } catch {
        return null;
    }
}

app.get('/api/update/check', async (req, res) => {
    try {
        log('Checking for Git updates...', 'info');

        // Get current version tag from local git history
        const currentTag = gitExec(['describe', '--tags', '--abbrev=0']) || CURRENT_VERSION;
        const currentVersion = currentTag.replace(/^v/, '');

        // Get latest remote tag without cloning
        const remoteRefs = gitExec(['ls-remote', '--tags', '--sort=-v:refname', GIT_REMOTE_URL]);
        let latestTag = null;

        if (remoteRefs) {
            // Parse the last line of `--tags --sort=-v:refname` which gives the newest tag
            const tagLines = remoteRefs.split('\n').filter(l => l.trim());
            for (const line of tagLines.reverse()) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const ref = parts[1];
                    // Filter out ^{} dereference annotations
                    const cleanRef = ref.replace(/\^\{\}$/, '');
                    if (cleanRef.startsWith('refs/tags/')) {
                        const tag = cleanRef.replace('refs/tags/', '');
                        if (/^v?\d+\.\d+\.\d+/.test(tag)) {
                            latestTag = tag;
                            break;
                        }
                    }
                }
            }
        }

        if (!latestTag) {
            log('Could not determine latest remote tag from git', 'warn');
            return res.json({
                updateAvailable: false,
                currentVersion,
                latestVersion: currentVersion,
                gitRepoUrl: GIT_REMOTE_URL,
                method: 'git_sync'
            });
        }

        const latestVersion = latestTag.replace(/^v/, '');
        const updateAvailable = latestVersion !== currentVersion;

        res.json({
            updateAvailable,
            currentVersion,
            latestVersion,
            gitRepoUrl: GIT_REMOTE_URL,
            method: 'git_sync'
        });
    } catch (err) {
        log(`Update check failed: ${err.message}`, 'error');
        res.status(500).json({
            error: 'Failed to check for updates via git',
            currentVersion: CURRENT_VERSION,
            gitRepoUrl: GIT_REMOTE_URL,
            method: 'git_sync'
        });
    }
});

app.post('/api/update/install', (req, res) => {
    if (isUpdateRunning) {
        return res.status(409).json({ error: 'Git sync is already running. Please wait.' });
    }

    if (!fs.existsSync(UPDATE_SCRIPT)) {
        log(`Update script not found at: ${UPDATE_SCRIPT}`, 'error');
        return res.status(500).json({ error: 'Update script not found on server. Contact support.' });
    }

    log('Git sync triggered via update.sh', 'info');

    // Respond to client immediately — do NOT fetch any external JSON/GitHub URLs
    res.json({ success: true, status: 'git_sync_initiated' });

    isUpdateRunning = true;

    // Spawn update.sh as detached subprocess
    const updater = spawn('/bin/bash', ['./update.sh'], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    updater.unref();

    log('Update subprocess spawned (detached mode)', 'info');

    // Broadcast stdout lines to all web panel clients
    updater.stdout.on('data', (chunk) => {
        const dataString = chunk.toString('utf8');
        io.emit('update-progress', dataString);
    });

    // Broadcast stderr lines to all web panel clients
    updater.stderr.on('data', (chunk) => {
        const dataString = chunk.toString('utf8');
        io.emit('update-progress', dataString);
    });

    updater.on('error', (err) => {
        isUpdateRunning = false;
        log(`Update subprocess error: ${err.message}`, 'error');
        io.emit('update-progress', `[GIT ERROR] ${err.message}\n`);
    });

    updater.on('close', (code) => {
        isUpdateRunning = false;
        if (code === 0) {
            log('Git sync completed successfully (exit code 0)', 'info');
            io.emit('update-progress', `[GIT SUCCESS] Deployment completed successfully.\n`);
        } else {
            log(`Git sync finished with non-zero exit code: ${code}`, 'error');
            io.emit('update-progress', `[GIT ERROR] Deployment failed with exit code ${code}.\n`);
        }
    });
});

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
// PHASE 18: SERVER INITIALIZATION
// ================================================================

async function init() {
    ensureDirectories();
    await checkAndDownloadServer();

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
