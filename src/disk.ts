/**
 * disk.ts — storage analytics.
 *
 * Recursive folder sizing with a short-TTL cache, per-folder breakdown
 * of the server directory, and host filesystem free space. The cache is
 * invalidated by the file manager whenever files change.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ctx } from './context';
import { SERVER_DIR, DISK_CACHE_TTL } from './config';
import { log } from './logger';
import type { DiskUsage, HostDiskInfo } from './types';

/** Recursive size/count of a directory. Cached for DISK_CACHE_TTL ms. */
export function getDiskUsage(dirPath: string): DiskUsage {
  const key = path.resolve(dirPath);
  const now = Date.now();
  const cached = ctx.diskCache.get(key);
  if (cached && now - (cached.time as number) < DISK_CACHE_TTL) {
    return cached.result as DiskUsage;
  }

  try {
    const totalSize = { bytes: 0 };
    const counts = { files: 0, dirs: 0 };

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // permission errors → skip subtree
      }
      for (const entry of entries) {
        try {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            counts.dirs++;
            walk(full);
          } else if (entry.isFile()) {
            counts.files++;
            totalSize.bytes += fs.statSync(full).size;
          }
        } catch {
          /* inaccessible entry — skip */
        }
      }
    };

    walk(dirPath);

    const result: DiskUsage = {
      totalBytes: totalSize.bytes,
      totalMB: Math.round((totalSize.bytes / 1024 / 1024) * 100) / 100,
      totalGB: Math.round((totalSize.bytes / 1024 / 1024 / 1024) * 100) / 100,
      fileCount: counts.files,
      dirCount: counts.dirs
    };
    ctx.diskCache.set(key, { result, time: now });
    return result;
  } catch (err) {
    return { totalBytes: 0, totalMB: 0, totalGB: 0, fileCount: 0, dirCount: 0, error: (err as Error).message };
  }
}

/** One-time (uncached) stat of a single file. */
export function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * getDiskBreakdown — size statistics for each top-level directory inside
 * the server folder (world, plugins, logs, ...) sorted largest-first.
 */
export function getDiskBreakdown(): Array<DiskUsage & { name: string }> {
  const breakdown: Array<DiskUsage & { name: string }> = [];
  try {
    const entries = fs.readdirSync(SERVER_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(SERVER_DIR, entry.name);
      const usage = getDiskUsage(fullPath);
      if (usage && !usage.error) {
        breakdown.push({ name: entry.name, ...usage });
      }
    }
  } catch (err) {
    log(`Disk breakdown error: ${(err as Error).message}`, 'warn');
  }
  return breakdown.sort((a, b) => b.totalBytes - a.totalBytes);
}

/**
 * getHostDiskInfo — free/total bytes of the filesystem hosting the
 * server directory. Returns null when unsupported so callers can
 * degrade gracefully.
 */
export function getHostDiskInfo(): HostDiskInfo | null {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number } }).statfsSync;
    if (typeof statfs !== 'function') return null;
    const s = statfs(SERVER_DIR);
    if (!s || !s.bsize) return null;
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedBytes = totalBytes - freeBytes;
    const gb = (b: number): number => Math.round((b / 1024 / 1024 / 1024) * 100) / 100;
    return {
      totalBytes, freeBytes, usedBytes,
      totalGB: gb(totalBytes), freeGB: gb(freeBytes),
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
    };
  } catch {
    return null;
  }
}

/** Drop the size cache after any mutation under the server directory. */
export function invalidateDiskCache(): void {
  ctx.diskCache.clear();
}
