/**
 * types.ts — shared domain types for the whole server.
 *
 * These are the contracts between services, REST controllers and the
 * Socket.IO event bus. The React client mirrors the JSON shapes in
 * client/src/types.ts (they must stay in sync manually).
 */

// ----------------------------------------------------------------------
// Console
// ----------------------------------------------------------------------

export type ConsoleLineType =
  | 'error' | 'warn' | 'info' | 'success' | 'system' | 'command'
  | 'join' | 'leave' | 'death' | 'advancement' | 'chat' | 'tick'
  | 'debug' | 'default';

export interface ConsoleLine {
  /** Raw text exactly as emitted by the process (may still contain ANSI). */
  raw: string;
  /** ANSI-stripped text safe to render. */
  text: string;
  type: ConsoleLineType;
  timestamp: string;
}

export interface ClientConsoleLine {
  text: string;
  type: ConsoleLineType;
  timestamp: string;
}

// ----------------------------------------------------------------------
// Minecraft server process
// ----------------------------------------------------------------------

export type ServerLifecycleState = 'starting' | 'online' | 'stopping' | 'offline';

export interface Player {
  name: string;
  joinedAt: string;
  location?: PlayerLocation | null;
}

export interface PlayerLocation {
  x: number;
  y: number;
  z: number;
  updatedAt: string;
}

export interface TpsReading {
  tps5s: number;
  tps1m: number;
  tps5m: number;
  timestamp: string;
}

export interface ProcessStats {
  cpu: number;
  memory: number; // MB
  uptime: number; // seconds
}

export interface DiskUsage {
  totalBytes: number;
  totalMB: number;
  totalGB: number;
  fileCount: number;
  dirCount: number;
  error?: string;
}

export interface HostDiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
}

export interface SystemMetrics {
  cpu: {
    cores: number;
    model: string;
    loadAvg1m: number;
    loadAvg5m: number;
    loadAvg15m: number;
  };
  ram: {
    totalBytes: number; totalMB: number; totalGB: number;
    freeBytes: number; freeMB: number; freeGB: number;
    usedBytes: number; usedMB: number; usedGB: number;
    usagePercent: number;
  };
  hostname: string;
  platform: string;
  uptime: number;
  type: string;
  error?: string;
}

export interface ServerStatsSnapshot {
  cpu: number;
  memory: number;
  uptime: number;
  disk: DiskUsage | null;
  system: SystemMetrics | null;
  allocation: {
    maxRam: string;
    recommended: string;
    autoResource: boolean;
  };
}

// ----------------------------------------------------------------------
// Settings / properties
// ----------------------------------------------------------------------

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

export interface PanelSettings {
  autoResource: boolean;
  maxRam: string;
  javaPath: string;
  javaArgs: string;
  serverVersion: string;
  serverPort: number;
  autoRestart: boolean;
  autoStart: boolean;
  starterPackOnFirstRun: boolean;
  panelPort: number;
  backupEnabled: boolean;
  backupInterval: number;
  backupMaxKeep: number;
  backupWorlds: string;
  consoleMaxLines: number;
  maxPlayers: number;
  motd: string;
  difficulty: Difficulty;
  gamemode: GameMode;
  pvp: boolean;
  onlineMode: boolean;
  whitelist: boolean;
  viewDistance: number;
  simulationDistance: number;
  spawnProtection: number;
}

/** One parsed key of server.properties with its leading comment preserved. */
export interface PropEntry {
  value: string;
  comment: string;
  raw: string;
}

// ----------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------

export type TaskType = 'command' | 'restart' | 'backup';

export interface Task {
  id: string;
  name: string;
  type: TaskType;
  command: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRun: string | null;
  createdAt: string;
}

// ----------------------------------------------------------------------
// Backups
// ----------------------------------------------------------------------

export interface BackupInfo {
  name: string;
  size: number; // MB
  date: Date;
}

// ----------------------------------------------------------------------
// Plugins
// ----------------------------------------------------------------------

export type PluginSource = 'modrinth' | 'spigot' | 'geysermc';

export interface PluginSearchHit {
  id: string;
  name: string;
  tag: string;
  description: string;
  icon: string | null;
  downloads: number;
  likes: number;
  premium: boolean;
  price: number;
  version: string;
  author: string;
  source: PluginSource;
  downloadUrl: string | null;
}

export interface InstalledPlugin {
  name: string;
  size: number;
  modified: string;
}

export interface EssentialPlugin {
  id: string;
  name: string;
  description: string;
  icon: string;
  author: string;
  source: PluginSource;
}

export type PluginProgressStage = 'queued' | 'resolving' | 'downloading' | 'verifying' | 'complete' | 'error';

export interface PluginInstallProgress {
  pluginId: string;
  stage: PluginProgressStage;
  percent: number;
  message: string;
  speed: number | null;
}

export interface PluginQueueState {
  active: number;
  queued: number;
  queue: string[];
}

// ----------------------------------------------------------------------
// Network
// ----------------------------------------------------------------------

export interface PortCheck {
  port: number;
  service: string;
  status: 'free' | 'in-use';
}

export interface PortAllocation {
  id: string;
  port: number;
  service: string;
  description: string;
  status: 'active';
  allocatedAt: string;
}

export interface NetworkStatus {
  publicIP: string | null;
  localIP: string;
  hostname: string;
  mac: string | null;
  defaultPorts: PortCheck[];
  allocations: PortAllocation[];
  timestamp: string;
}

// ----------------------------------------------------------------------
// Crashes / diagnosis
// ----------------------------------------------------------------------

export type CrashSeverity = 'info' | 'warning' | 'high' | 'critical';

export interface CrashDiagnosis {
  reason: string;
  severity: CrashSeverity;
  repairs: { action: string; label: string; auto: boolean }[];
}

export interface CrashLogEntry extends CrashDiagnosis {
  timestamp: string;
  exitCode: number | null;
  recentOutput: string[];
}

// ----------------------------------------------------------------------
// Updates
// ----------------------------------------------------------------------

export interface UpdateCheckPayload {
  method: 'github';
  source: 'version.json';
  gitRepoUrl: string;
  branch: string;
  checkedAt: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkBlocked: boolean;
  message: string;
  fromCache?: boolean;
}

export interface UpdateProgressLine {
  text: string;
  level: 'system' | 'info' | 'warn' | 'error' | 'success';
  timestamp: string;
}

// ----------------------------------------------------------------------
// Misc API payloads
// ----------------------------------------------------------------------

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modified: string | null;
  extension: string;
  fileCount?: number;
}

export interface DiskFolderUsage extends DiskUsage {
  name: string;
}

export interface PlayerAction {
  kind: 'op' | 'deop' | 'kick' | 'ban' | 'pardon' | 'teleport' | 'locate' | 'give';
  target: string;
  reason?: string;
}
