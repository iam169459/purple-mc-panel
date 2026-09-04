/**
 * updater.ts — GitHub self-update engine (version.json driven).
 *
 * The panel updates itself by downloading the latest source archive from
 * GitHub. Version comparison uses version.json — the same file that lives
 * in this install and at the repository root — so updates work with or
 * without a local git clone. Protected directories (server/, config/,
 * backups/, node_modules/, .git/, .env) are never touched.
 *
 * Because the panel now ships TypeScript source (server) plus a Vite-built
 * React client, the pipeline recompiles everything after files are
 * installed so a fresh `npm start` always runs current code.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import axios from 'axios';
import { ctx } from './context';
import {
  ROOT_DIR, VERSION_FILE, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH,
  GIT_REMOTE_URL, UPDATE_RAW_URL, UPDATE_ARCHIVE_URL, UPDATE_PROTECTED,
  UPDATE_CHECK_TTL, CURRENT_VERSION, USER_AGENT
} from './config';
import { log } from './logger';
import { downloadFile } from './download';
import { requestShutdown } from './shutdown';
import type { UpdateCheckPayload } from './types';

// ------------------------------------------------------------------
// Version helpers
// ------------------------------------------------------------------

export function normalizeVersion(v: unknown): string | null {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  return s || null;
}

/** Numeric dotted comparison (1.0.10 > 1.0.9). Returns -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    normalizeVersion(v)?.split('.').map((n) => parseInt(n, 10) || 0) ?? [0];
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function parseVersionJson(text: unknown): string | null {
  // Handles both raw file strings and already-parsed objects
  // (axios auto-JSON-parses its responses).
  if (typeof text === 'object' && text !== null) {
    const data = text as { version?: unknown; latest?: unknown; build?: unknown };
    const v = normalizeVersion(data.version ?? data.latest ?? data.build);
    if (v) return v;
    return null;
  }
  try {
    const data = JSON.parse(String(text));
    const v = normalizeVersion(data?.version ?? data?.latest ?? data?.build);
    if (v) return v;
  } catch {
    /* fall through to the regex */
  }
  const m = String(text ?? '').match(/(\d+(?:\.\d+){1,3})/);
  return m ? m[1] : null;
}

/** The version of this install: version.json → package.json → hardcoded fallback. */
export function getLocalVersion(): string {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      const v = parseVersionJson(fs.readFileSync(VERSION_FILE, 'utf8'));
      if (v) return v;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version?: string };
    const v = normalizeVersion(pkg.version);
    if (v) return v;
  } catch { /* ignore */ }
  return CURRENT_VERSION;
}

export function emitUpdateEvent(level: 'system' | 'info' | 'warn' | 'error' | 'success', text: string): void {
  try {
    ctx.io?.emit('update-progress', { text, level, timestamp: new Date().toISOString() });
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------
// Remote version resolution
// ------------------------------------------------------------------

function rawVersionUrl(branch: string): string {
  if (UPDATE_RAW_URL) return UPDATE_RAW_URL;
  return `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/version.json`;
}

function archiveUrl(branch: string): string {
  if (UPDATE_ARCHIVE_URL) return UPDATE_ARCHIVE_URL;
  return `https://codeload.github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tar.gz/refs/heads/${branch}`;
}

/** Fetches { version, branch } for one branch, or null when unreachable/404. */
async function fetchRemoteVersion(branch: string): Promise<{ version: string; branch: string } | null> {
  try {
    const res = await axios.get(rawVersionUrl(branch), {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
      validateStatus: (s) => s >= 200 && s < 300
    });
    const version = parseVersionJson(res.data);
    return version ? { version, branch } : null;
  } catch (err) {
    log(`fetchRemoteVersion(${branch}) failed: ${(err as Error).message}`, 'warn');
    return null;
  }
}

/** Resolves the live remote version (last-known branch, then main, then master). */
export async function resolveRemoteVersion(): Promise<{ version: string; branch: string } | null> {
  const candidates: string[] = [];
  if (ctx.lastKnownBranch) candidates.push(ctx.lastKnownBranch);
  for (const b of [GITHUB_BRANCH, 'master']) {
    if (!candidates.includes(b)) candidates.push(b);
  }
  for (const branch of candidates) {
    const remote = await fetchRemoteVersion(branch);
    if (remote) {
      ctx.lastKnownBranch = branch;
      return remote;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Check
// ------------------------------------------------------------------

export async function buildUpdateCheckPayload(branchOverride?: string): Promise<UpdateCheckPayload> {
  const now = Date.now();
  // Only use cache when no branch override is specified
  if (!branchOverride && ctx.updateCheckCache && now - ctx.updateCheckCache.at < UPDATE_CHECK_TTL) {
    return { ...ctx.updateCheckCache.payload, fromCache: true };
  }

  const currentVersion = getLocalVersion();
  let remote: { version: string; branch: string } | null = null;
  if (branchOverride) {
    remote = await fetchRemoteVersion(branchOverride);
  } else {
    remote = await resolveRemoteVersion();
  }
  const newer = remote ? compareVersions(remote.version, currentVersion) : 0;

  const payload: UpdateCheckPayload = {
    method: 'github',
    source: 'version.json',
    gitRepoUrl: GIT_REMOTE_URL,
    branch: remote ? remote.branch : (branchOverride ?? ctx.lastKnownBranch ?? GITHUB_BRANCH),
    checkedAt: new Date().toISOString(),
    currentVersion,
    latestVersion: remote ? remote.version : currentVersion,
    updateAvailable: newer > 0,
    checkBlocked: !remote,
    message: !remote
      ? 'Could not fetch version.json from the GitHub repository. Push version.json to the repo (main or master) and make sure the panel can reach the network.'
      : newer === 0
        ? `This install matches the repository (v${currentVersion}) on branch ${remote.branch}.`
        : newer < 0
          ? `The repository is at v${remote.version} on branch ${remote.branch} — older than this install (v${currentVersion}). No downgrade performed.`
          : `A newer release (v${remote.version}) is available on branch ${remote.branch}.`
  };
  if (!branchOverride) ctx.updateCheckCache = { at: now, payload };
  return payload;
}

// ------------------------------------------------------------------
// Install pipeline
// ------------------------------------------------------------------

function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'ignore' });
    child.on('error', () => reject(new Error('tar could not be started — this system needs the tar utility to install updates.')));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Archive extraction failed (tar exit code ${code}).`)));
  });
}

function findStagedRoot(stageDir: string): string | null {
  try {
    for (const entry of fs.readdirSync(stageDir)) {
      const p = path.join(stageDir, entry);
      if (!fs.statSync(p).isDirectory()) continue;
      if (fs.existsSync(path.join(p, 'package.json')) && fs.existsSync(path.join(p, 'version.json'))) return p;
    }
  } catch { /* fall through */ }
  return null;
}

function filesDiffer(aPath: string, bPath: string): boolean {
  try {
    return fs.readFileSync(aPath, 'utf8') !== fs.readFileSync(bPath, 'utf8');
  } catch {
    return true;
  }
}

function runNpm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    child.stdout.on('data', (c) => { tail = (tail + c.toString()).slice(-400); });
    child.stderr.on('data', (c) => { tail = (tail + c.toString()).slice(-400); });
    child.on('error', () => reject(new Error(`npm could not be started while running "${args[0]}".`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`npm ${args[0]} failed (exit code ${code}). ${tail.split('\n').slice(-3).join(' ')}`));
    });
  });
}

function restartPanel(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.env.pm_id !== undefined || process.env.PM2_HOME) {
      // Under PM2, exit through the graceful-shutdown path so a running
      // Minecraft server is stopped (world saved) instead of orphaned
      // mid-session; the non-zero exit makes PM2 auto-restart the panel
      // with the freshly-installed code.
      log('Panel runs under PM2 — shutting down for automatic restart with the new version', 'info');
      requestShutdown('self-update restart');
      resolve(true);
      return;
    }
    const child = spawn('pm2', ['restart', 'purple-mc-panel'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function runGithubUpdate(branchOverride?: string): Promise<void> {
  const stageBase = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-update-'));
  const archivePath = path.join(stageBase, 'source.tar.gz');

  try {
    // ── 1 · resolve remote version from version.json ──────────────────
    emitUpdateEvent('system', '[STEP 1] Checking version.json against the GitHub repository...');
    let remote: { version: string; branch: string } | null = null;
    if (branchOverride) {
      remote = await fetchRemoteVersion(branchOverride);
    } else {
      remote = await resolveRemoteVersion();
    }
    if (!remote) throw new Error('Could not fetch version.json from GitHub — the update was not installed.');
    const currentVersion = getLocalVersion();
    const cmp = compareVersions(remote.version, currentVersion);
    if (cmp === 0) throw new Error(`No newer version available — the repository is at v${remote.version}, same as this install.`);
    if (cmp < 0) throw new Error(`Repository version v${remote.version} is older than this install (v${currentVersion}). Refusing to downgrade.`);
    emitUpdateEvent('info', `[STEP 1] v${currentVersion} → v${remote.version} on branch ${remote.branch} — updating.`);

    // ── 2 · download the source archive ───────────────────────────────
    emitUpdateEvent('system', '[STEP 2] Downloading the latest source from GitHub...');
    let lastProgress = 0;
    await downloadFile(archiveUrl(remote.branch), archivePath, (got, total) => {
      const now = Date.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      const pct = total > 0 ? Math.round((got / total) * 100) : Math.round(got / 1024);
      emitUpdateEvent('info', `[STEP 2] ${total > 0 ? `${pct}%` : `${got} bytes downloaded`}`);
    });

    // ── 3 · extract and validate ──────────────────────────────────────
    emitUpdateEvent('system', '[STEP 3] Extracting and validating the archive...');
    await extractTarGz(archivePath, stageBase);
    const stageRoot = findStagedRoot(stageBase);
    if (!stageRoot) throw new Error('Downloaded archive does not look like the panel source (package.json / version.json missing). Nothing was changed.');
    const stagedVersion = parseVersionJson(fs.readFileSync(path.join(stageRoot, 'version.json'), 'utf8')) || remote.version;
    emitUpdateEvent('info', `[STEP 3] Archive verified — staged version ${stagedVersion}.`);

    // ── 4 · install new files, preserving runtime data ────────────────
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

    // ── 5 · dependencies (only when package files changed) ────────────
    if (filesDiffer(path.join(ROOT_DIR, 'package.json'), path.join(stageRoot, 'package.json'))) {
      emitUpdateEvent('system', '[STEP 5] Package files changed — installing dependencies (can take a minute)...');
      await runNpm(['install', '--no-audit', '--no-fund']);
    } else {
      emitUpdateEvent('info', '[STEP 5] Dependencies unchanged — skipping npm install.');
    }

    // ── 6 · rebuild server + client so the new code actually runs ─────
    emitUpdateEvent('system', '[STEP 6] Rebuilding server and client bundles...');
    try {
      await runNpm(['run', 'build']);
      emitUpdateEvent('success', '[STEP 6] Build completed.');
    } catch (err) {
      throw new Error(`Build after update failed: ${(err as Error).message}. The new files are in place — run "npm run build" manually, then restart the panel.`);
    }
    try { if (fs.existsSync(path.join(ROOT_DIR, 'install.sh'))) fs.chmodSync(path.join(ROOT_DIR, 'install.sh'), 0o755); } catch { /* ignore */ }

    // ── 7 · restart the panel ─────────────────────────────────────────
    emitUpdateEvent('system', '[STEP 7] Restarting the panel to load the new version...');
    const restarted = await restartPanel();
    const doneMsg = `Update applied — now running v${stagedVersion}.`;
    emitUpdateEvent('success', '[GIT SUCCESS] ' + doneMsg);
    try {
      ctx.io?.emit('update-complete', {
        success: true,
        message: restarted
          ? `${doneMsg} The panel is restarting.`
          : `${doneMsg} Restart the panel process (pm2 restart purple-mc-panel) to finish.`
      });
    } catch { /* ignore */ }
  } finally {
    try { fs.rmSync(stageBase, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
