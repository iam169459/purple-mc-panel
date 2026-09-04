/**
 * config.ts — single source of truth for paths, defaults and constants.
 */

import * as path from 'path';
import type { PanelSettings } from './types';

export const ROOT_DIR = path.join(__dirname, '..', '..');

// --- Filesystem layout -------------------------------------------
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const SERVER_DIR = path.join(ROOT_DIR, 'server');
export const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const NETWORK_DB_PATH = path.join(CONFIG_DIR, 'network-allocations.json');
export const SETTINGS_DB_PATH = path.join(CONFIG_DIR, 'settings.json');
export const TASKS_DB_PATH = path.join(CONFIG_DIR, 'tasks.json');
export const JAR_PATH = path.join(SERVER_DIR, 'server.jar');
export const EULA_PATH = path.join(SERVER_DIR, 'eula.txt');
export const SERVER_PROPS_PATH = path.join(SERVER_DIR, 'server.properties');
export const CRASH_LOG_PATH = path.join(CONFIG_DIR, 'crash.log');
export const VERSION_FILE = path.join(ROOT_DIR, 'version.json');

// --- HTTP server -------------------------------------------------
export const PORT = Number(process.env.PORT) || 3000;

// --- Versioning / self-update ------------------------------------
export const GITHUB_OWNER = 'iam169459';
export const GITHUB_REPO = 'purple-mc-panel';
export const GITHUB_BRANCH = 'main'; // default — probed and cached at runtime
export const GIT_REMOTE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
/** Env overrides let ops point the updater at a mirror (used in tests too). */
export const UPDATE_RAW_URL: string | null = process.env.PANEL_UPDATE_RAW_URL || null;
export const UPDATE_ARCHIVE_URL: string | null = process.env.PANEL_UPDATE_ARCHIVE_URL || null;
/** Fallback when version.json / package.json can't be read at boot. */
export const CURRENT_VERSION = '1.0.0';
/** Directories/files the updater must never touch. */
export const UPDATE_PROTECTED = new Set(['.git', 'node_modules', 'server', 'config', 'backups', 'uploads', '.env']);
/** Re-query GitHub at most every 5 minutes from the update-check route. */
export const UPDATE_CHECK_TTL = 5 * 60 * 1000;

// --- PaperMC / Minecraft -----------------------------------------
export const PAPER_API = 'https://fill.papermc.io/v3';
export const USER_AGENT = `PurpleMC-Panel/1.1 (https://github.com/${GITHUB_OWNER}/${GITHUB_REPO})`;
/** Static fallbacks used when the live PaperMC API is unreachable. */
export const PAPER_VERSIONS: Record<string, string> = {
  '1.20.4': 'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/499/downloads/paper-1.20.4-499.jar',
  '1.20.2': 'https://api.papermc.io/v2/projects/paper/versions/1.20.2/builds/317/downloads/paper-1.20.2-317.jar',
  '1.19.4': 'https://api.papermc.io/v2/projects/paper/versions/1.19.4/builds/557/downloads/paper-1.19.4-557.jar'
};
/** Curated Paper release list (newest first) — shown only when the live API is unreachable. */
export const PAPER_VERSION_IDS: string[] = [
  '26.2', '26.1.2', '26.1.1',
  '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.6', '1.20.5', '1.20.4', '1.20.2', '1.20.1', '1.20',
  '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
  '1.18.2', '1.18.1', '1.18',
  '1.17.1', '1.17',
  '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
  '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.11.2', '1.10.2', '1.9.4', '1.8.8'
];
export const DEFAULT_VERSION = '1.20.4';
export const DEFAULT_RAM = '4G';
export const JAVA_FALLBACKS = (): string[] => ['java', '/usr/bin/java', '/usr/local/bin/java', '/opt/java/bin/java'];

// Java flags tuned for Minecraft server garbage collection (Aikar's flags).
const DEFAULT_JAVA_ARGS = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true'
].join(' ');

export const DEFAULT_SETTINGS: PanelSettings = {
  autoResource: true,
  maxRam: '4G',
  javaPath: 'java',
  javaArgs: DEFAULT_JAVA_ARGS,
  serverVersion: '1.20.4',
  serverPort: 25565,
  autoRestart: true,
  autoStart: false,
  /** Download the curated starter pack into an empty plugins folder on first boot. */
  starterPackOnFirstRun: true,
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
  viewDistance: 8,
  simulationDistance: 6,
  spawnProtection: 16
};

/** Settings keys that also live in server.properties (synced on save). */
export const SETTINGS_TO_PROPS: Record<keyof PanelSettings, string> = {
  motd: 'motd',
  difficulty: 'difficulty',
  gamemode: 'gamemode',
  pvp: 'pvp',
  onlineMode: 'online-mode',
  whitelist: 'white-list',
  viewDistance: 'view-distance',
  simulationDistance: 'simulation-distance',
  spawnProtection: 'spawn-protection',
  serverPort: 'server-port'
} as unknown as Record<keyof PanelSettings, string>;

// --- Console / crash handling ------------------------------------
export const CONSOLE_DEFAULT_MAX = 500;
export const CONSOLE_ABSOLUTE_MIN = 100;
export const CONSOLE_ABSOLUTE_MAX = 5000;
export const CRASH_THROTTLE_MAX = 5;
export const CRASH_THROTTLE_WINDOW = 120000;
/** A process that survived this long is treated as healthy — the crash
 * throttle resets so a one-off later crash still gets full auto-restarts. */
export const HEALTHY_RUNTIME_MS = 90_000;
export const CRASH_LOG_MAX = 100;
export const CRASH_RESTART_MAX_DELAY_S = 30;

// --- File manager ------------------------------------------------
export const FILE_MAX_READ_BYTES = 5 * 1024 * 1024;
export const FILE_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const PLUGIN_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const EDITABLE_EXTENSIONS = [
  '.txt', '.yml', '.yaml', '.properties', '.json', '.xml', '.cfg', '.conf',
  '.log', '.md', '.sh', '.bat', '.toml', '.env', '.java', '.js', '.ts', '.css', '.html'
];
export const DISK_CACHE_TTL = 30000;

// --- Marketplace -------------------------------------------------
export const SPIGET_API = 'https://api.spiget.org/v2';
export const MODRINTH_API = 'https://api.modrinth.com/v2';
/** GeyserMC's own download API — Bukkit builds of Geyser/Floodgate live here, not on Modrinth. */
export const GEYSERMC_DL_API = 'https://download.geysermc.org/v2';

// --- ANSI colors (console + UI streams) --------------------------
export const COLORS = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m'
};
