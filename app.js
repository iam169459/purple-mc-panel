const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const pidusage = require('pidusage');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const GITHUB_REPO = 'iam169459/purple-mc-panel';
const CURRENT_VERSION = '1.0.0';
const SERVER_DIR = path.join(__dirname, 'server');
const JAR_PATH = path.join(SERVER_DIR, 'server.jar');
const EULA_PATH = path.join(SERVER_DIR, 'eula.txt');
const PROPERTIES_PATH = path.join(SERVER_DIR, 'server.properties');
const BACKUPS_DIR = path.join(__dirname, 'backups');

const JAR_URL = "https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/496/downloads/paper-1.20.4-496.jar";

let minecraftProcess = null;
let statsInterval = null;
let onlinePlayers = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create directories
if (!fs.existsSync(SERVER_DIR)) fs.mkdirSync(SERVER_DIR);
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR);

// ============ SERVER START/STOP ============

function downloadJar(callback) {
    if (fs.existsSync(JAR_PATH)) return callback();
    console.log("Downloading Minecraft Server JAR...");
    const file = fs.createWriteStream(JAR_PATH);
    https.get(JAR_URL, (response) => {
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            fs.writeFileSync(EULA_PATH, "eula=true");
            callback();
        });
    });
}

function startMinecraft() {
    if (minecraftProcess) return;

    downloadJar(() => {
        minecraftProcess = spawn('java', ['-Xmx2G', '-Xms2G', '-jar', 'server.jar', 'nogui'], {
            cwd: SERVER_DIR
        });

        io.emit('status', 'online');
        console.log("Minecraft process spawned.");

        minecraftProcess.stdout.on('data', (data) => {
            const output = data.toString();
            io.emit('console', output);
            parsePlayerList(output);
        });

        minecraftProcess.stderr.on('data', (data) => {
            io.emit('console', `[ERROR] ${data.toString()}`);
        });

        minecraftProcess.on('close', (code) => {
            console.log(`Minecraft process stopped with code ${code}`);
            minecraftProcess = null;
            onlinePlayers = [];
            io.emit('status', 'offline');
            io.emit('players', []);
            clearInterval(statsInterval);
        });

        statsInterval = setInterval(() => {
            if (minecraftProcess && minecraftProcess.pid) {
                pidusage(minecraftProcess.pid, (err, stats) => {
                    if (!err) {
                        io.emit('stats', {
                            cpu: stats.cpu.toFixed(1),
                            memory: (stats.memory / 1024 / 1024).toFixed(0)
                        });
                    }
                });
            }
        }, 2000);
    });
}

function parsePlayerList(output) {
    const match = output.match(/There are (\d+) of a max of \d+ players online:/);
    if (match) {
        const namesMatch = output.match(/Players \((\d+)\):\s*([^\n]+)/);
        if (namesMatch) {
            const names = namesMatch[2].split(',').map(n => n.trim()).filter(n => n);
            if (names.length !== onlinePlayers.length || !names.every(n => onlinePlayers.includes(n))) {
                onlinePlayers = names;
                io.emit('players', onlinePlayers);
            }
        }
    }
}

function sendCommand(cmd) {
    if (minecraftProcess) {
        minecraftProcess.stdin.write(cmd + '\n');
    }
}

// ============ API ROUTES ============

// Status
app.get('/api/status', (req, res) => {
    res.json({
        running: !!minecraftProcess,
        pid: minecraftProcess?.pid || null,
        players: onlinePlayers
    });
});

// Settings - get
app.get('/api/settings', (req, res) => {
    if (!fs.existsSync(PROPERTIES_PATH)) {
        return res.json({});
    }
    const content = fs.readFileSync(PROPERTIES_PATH, 'utf8');
    const settings = {};
    content.split('\n').forEach(line => {
        if (line.includes('=')) {
            const [key, value] = line.split('=');
            settings[key.trim()] = value.trim();
        }
    });
    res.json(settings);
});

// Settings - update
app.post('/api/settings', (req, res) => {
    const settings = req.body;
    let content = '';
    for (const [key, value] of Object.entries(settings)) {
        content += `${key}=${value}\n`;
    }
    fs.writeFileSync(PROPERTIES_PATH, content);
    res.json({ success: true });
});

// Players - list (from memory)
app.get('/api/players', (req, res) => {
    res.json(onlinePlayers);
});

// Players - kick
app.post('/api/players/kick', (req, res) => {
    const { player } = req.body;
    sendCommand(`kick ${player}`);
    res.json({ success: true });
});

// Players - ban
app.post('/api/players/ban', (req, res) => {
    const { player } = req.body;
    sendCommand(`ban ${player}`);
    res.json({ success: true });
});

// Players - op
app.post('/api/players/op', (req, res) => {
    const { player } = req.body;
    sendCommand(`op ${player}`);
    res.json({ success: true });
});

// Files - list
app.get('/api/files', (req, res) => {
    const dir = req.query.dir || SERVER_DIR;
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        const files = items.map(item => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            path: path.join(dir, item.name).replace(SERVER_DIR, '')
        }));
        res.json(files);
    } catch (e) {
        res.json([]);
    }
});

// Files - read
app.get('/api/files/read', (req, res) => {
    const filePath = req.query.path;
    const fullPath = path.join(SERVER_DIR, filePath);
    try {
        const content = fs.readFileSync(fullPath, 'utf8');
        res.json({ content: content.substring(0, 10000) });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Files - write
app.post('/api/files/write', (req, res) => {
    const { path: filePath, content } = req.body;
    const fullPath = path.join(SERVER_DIR, filePath);
    try {
        fs.writeFileSync(fullPath, content);
        res.json({ success: true });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Backups - list
app.get('/api/backups', (req, res) => {
    try {
        const files = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
            .filter(f => f.name.endsWith('.zip'))
            .map(f => ({
                name: f.name,
                size: (fs.statSync(path.join(BACKUPS_DIR, f.name)).size / 1024 / 1024).toFixed(2),
                date: fs.statSync(path.join(BACKUPS_DIR, f.name)).mtime
            }))
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(files);
    } catch (e) {
        res.json([]);
    }
});

// Backups - create
app.post('/api/backups/create', (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const worldPath = path.join(SERVER_DIR, 'world');
    const backupPath = path.join(BACKUPS_DIR, `backup-${timestamp}.zip`);

    if (!fs.existsSync(worldPath)) {
        return res.json({ error: 'World folder not found' });
    }

    exec(`cd "${SERVER_DIR}" && zip -r "${backupPath}" world`, (err) => {
        if (err) {
            return res.json({ error: err.message });
        }
        res.json({ success: true, name: `backup-${timestamp}.zip` });
    });
});

// Backups - restore
app.post('/api/backups/restore', (req, res) => {
    const { name } = req.body;
    const backupPath = path.join(BACKUPS_DIR, name);
    const extractPath = SERVER_DIR;

    if (!fs.existsSync(backupPath)) {
        return res.json({ error: 'Backup not found' });
    }

    // Stop server first if running
    if (minecraftProcess) {
        sendCommand('stop');
        setTimeout(() => {
            exec(`unzip -o "${backupPath}" -d "${extractPath}"`, (err) => {
                if (err) {
                    return res.json({ error: err.message });
                }
                res.json({ success: true });
            });
        }, 5000);
    } else {
        exec(`unzip -o "${backupPath}" -d "${extractPath}"`, (err) => {
            if (err) {
                return res.json({ error: err.message });
            }
            res.json({ success: true });
        });
    }
});

// Backups - delete
app.delete('/api/backups/:name', (req, res) => {
    const backupPath = path.join(BACKUPS_DIR, req.params.name);
    if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
    }
    res.json({ success: true });
});

// ============ WORLD MANAGEMENT ============

// Get world info
app.get('/api/world', (req, res) => {
    const worldPath = path.join(SERVER_DIR, 'world');
    const netherPath = path.join(SERVER_DIR, 'world_nether');
    const theEndPath = path.join(SERVER_DIR, 'world_the_end');
    
    const getWorldInfo = (wp) => {
        if (!fs.existsSync(wp)) return null;
        const stats = fs.statSync(wp);
        return {
            exists: true,
            size: getDirSize(wp),
            modified: stats.mtime
        };
    };
    
    res.json({
        world: getWorldInfo(worldPath),
        nether: getWorldInfo(netherPath),
        theEnd: getWorldInfo(theEndPath),
        totalSize: getDirSize(worldPath) + getDirSize(netherPath) + getDirSize(theEndPath)
    });
});

function getDirSize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let size = 0;
    try {
        const files = fs.readdirSync(dirPath);
        files.forEach(file => {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                size += stat.size;
            } else if (stat.isDirectory()) {
                size += getDirSize(filePath);
            }
        });
    } catch (e) {}
    return size;
}

// Download world (as zip)
app.get('/api/world/download', (req, res) => {
    const worldPath = path.join(SERVER_DIR, 'world');
    if (!fs.existsSync(worldPath)) {
        return res.status(404).json({ error: 'World not found' });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(__dirname, `world-${timestamp}.zip`);
    
    exec(`cd "${SERVER_DIR}" && zip -r "${zipPath}" world`, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.download(zipPath, `world-${timestamp}.zip`, () => {
            fs.unlinkSync(zipPath);
        });
    });
});

// Upload world
app.post('/api/world/upload', (req, res) => {
    // This would need multer for file upload
    // For now, just restart to apply changes
    res.json({ success: true, message: 'World upload received. Restart server to apply.' });
});

// Delete world
app.post('/api/world/delete', (req, res) => {
    const worldPath = path.join(SERVER_DIR, 'world');
    if (minecraftProcess) {
        return res.json({ error: 'Stop server first' });
    }
    
    if (fs.existsSync(worldPath)) {
        exec(`rm -rf "${worldPath}"`, (err) => {
            if (err) return res.json({ error: err.message });
            // Also delete nether and end
            if (fs.existsSync(path.join(SERVER_DIR, 'world_nether'))) {
                exec(`rm -rf "${path.join(SERVER_DIR, 'world_nether')}"`);
            }
            if (fs.existsSync(path.join(SERVER_DIR, 'world_the_end'))) {
                exec(`rm -rf "${path.join(SERVER_DIR, 'world_the_end')}"`);
            }
            res.json({ success: true });
        });
    } else {
        res.json({ error: 'World not found' });
    }
});

// Generate new world
app.post('/api/world/generate', (req, res) => {
    if (minecraftProcess) {
        return res.json({ error: 'Stop server first' });
    }
    
    // Delete old world and restart
    const worldPath = path.join(SERVER_DIR, 'world');
    const commands = [];
    
    if (fs.existsSync(worldPath)) {
        commands.push(`rm -rf "${worldPath}"`);
    }
    commands.push(`rm -rf "${path.join(SERVER_DIR, 'world_nether')}"`);
    commands.push(`rm -rf "${path.join(SERVER_DIR, 'world_the_end')}"`);
    
    exec(commands.join(' && '), (err) => {
        if (err) return res.json({ error: err.message });
        res.json({ success: true, message: 'World deleted. Start server to generate new world.' });
    });
});

// ============ QUICK ACTIONS ============

// Get quick actions info
app.get('/api/actions', (req, res) => {
    res.json({
        worldExists: fs.existsSync(path.join(SERVER_DIR, 'world')),
        serverRunning: !!minecraftProcess,
        jarExists: fs.existsSync(JAR_PATH),
        eulaAccepted: fs.existsSync(EULA_PATH)
    });
});

// Quick start
app.post('/api/start', (req, res) => {
    if (minecraftProcess) return res.json({ error: 'Already running' });
    startMinecraft();
    res.json({ success: true });
});

// Quick stop
app.post('/api/stop', (req, res) => {
    if (!minecraftProcess) return res.json({ error: 'Not running' });
    sendCommand('stop');
    res.json({ success: true });
});

// Force stop
app.post('/api/force-stop', (req, res) => {
    if (!minecraftProcess) return res.json({ error: 'Not running' });
    minecraftProcess.kill('SIGKILL');
    res.json({ success: true });
});

// ============ SYSTEM MANAGEMENT ============

// Get system info (CPU, RAM, Storage)
app.get('/api/system', (req, res) => {
    const os = require('os');
    
    // Get disk usage
    const getDiskUsage = () => {
        try {
            const stats = fs.statfsSync ? fs.statfsSync(SERVER_DIR) : null;
            if (stats) {
                return {
                    total: stats.bsize * stats.blocks,
                    free: stats.bsize * stats.bfree,
                    used: stats.bsize * (stats.blocks - stats.bfree)
                };
            }
        } catch (e) {}
        // Fallback - estimate from folder size
        return {
            total: 100 * 1024 * 1024 * 1024, // 100GB placeholder
            free: 50 * 1024 * 1024 * 1024,
            used: getDirSize(SERVER_DIR)
        };
    };

    const disk = getDiskUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    res.json({
        cpu: {
            cores: os.cpus().length,
            model: os.cpus()[0]?.model || 'Unknown',
            load: os.loadavg()[0] * 10 // Approximate percentage
        },
        memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            usedPercent: (usedMem / totalMem * 100).toFixed(1),
            serverAllocated: 2 * 1024 * 1024 * 1024 // 2GB default
        },
        storage: {
            total: disk.total,
            used: disk.used,
            free: disk.free,
            usedPercent: (disk.used / disk.total * 100).toFixed(1),
            serverFolder: getDirSize(SERVER_DIR)
        },
        system: {
            platform: os.platform(),
            uptime: os.uptime(),
            hostname: os.hostname()
        }
    });
});

// Get/Set memory allocation
let serverMemory = '2G'; // Default
let serverStorage = 10; // Default max storage in GB

// Upload limit configuration
app.post('/api/system/storage', (req, res) => {
    const { maxStorage } = req.body;
    if (maxStorage && typeof maxStorage === 'number') {
        serverStorage = maxStorage;
    }
    res.json({ success: true, maxStorage: serverStorage });
});

app.get('/api/system/memory', (req, res) => {
    res.json({ 
        allocated: serverMemory,
        options: ['512M', '1G', '2G', '3G', '4G', '6G', '8G', '12G', '16G']
    });
});

app.post('/api/system/memory', (req, res) => {
    const { memory } = req.body;
    if (!memory) return res.json({ error: 'Memory value required' });
    
    const validMem = ['512M', '1G', '2G', '3G', '4G', '6G', '8G', '12G', '16G'];
    if (!validMem.includes(memory)) {
        return res.json({ error: 'Invalid memory value' });
    }
    
    serverMemory = memory;
    res.json({ success: true, allocated: serverMemory });
});

// Server performance settings
app.get('/api/system/performance', (req, res) => {
    res.json({
        viewDistance: 10,
        simulationDistance: 10,
        entityTrackingRange: 64,
        maxPlayers: 20,
        spawnRadius: 10,
        allowFlight: false,
        viewDistanceOptions: [6, 8, 10, 12, 16, 20, 24, 32],
        simulationDistanceOptions: [6, 8, 10, 12, 16, 24]
    });
});

app.post('/api/system/performance', (req, res) => {
    const settings = req.body;
    // Update server.properties
    try {
        let props = '';
        if (fs.existsSync(PROPERTIES_PATH)) {
            props = fs.readFileSync(PROPERTIES_PATH, 'utf8');
        }
        
        const updates = {
            'view-distance': settings.viewDistance,
            'simulation-distance': settings.simulationDistance,
            'max-players': settings.maxPlayers,
            'spawn-radius': settings.spawnRadius,
            'allow-flight': settings.allowFlight
        };
        
        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(props)) {
                props = props.replace(regex, `${key}=${value}`);
            } else {
                props += `\n${key}=${value}`;
            }
        }
        
        fs.writeFileSync(PROPERTIES_PATH, props);
        res.json({ success: true });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Get server logs (recent)
app.get('/api/system/logs', (req, res) => {
    const logPath = path.join(SERVER_DIR, 'logs', 'latest.log');
    if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n').slice(-100);
        res.json({ logs: lines.join('\n') });
    } else {
        res.json({ logs: '' });
    }
});

// Clear logs
app.post('/api/system/logs/clear', (req, res) => {
    const logsDir = path.join(SERVER_DIR, 'logs');
    if (fs.existsSync(logsDir)) {
        exec(`rm -rf "${logsDir}"/*`, (err) => {
            if (err) return res.json({ error: err.message });
            res.json({ success: true });
        });
    } else {
        res.json({ success: true });
    }
});

// ============ UPDATE SYSTEM ============

app.get('/api/update/check', (req, res) => {
    const https = require('https');
    
    const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/releases/latest`,
        method: 'GET',
        headers: {
            'User-Agent': 'PurpleMC-Panel'
        }
    };

    https.get(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
            try {
                const release = JSON.parse(data);
                const latestVersion = release.tag_name?.replace('v', '') || '0.0.0';
                const isUpdate = latestVersion !== CURRENT_VERSION;
                
                res.json({
                    currentVersion: CURRENT_VERSION,
                    latestVersion: latestVersion,
                    isUpdate: isUpdate,
                    releaseUrl: release.html_url,
                    downloadUrl: release.assets?.[0]?.browser_download_url,
                    releaseNotes: release.body,
                    publishedAt: release.published_at
                });
            } catch (e) {
                res.json({ 
                    currentVersion: CURRENT_VERSION, 
                    latestVersion: CURRENT_VERSION, 
                    isUpdate: false,
                    error: 'Could not check for updates'
                });
            }
        });
    }).on('error', (e) => {
        res.json({ 
            currentVersion: CURRENT_VERSION, 
            latestVersion: CURRENT_VERSION, 
            isUpdate: false,
            error: 'Connection failed'
        });
    });
});

app.get('/api/update/info', (req, res) => {
    res.json({
        version: CURRENT_VERSION,
        repo: GITHUB_REPO,
        lastChecked: new Date().toISOString()
    });
});

app.post('/api/update/apply', (req, res) => {
    // Pull latest from git
    const { action } = req.body;
    
    if (action === 'pull') {
        exec('git pull origin main', { cwd: __dirname }, (err, stdout, stderr) => {
            if (err) {
                return res.json({ success: false, error: stderr || err.message });
            }
            res.json({ success: true, message: 'Updated! Restart to apply.' });
        });
    } else if (action === 'restart') {
        res.json({ success: true, message: 'Restarting...' });
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }
});

// ============ SOCKET ============

io.on('connection', (socket) => {
    socket.emit('status', minecraftProcess ? 'online' : 'offline');
    socket.emit('players', onlinePlayers);

    socket.on('action', (action) => {
        if (action === 'start') startMinecraft();
        if (action === 'stop' && minecraftProcess) sendCommand('stop');
        if (action === 'kill' && minecraftProcess) minecraftProcess.kill('SIGKILL');
    });

    socket.on('command', (cmd) => {
        sendCommand(cmd);
    });
});

server.listen(PORT, () => {
    console.log(`Panel active at http://localhost:${PORT}`);
});
