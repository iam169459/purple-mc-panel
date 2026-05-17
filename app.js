/**
 * PurpleMC Panel - Optimized Minecraft Server Management
 * Senior Node.js Implementation with Express, Socket.io, and Process Control
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const pidusage = require('pidusage');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const SERVER_DIR = path.join(ROOT_DIR, 'server');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const JAR_PATH = path.join(SERVER_DIR, 'server.jar');
const EULA_PATH = path.join(SERVER_DIR, 'eula.txt');

const DEFAULT_VERSION = '1.20.4';
const RAM_ALLOC = '2G';

const PAPER_VERSIONS = {
    '1.20.4': 'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/499/downloads/paper-1.20.4-499.jar',
    '1.20.2': 'https://api.papermc.io/v2/projects/paper/versions/1.20.2/builds/317/downloads/paper-1.20.2-317.jar',
    '1.19.4': 'https://api.papermc.io/v2/projects/paper/versions/1.19.4/builds/557/downloads/paper-1.19.4-557.jar'
};

const COLORS = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m'
};

let mcProcess = null;
let processPid = null;
let isStarting = false;
let isStopping = false;
let serverStartTime = null;
let restartPending = false;

console.log(`${COLORS.cyan}[PurpleMC]${COLORS.reset} Initializing panel...`);

function ensureDirectories() {
    [SERVER_DIR, BACKUPS_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`${COLORS.green}[PurpleMC]${COLORS.reset} Created directory: ${dir}`);
        }
    });
}

function log(msg, type = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = type === 'error' ? `${COLORS.red}[ERROR]${COLORS.reset}` : 
                   type === 'warn' ? `${COLORS.yellow}[WARN]${COLORS.reset}` : 
                   `${COLORS.cyan}[PurpleMC]${COLORS.reset}`;
    console.log(`${prefix} ${msg}`);
}

async function checkAndDownloadServer() {
    if (!fs.existsSync(JAR_PATH)) {
        log('Server JAR not found. Downloading PaperMC...', 'warn');
        
        const downloadUrl = PAPER_VERSIONS[DEFAULT_VERSION];
        if (!downloadUrl) {
            log(`No download URL for version ${DEFAULT_VERSION}`, 'error');
            throw new Error('Unsupported version');
        }
        
        try {
            await downloadFile(downloadUrl, JAR_PATH);
            fs.writeFileSync(EULA_PATH, 'eula=true');
            log('Server JAR downloaded and eula.txt created', 'info');
        } catch (err) {
            log(`Failed to download server: ${err.message}`, 'error');
            throw err;
        }
    }
    
    if (!fs.existsSync(EULA_PATH)) {
        fs.writeFileSync(EULA_PATH, 'eula=true');
        log('Created eula.txt', 'info');
    }
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            reject(err);
        });
    });
}

async function startServer() {
    if (mcProcess || isStarting) {
        log('Server already running or starting', 'warn');
        return { success: false, error: 'Server already running' };
    }

    isStarting = true;
    io.emit('console', `\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Starting Minecraft server...\n`);

    try {
        await checkAndDownloadServer();
        
        mcProcess = spawn('java', ['-Xmx' + RAM_ALLOC, '-Xms' + RAM_ALLOC, '-jar', 'server.jar', 'nogui'], {
            cwd: SERVER_DIR,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });

        processPid = mcProcess.pid;
        serverStartTime = Date.now();
        
        log(`Server started with PID: ${processPid}`, 'info');
        
        mcProcess.stdout.on('data', (data) => {
            const output = data.toString();
            io.emit('console', output);
        });

        mcProcess.stderr.on('data', (data) => {
            const output = data.toString();
            io.emit('console', `${COLORS.red}[ERROR]${COLORS.reset} ${output}`);
        });

        mcProcess.on('spawn', () => {
            isStarting = false;
            io.emit('status', 'online');
            log('Server process spawned successfully', 'info');
        });

        mcProcess.on('close', (code) => {
            const wasRunning = mcProcess !== null;
            mcProcess = null;
            processPid = null;
            serverStartTime = null;
            
            io.emit('status', 'offline');
            io.emit('players', []);
            
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
    
    try {
        mcProcess.stdin.write('stop\n');
        
        setTimeout(() => {
            isStopping = false;
            if (mcProcess) {
                log('Graceful stop timeout, process may still be running', 'warn');
            }
        }, 15000);

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

function sendCommand(cmd) {
    if (!mcProcess || !cmd || !cmd.trim()) {
        return { success: false, error: 'No server running or empty command' };
    }

    try {
        mcProcess.stdin.write(cmd.trim() + '\n');
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
    } catch (err) {
        return { cpu: 0, memory: 0, uptime: 0 };
    }
}

function isSafeName(name) {
    return typeof name === 'string' && /^[a-zA-Z0-9._ -]+$/.test(name) && !name.includes('..');
}

function resolveSafePath(basePath, userPath) {
    const resolved = path.resolve(basePath, userPath || '');
    const base = path.resolve(basePath);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        throw new Error('Path traversal detected');
    }
    return resolved;
}

function sendError(res, message, status = 400) {
    res.status(status).json({ error: message });
}

// ============ MIDDLEWARE ============

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// ============ API ENDPOINTS ============

// Status
app.get('/api/status', async (req, res) => {
    const stats = await getProcessStats();
    res.json({
        running: !!mcProcess,
        pid: processPid,
        uptime: stats.uptime,
        cpu: stats.cpu,
        memory: stats.memory,
        players: []
    });
});

// Server Actions
app.post('/api/server/start', async (req, res) => {
    const result = await startServer();
    res.json(result);
});

app.post('/api/server/stop', (req, res) => {
    const result = stopServer();
    res.json(result);
});

app.post('/api/server/kill', (req, res) => {
    const result = killServer();
    res.json(result);
});

app.post('/api/server/restart', (req, res) => {
    const result = restartServer();
    res.json(result);
});

// Command
app.post('/api/command', (req, res) => {
    const { cmd } = req.body;
    const result = sendCommand(cmd);
    res.json(result);
});

// Players (placeholder - integrate with console parsing)
app.get('/api/players', (req, res) => {
    res.json([]);
});

// Files
app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(SERVER_DIR).filter(f => !f.includes('.dat') && !f.includes('.lock')).map(f => {
            const stat = fs.statSync(path.join(SERVER_DIR, f));
            return { name: f, isDirectory: stat.isDirectory(), size: stat.size };
        });
        res.json(files);
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/files/:path(*)', (req, res) => {
    try {
        const filePath = resolveSafePath(SERVER_DIR, req.params.path);
        if (!fs.existsSync(filePath)) {
            return sendError(res, 'Not found', 404);
        }
        if (fs.statSync(filePath).isDirectory()) {
            const files = fs.readdirSync(filePath).map(f => ({
                name: f,
                isDirectory: fs.statSync(path.join(filePath, f)).isDirectory(),
                size: fs.statSync(path.join(filePath, f)).size
            }));
            res.json(files);
        } else {
            res.send(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        sendError(res, err.message);
    }
});

app.post('/api/files/create', (req, res) => {
    const { name, type, path: dir } = req.body;
    if (!isSafeName(name)) return sendError(res, 'Invalid name');
    if (!['folder', 'file'].includes(type)) return sendError(res, 'Invalid type');
    
    try {
        const targetDir = resolveSafePath(SERVER_DIR, dir || '');
        const target = resolveSafePath(targetDir, name);
        
        if (type === 'folder') {
            fs.mkdirSync(target, { recursive: true });
        } else {
            fs.writeFileSync(target, '');
        }
        res.json({ success: true });
    } catch (err) {
        sendError(res, err.message);
    }
});

app.put('/api/files/:path(*)', (req, res) => {
    const { content } = req.body;
    try {
        const filePath = resolveSafePath(SERVER_DIR, req.params.path);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            return sendError(res, 'Cannot write to directory');
        }
        fs.writeFileSync(filePath, content);
        res.json({ success: true });
    } catch (err) {
        sendError(res, err.message);
    }
});

app.delete('/api/files/:path(*)', (req, res) => {
    try {
        const filePath = resolveSafePath(SERVER_DIR, req.params.path);
        if (!fs.existsSync(filePath)) return sendError(res, 'Not found', 404);
        
        if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    } catch (err) {
        sendError(res, err.message);
    }
});

// Plugins (simple)
app.get('/api/plugins', (req, res) => {
    const pluginsDir = path.join(SERVER_DIR, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
        return res.json([]);
    }
    try {
        const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.jar')).map(f => ({
            name: f,
            size: Math.round(fs.statSync(path.join(pluginsDir, f)).size / 1024)
        }));
        res.json(files);
    } catch (err) {
        res.json([]);
    }
});

app.delete('/api/plugins/:name', (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name) || !name.endsWith('.jar')) {
        return sendError(res, 'Invalid name');
    }
    const pluginPath = path.join(SERVER_DIR, 'plugins', name);
    if (fs.existsSync(pluginPath)) {
        fs.unlinkSync(pluginPath);
        res.json({ success: true });
    } else {
        res.json({ error: 'Not found' });
    }
});

app.post('/api/plugins/download', (req, res) => {
    const { url } = req.body;
    if (!url) return sendError(res, 'No URL provided');
    
    const pluginsDir = path.join(SERVER_DIR, 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
    
    try {
        const urlObj = new URL(url);
        const fileName = path.basename(urlObj.pathname) || 'plugin.jar';
        
        if (!isSafeName(fileName) || !fileName.endsWith('.jar')) {
            return sendError(res, 'Invalid filename');
        }
        
        const targetPath = path.join(pluginsDir, fileName);
        const file = fs.createWriteStream(targetPath);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(targetPath);
                return sendError(res, 'Download failed', response.statusCode);
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                res.json({ success: true, name: fileName });
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
            sendError(res, err.message, 502);
        });
    } catch (err) {
        sendError(res, err.message);
    }
});

// Backups
app.get('/api/backups', (req, res) => {
    if (!fs.existsSync(BACKUPS_DIR)) {
        return res.json([]);
    }
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
    
    const { exec } = require('child_process');
    exec(`cd "${SERVER_DIR}" && zip -r "${backupPath}" world world_nether world_the_end plugins server.properties`, (err) => {
        if (err) return sendError(res, err.message, 500);
        res.json({ success: true, name: backupName });
    });
});

app.post('/api/backups/restore', (req, res) => {
    const { name } = req.body;
    if (!isSafeName(name) || !name.endsWith('.zip')) {
        return sendError(res, 'Invalid name');
    }
    
    const backupPath = path.join(BACKUPS_DIR, name);
    if (!fs.existsSync(backupPath)) {
        return sendError(res, 'Backup not found', 404);
    }
    
    if (mcProcess) sendCommand('save-off');
    
    ['world', 'world_nether', 'world_the_end'].forEach(w => {
        const worldPath = path.join(SERVER_DIR, w);
        if (fs.existsSync(worldPath)) {
            fs.rmSync(worldPath, { recursive: true, force: true });
        }
    });
    
    const { exec } = require('child_process');
    exec(`cd "${SERVER_DIR}" && unzip -o "${backupPath}"`, (err) => {
        if (mcProcess) sendCommand('save-on');
        if (err) return sendError(res, err.message, 500);
        res.json({ success: true });
    });
});

app.delete('/api/backups/:name', (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name) || !name.endsWith('.zip')) {
        return sendError(res, 'Invalid name');
    }
    const backupPath = path.join(BACKUPS_DIR, name);
    if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
        res.json({ success: true });
    } else {
        res.json({ error: 'Not found' });
    }
});

// Settings
app.get('/api/settings', (req, res) => {
    const propsPath = path.join(SERVER_DIR, 'server.properties');
    res.json({ properties: fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf8') : '' });
});

app.post('/api/settings', (req, res) => {
    const { properties } = req.body;
    fs.writeFileSync(path.join(SERVER_DIR, 'server.properties'), properties);
    res.json({ success: true });
});

// System Info
app.get('/api/system', (req, res) => {
    const stats = os.totalmem();
    res.json({
        cpu: { cores: os.cpus().length, load: (os.loadavg()[0] * 10).toFixed(1) },
        memory: { total: stats, free: os.freemem(), used: stats - os.freemem() },
        uptime: os.uptime()
    });
});

app.get('/api/network', (req, res) => {
    let ip = '127.0.0.1';
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ip = iface.address;
                break;
            }
        }
    }
    res.json({ ip, hostname: os.hostname() });
});

// Server Download
app.post('/api/server/download', async (req, res) => {
    if (mcProcess) return sendError(res, 'Stop server first', 409);
    
    const { version = DEFAULT_VERSION } = req.body;
    const downloadUrl = PAPER_VERSIONS[version];
    
    if (!downloadUrl) {
        return sendError(res, 'Unsupported version', 400);
    }
    
    try {
        io.emit('console', `\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Downloading PaperMC ${version}...\n`);
        await downloadFile(downloadUrl, JAR_PATH);
        fs.writeFileSync(EULA_PATH, 'eula=true');
        res.json({ success: true });
    } catch (err) {
        sendError(res, err.message, 500);
    }
});

// Reinstall
app.post('/api/reinstall', async (req, res) => {
    if (mcProcess) return sendError(res, 'Stop server first', 409);
    
    try {
        const items = fs.readdirSync(SERVER_DIR);
        for (const item of items) {
            const itemPath = path.join(SERVER_DIR, item);
            if (fs.statSync(itemPath).isDirectory()) {
                fs.rmSync(itemPath, { recursive: true });
            } else if (item !== 'server.jar') {
                fs.unlinkSync(itemPath);
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ============ SOCKET.IO ============

io.on('connection', (socket) => {
    log('Client connected: ' + socket.id, 'info');
    
    socket.emit('status', mcProcess ? 'online' : 'offline');
    
    socket.on('action', async (action) => {
        switch (action) {
            case 'start':
                if (!mcProcess && !isStarting) await startServer();
                break;
            case 'stop':
                if (mcProcess) stopServer();
                break;
            case 'restart':
                if (mcProcess) restartServer();
                break;
            case 'kill':
                if (mcProcess) killServer();
                break;
        }
    });
    
    socket.on('command', (cmd) => {
        sendCommand(cmd);
    });
    
    socket.on('disconnect', () => {
        log('Client disconnected: ' + socket.id, 'info');
    });
});

// ============ MONITORING LOOP ============

setInterval(async () => {
    if (mcProcess && processPid) {
        try {
            const stats = await pidusage(processPid);
            io.emit('stats', {
                cpu: Math.round(stats.cpu),
                memory: Math.round(stats.memory / 1024 / 1024)
            });
        } catch (err) {
            io.emit('stats', { cpu: 0, memory: 0 });
        }
    } else {
        io.emit('stats', { cpu: 0, memory: 0 });
    }
}, 2000);

// ============ START SERVER ============

async function init() {
    ensureDirectories();
    await checkAndDownloadServer();
    initGitUpdater();
    
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
    });
}

init().catch(err => {
    log(`Initialization failed: ${err.message}`, 'error');
    process.exit(1);
});

// ============ GIT UPDATE SERVICE ============

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const REPO_URL = 'https://github.com/iam169459/purple-mc-panel';

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (err) {
        log('Failed to load config: ' + err.message, 'warn');
    }
    return { autoUpdateEnabled: false, lastChecked: null };
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return true;
    } catch (err) {
        log('Failed to save config: ' + err.message, 'error');
        return false;
    }
}

function execGit(command, cwd = ROOT_DIR) {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        exec(command, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function checkForUpdates() {
    try {
        // Ensure git is initialized
        if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) {
            await execGit('git init');
            await execGit(`remote add origin ${REPO_URL}`);
        }

        // Fetch latest changes
        await execGit('git fetch origin main');
        
        // Get current commit
        const currentCommit = await execGit('git rev-parse HEAD').trim();
        
        // Check if we're behind
        const statusOutput = await execGit('git status -uno');
        const isBehind = statusOutput.includes('behind');
        
        // Get latest commit if behind
        let latestCommit = currentCommit;
        if (isBehind) {
            try {
                latestCommit = await execGit('git rev-parse origin/main').trim();
            } catch (e) {
                log('Could not get latest commit: ' + e.message, 'warn');
            }
        }

        return {
            updateAvailable: isBehind,
            currentCommit: currentCommit.substring(0, 7),
            latestCommit: latestCommit.substring(0, 7),
            status: statusOutput.trim()
        };
    } catch (err) {
        log('Update check failed: ' + err.message, 'error');
        return { updateAvailable: false, currentCommit: 'unknown', latestCommit: 'unknown', error: err.message };
    }
}

async function executeUpdate() {
    try {
        log('Starting panel update...', 'info');
        io.emit('console', `\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Starting panel update...\n`);

        // Git pull
        const pullResult = await execGit('git pull origin main');
        log('Git pull completed', 'info');
        io.emit('console', `» Git pull: ${pullResult.substring(0, 200)}\n`);

        // NPM install
        log('Installing dependencies...', 'info');
        io.emit('console', `» Installing dependencies...\n`);
        
        await new Promise((resolve, reject) => {
            const { exec } = require('child_process');
            exec('npm install --production', { cwd: ROOT_DIR, timeout: 120000 }, (error, stdout, stderr) => {
                if (error) {
                    log('npm install failed: ' + error.message, 'error');
                    reject(error);
                } else {
                    log('Dependencies installed', 'info');
                    resolve();
                }
            });
        });

        // Restart PM2
        log('Restarting PM2 service...', 'info');
        io.emit('console', `» Restarting PM2 service...\n`);
        
        await execGit('pm2 restart purple-mc-panel');

        return { success: true, message: 'Update completed and service restarted' };
    } catch (err) {
        log('Update failed: ' + err.message, 'error');
        return { success: false, error: err.message };
    }
}

let autoUpdateInterval = null;

function startAutoUpdater() {
    if (autoUpdateInterval) {
        clearInterval(autoUpdateInterval);
    }

    autoUpdateInterval = setInterval(async () => {
        const config = loadConfig();
        if (!config.autoUpdateEnabled) {
            return;
        }

        log('Checking for updates (auto)...', 'info');
        
        try {
            const result = await checkForUpdates();
            
            if (result.updateAvailable) {
                log('Auto-update: new version available, updating...', 'info');
                io.emit('console', `\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Auto-update: new version detected, updating...\n`);
                
                await executeUpdate();
            }
        } catch (err) {
            log('Auto-update check failed: ' + err.message, 'error');
        }
    }, 30 * 60 * 1000); // 30 minutes

    log('Auto-updater started (checks every 30 minutes)', 'info');
}

// ============ UPDATE API ENDPOINTS ============

app.get('/api/update/check', async (req, res) => {
    try {
        const result = await checkForUpdates();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/update/apply', async (req, res) => {
    try {
        const result = await executeUpdate();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/update/config', (req, res) => {
    const config = loadConfig();
    res.json(config);
});

app.post('/api/update/config', (req, res) => {
    const { autoUpdateEnabled } = req.body;
    
    if (typeof autoUpdateEnabled !== 'boolean') {
        return res.status(400).json({ error: 'autoUpdateEnabled must be a boolean' });
    }

    const config = loadConfig();
    config.autoUpdateEnabled = autoUpdateEnabled;
    config.lastChecked = new Date().toISOString();

    if (saveConfig(config)) {
        if (autoUpdateEnabled) {
            startAutoUpdater();
        }
        res.json({ success: true, config });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// ============ INITIALIZE ============

function initGitUpdater() {
    const config = loadConfig();
    if (config.autoUpdateEnabled) {
        startAutoUpdater();
    }
}

module.exports = { app, server, io };