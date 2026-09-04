/**
 * index.ts — boot entry point.
 *
 * Wires the modular backend together: middleware, REST controllers,
 * Socket.IO, schedulers, and the HTTP server. Compiled to dist/src and
 * launched through the thin root app.js launcher.
 */

import * as fs from 'fs';
import * as path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ctx, ApiError } from './context';
import { ROOT_DIR, PUBLIC_DIR, SERVER_DIR, CONFIG_DIR, BACKUPS_DIR, PORT } from './config';
import { log } from './logger';
import { loadSettings } from './settings';
import { checkAndDownloadServer, startServer } from './server';
import { setupSockets } from './sockets';
import { startTaskScheduler } from './tasks';
import { pruneBackups } from './backups';
import { maybeInstallStarterPackOnBoot } from './plugins';
import './shutdown'; // registers SIGINT/SIGTERM handlers
import { register as registerStatus } from '../routes/status';
import { register as registerServer } from '../routes/server';
import { register as registerFiles } from '../routes/files';
import { register as registerPlugins } from '../routes/plugins';
import { register as registerBackups } from '../routes/backups';
import { register as registerTasks } from '../routes/tasks';
import { register as registerSettings } from '../routes/settings';
import { register as registerNetwork } from '../routes/network';
import { register as registerUpdates } from '../routes/updates';

function getVersion(): string {
  try {
    const vf = path.join(ROOT_DIR, 'version.json');
    if (fs.existsSync(vf)) {
      const parsed = JSON.parse(fs.readFileSync(vf, 'utf8'));
      if (parsed.version) return String(parsed.version);
    }
  } catch { /* ignore */ }
  return 'dev';
}

// ================================================================
// MIDDLEWARE
// ================================================================
ctx.app.use(express.json({ limit: '50mb' }));
ctx.app.use(express.urlencoded({ extended: true }));
ctx.app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// ================================================================
// REST ROUTES
// ================================================================
registerStatus(ctx.app);
registerServer(ctx.app);
registerFiles(ctx.app);
registerPlugins(ctx.app);
registerBackups(ctx.app);
registerTasks(ctx.app);
registerSettings(ctx.app);
registerNetwork(ctx.app);
registerUpdates(ctx.app);

// ================================================================
// SPA FALLBACK + ERROR HANDLING
// ================================================================
// Anything non-API that didn't hit a static file serves the React app so
// client-side routes survive a refresh.
ctx.app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// Final error handler — normalizes ApiError into a JSON response.
ctx.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : 'Internal server error';
  if (status >= 500) log(message, 'error');
  if (!res.headersSent) res.status(status).json({ error: message });
});

// ================================================================
// SOCKETS + SCHEDULERS
// ================================================================
setupSockets(); // attaches ctx.io
startTaskScheduler();
// Retention pruning for scheduled backups, every 30 minutes.
setInterval(pruneBackups, 30 * 60 * 1000);

// ================================================================
// BOOTSTRAP
// ================================================================
function ensureDirectories(): void {
  for (const dir of [SERVER_DIR, BACKUPS_DIR, CONFIG_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`Created directory: ${dir}`, 'info');
    }
  }
}

async function init(): Promise<void> {
  ensureDirectories();

  // Kick off a background server-JAR download (if one is needed) so the
  // panel comes up instantly and is never blocked on the network.
  // startServer() also awaits checkAndDownloadServer() before spawning.
  checkAndDownloadServer().then(
    () => log('Server JAR ready', 'info'),
    (err: Error) => {
      log(`Server JAR unavailable: ${err.message}`, 'error');
      log('Place a server.jar in the server/ directory to start the Minecraft server.', 'warn');
    }
  );

  ctx.server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${PORT} in use. Try: PORT=3001 npm start`, 'error');
      process.exit(1);
    }
    throw err;
  });

  // First-boot convenience: install the curated starter plugin pack when
  // the plugins folder is still empty (see settings.starterPackOnFirstRun).
  void maybeInstallStarterPackOnBoot();

  ctx.server.listen(PORT, () => {
    log(`PurpleMC Panel running on port ${PORT}`, 'info');
    log(`Server directory: ${SERVER_DIR}`, 'info');
    log(`Current version: v${getVersion()}`, 'info');

    // Auto-start the Minecraft server if configured.
    const s = loadSettings();
    if (s.autoStart) {
      log('Auto-start enabled, starting server...', 'info');
      setTimeout(() => { void startServer({ resetCrashThrottle: true }); }, 2000);
    }
  });
}

void init().catch((err: Error) => {
  log(`Initialization failed: ${err.message}`, 'error');
  process.exit(1);
});

export { ctx };
