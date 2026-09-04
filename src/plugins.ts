/**
 * plugins.ts — plugin marketplace.
 *
 * Search hits Modrinth first (loader-filtered so Paper/Spigot builds are
 * guaranteed) with a Spigot fallback. Installs run through a strictly
 * serialized queue so parallel browser tabs never start simultaneous
 * downloads or contend for the plugins folder.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { ctx } from './context';
import { SERVER_DIR, MODRINTH_API, SPIGET_API, GEYSERMC_DL_API, USER_AGENT, COLORS } from './config';
import { log } from './logger';
import { loadSettings, saveSettings } from './settings';
import { invalidateDiskCache } from './disk';
import { emitConsoleSafe } from './server';
import type {
  EssentialPlugin, InstalledPlugin, PluginProgressStage, PluginSearchHit, PluginSource
} from './types';

// Entries resolve through the same installer as any marketplace hit, so a
// one-click install always succeeds. Most ship Paper/Spigot builds on
// Modrinth; GeyserMC ecosystem plugins (Floodgate) use the geysermc source
// and are pulled from GeyserMC's download API instead.
export const ESSENTIAL_PLUGINS: EssentialPlugin[] = [
  { id: 'luckperms', name: 'LuckPerms', description: 'Advanced permissions management with support for groups, contexts, and extensive inheritance trees.', icon: 'https://cdn.modrinth.com/data/luckperms/icon.png', author: 'Luck', source: 'modrinth' },
  { id: 'worldedit', name: 'WorldEdit', description: 'In-game world editing utility with brushes, schematics, and millions of builds at your fingertips.', icon: 'https://cdn.modrinth.com/data/worldedit/icon.png', author: 'EngineHub', source: 'modrinth' },
  { id: 'essentialsx', name: 'EssentialsX', description: 'Essential server management featuring teleportation, economy, warps, kits, and more.', icon: 'https://cdn.modrinth.com/data/essentialsx/icon.png', author: 'EssentialsX Team', source: 'modrinth' },
  { id: 'placeholderapi', name: 'PlaceholderAPI', description: 'Flexible placeholder text system used by thousands of plugins — no more hardcoded text.', icon: 'https://cdn.modrinth.com/data/placeholderapi/icon.png', author: 'PlaceholderAPI Team', source: 'modrinth' },
  { id: 'coreprotect', name: 'CoreProtect', description: 'Fast block logging and anti-griefing. Inspect changes and roll back griefing with ease.', icon: 'https://cdn.modrinth.com/data/coreprotect/icon.png', author: 'Intelli', source: 'modrinth' },
  { id: 'geyser', name: 'Geyser', description: 'Lets Bedrock Edition players join your Java server — a full implementation of the Bedrock protocol with no extra software.', icon: 'https://cdn.modrinth.com/data/geyser/icon.png', author: 'GeyserMC', source: 'modrinth' },
  { id: 'floodgate', name: 'Floodgate', description: 'Pairs with Geyser so Bedrock players can join without a paid Java account — the server stays in online mode.', icon: 'https://cdn.modrinth.com/data/bWrNNfkb/851eeb9b5daf37baaebe7e8f25e8437735897c9c_96.webp', author: 'GeyserMC', source: 'geysermc' },
  { id: 'viaversion', name: 'ViaVersion', description: 'Allows clients on almost any Minecraft version (1.7 through the latest) to connect, whatever version the server runs.', icon: 'https://cdn.modrinth.com/data/viaversion/icon.png', author: 'ViaVersion', source: 'modrinth' }
];

const COMPATIBLE_LOADERS = ['paper', 'purpur', 'spigot', 'bukkit'];
const STABLE_RE = /(-|^)(beta|alpha|pre|rc|snapshot)/i;

type InstallProgress = {
  stage: PluginProgressStage;
  percent: number;
  message: string;
  speed: number | null;
};

function emitPluginQueue(): void {
  ctx.emit('plugin-queue', {
    active: ctx.pluginInstallQueue.length > 0 ? 1 : 0,
    queued: Math.max(ctx.pluginInstallQueue.length - 1, 0),
    queue: ctx.pluginInstallQueue.slice(0, 10)
  });
}

function emitProgressNow(pluginId: string, progress: InstallProgress): void {
  ctx.emit('plugin-progress', { pluginId, ...progress });
}

export interface InstallOutcome {
  success: boolean;
  error?: string;
  /** HTTP-ish status to surface alongside `error`. */
  status?: number;
  name?: string;
  size?: number;
  needsRestart?: boolean;
}

/** Enqueue a single install; runs strictly one at a time. */
export function installPlugin(
  resourceId: string,
  source: string,
  name: string
): Promise<InstallOutcome> {
  return new Promise((resolve) => {
    const position = ctx.pluginInstallQueue.length + 1;
    ctx.pluginInstallQueue.push(resourceId);
    emitPluginQueue();

    if (position > 1) {
      emitProgressNow(resourceId, { stage: 'queued', percent: 0, message: `Queued behind ${position - 1} install(s)...`, speed: null });
    }

    ctx.pluginInstallTail = ctx.pluginInstallTail
      .then(() => runPluginInstall(resourceId, source, name))
      .then((outcome) => {
        if (!outcome.success) {
          // Boot-time installs have no browser to show the error — make sure
          // resolution/download failures always land in the panel log.
          log(`Plugin install failed (${resourceId}): ${outcome.error ?? 'unknown error'}`, 'error');
        }
        resolve(outcome);
      })
      .catch((err: Error) => {
        // A thrown job must never break the queue.
        log(`Plugin install job error: ${err.message}`, 'error');
        resolve({ success: false, error: err.message, status: 500 });
      })
      .finally(() => {
        ctx.pluginInstallQueue = ctx.pluginInstallQueue.filter((id) => id !== resourceId);
        emitPluginQueue();
      });
  });
}

async function runPluginInstall(
  resourceId: string,
  source: string,
  name: string
): Promise<InstallOutcome> {
  const pluginsDir = path.join(SERVER_DIR, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  log(`Installing plugin from ${source}:${resourceId}`, 'info');

  let downloadUrl: string | null = null;
  let suggestedName = name || `plugin-${resourceId}.jar`;

  const emitProgress = (progress: InstallProgress): void => {
    emitProgressNow(resourceId, progress);
  };

  emitProgress({ stage: 'resolving', percent: 0, message: 'Resolving download URL...', speed: null });

  try {
    if (source === 'modrinth') {
      const resolution = await resolveModrinthBuild(resourceId, emitProgress);
      if (!resolution.ok) return { success: false, error: resolution.error, status: 404 };
      downloadUrl = resolution.url;
      suggestedName = resolution.filename;
    } else if (source === 'spigot') {
      try {
        const infoRes = await axios.get(`${SPIGET_API}/resources/${resourceId}?fields=id,name`, {
          timeout: 10000,
          headers: { 'User-Agent': USER_AGENT }
        });
        downloadUrl = `${SPIGET_API}/resources/${resourceId}/download`;
        suggestedName = `${String((infoRes.data as { name?: string }).name ?? suggestedName).replace(/[^a-zA-Z0-9._ -]/g, '_')}.jar`;
      } catch {
        emitProgress({ stage: 'error', percent: 0, message: 'Spigot resource lookup failed', speed: null });
        return { success: false, error: 'Spigot resource lookup failed', status: 502 };
      }
    } else if (source === 'geysermc') {
      // GeyserMC ecosystem plugins (Floodgate) publish Bukkit jars only
      // through their download API — "latest" tracks the newest supported
      // build. streamDownload follows the CDN redirect.
      emitProgress({ stage: 'resolving', percent: 10, message: 'Resolving GeyserMC download...', speed: null });
      downloadUrl = `${GEYSERMC_DL_API}/projects/${encodeURIComponent(resourceId)}/versions/latest/builds/latest/downloads/spigot`;
      const pretty = resourceId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, '');
      suggestedName = `${pretty || 'geysermc'}-Spigot.jar`;
    } else {
      emitProgress({ stage: 'error', percent: 0, message: 'Invalid plugin source', speed: null });
      return { success: false, error: 'Invalid source. Use "modrinth" or "spigot"', status: 400 };
    }

    if (!downloadUrl) {
      emitProgress({ stage: 'error', percent: 0, message: 'No download URL resolved', speed: null });
      return { success: false, error: 'No download URL resolved', status: 502 };
    }
    if (!suggestedName.endsWith('.jar') || suggestedName.length > 255) {
      emitProgress({ stage: 'error', percent: 0, message: 'Invalid filename generated', speed: null });
      return { success: false, error: 'Invalid filename generated', status: 400 };
    }

    const targetPath = path.join(pluginsDir, suggestedName);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

    emitProgress({ stage: 'downloading', percent: 0, message: 'Starting download...', speed: null });
    const result = await streamDownload(downloadUrl, targetPath, emitProgress);
    if (!result.ok) return { success: false, error: result.error ?? 'Download failed', status: 502 };

    emitProgress({ stage: 'verifying', percent: 100, message: 'Verifying downloaded file...', speed: null });

    const stat = fs.statSync(targetPath);
    if (stat.size < 1000) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
      emitProgress({ stage: 'error', percent: 0, message: 'Downloaded file is too small, may be corrupted', speed: null });
      return { success: false, error: 'Downloaded file is too small, may be corrupted', status: 502 };
    }

    invalidateDiskCache(); // plugins/ changed — folder sizes must refresh
    const needsRestart = !!ctx.mcProcess;
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    emitProgress({
      stage: 'complete', percent: 100,
      message: `${suggestedName} installed successfully (${sizeMB} MB)${needsRestart ? ' — restart to load' : ''}`,
      speed: null
    });
    log(`Plugin installed: ${suggestedName} (${sizeMB} MB)`, 'info');
    ctx.emit('console', `\n${COLORS.green}[PLUGIN]${COLORS.reset} Installed: ${suggestedName}\n`);
    if (needsRestart) {
      emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Restart the server to load ${suggestedName}\n`);
    }
    return { success: true, name: suggestedName, size: stat.size, needsRestart };
  } catch (err) {
    log(`Plugin install error: ${(err as Error).message}`, 'error');
    emitProgress({ stage: 'error', percent: 0, message: `Install failed: ${(err as Error).message}`, speed: null });
    return { success: false, error: (err as Error).message, status: 500 };
  }
}

// ----------------------------------------------------------------------
// Starter pack (default plugins)
// ----------------------------------------------------------------------

/** True when the plugins folder holds at least one .jar. */
export function hasInstalledPlugins(): boolean {
  const pluginsDir = path.join(SERVER_DIR, 'plugins');
  try {
    if (!fs.existsSync(pluginsDir)) return false;
    return fs.readdirSync(pluginsDir).some((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return false;
  }
}

/** Install every plugin in the curated starter pack through the queue. */
export function installStarterPack(): Promise<InstallOutcome[]> {
  log(`Enqueuing starter pack: ${ESSENTIAL_PLUGINS.map((p) => p.name).join(', ')}`, 'info');
  ctx.emit('console', `\n[PLUGIN] Installing the starter pack: ${ESSENTIAL_PLUGINS.map((p) => p.name).join(', ')}...\n`);
  const results: Promise<InstallOutcome>[] = ESSENTIAL_PLUGINS.map((p) =>
    installPlugin(p.id, p.source, p.name)
  );
  return Promise.all(results);
}

/**
 * First-boot convenience: if the plugins folder is still empty and the
 * setting is enabled, download the starter pack automatically. Only turns
 * the setting off after at least one plugin landed, so an offline first
 * boot retries on the next start.
 */
export async function maybeInstallStarterPackOnBoot(): Promise<void> {
  const settings = loadSettings();
  if (!settings.starterPackOnFirstRun) return;
  if (hasInstalledPlugins()) return; // not a fresh plugins folder

  log('Fresh plugins folder detected — downloading the starter plugin pack...', 'info');
  const outcomes = await installStarterPack();
  const okCount = outcomes.filter((o) => o.success).length;
  if (okCount > 0) {
    log(`Starter pack ready (${okCount}/${outcomes.length} installed). They load on the next server start.`, 'info');
    // One-shot: don't re-trigger on later boots.
    settings.starterPackOnFirstRun = false;
    saveSettings(settings);
  } else {
    const first = outcomes.find((o) => !o.success);
    log(`Starter pack could not be downloaded yet (${first?.error ?? 'unknown'}) — will retry on the next boot.`, 'warn');
  }
}

interface ModrinthVersion {
  version_number?: string;
  loaders?: string[];
  game_versions?: string[];
  files?: Array<{ url?: string; filename?: string }>;
}

/** Compare two Minecraft versions numerically ("1.20.4" > "1.20.2"). */
function mcVersionGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Newest-first ordering, stable builds preferred over pre-releases. */
function pickBest(versions: ModrinthVersion[]): ModrinthVersion | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => {
    const s = STABLE_RE.test(a.version_number ?? '') ? 1 : 0;
    const t = STABLE_RE.test(b.version_number ?? '') ? 1 : 0;
    if (s !== t) return s - t;
    return 0; // API already returns newest-first; keep that order
  });
  return sorted[0] ?? null;
}

/**
 * Pick the newest stable Paper-compatible build for the configured
 * Minecraft version. Exact game-version match first, then the newest
 * build whose LOWEST claimed Minecraft version still reaches the target
 * (many projects tag releases sparsely), then any loader-compatible build.
 */
async function resolveModrinthBuild(
  resourceId: string,
  emitProgress: (p: InstallProgress) => void
): Promise<{ ok: true; url: string; filename: string } | { ok: false; error: string }> {
  let versions: ModrinthVersion[] = [];
  try {
    const vRes = await axios.get(`${MODRINTH_API}/project/${resourceId}/version`, {
      params: { loaders: JSON.stringify(COMPATIBLE_LOADERS) },
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT }
    });
    versions = (vRes.data as ModrinthVersion[]) ?? [];
  } catch (verErr) {
    log(`Modrinth version lookup failed for ${resourceId}: ${(verErr as Error).message}`, 'warn');
  }

  const serverSettings = loadSettings();
  const targetVer = (serverSettings.serverVersion || '').trim();

  const isPluginBuild = (v: ModrinthVersion): boolean => {
    const url = v.files?.[0]?.url;
    if (!url) return false;
    const loaders = (v.loaders ?? []).map((l) => l.toLowerCase());
    return loaders.some((l) => COMPATIBLE_LOADERS.includes(l));
  };
  const pluginBuilds = versions.filter(isPluginBuild);

  let best: ModrinthVersion | null = null;
  if (targetVer) {
    // 1) A build that explicitly supports the configured version.
    best = pickBest(pluginBuilds.filter((v) => (v.game_versions ?? []).includes(targetVer)));
    // 2) A build whose declared minimum Minecraft version reaches the target.
    if (!best) {
      const reachesTarget = pluginBuilds.filter((v) => {
        const versionsList = (v.game_versions ?? []).filter(Boolean);
        if (versionsList.length === 0) return false;
        const min = versionsList.reduce((lo, cur) => (mcVersionGt(lo, cur) ? cur : lo));
        return !mcVersionGt(min, targetVer); // min <= target
      });
      best = pickBest(reachesTarget);
    }
  }
  // 3) Fall back to the newest compatible build when nothing claims support.
  if (!best) best = pickBest(pluginBuilds);

  if (!best) {
    // Explain WHY resolution failed so the user can act on it.
    const loaderSet = new Set<string>();
    for (const v of versions) {
      for (const l of (v.loaders ?? [])) loaderSet.add(l);
    }
    const loaderList = [...loaderSet].slice(0, 5).join(', ');
    const msg = versions.length === 0
      ? 'This plugin has no downloadable versions on Modrinth.'
      : `This plugin has no Paper/Spigot build on Modrinth (only: ${loaderList || 'other loaders'}). Try searching Spigot instead.`;
    emitProgress({ stage: 'error', percent: 0, message: msg, speed: null });
    return { ok: false, error: msg };
  }

  const url = best.files?.[0]?.url;
  if (!url) return { ok: false, error: 'Resolved build has no download URL' };
  return { ok: true, url, filename: best.files?.[0]?.filename ?? `plugin-${resourceId}.jar` };
}

/** Stream a plugin jar to disk with live progress + stall detection. */
function streamDownload(
  downloadUrl: string,
  targetPath: string,
  emitProgress: (p: InstallProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    (async () => {
      try {
        const response = await axios({
          method: 'GET', url: downloadUrl, responseType: 'stream',
          timeout: 120000, maxRedirects: 5,
          headers: { 'User-Agent': USER_AGENT }
        });
        const contentLength = Number(response.headers['content-length']) || 0;
        const startTime = Date.now();
        let downloadedBytes = 0;
        let lastEmitTime = 0;
        let lastEmitBytes = 0;
        const writer = fs.createWriteStream(targetPath);

        // Abort the transfer if the upstream stalls for 60s.
        let stalledTimer: NodeJS.Timeout | null = setTimeout(() => {
          response.data.destroy(new Error('Download stalled — no data received for 60s'));
        }, 60000);

        const pushProgress = (force: boolean): void => {
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
          emitProgress({ stage: 'downloading', percent, message: `Downloading... ${msg}`, speed: speedMBps });
          lastEmitBytes = downloadedBytes;
          lastEmitTime = now;
        };

        response.data.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (stalledTimer) clearTimeout(stalledTimer);
          stalledTimer = setTimeout(() => {
            response.data.destroy(new Error('Download stalled — no data received for 60s'));
          }, 60000);
          if (Date.now() - lastEmitTime >= 1000) pushProgress(false);
        });

        response.data.pipe(writer);

        await new Promise<void>((resolveWrite, rejectWrite) => {
          response.data.on('error', (err: Error) => {
            if (stalledTimer) clearTimeout(stalledTimer);
            try { writer.destroy(); } catch { /* ignore */ }
            try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
            rejectWrite(new Error(`Download error: ${err.message}`));
          });
          writer.on('finish', () => {
            if (stalledTimer) clearTimeout(stalledTimer);
            pushProgress(true); // final readout before verify
            resolveWrite();
          });
          writer.on('error', (err) => {
            if (stalledTimer) clearTimeout(stalledTimer);
            try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
            rejectWrite(new Error(`Write failed: ${err.message}`));
          });
        });

        resolve({ ok: true });
      } catch (err) {
        emitProgress({ stage: 'error', percent: 0, message: `Install failed: ${(err as Error).message}`, speed: null });
        resolve({ ok: false, error: (err as Error).message });
      }
    })();
  });
}

export function listInstalledPlugins(): InstalledPlugin[] {
  const pluginsDir = path.join(SERVER_DIR, 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  try {
    return fs.readdirSync(pluginsDir)
      .filter((f) => f.endsWith('.jar'))
      .map((f) => {
        const stat = fs.statSync(path.join(pluginsDir, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      });
  } catch (err) {
    log(`List installed plugins error: ${(err as Error).message}`, 'error');
    throw err;
  }
}

interface SpigetSearchItem {
  id: string | number;
  name: string;
  tag?: string;
  description?: string;
  icon?: { url?: string } | string | null;
  downloads?: number;
  likes?: number;
  premium?: boolean;
  price?: number | { amount?: number };
  version?: string;
  author?: { name?: string };
  file?: unknown;
}

export async function searchPlugins(
  query: string,
  page = 1,
  perPage = 24
): Promise<{ query: string; page: number; perPage: number; count: number; plugins: PluginSearchHit[] }> {
  const maxResults = Math.min(parseInt(String(perPage), 10) || 24, 48);
  const pageNum = Math.max(parseInt(String(page), 10) || 1, 1);
  log(`Plugin search: "${query}" page ${pageNum}`, 'info');

  let plugins: PluginSearchHit[] = [];

  // Primary source: Modrinth API with proper facets filtering.
  try {
    const mrRes = await axios.get(`${MODRINTH_API}/search`, {
      params: {
        query: query.trim(),
        offset: (pageNum - 1) * maxResults,
        limit: maxResults,
        facets: JSON.stringify([['project_type:plugin']])
      },
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT }
    });

    const hits: any[] = mrRes.data?.hits ?? [];
    if (hits.length > 0) {
      const versionPromises = hits.slice(0, maxResults).map(async (p: any): Promise<PluginSearchHit | null> => {
        try {
          const vRes = await axios.get(`${MODRINTH_API}/project/${p.project_id}/version`, {
            params: { loaders: JSON.stringify(COMPATIBLE_LOADERS) },
            timeout: 5000,
            headers: { 'User-Agent': USER_AGENT }
          });
          const versions: ModrinthVersion[] = (vRes.data ?? []) as ModrinthVersion[];
          const found = versions.find((v) => v.files?.[0]?.url) ?? null;
          return {
            id: p.project_id,
            name: p.title ?? 'Unknown',
            tag: p.slug ?? '',
            description: p.description ? String(p.description).substring(0, 200) : '',
            icon: p.icon_url ?? null,
            downloads: p.downloads ?? 0,
            likes: 0,
            premium: false,
            price: 0,
            version: found?.version_number ?? 'N/A',
            author: p.author ?? 'Unknown',
            source: 'modrinth' as PluginSource,
            downloadUrl: found?.files?.[0]?.url ?? null
          };
        } catch {
          return null;
        }
      });
      const results = await Promise.all(versionPromises);
      plugins = results.filter((p): p is PluginSearchHit => !!p && !!p.downloadUrl);
    }
  } catch (err) {
    log(`Modrinth search failed: ${(err as Error).message}`, 'warn');
  }

  // Fallback: Spiget API when Modrinth returns no results.
  if (plugins.length === 0) {
    try {
      const spigetUrl = `${SPIGET_API}/search/resources/${encodeURIComponent(query.trim())}?page=${pageNum - 1}&size=${maxResults}&fields=id,name,tag,description,icon,downloads,likes,premium,price,version,author,file`;
      const spRes = await axios.get(spigetUrl, { timeout: 10000, headers: { 'User-Agent': USER_AGENT } });
      plugins = ((spRes.data ?? []) as SpigetSearchItem[]).map((p): PluginSearchHit => ({
        id: String(p.id),
        name: p.name ?? 'Unknown Plugin',
        tag: p.tag ?? '',
        description: p.description ? String(p.description).replace(/<[^>]*>/g, '').substring(0, 200) : '',
        icon: p.icon ? (typeof p.icon === 'string' ? p.icon : (p.icon.url ?? null)) : null,
        downloads: p.downloads ?? 0,
        likes: p.likes ?? 0,
        premium: p.premium ?? false,
        price: typeof p.price === 'object' ? (p.price.amount ?? 0) : (p.price ?? 0),
        version: p.version ?? 'N/A',
        author: p.author?.name ?? 'Unknown',
        source: 'spigot',
        downloadUrl: p.file ? `${SPIGET_API}/resources/${p.id}/download` : null
      })).filter((p) => p.downloadUrl);
    } catch (spErr) {
      log(`Spigot fallback search failed: ${(spErr as Error).message}`, 'warn');
    }
  }

  return {
    query,
    page: pageNum,
    perPage: maxResults,
    count: plugins.length,
    plugins
  };
}
