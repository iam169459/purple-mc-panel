/**
 * context.ts — shared application context.
 *
 * All runtime state lives in one typed place instead of module-level
 * globals. Services and controllers read/write this object; `io` is
 * attached once the socket server is created so nothing has to guess
 * whether it exists yet.
 */

import { createServer, type Server as HttpServer } from 'http';
import express, { type Express, type Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type {
  ConsoleLine, Player, PlayerLocation, PluginQueueState, TpsReading,
  UpdateCheckPayload
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface ContextState {
  // HTTP / socket servers.
  app: Express;
  server: HttpServer;
  io: SocketServer | null;

  // Minecraft server process state.
  mcProcess: ChildProcessWithoutNullStreams | null;
  processPid: number | null;
  isStarting: boolean;
  isStopping: boolean;
  serverStartTime: number | null;
  restartPending: boolean;

  // True once SIGINT/SIGTERM/self-update shutdown begins — keeps the
  // crash-restart logic from fighting a deliberate panel shutdown.
  shuttingDown: boolean;

  // Player tracking.
  onlinePlayers: Player[];
  playerLocations: Record<string, PlayerLocation>;

  // Live TPS / MSPT readings parsed from console output.
  lastTps: TpsReading | null;
  lastMspt: number | null;

  // Crash throttle state.
  crashCount: number;
  crashWindowStart: number;

  // Self-update state.
  isUpdateRunning: boolean;
  updateCheckCache: { at: number; payload: UpdateCheckPayload } | null;
  lastKnownBranch: string | null;

  // Plugin install queue (strictly serialized).
  pluginInstallTail: Promise<unknown>;
  pluginInstallQueue: string[];

  // Directory-size cache (invalidated on every mutation under server/).
  diskCache: Map<string, { result: unknown; time: number }>;

  // Rolling console history (fixed size, memory-capped).
  logBuffer: ConsoleLine[];

  /** Emit a socket event when a client is actually connected. */
  emit(event: string, payload: unknown): void;

  // Optional socket-close hook registered by src/sockets.ts.
  onSocketConnect?: (socketId: string) => void;
}

function createContext(): ContextState {
  const app = express();
  const server = createServer(app);

  return {
    app,
    server,
    io: null,
    emit: (event: string, payload: unknown) => emit(event, payload),
    mcProcess: null,
    processPid: null,
    isStarting: false,
    isStopping: false,
    serverStartTime: null,
    restartPending: false,
    shuttingDown: false,
    onlinePlayers: [],
    playerLocations: {},
    lastTps: null,
    lastMspt: null,
    crashCount: 0,
    crashWindowStart: 0,
    isUpdateRunning: false,
    updateCheckCache: null,
    lastKnownBranch: null,
    pluginInstallTail: Promise.resolve(),
    pluginInstallQueue: [],
    diskCache: new Map(),
    logBuffer: []
  };
}

/** Emit a socket event when a client is actually connected. */
export function emit(event: string, payload: unknown): void {
  try {
    if (ctx.io && ctx.io.engine && ctx.io.engine.clientsCount > 0) {
      ctx.io.emit(event, payload);
    }
  } catch {
    /* ignore */
  }
}

export const ctx: ContextState = createContext();

/** Reset Minecraft-runtime state when the server process goes away. */
export function resetServerRuntimeState(): void {
  ctx.mcProcess = null;
  ctx.processPid = null;
  ctx.serverStartTime = null;
  ctx.isStarting = false;
  ctx.isStopping = false;
  ctx.restartPending = false;
  ctx.onlinePlayers = [];
  ctx.playerLocations = {};
}

/** Standard JSON error response. */
export function sendError(res: Response, message: string, status = 400): void {
  res.status(status).json({ error: message });
}

/** Wrap an async handler so rejected promises reach Express' error path. */
export function asyncHandler<T>(
  fn: (req: T & { body: any }, res: Response, next: (err?: unknown) => void) => Promise<unknown>
) {
  return (req: any, res: Response, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
