/**
 * routes/updates.ts — self-update endpoints.
 */

import type { Express, Request, Response } from 'express';
import { ctx } from '../src/context';
import { GIT_REMOTE_URL } from '../src/config';
import { log } from '../src/logger';
import { buildUpdateCheckPayload, runGithubUpdate, emitUpdateEvent, getLocalVersion } from '../src/updater';

export function register(app: Express): void {
  app.get('/api/update/check', async (_req: Request, res: Response) => {
    try {
      const payload = await buildUpdateCheckPayload();
      res.json(payload);
    } catch (err) {
      log(`Update check failed: ${(err as Error).message}`, 'error');
      res.status(500).json({
        error: 'Failed to check for updates on GitHub',
        method: 'github',
        source: 'version.json',
        currentVersion: getLocalVersion(),
        gitRepoUrl: GIT_REMOTE_URL
      });
    }
  });

  app.post('/api/update/install', (_req: Request, res: Response) => {
    if (ctx.isUpdateRunning) {
      return res.status(409).json({ error: 'An update is already running. Please wait.' });
    }

    // Respond immediately; the async runner streams progress over Socket.io.
    res.json({ success: true, status: 'github_update_initiated', method: 'github', source: 'version.json' });

    // Drop the cached check result so the next check reflects the installed version.
    ctx.updateCheckCache = null;
    ctx.isUpdateRunning = true;
    log('GitHub update initiated (version.json source)', 'info');
    runGithubUpdate()
      .catch((err: Error) => {
        log(`Update failed: ${err.message}`, 'error');
        emitUpdateEvent('error', `[GIT ERROR] ${err.message}`);
        try { ctx.io?.emit('update-complete', { success: false, message: err.message }); } catch { /* ignore */ }
      })
      .finally(() => {
        ctx.isUpdateRunning = false;
      });
  });
}
