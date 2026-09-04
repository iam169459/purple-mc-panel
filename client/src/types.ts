/**
 * types.ts — JSON shapes as served by the panel backend.
 * Mirrors src/types.ts on the server; keep in sync.
 */

export type Lifecycle = 'starting' | 'online' | 'stopping' | 'offline';

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

export interface AllocationInfo {
  maxRam: string;
  recommended?: string;
  autoResource: boolean;
  javaPath?: string;
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
}

export interface StatsSnapshot {
  cpu: number;
  memory: number;
  uptime: number;
  disk: DiskUsage | null;
  system: SystemMetrics | null;
  allocation: AllocationInfo;
}

export interface TpsData {
  tps: {
    tps5s: number;
    tps1m: number;
    tps5m: number;
    timestamp: string;
  } | null;
  mspt: number | null;
}

export interface Player {
  name: string;
  joinedAt: string;
  location?: { x: number; y: number; z: number; updatedAt: string } | null;
}

export interface EssentialPlugin {
  id: string;
  name: string;
  description: string;
  icon: string;
  author: string;
  source: 'modrinth' | 'spigot' | 'geysermc';
}

export interface PluginHit {
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
  source: 'modrinth' | 'spigot';
  downloadUrl: string | null;
}

export interface InstalledPlugin {
  name: string;
  size: number;
  modified: string;
}

export interface PluginProgress {
  pluginId: string;
  stage: 'queued' | 'resolving' | 'downloading' | 'verifying' | 'complete' | 'error';
  percent: number;
  message: string;
  speed: number | null;
}

export interface PluginQueue {
  active: number;
  queued: number;
  queue: string[];
}

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
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
  gamemode: 'survival' | 'creative' | 'adventure' | 'spectator';
  pvp: boolean;
  onlineMode: boolean;
  whitelist: boolean;
  viewDistance: number;
  simulationDistance: number;
  spawnProtection: number;
}

export interface Task {
  id: string;
  name: string;
  type: 'command' | 'restart' | 'backup';
  command: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRun: string | null;
  createdAt: string;
}

export interface BackupInfo {
  name: string;
  size: number;
  date: string;
}

export interface PortAllocation {
  id: string;
  port: number;
  service: string;
  description: string;
  status: 'active';
  allocatedAt: string;
}

export interface PortCheck {
  port: number;
  service: string;
  status: 'free' | 'in-use';
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

export interface CrashLogEntry {
  timestamp: string;
  exitCode: number | null;
  reason: string;
  severity: 'info' | 'warning' | 'high' | 'critical';
  repairs: { action: string; label: string; auto: boolean }[];
  recentOutput: string[];
}

export interface UpdateCheck {
  method: string;
  source: string;
  gitRepoUrl: string;
  branch: string;
  checkedAt: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkBlocked: boolean;
  message: string;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modified: string | null;
  extension: string;
  fileCount?: number;
}

export interface FileStorage {
  success: boolean;
  server: DiskUsage;
  host: HostDiskInfo | null;
  folders: Array<DiskUsage & { name: string }>;
}
