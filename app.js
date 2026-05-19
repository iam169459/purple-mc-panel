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

const SERVER_DIR = path.join(ROOT_DIR, 'server');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const NETWORK_DB_PATH = path.join(CONFIG_DIR, 'network-allocations.json');
const SETTINGS_DB_PATH = path.join(CONFIG_DIR, 'settings.json');
const JAR_PATH = path.join(SERVER_DIR, 'server.jar');
const EULA_PATH = path.join(SERVER_DIR, 'eula.txt');
const SERVER_PROPS_PATH = path.join(SERVER_DIR, 'server.properties');
const UPDATE_SCRIPT = path.join(ROOT_DIR, 'update.sh');

const PORT = process.env.PORT || 3000;
const PAPER_VERSIONS = {
    '1.20.4': 'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/499/downloads/paper-1.20.4-499.jar',
    '1.20.2': 'https://api.papermc.io/v2/projects/paper/versions/1.20.2/builds/317/downloads/paper-1.20.2-317.jar',
    '1.19.4': 'https://api.papermc.io/v2/projects/paper/versions/1.19.4/builds/557/downloads/paper-1.19.4-557.jar'
};
const DEFAULT_VERSION = '1.20.4';
const DEFAULT_RAM = '2G';

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

const LOG_BUFFER_MAX = 500;
const logBuffer = [];

function pushToLogBuffer(rawChunk, type) {
    const text = rawChunk.toString ? rawChunk.toString('utf8') : String(rawChunk);
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const trimmed = lineText.trim();

        if (trimmed === '' && lineText === '') continue;

        const entry = {
            raw: lineText,
            text: stripAnsi(lineText),
            type: classifyLine(lineText),
            timestamp: new Date().toISOString()
        };

        logBuffer.push(entry);

        if (logBuffer.length > LOG_BUFFER_MAX) {
            logBuffer.shift();
        }
    }
}

function stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function classifyLine(line) {
    const lower = line.toLowerCase();
    if (lower.includes('[error]') || lower.includes('exception') || lower.includes('fatal') || lower.includes('[fatal]')) return 'error';
    if (lower.includes('[warn]') || lower.includes('[warning]')) return 'warn';
    if (lower.includes('[info]')) return 'info';
    if (lower.includes(' done') || lower.includes('complete') || lower.includes('success') || lower.includes('started')) return 'success';
    if (lower.includes('system') || lower.includes('[system]')) return 'system';
    if (lower.startsWith('$')) return 'command';
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
        log('Server JAR not found. Downloading PaperMC...', 'warn');
        const url = PAPER_VERSIONS[DEFAULT_VERSION];
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

// ================================================================
// PHASE 4: SERVER PROCESS CONTROL (ENHANCED SPAWN)
// ================================================================

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_DB_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_DB_PATH, 'utf8'));
        }
    } catch (err) {
        log(`Failed to load settings: ${err.message}`, 'warn');
    }
    return { maxRam: DEFAULT_RAM, javaPath: 'java' };
}

async function startServer() {
    if (mcProcess || isStarting) {
        return { success: false, error: 'Server already running or starting' };
    }
    isStarting = true;
    io.emit('console', `\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Starting Minecraft server...\n`);

    try {
        await checkAndDownloadServer();
        const settings = loadSettings();
        const ram = settings.maxRam || DEFAULT_RAM;
        const javaExe = settings.javaPath || 'java';

        const javaFallbacks = [];
        if (javaExe !== 'java') {
            javaFallbacks.push(javaExe);
        }
        javaFallbacks.push('java');
        javaFallbacks.push('/usr/bin/java');
        javaFallbacks.push('/usr/local/bin/java');
        javaFallbacks.push('/opt/java/bin/java');

        let spawned = false;
        let lastError = null;

        for (const javaPathCandidate of javaFallbacks) {
            try {
                mcProcess = spawn(javaPathCandidate, ['-Xmx' + ram, '-Xms' + ram, '-jar', 'server.jar', 'nogui'], {
                    cwd: SERVER_DIR,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: false
                });

                const testResult = await new Promise((resolve) => {
                    const timeout = setTimeout(() => resolve({ ok: true }), 100);
                    mcProcess.on('error', (err) => {
                        clearTimeout(timeout);
                        resolve({ ok: false, err });
                    });
                    mcProcess.on('spawn', () => {
                        clearTimeout(timeout);
                        resolve({ ok: true });
                    });
                });

                if (!testResult.ok && testResult.err) {
                    mcProcess = null;
                    lastError = testResult.err;
                    continue;
                }

                spawned = true;
                log(`Server spawn using: ${javaPathCandidate}`, 'info');
                break;
            } catch (spawnErr) {
                mcProcess = null;
                lastError = spawnErr;
                continue;
            }
        }

        if (!spawned || !mcProcess) {
            isStarting = false;
            const msg = `Failed to spawn Java process. Tried: ${javaFallbacks.join(', ')}. Last error: ${lastError?.message || 'unknown'}`;
            log(msg, 'error');
            io.emit('console', `\n${COLORS.red}[SYSTEM ERROR]${COLORS.reset} ${msg}\n`);
            return { success: false, error: msg };
        }

        processPid = mcProcess.pid;
        serverStartTime = Date.now();
        isStarting = false;
        log(`Server started with PID: ${processPid}`, 'info');
        io.emit('status', 'online');
        pushToLogBuffer(`[SYSTEM] Minecraft server started (PID: ${processPid})`, 'system');

        mcProcess.stdout.on('data', (chunk) => {
            pushToLogBuffer(chunk, 'stdout');
            io.emit('console', chunk.toString());
        });

        mcProcess.stderr.on('data', (chunk) => {
            pushToLogBuffer(chunk, 'stderr');
            io.emit('console', `\x1b[31m[ERROR]\x1b[0m ${chunk}`);
        });

        mcProcess.on('close', (code) => {
            const wasRunning = mcProcess !== null;
            mcProcess = null;
            processPid = null;
            serverStartTime = null;
            io.emit('status', 'offline');
            io.emit('players', []);

            pushToLogBuffer(`[SYSTEM] Minecraft server stopped (exit code: ${code})`, 'system');

            if (restartPending) {
                restartPending = false;
                log('Restart pending, starting server...', 'warn');
                setTimeout(() => startServer(), 2000);
            } else if (wasRunning) {
                io.emit('console', `\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Server stopped (code: ${code})\n`);
            }
        });

        mcProcess.on('error', (err) => {
            isStarting = false;
            log(`Process error: ${err.message}`, 'error');
            io.emit('console', `\n${COLORS.red}[SYSTEM ERROR]${COLORS.reset} ${err.message}\n`);
            pushToLogBuffer(`[SYSTEM ERROR] ${err.message}`, 'error');
        });

        return { success: true };
    } catch (err) {
        isStarting = false;
        log(`Failed to start: ${err.message}`, 'error');
        return { success: false, error: err.message };
    }
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

function getDiskUsage(dirPath) {
    try {
        const stats = fs.statSync(dirPath);
        let totalSize = 0;
        let fileCount = 0;
        let dirCount = 0;

        function calculateSize(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
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

        return {
            totalBytes: totalSize,
            totalMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
            totalGB: Math.round(totalSize / 1024 / 1024 / 1024 * 100) / 100,
            fileCount,
            dirCount
        };
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

// ================================================================
// PHASE 6: MIDDLEWARE
// ================================================================

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

function sendError(res, message, status = 400) {
    res.status(status).json({ error: message });
}

// ================================================================
// PHASE 7: CONSOLE MODULE — API ROUTES
// ================================================================

app.get('/api/status', async (req, res) => {
    const stats = await getProcessStats();
    const disk = getDiskUsage(SERVER_DIR);
    res.json({
        running: !!mcProcess,
        pid: processPid,
        uptime: stats.uptime,
        cpu: stats.cpu,
        memory: stats.memory,
        players: [],
        disk
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
    res.json([]);
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
                maxRam: settings.maxRam || DEFAULT_RAM,
                javaPath: settings.javaPath || 'java'
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
        const filePath = sanitizePath(SERVER_DIR, req.params.path);
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
        const filePath = sanitizePath(SERVER_DIR, req.params.path);
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
        srv.once('error', () => resolve(false));
        srv.once('listening', () => { srv.close(); resolve(true); });
        srv.listen(port);
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

app.get('/api/plugins/search', async (req, res) => {
    const { q = '', page = 1, per_page = 24 } = req.query;

    if (!q || q.trim().length < 2) {
        return sendError(res, 'Search query must be at least 2 characters', 400);
    }

    const maxResults = Math.min(parseInt(per_page, 10) || 24, 48);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    log(`Plugin search: "${q}" page ${pageNum}`, 'info');

    try {
        const spigetUrl = `${SPIGET_API}/search/resources/${encodeURIComponent(q.trim())}?page=${pageNum - 1}&size=${maxResults}&fields=id,name,tag,description,icon,downloads,likes,premium,price,version,author,file`;

        const response = await axios.get(spigetUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
        });

        let plugins = (response.data || []).map(p => ({
            id: p.id,
            name: p.name || 'Unknown Plugin',
            tag: p.tag || '',
            description: p.description ? p.description.replace(/<[^>]*>/g, '').substring(0, 200) : '',
            icon: p.icon ? (p.icon.url || p.icon) : null,
            downloads: p.downloads || 0,
            likes: p.likes || 0,
            premium: p.premium || false,
            price: p.price || 0,
            version: p.version || 'N/A',
            author: (p.author && p.author.name) ? p.author.name : 'Unknown',
            source: 'spigot',
            downloadUrl: p.file ? `${SPIGET_API}/resources/${p.id}/download` : null
        }));

        if (plugins.length === 0) {
            try {
                const mrRes = await axios.get(`${MODRINTH_API}/search?q=${encodeURIComponent(q.trim())}&offset=${(pageNum - 1) * maxResults}&limit=${maxResults}`, {
                    timeout: 10000,
                    headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                });

                if (mrRes.data && mrRes.data.hits) {
                    const mrPlugins = await Promise.all(mrRes.data.hits.slice(0, maxResults).map(async p => {
                        try {
                            const vRes = await axios.get(`${MODRINTH_API}/project/${p.project_id}/version`, {
                                timeout: 5000,
                                headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
                            });
                            const latest = vRes.data && vRes.data[0];
                            return {
                                id: p.project_id,
                                name: p.title || p.name || 'Unknown',
                                tag: p.slug || '',
                                description: p.description || '',
                                icon: p.icon ? p.icon.url : null,
                                downloads: p.downloads || 0,
                                likes: 0,
                                premium: false,
                                price: 0,
                                version: latest ? latest.version_number : 'N/A',
                                author: p.author || 'Unknown',
                                source: 'modrinth',
                                downloadUrl: latest && latest.files && latest.files[0] ? latest.files[0].url : null
                            };
                        } catch {
                            return {
                                id: p.project_id,
                                name: p.title || p.name || 'Unknown',
                                tag: p.slug || '',
                                description: p.description || '',
                                icon: p.icon ? p.icon.url : null,
                                downloads: p.downloads || 0,
                                likes: 0,
                                premium: false,
                                price: 0,
                                version: 'N/A',
                                author: p.author || 'Unknown',
                                source: 'modrinth',
                                downloadUrl: null
                            };
                        }
                    }));
                    plugins = mrPlugins.filter(p => p.downloadUrl);
                }
            } catch (mrErr) {
                log(`Modrinth fallback search failed: ${mrErr.message}`, 'warn');
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
    if (mcProcess) {
        return sendError(res, 'Stop the server before installing plugins', 409);
    }

    const { resourceId, source, name } = req.body;
    if (!resourceId || !source) {
        return sendError(res, 'resourceId and source are required');
    }

    const pluginsDir = path.join(SERVER_DIR, 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    log(`Installing plugin from ${source}:${resourceId}`, 'info');

    let downloadUrl;
    let suggestedName = name || `plugin-${resourceId}.jar`;

    try {
        if (source === 'spigot') {
            const infoRes = await axios.get(`${SPIGET_API}/resources/${resourceId}?fields=id,name,file`, {
                timeout: 8000,
                headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
            });
            const info = infoRes.data;
            downloadUrl = `${SPIGET_API}/resources/${resourceId}/download`;
            suggestedName = (info.name || suggestedName).replace(/[^a-zA-Z0-9._ -]/g, '_') + '.jar';
        } else if (source === 'modrinth') {
            const projRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
                timeout: 8000,
                headers: { 'User-Agent': 'PurpleMC-Panel/1.0' }
            });
            const versions = projRes.data;
            if (!versions || !versions[0] || !versions[0].files || !versions[0].files[0]) {
                return sendError(res, 'No downloadable file found for this plugin version', 404);
            }
            downloadUrl = versions[0].files[0].url;
            suggestedName = versions[0].files[0].filename || suggestedName;
        } else {
            return sendError(res, 'Invalid source. Use "spigot" or "modrinth"', 400);
        }

        if (!suggestedName.endsWith('.jar') || suggestedName.length > 255) {
            return sendError(res, 'Invalid filename generated');
        }

        const targetPath = path.join(pluginsDir, suggestedName);
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

        await new Promise((resolve, reject) => {
            https.get(downloadUrl, { headers: { 'User-Agent': 'PurpleMC-Panel/1.0' } }, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    https.get(response.headers.location, (redirRes) => {
                        if (redirRes.statusCode !== 200) return reject(new Error(`Download failed (${redirRes.statusCode})`));
                        const newFile = fs.createWriteStream(targetPath);
                        redirRes.pipe(newFile);
                        newFile.on('finish', () => { newFile.close(); resolve(); });
                        newFile.on('error', reject);
                    }).on('error', reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    return reject(new Error(`Download failed (${response.statusCode})`));
                }

                const file = fs.createWriteStream(targetPath);
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', reject);
            }).on('error', reject);
        });

        const stat = fs.statSync(targetPath);
        if (stat.size < 1000) {
            if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
            return sendError(res, 'Downloaded file is too small, may be corrupted', 502);
        }

        log(`Plugin installed: ${suggestedName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`, 'info');
        io.emit('console', `\n${COLORS.green}[PLUGIN]${COLORS.reset} Installed: ${suggestedName}\n`);

        res.json({ success: true, name: suggestedName, size: stat.size });
    } catch (err) {
        log(`Plugin install error: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/plugins/:name', (req, res) => {
    const name = req.params.name;
    if (!name.endsWith('.jar') || !/^[a-zA-Z0-9._ -]+$/.test(name)) {
        return sendError(res, 'Invalid plugin name');
    }
    const pluginPath = path.join(SERVER_DIR, 'plugins', name);
    if (fs.existsSync(pluginPath)) {
        fs.unlinkSync(pluginPath);
        log(`Plugin deleted: ${name}`, 'info');
        res.json({ success: true });
    } else {
        res.json({ error: 'Not found' });
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

app.post('/api/settings/save', (req, res) => {
    const { maxRam, javaPath } = req.body;
    const current = loadSettings();

    if (maxRam) current.maxRam = maxRam;
    if (javaPath) current.javaPath = javaPath;

    if (saveSettings(current)) {
        log(`Settings saved: maxRam=${current.maxRam} javaPath=${current.javaPath}`, 'info');
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

    spawn('zip', ['-r', backupPath, 'world', 'world_nether', 'world_the_end', 'plugins', 'server.properties'], {
        cwd: SERVER_DIR,
        stdio: 'ignore'
    }).on('close', (code) => {
        if (code === 0) {
            res.json({ success: true, name: backupName });
        } else {
            sendError(res, 'Backup failed', 500);
        }
    });
});

app.delete('/api/backups/:name', (req, res) => {
    const name = req.params.name;
    const backupPath = path.join(BACKUPS_DIR, name);
    if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
        res.json({ success: true });
    } else {
        res.json({ error: 'Not found' });
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
// PHASE 15: SYSTEM INFO
// ================================================================

app.get('/api/system', (req, res) => {
    const stats = os.totalmem();
    res.json({
        cpu: { cores: os.cpus().length, load: os.loadavg() },
        memory: { total: stats, free: os.freemem(), used: stats - os.freemem() },
        uptime: os.uptime()
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

    socket.on('disconnect', () => {
        log(`Client disconnected: ${socket.id}`, 'info');
    });
});

// ================================================================
// PHASE 17: ENHANCED MONITORING LOOP
// ================================================================

setInterval(async () => {
    if (mcProcess && processPid) {
        try {
            const stats = await pidusage(processPid);
            const diskUsage = getDiskUsage(SERVER_DIR);
            const sysMetrics = getSystemMetrics();

            io.emit('stats', {
                cpu: Math.round(stats.cpu),
                memory: Math.round(stats.memory / 1024 / 1024),
                disk: diskUsage,
                system: sysMetrics
            });
        } catch {
            io.emit('stats', { cpu: 0, memory: 0, disk: null, system: null });
        }
    } else {
        const sysMetrics = getSystemMetrics();
        io.emit('stats', { cpu: 0, memory: 0, disk: null, system: sysMetrics });
    }
}, 2000);

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
    });
}

init().catch(err => {
    log(`Initialization failed: ${err.message}`, 'error');
    process.exit(1);
});

module.exports = { app, server, io };
console.log('Test Update v1.0.4-Beta Ready');
