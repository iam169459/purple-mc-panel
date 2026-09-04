/**
 * sockets.ts — Socket.IO wiring.
 *
 * Client connect → replay console history + current status. Clients drive
 * the server with `action` / `command` / `locate-player`. A 2-second
 * telemetry loop pushes CPU/RAM/disk stats while anyone is connected.
 */

import { Server, type Socket } from 'socket.io';
import { ctx } from './context';
import { SERVER_DIR, DEFAULT_RAM } from './config';
import { log } from './logger';
import { loadSettings } from './settings';
import { getDiskUsage } from './disk';
import { getSystemMetrics, calculateRecommendedRam } from './metrics';
import { getConsoleHistory } from './console-buffer';
import { startServer, stopServer, killServer, restartServer, sendCommand } from './server';
import type { ServerStatsSnapshot } from './types';

export const STATS_INTERVAL_MS = 2000;

/** Socket events that this panel uses; payload types live in ./types. */
export const SOCKET_EVENTS = {
  console: 'console',
  consoleHistory: 'console-history',
  status: 'status',
  stats: 'stats',
  tps: 'tps',
  players: 'players',
  playerLocation: 'player-location',
  pluginQueue: 'plugin-queue',
  pluginProgress: 'plugin-progress',
  taskRan: 'task-ran',
  updateProgress: 'update-progress',
  updateComplete: 'update-complete'
} as const;

async function buildStatsSnapshot(): Promise<ServerStatsSnapshot> {
  const settings = loadSettings();
  const recommended = calculateRecommendedRam();
  const maxRam = settings.autoResource ? recommended : (settings.maxRam || DEFAULT_RAM);
  try {
    if (ctx.mcProcess && ctx.processPid) {
      const pidusage = (await import('pidusage')).default;
      const stats = await pidusage(ctx.processPid);
      return {
        cpu: Math.round(stats.cpu),
        memory: Math.round(stats.memory / 1024 / 1024),
        uptime: ctx.serverStartTime ? Math.floor((Date.now() - ctx.serverStartTime) / 1000) : 0,
        disk: getDiskUsage(SERVER_DIR),
        system: getSystemMetrics(),
        allocation: { maxRam, recommended, autoResource: settings.autoResource }
      };
    }
    return {
      cpu: 0, memory: 0, uptime: 0, disk: null,
      system: getSystemMetrics(),
      allocation: { maxRam, recommended, autoResource: settings.autoResource }
    };
  } catch {
    return {
      cpu: 0, memory: 0, uptime: 0, disk: null, system: null,
      allocation: { maxRam, recommended, autoResource: settings.autoResource }
    };
  }
}

function registerClientHandlers(socket: Socket): void {
  socket.on('action', async (action: string) => {
    switch (action) {
      case 'start':
        if (!ctx.mcProcess && !ctx.isStarting) await startServer({ resetCrashThrottle: true });
        break;
      case 'stop':
        if (ctx.mcProcess && !ctx.isStopping) stopServer();
        break;
      case 'kill':
        if (ctx.mcProcess) killServer();
        break;
      case 'restart':
        if (ctx.mcProcess) restartServer();
        break;
    }
  });

  socket.on('command', (cmd: string) => {
    sendCommand(cmd);
  });

  socket.on('locate-player', (playerName: string) => {
    if (playerName && typeof playerName === 'string') {
      log(`Locating player: ${playerName}`, 'info');
      sendCommand(`data get entity ${playerName} Pos`);
      // Also send a /list to trigger player list sync.
      sendCommand('list');
    }
  });
}

export function setupSockets(): Server {
  const io = new Server(ctx.server);
  ctx.io = io;

  io.on('connection', (socket) => {
    log(`Client connected: ${socket.id}`, 'info');

    // Immediately dump the rolling log buffer to the new client.
    socket.emit(SOCKET_EVENTS.consoleHistory, getConsoleHistory());

    // Inform client of current server status.
    socket.emit(SOCKET_EVENTS.status, ctx.mcProcess ? 'online' : 'offline');

    registerClientHandlers(socket);

    socket.on('disconnect', () => {
      log(`Client disconnected: ${socket.id}`, 'info');
    });
  });

  // Enhanced monitoring loop — only runs while clients are connected.
  setInterval(async () => {
    const clientCount = ctx.io?.engine?.clientsCount ?? 0;
    if (clientCount === 0) return;
    const snapshot = await buildStatsSnapshot();
    ctx.io?.emit(SOCKET_EVENTS.stats, snapshot);
  }, STATS_INTERVAL_MS);

  return io;
}
