/**
 * shutdown.ts — graceful shutdown (PM2 / SIGTERM / SIGINT / updates).
 *
 * When the panel is stopped or restarted (pm2 restart/stop, host reboot,
 * self-update) PM2 sends SIGINT/SIGTERM and escalates to SIGKILL only after
 * kill_timeout. Without handlers a running Minecraft server would be orphaned
 * mid-session, so on shutdown we first tell it to stop cleanly ('stop' →
 * world save) and only exit once it is gone. With autoStart enabled, the
 * server then comes right back when PM2 starts the panel again.
 *
 * Under PM2 we must NOT exit 0: PM2 reads a clean code-0 exit as an
 * intentional stop and leaves the app "stopped", while an exit that looks
 * like a crash (non-zero) triggers autorestart and the panel heals itself.
 * Plain `npm start` users still get a clean 0.
 */

import { ctx } from './context';
import { COLORS } from './config';
import { log } from './logger';
import { emitConsoleSafe } from './server';

export const PANEL_EXIT_CODE = (process.env.pm_id !== undefined || process.env.PM2_HOME) ? 1 : 0;

const GRACE_MS = 1200;          // flush in-flight socket events before exiting
const MC_STOP_DEADLINE_MS = 20000; // hard cap — keep UNDER PM2 kill_timeout (30s)

export function requestShutdown(reason: string): void {
  if (ctx.shuttingDown) {
    // Second signal while stopping — don't block the reboot/restart.
    log('Second shutdown signal while stopping — force-killing the Minecraft server.', 'error');
    try { if (ctx.mcProcess) ctx.mcProcess.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(1);
    return;
  }
  ctx.shuttingDown = true;

  if (!ctx.mcProcess) {
    log(`Shutdown requested (${reason}) — no Minecraft server running, exiting.`, 'info');
    // Short grace so in-flight socket events (e.g. update progress) flush.
    setTimeout(() => process.exit(PANEL_EXIT_CODE), GRACE_MS);
    return;
  }

  log(`Shutdown requested (${reason}) — stopping the Minecraft server cleanly...`, 'warn');
  try {
    emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Panel is shutting down — saving the world and stopping the Minecraft server...\n`);
    ctx.mcProcess.stdin.write('stop\n');
  } catch { /* ignore */ }

  // Hard cap so a hung server can never block a reboot or update forever.
  const deadline = setTimeout(() => {
    log('Minecraft server did not stop within 20s — force-killing it and exiting.', 'error');
    try { if (ctx.mcProcess) ctx.mcProcess.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(PANEL_EXIT_CODE);
  }, MC_STOP_DEADLINE_MS);

  const watcher = setInterval(() => {
    if (!ctx.mcProcess) {
      clearInterval(watcher);
      clearTimeout(deadline);
      log('Minecraft server stopped — panel exiting.', 'info');
      process.exit(PANEL_EXIT_CODE);
    }
  }, 500);
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));
