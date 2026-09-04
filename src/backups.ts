/**
 * backups.ts — zip backups of worlds + plugins via the system `zip`
 * utility, with retention pruning for scheduled backups.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ctx } from './context';
import { BACKUPS_DIR, SERVER_DIR, COLORS } from './config';
import { log } from './logger';
import { loadSettings } from './settings';
import type { BackupInfo } from './types';

const SAFE_NAME = /^[a-zA-Z0-9._-]+\.zip$/;

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  try {
    return fs.readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, size: Math.round(stat.size / 1024 / 1024), date: stat.mtime };
      })
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  } catch {
    return [];
  }
}

/**
 * Create a zip backup of the configured worlds + plugins. Only paths that
 * actually exist are zipped — a brand-new server has no world/ folder yet,
 * and zip exits with "Nothing to do!" (code 12) when handed only missing
 * inputs, which made backups fail mysteriously.
 */
export function createBackupZip(): Promise<string> {
  return new Promise((resolve, reject) => {
    const backupName = `backup-${Date.now()}.zip`;
    const backupPath = path.join(BACKUPS_DIR, backupName);
    const s = loadSettings();
    const worlds = (s.backupWorlds || 'world').split(',').map((w) => w.trim()).filter(Boolean);

    const targets: string[] = [];
    for (const t of [...worlds, 'plugins', 'server.properties']) {
      const safe = String(t).replace(/^\/+|\/+$/g, '').replace(/\/\//g, '/');
      if (!safe || safe.includes('..')) continue;
      if (fs.existsSync(path.join(SERVER_DIR, safe))) targets.push(safe);
    }
    if (targets.length === 0) {
      reject(new Error('Nothing to back up yet — no world folder or plugins found. Start the server once to generate a world.'));
      return;
    }

    const args = ['-r', backupPath, ...targets];
    const child = spawn('zip', args, { cwd: SERVER_DIR, stdio: 'ignore' });

    child.on('error', (err) => {
      reject(new Error(`Backup failed — the 'zip' utility is not installed on this system (${err.message})`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        pruneBackups(); // Prune excess after creation
        resolve(backupName);
      } else {
        reject(new Error(`Backup failed (zip exit code ${code})`));
      }
    });
  });
}

export function deleteBackup(name: string): { success: boolean; error?: string } {
  if (!SAFE_NAME.test(name)) {
    return { success: false, error: 'Invalid backup name' };
  }
  const backupPath = path.resolve(BACKUPS_DIR, name);
  if (!backupPath.startsWith(path.resolve(BACKUPS_DIR) + path.sep)) {
    return { success: false, error: 'Invalid path' };
  }
  try {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
      return { success: true };
    }
    return { success: false, error: 'Not found' };
  } catch {
    return { success: false, error: 'Failed to delete backup' };
  }
}

/** Retention pruning — remove the oldest backups beyond backupMaxKeep. */
export function pruneBackups(): void {
  const s = loadSettings();
  if (!s.backupEnabled) return;
  if (!fs.existsSync(BACKUPS_DIR)) return;

  const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.zip'));
  const maxKeep = s.backupMaxKeep || 7;

  if (files.length >= maxKeep) {
    const sorted = files
      .map((f) => ({ name: f, time: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    while (sorted.length >= maxKeep) {
      const oldest = sorted.pop();
      if (oldest) {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, oldest.name)); } catch { /* ignore */ }
      }
    }
  }
}

/** Emit a friendly console message for scheduled backup results. */
export function logBackupResult(err: Error | null, backupName?: string): void {
  log(`[Task] Scheduled backup ${err ? `failed: ${err.message}` : `completed: ${backupName}`}`, err ? 'error' : 'info');
  ctx.emit('console', `\n${COLORS.cyan}[TASK]${COLORS.reset} Scheduled backup ${err ? 'failed' : `completed: ${backupName}`}\n`);
}
