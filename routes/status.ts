/**
 * routes/status.ts — status, usage, system, disk breakdown, crash log.
 */

import * as fs from 'fs';
import * as os from 'os';
import type { Express, Request, Response } from 'express';
import { ctx, sendError } from '../src/context';
import { SERVER_DIR, CRASH_LOG_PATH, DEFAULT_RAM } from '../src/config';
import { loadSettings } from '../src/settings';
import { getDiskUsage, getDiskBreakdown } from '../src/disk';
import { getProcessStats, getSystemMetrics, calculateRecommendedRam } from '../src/metrics';
import type { CrashLogEntry } from '../src/types';

export function register(app: Express): void {
  app.get('/api/status', async (_req: Request, res: Response) => {
    const stats = await getProcessStats();
    const disk = getDiskUsage(SERVER_DIR);
    const settings = loadSettings();
    res.json({
      running: !!ctx.mcProcess,
      pid: ctx.processPid,
      uptime: stats.uptime,
      cpu: stats.cpu,
      memory: stats.memory,
      players: ctx.onlinePlayers,
      disk,
      allocation: {
        maxRam: settings.autoResource ? calculateRecommendedRam() : (settings.maxRam || DEFAULT_RAM),
        autoResource: settings.autoResource
      }
    });
  });

  app.get('/api/server/usage', async (_req: Request, res: Response) => {
    try {
      const processStats = await getProcessStats();
      const sysMetrics = getSystemMetrics();
      const diskUsage = getDiskUsage(SERVER_DIR);
      const settings = loadSettings();
      res.json({
        process: {
          cpu: processStats.cpu,
          memory: processStats.memory,
          uptime: processStats.uptime,
          running: !!ctx.mcProcess,
          pid: ctx.processPid
        },
        system: sysMetrics,
        disk: diskUsage,
        allocation: {
          maxRam: settings.autoResource ? calculateRecommendedRam() : (settings.maxRam || DEFAULT_RAM),
          javaPath: settings.javaPath || 'java',
          autoResource: settings.autoResource
        }
      });
    } catch (err) {
      sendError(res, (err as Error).message, 500);
    }
  });

  app.get('/api/server/disk-breakdown', (_req: Request, res: Response) => {
    const breakdown = getDiskBreakdown();
    const total = getDiskUsage(SERVER_DIR);
    res.json({ success: true, total, folders: breakdown });
  });

  app.get('/api/system', (_req: Request, res: Response) => {
    const totalMem = os.totalmem();
    res.json({
      cpu: { cores: os.cpus().length, load: os.loadavg() },
      memory: { total: totalMem, free: os.freemem(), used: totalMem - os.freemem() },
      uptime: os.uptime()
    });
  });

  app.get('/api/system/resources', (_req: Request, res: Response) => {
    const metrics = getSystemMetrics();
    const recommended = calculateRecommendedRam();
    const settings = loadSettings();
    res.json({
      success: true,
      system: metrics,
      recommended: { maxRam: recommended },
      allocation: {
        mode: settings.autoResource ? 'auto' : 'manual',
        currentMaxRam: settings.maxRam || DEFAULT_RAM,
        recommendedMaxRam: recommended
      }
    });
  });

  app.get('/api/crash-log', (_req: Request, res: Response) => {
    try {
      if (fs.existsSync(CRASH_LOG_PATH)) {
        const raw = fs.readFileSync(CRASH_LOG_PATH, 'utf8').trim();
        if (raw) {
          const logs = JSON.parse(raw);
          return res.json({ success: true, logs: Array.isArray(logs) ? (logs as CrashLogEntry[]) : [] });
        }
      }
      res.json({ success: true, logs: [] });
    } catch {
      res.json({ success: true, logs: [] });
    }
  });

  app.post('/api/crash-log/clear', (_req: Request, res: Response) => {
    try {
      fs.writeFileSync(CRASH_LOG_PATH, '[]', 'utf8');
      res.json({ success: true });
    } catch {
      sendError(res, 'Failed to clear crash log', 400);
    }
  });
}
