/**
 * metrics.ts — process stats (pidusage), system metrics (os), and
 * automatic RAM recommendations.
 */

import * as os from 'os';
import pidusage from 'pidusage';
import { ctx } from './context';
import { DEFAULT_RAM } from './config';
import type { ProcessStats, SystemMetrics } from './types';

export async function getProcessStats(): Promise<ProcessStats> {
  if (!ctx.processPid) return { cpu: 0, memory: 0, uptime: 0 };
  try {
    const stats = await pidusage(ctx.processPid);
    return {
      cpu: Math.round(stats.cpu),
      memory: Math.round(stats.memory / 1024 / 1024),
      uptime: ctx.serverStartTime ? Math.floor((Date.now() - ctx.serverStartTime) / 1000) : 0
    };
  } catch {
    return { cpu: 0, memory: 0, uptime: 0 };
  }
}

export function getSystemMetrics(): SystemMetrics {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    const gb = (bytes: number): number => Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
    const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

    return {
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model ?? 'Unknown',
        loadAvg1m: Math.round(loadAvg[0] * 100) / 100,
        loadAvg5m: Math.round(loadAvg[1] * 100) / 100,
        loadAvg15m: Math.round(loadAvg[2] * 100) / 100
      },
      ram: {
        totalBytes: totalMem, totalMB: mb(totalMem), totalGB: gb(totalMem),
        freeBytes: freeMem, freeMB: mb(freeMem), freeGB: gb(freeMem),
        usedBytes: usedMem, usedMB: mb(usedMem), usedGB: gb(usedMem),
        usagePercent: Math.round((usedMem / totalMem) * 100)
      },
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: os.uptime(),
      type: os.type()
    };
  } catch (err) {
    return { error: (err as Error).message } as SystemMetrics;
  }
}

/** Recommend ~75% of physical RAM (min 1G) for the Minecraft heap. */
export function calculateRecommendedRam(): string {
  try {
    const totalGB = Math.floor(os.totalmem() / 1024 / 1024 / 1024);
    if (totalGB <= 1) return '1G';
    const recommended = Math.max(1, Math.floor(totalGB * 0.75));
    return `${recommended}G`;
  } catch {
    return DEFAULT_RAM;
  }
}
