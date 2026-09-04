/**
 * server.ts — Minecraft server process control.
 *
 * Spawns Java with fallback binary detection, manages the full lifecycle
 * (start / stop / kill / restart), pipes console output into the rolling
 * buffer + sockets, diagnoses crashes, and auto-restarts with throttling.
 * Also ensures the Paper JAR + EULA exist.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import axios from 'axios';
import { ctx, emit, resetServerRuntimeState } from './context';
import {
  SERVER_DIR, JAR_PATH, EULA_PATH, CRASH_LOG_PATH, COLORS,
  PAPER_API, PAPER_VERSIONS, PAPER_VERSION_IDS, DEFAULT_VERSION, DEFAULT_RAM, JAVA_FALLBACKS, USER_AGENT,
  CRASH_THROTTLE_MAX, CRASH_THROTTLE_WINDOW, HEALTHY_RUNTIME_MS, CRASH_LOG_MAX,
  CRASH_RESTART_MAX_DELAY_S
} from './config';
import { log } from './logger';
import { stripAnsi } from './line';
import { pushToLogBuffer } from './console-buffer';
import { loadSettings, saveSettings } from './settings';
import { calculateRecommendedRam } from './metrics';
import { downloadFile } from './download';
import type { CrashDiagnosis, CrashLogEntry } from './types';

export type StartResult = { success: true; message?: string } | { success: false; error: string };

// ------------------------------------------------------------------
// Console helpers
// ------------------------------------------------------------------

/** Emit a message into the live console stream (no buffer write). */
export function emitConsoleSafe(msg: string): void {
  try {
    ctx.io?.emit('console', msg);
  } catch { /* ignore */ }
}

function statusEmit(state: 'online' | 'offline'): void {
  emit('status', state);
}

// ------------------------------------------------------------------
// Auto Java download (Adoptium / Eclipse Temurin)
// ------------------------------------------------------------------

const JAVA_INSTALL_DIR = path.join(path.dirname(JAR_PATH), '..', 'java');

function getJavaArch(): string {
  const arch = os.arch();
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'aarch64';
  return 'x64';
}

function getInstalledJavaVersion(): number | null {
  const settings = loadSettings();
  const javaPath = settings.javaPath || 'java';
  // Check downloaded Java first
  const downloadedJava = path.join(JAVA_INSTALL_DIR, 'bin', 'java');
  const candidates = [downloadedJava, javaPath, 'java'];
  for (const jp of candidates) {
    try {
      const { execSync } = require('child_process');
      const out = execSync(`${jp} -version 2>&1`, { timeout: 5000 }).toString();
      const match = out.match(/version[\s"]+(\d+)/);
      if (match) return parseInt(match[1], 10);
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Downloads Adoptium Temurin JDK if the required version isn't available.
 * Returns the path to the java binary, or null on failure.
 */
export async function ensureJava(requiredVersion: number): Promise<string | null> {
  const current = getInstalledJavaVersion();
  if (current !== null && current >= requiredVersion) {
    const downloaded = path.join(JAVA_INSTALL_DIR, 'bin', 'java');
    if (fs.existsSync(downloaded)) return downloaded;
    return null; // system java is good enough
  }

  emitConsoleSafe(`\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Java ${current ?? 'not found'} detected — Paper requires Java ${requiredVersion}. Downloading Adoptium Temurin...\n`);
  log(`Java ${current ?? 'not found'} detected, need ${requiredVersion} — downloading Adoptium`, 'info');

  const arch = getJavaArch();
  const url = `https://api.adoptium.net/v3/binary/latest/${requiredVersion}/ga/linux/${arch}/jdk/hotspot/normal/eclipse`;
  const tmpDir = path.join(os.tmpdir(), `pmc-java-${Date.now()}`);
  const archivePath = path.join(tmpDir, 'jdk.tar.gz');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(JAVA_INSTALL_DIR, { recursive: true });

    let lastPct = 0;
    await downloadFile(url, archivePath, (got, total) => {
      const pct = total > 0 ? Math.round((got / total) * 100) : 0;
      if (pct - lastPct >= 10 || pct === 100) {
        lastPct = pct;
        const mb = (got / 1024 / 1024).toFixed(0);
        const msg = `Downloading Java ${requiredVersion} (Adoptium) ${total > 0 ? `${pct}%` : `${mb} MB`}...`;
        pushToLogBuffer(`[SYSTEM] ${msg}`, 'system');
        emitConsoleSafe(`\n${COLORS.cyan}[DOWNLOAD]${COLORS.reset} ${msg}\n`);
      }
    });

    emitConsoleSafe(`\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Extracting Java ${requiredVersion}...\n`);

    // Extract
    const { execSync } = require('child_process');
    execSync(`tar -xzf ${archivePath} -C ${tmpDir}`, { timeout: 120000 });

    // Find the extracted JDK directory
    const entries = fs.readdirSync(tmpDir).filter((e: string) => e.startsWith('jdk-') || e.startsWith('jdk_'));
    if (entries.length === 0) throw new Error('JDK directory not found in archive');

    const extractedDir = path.join(tmpDir, entries[0]);
    // Move to install dir
    const targetDir = path.join(JAVA_INSTALL_DIR, `jdk-${requiredVersion}`);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(extractedDir, targetDir);

    // Symlink bin/java
    const binDir = path.join(JAVA_INSTALL_DIR, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const javaBin = path.join(targetDir, 'bin', 'java');
    const linkPath = path.join(binDir, 'java');
    if (fs.existsSync(linkPath)) fs.rmSync(linkPath);
    fs.symlinkSync(javaBin, linkPath);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const doneMsg = `Java ${requiredVersion} installed at ${targetDir}`;
    pushToLogBuffer(`[SYSTEM] ${doneMsg}`, 'system');
    emitConsoleSafe(`\n${COLORS.green}[SYSTEM]${COLORS.reset} ${doneMsg}\n`);
    log(doneMsg, 'info');

    // Save the java path in settings
    const settings = loadSettings();
    settings.javaPath = javaBin;
    saveSettings(settings);

    return javaBin;
  } catch (err) {
    emitConsoleSafe(`\n${COLORS.red}[ERROR]${COLORS.reset} Failed to download Java ${requiredVersion}: ${(err as Error).message}\n`);
    log(`Adoptium download failed: ${(err as Error).message}`, 'error');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Parse the required Java version from a server crash message.
 * e.g. "requires running the server with Java 25" → 25
 */
function parseRequiredJavaVersion(recentLines: string[]): number | null {
  const combined = recentLines.join('\n');
  const match = combined.match(/requires running the server with Java\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

// ------------------------------------------------------------------
// Paper server JAR provisioning
// ------------------------------------------------------------------

/**
 * resolvePaperDownloadUrl — asks the current PaperMC downloads service
 * for the latest stable build of a Minecraft version and returns its
 * direct download URL. Returns null on any failure so callers can fall
 * back to the hardcoded URL table.
 */
export async function resolvePaperDownloadUrl(version: string): Promise<string | null> {
  try {
    const res = await axios.get(`${PAPER_API}/projects/paper/versions/${encodeURIComponent(version)}/builds`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000
    });
    const builds: any[] = res.data;
    if (Array.isArray(builds)) {
      const withDownload = (b: any): boolean => !!(b?.downloads?.['server:default']?.url);
      const pick = builds.find((b) => b.channel === 'STABLE' && withDownload(b))
        ?? builds.find(withDownload);
      if (pick) return pick.downloads['server:default'].url as string;
    }
  } catch (err) {
    log(`PaperMC API lookup failed for ${version}: ${(err as Error).message}`, 'warn');
  }
  return null;
}

/** Stream a Paper JAR to disk atomically (tmp file + rename) with progress. */
async function downloadPaperJar(version: string, url: string): Promise<void> {
  const tmp = `${JAR_PATH}.tmp`;
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  const onProgress = (got: number, total: number): void => {
    const pct = total > 0 ? Math.round((got / total) * 100) : 0;
    const gotMB = (got / 1024 / 1024).toFixed(1);
    const totMB = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';
    const msg = `Downloading PaperMC ${version} ${total > 0 ? `${pct}%` : `${gotMB} MB`} (${gotMB}/${totMB} MB)`;
    pushToLogBuffer(`[SYSTEM] ${msg}`, 'system');
    emitConsoleSafe(`\n${COLORS.cyan}[DOWNLOAD]${COLORS.reset} ${msg}\n`);
  };

  try {
    pushToLogBuffer(`[SYSTEM] Downloading PaperMC ${version}...`, 'system');
    await downloadFile(url, tmp, onProgress);
    fs.renameSync(tmp, JAR_PATH);
    fs.writeFileSync(EULA_PATH, 'eula=true');
    const jarSize = (fs.statSync(JAR_PATH).size / 1024 / 1024).toFixed(1);
    const doneMsg = `Server JAR ready (${jarSize} MB)`;
    pushToLogBuffer(`[SYSTEM] ${doneMsg}`, 'system');
    emitConsoleSafe(`\n${COLORS.green}[DOWNLOAD]${COLORS.reset} ${doneMsg}\n`);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export async function checkAndDownloadServer(): Promise<void> {
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
      await downloadPaperJar(version, url);
      log(`Server JAR downloaded and eula.txt created`, 'info');
    } catch (err) {
      log(`Failed to download server: ${(err as Error).message}`, 'error');
      throw err;
    }
  }
  if (!fs.existsSync(EULA_PATH)) {
    fs.writeFileSync(EULA_PATH, 'eula=true');
  }
}

export interface PaperVersionInfo {
  id: string;
  status: string;
  java: number | null;
}

let paperVersionCache: { at: number; data: PaperVersionInfo[] } | null = null;

/** Paper releases (newest first) with support + Java requirements; cached 10 min. */
export async function listPaperVersions(): Promise<PaperVersionInfo[]> {
  if (paperVersionCache && Date.now() - paperVersionCache.at < 10 * 60 * 1000) return paperVersionCache.data;
  try {
    const res = await axios.get(`${PAPER_API}/projects/paper/versions`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000
    });
    const entries: any[] = (res.data as { versions?: any[] })?.versions ?? [];
    const versions: PaperVersionInfo[] = entries
      .filter((e) => {
        const id = String(e?.version?.id ?? '');
        return id !== ''
          && !/(^|[-])(pre|rc|snapshot)/i.test(id)
          && Array.isArray(e?.builds) && (e.builds as unknown[]).length > 0;
      })
      .map((e) => ({
        id: String(e.version.id),
        status: String(e.version?.support?.status ?? 'unknown'),
        java: Number(e.version?.java?.version?.minimum) || null
      }));
    if (versions.length > 0) {
      paperVersionCache = { at: Date.now(), data: versions };
      return versions;
    }
  } catch (err) {
    log(`PaperMC versions lookup failed: ${(err as Error).message}`, 'warn');
  }
  // Offline fallback — curated list of versions Paper publishes, newest first.
  return PAPER_VERSION_IDS.map((id) => ({ id, status: 'unknown', java: null }));
}

/** Swap server.jar to a specific Paper version (refuses while the server runs). */
export async function installServerJarForVersion(version: string): Promise<void> {
  if (ctx.mcProcess) throw new Error('Stop the Minecraft server before switching versions');
  const known = await listPaperVersions();
  if (!known.some((v) => v.id === version)) throw new Error(`Unknown Paper version: ${version}`);

  log(`Switching server JAR to PaperMC ${version}...`, 'info');
  const liveUrl = await resolvePaperDownloadUrl(version);
  const fallback = PAPER_VERSIONS[version];
  if (!liveUrl && !fallback) throw new Error(`No download URL available for Paper ${version}`);

  const settings = loadSettings();
  settings.serverVersion = version;
  saveSettings(settings);
  await downloadPaperJar(version, liveUrl ?? (fallback as string));
  log(`Server JAR switched to PaperMC ${version}`, 'info');
}

// ------------------------------------------------------------------
// Crash diagnosis & logging
// ------------------------------------------------------------------

export function writeCrashLog(entry: CrashLogEntry): void {
  try {
    const logs: CrashLogEntry[] = [];
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
  } catch { /* ignore */ }
}

export function diagnoseCrash(code: number | null, recentLines: string[]): CrashDiagnosis {
  const combined = recentLines.join('\n').toLowerCase();
  const diagnosis: CrashDiagnosis = { reason: 'unknown', severity: 'warning', repairs: [] };

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
  } else if (combined.includes('error loading plugin') || (combined.includes('plugins') && (combined.includes('failed to load') || combined.includes('could not load')))) {
    diagnosis.reason = 'plugin_failure';
    diagnosis.severity = 'high';
    diagnosis.repairs.push({ action: 'disable_plugins', label: 'A plugin failed to load — remove recently added plugins', auto: false });
  } else if (combined.includes('java.lang.nosuchmethod') || combined.includes('classcastexception')) {
    diagnosis.reason = 'plugin_incompatibility';
    diagnosis.severity = 'high';
    diagnosis.repairs.push({ action: 'update_plugins', label: 'Plugin incompatibility detected — update all plugins', auto: false });
  } else if (combined.includes('bindexception') || combined.includes('address already in use')) {
    diagnosis.reason = 'port_conflict';
    diagnosis.severity = 'high';
    diagnosis.repairs.push({ action: 'change_port', label: 'Port already in use — change server-port in settings', auto: false });
  } else if (combined.includes('requires running the server with java') || combined.includes('java version') && combined.includes('not supported')) {
    diagnosis.reason = 'java_version_mismatch';
    diagnosis.severity = 'critical';
    diagnosis.repairs.push({ action: 'install_java', label: 'Paper requires a newer Java version — install Java 25+ and restart', auto: false });
  } else if (code === 1) {
    diagnosis.reason = 'generic_error';
    diagnosis.severity = 'warning';
    diagnosis.repairs.push({ action: 'check_logs', label: 'Check console output above for error details', auto: false });
  }

  return diagnosis;
}

export function captureCrashSnapshot(code: number | null): CrashLogEntry {
  const recentLines = ctx.logBuffer.slice(-50).map((e) => e.text);
  const diagnosis = diagnoseCrash(code, recentLines);
  const snapshot: CrashLogEntry = {
    timestamp: new Date().toISOString(),
    exitCode: code,
    ...diagnosis,
    recentOutput: recentLines.slice(-20)
  };

  writeCrashLog(snapshot);
  log(
    `Crash logged: ${diagnosis.reason} (code: ${code}, severity: ${diagnosis.severity})`,
    diagnosis.severity === 'critical' ? 'error' : 'warn'
  );
  return snapshot;
}

// ------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------

/** Build the Java command line from settings. */
function buildJavaCommand(settings: ReturnType<typeof loadSettings>): string[] {
  const ram = settings.autoResource ? calculateRecommendedRam() : (settings.maxRam || DEFAULT_RAM);
  const extraArgs = settings.javaArgs ? settings.javaArgs.split(' ').filter(Boolean) : [];
  return ['-Xmx' + ram, '-Xms' + ram, ...extraArgs, '-jar', 'server.jar', 'nogui'];
}

function attachProcessHandlers(proc: ChildProcessWithoutNullStreams): void {
  proc.stdout.on('data', (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    pushToLogBuffer(text, 'stdout');
    try { ctx.io?.emit('console', text); } catch { /* ignore */ }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    pushToLogBuffer(`[STDERR] ${text}`, 'stderr');
    emitConsoleSafe(`\n${COLORS.red}[ERROR]${COLORS.reset} ${text}`);
  });

  proc.on('error', (err) => {
    ctx.isStarting = false;
    log(`Process error: ${err.message}`, 'error');
    emitConsoleSafe(`\n${COLORS.red}[SYSTEM ERROR]${COLORS.reset} ${err.message}\n`);
    pushToLogBuffer(`[SYSTEM ERROR] ${err.message}`, 'error');
  });

  proc.on('close', (code) => {
    handleProcessClose(code);
  });
}

function handleProcessClose(code: number | null): void {
  const wasRunning = ctx.mcProcess !== null;
  const restartWasPending = ctx.restartPending;
  // Capture how long the process lived BEFORE clearing runtime state.
  const uptimeMs = ctx.serverStartTime ? Date.now() - ctx.serverStartTime : 0;
  resetServerRuntimeState();
  statusEmit('offline');
  emit('players', []);

  pushToLogBuffer(`[SYSTEM] Minecraft server stopped (exit code: ${code})`, 'system');

  if (restartWasPending) {
    log('Restart pending, starting server...', 'warn');
    setTimeout(() => { void startServer(); }, 2000);
    return;
  }

  if (ctx.shuttingDown) {
    log(`Minecraft server stopped during panel shutdown (exit code: ${code}) — not auto-restarting.`, 'info');
    return;
  }

  if (wasRunning && code !== 0) {
    const crashInfo = captureCrashSnapshot(code);
    const crashMsg = crashInfo.reason === 'out_of_memory'
      ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}Out of memory detected!${COLORS.reset} Try reducing max RAM or adding more swap.`
      : crashInfo.reason === 'world_corruption'
        ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}World corruption detected!${COLORS.reset} Restore from backup or run world repair.`
        : crashInfo.reason === 'plugin_failure' || crashInfo.reason === 'plugin_incompatibility'
          ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}Plugin problem detected!${COLORS.reset} Remove or update recently added plugins and restart.`
          : crashInfo.reason === 'java_version_mismatch'
            ? `${COLORS.red}[CRASH]${COLORS.reset} ${COLORS.yellow}Java version mismatch!${COLORS.reset} Paper requires a newer Java — downloading now...`
            : `${COLORS.red}[CRASH]${COLORS.reset} Server exited with code ${code}`;

    emitConsoleSafe(`\n${crashMsg}\n`);

    // Auto-download the required Java version on mismatch
    if (crashInfo.reason === 'java_version_mismatch') {
      const requiredJava = parseRequiredJavaVersion(ctx.logBuffer.map((e) => e.text));
      if (requiredJava) {
        ctx.crashCount = 0;
        ensureJava(requiredJava).then((javaBin) => {
          if (javaBin) {
            emitConsoleSafe(`\n${COLORS.green}[SYSTEM]${COLORS.reset} Java ${requiredJava} ready — restarting server...\n`);
            log(`Auto-downloaded Java ${requiredJava} at ${javaBin}, restarting server`, 'info');
            setTimeout(() => { void startServer({ resetCrashThrottle: true }); }, 2000);
          } else {
            emitConsoleSafe(`\n${COLORS.red}[SYSTEM]${COLORS.reset} Auto Java download failed. Install Java ${requiredJava}+ manually.\n`);
          }
        });
        return;
      }
    }

    const s = loadSettings();
    if (s.autoRestart) {
      const now = Date.now();
      // A long-lived process means the crash is a fresh incident — reset the
      // throttle budget. Short-lived boot crashes accumulate so auto-restart
      // gives up after CRASH_THROTTLE_MAX attempts instead of looping forever.
      if (uptimeMs >= HEALTHY_RUNTIME_MS || now - ctx.crashWindowStart > CRASH_THROTTLE_WINDOW) {
        ctx.crashWindowStart = now;
        ctx.crashCount = 0;
      }
      ctx.crashCount++;
      const delay = Math.min(CRASH_RESTART_MAX_DELAY_S, ctx.crashCount * 5);
      emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Auto-restart in ${delay}s (attempt ${ctx.crashCount}/${CRASH_THROTTLE_MAX})\n`);
      log(`Server crashed (code: ${code}, reason: ${crashInfo.reason}), auto-restart #${ctx.crashCount} in ${delay}s`, 'warn');
      if (ctx.crashCount <= CRASH_THROTTLE_MAX) {
        setTimeout(() => { void startServer(); }, delay * 1000);
      } else {
        emitConsoleSafe(`\n${COLORS.red}[SYSTEM]${COLORS.reset} Auto-restart throttled: too many crashes. Manual restart required.\n`);
        log(`Auto-restart throttled after ${CRASH_THROTTLE_MAX} consecutive crashes`, 'error');
      }
    } else {
      emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Server stopped (code: ${code})\n`);
    }
  }
}

export async function startServer(opts: { resetCrashThrottle?: boolean } = {}): Promise<StartResult> {
  if (ctx.mcProcess || ctx.isStarting || ctx.isStopping) {
    return { success: false, error: 'Server already running, starting, or stopping' };
  }
  ctx.isStarting = true;
  emitConsoleSafe(`\n${COLORS.cyan}[SYSTEM]${COLORS.reset} Starting Minecraft server...\n`);

  // A user-initiated start (route / socket / auto-start on boot) deserves a
  // fresh throttle budget; crash-driven auto-restarts keep the counter so a
  // boot-crash loop is cut off after CRASH_THROTTLE_MAX attempts.
  if (opts.resetCrashThrottle) {
    ctx.crashCount = 0;
    ctx.crashWindowStart = 0;
  }

  try {
    const settings = loadSettings();
    await checkAndDownloadServer();
    const javaExe = settings.javaPath || 'java';
    const javaFallbacks = [...new Set([javaExe, ...JAVA_FALLBACKS()].filter(Boolean))];
    const args = buildJavaCommand(settings);

    let spawnedProcess: ChildProcessWithoutNullStreams | null = null;
    let lastError: Error | null = null;

    for (const javaPathCandidate of javaFallbacks) {
      const candidate = spawn(javaPathCandidate, args, {
        cwd: SERVER_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });

      const testResult = await Promise.race<{ ok: true } | { ok: false; err: Error }>([
        new Promise((resolve) => candidate.once('spawn', () => resolve({ ok: true }))),
        new Promise((resolve) => candidate.once('error', (err) => resolve({ ok: false, err }))),
        new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500))
      ]);

      if (testResult.ok === false) {
        try { candidate.kill(); } catch { /* ignore */ }
        lastError = testResult.err;
        continue;
      }

      spawnedProcess = candidate;
      log(`Server spawn using: ${javaPathCandidate}`, 'info');
      break;
    }

    if (!spawnedProcess) {
      ctx.isStarting = false;
      const msg = `Failed to spawn Java process. Tried: ${javaFallbacks.join(', ')}. Last error: ${lastError?.message || 'unknown'}`;
      log(msg, 'error');
      emitConsoleSafe(`\n${COLORS.red}[SYSTEM ERROR]${COLORS.reset} ${msg}\n`);
      return { success: false, error: msg };
    }

    ctx.mcProcess = spawnedProcess;
    ctx.processPid = spawnedProcess.pid ?? null;
    ctx.serverStartTime = Date.now();
    ctx.isStarting = false;
    log(`Server started with PID: ${ctx.processPid}`, 'info');
    statusEmit('online');
    pushToLogBuffer(`[SYSTEM] Minecraft server started (PID: ${ctx.processPid})`, 'system');

    attachProcessHandlers(spawnedProcess);
    return { success: true };
  } catch (err) {
    ctx.isStarting = false;
    log(`Failed to start: ${(err as Error).message}`, 'error');
    return { success: false, error: (err as Error).message };
  }
}

export function stopServer(): StartResult {
  if (!ctx.mcProcess || ctx.isStopping) {
    return { success: false, error: 'Server not running' };
  }
  ctx.isStopping = true;
  log('Stopping server gracefully...', 'info');
  emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Stopping server...\n`);
  pushToLogBuffer('[SYSTEM] Stopping Minecraft server...', 'system');
  try {
    ctx.mcProcess.stdin.write('stop\n');
    // Safety net: if the process never closes, clear the flag after 15s
    // so a later explicit stop is allowed again.
    setTimeout(() => { ctx.isStopping = false; }, 15000);
    return { success: true };
  } catch (err) {
    ctx.isStopping = false;
    return { success: false, error: (err as Error).message };
  }
}

export function killServer(): StartResult {
  if (!ctx.mcProcess) {
    return { success: false, error: 'Server not running' };
  }
  log('Force killing server...', 'warn');
  emitConsoleSafe(`\n${COLORS.red}[SYSTEM]${COLORS.reset} Force killing server...\n`);
  pushToLogBuffer('[SYSTEM] Force killing Minecraft server...', 'error');
  try {
    ctx.mcProcess.kill('SIGKILL');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function restartServer(): StartResult {
  if (!ctx.mcProcess) {
    return { success: false, error: 'Server not running' };
  }
  ctx.restartPending = true;
  log('Restart requested', 'info');
  emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Restarting server...\n`);
  stopServer();
  return { success: true, message: 'Restart initiated' };
}

/** Send a console command to the running server (echoed into the log). */
export function sendCommand(command: string): { success: boolean; error?: string } {
  if (!ctx.mcProcess || !command || !command.trim()) {
    return { success: false, error: 'No server running or empty command' };
  }
  try {
    ctx.mcProcess.stdin.write(`${command.trim()}\n`);
    pushToLogBuffer(`$ ${command.trim()}`, 'command');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

