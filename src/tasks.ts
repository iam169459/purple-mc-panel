/**
 * tasks.ts — scheduled tasks (config/tasks.json).
 *
 * Tasks run on a 30-second heartbeat:
 *   command  -> send a console command to the running server
 *   restart  -> gracefully restart the server (if running)
 *   backup   -> create a zip backup of the configured worlds
 */

import * as fs from 'fs';
import { ctx } from './context';
import { TASKS_DB_PATH, CONFIG_DIR } from './config';
import { log } from './logger';
import { sendCommand, restartServer } from './server';
import { createBackupZip, logBackupResult } from './backups';
import type { Task } from './types';

export const HEARTBEAT_MS = 30000;

export function loadTasks(): Task[] {
  try {
    if (fs.existsSync(TASKS_DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(TASKS_DB_PATH, 'utf8'));
      if (Array.isArray(parsed)) return parsed as Task[];
    }
  } catch (err) {
    log(`Failed to load tasks: ${(err as Error).message}`, 'warn');
  }
  return [];
}

export function saveTasks(tasks: Task[]): boolean {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TASKS_DB_PATH, JSON.stringify(tasks, null, 2));
    return true;
  } catch (err) {
    log(`Failed to save tasks: ${(err as Error).message}`, 'error');
    return false;
  }
}

export function runTask(task: Task): void {
  if (task.type === 'command') {
    const result = sendCommand(task.command);
    log(`[Task] Ran command "${task.command}" — ${result.success ? 'ok' : result.error}`, 'info');
  } else if (task.type === 'restart') {
    if (ctx.mcProcess) {
      restartServer();
      log('[Task] Scheduled restart triggered', 'warn');
    } else {
      log('[Task] Restart skipped — server not running', 'warn');
    }
  } else if (task.type === 'backup') {
    createBackupZip()
      .then((name) => logBackupResult(null, name))
      .catch((err: Error) => logBackupResult(err));
  }
}

/** Start the 30s heartbeat that fires due tasks. */
export function startTaskScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    const tasks = loadTasks();
    const now = Date.now();
    let changed = false;
    for (const task of tasks) {
      if (!task.enabled) continue;
      const intervalMs = (task.intervalMinutes || 0) * 60 * 1000;
      if (intervalMs <= 0) continue;
      const lastRun = task.lastRun ? new Date(task.lastRun).getTime() : 0;
      if (now - lastRun >= intervalMs) {
        task.lastRun = new Date().toISOString();
        changed = true;
        ctx.emit('task-ran', { id: task.id, name: task.name, type: task.type });
        runTask(task);
      }
    }
    if (changed) saveTasks(tasks);
  }, HEARTBEAT_MS);
}
