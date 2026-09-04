/**
 * routes/plugins.ts — plugin marketplace endpoints.
 */

import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';
import { ctx, sendError } from '../src/context';
import { SERVER_DIR, COLORS } from '../src/config';
import { invalidateDiskCache } from '../src/disk';
import { pluginUpload } from '../src/files';
import { emitConsoleSafe } from '../src/server';
import { ESSENTIAL_PLUGINS, searchPlugins, listInstalledPlugins, installPlugin, installStarterPack } from '../src/plugins';

export function register(app: Express): void {
  app.get('/api/plugins/essential', (_req: Request, res: Response) => {
    res.json({ success: true, plugins: ESSENTIAL_PLUGINS });
  });

  app.get('/api/plugins/search', async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '');
    const page = req.query.page;
    const perPage = req.query.per_page;
    if (!q || q.trim().length < 2) return sendError(res, 'Search query must be at least 2 characters', 400);
    try {
      const result = await searchPlugins(q.trim(), Number(page) || 1, Number(perPage) || 24);
      res.json({ success: true, ...result });
    } catch (err) {
      sendError(res, 'Search service unavailable', 502);
    }
  });

  app.get('/api/plugins/installed', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, plugins: listInstalledPlugins() });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  app.post('/api/plugins/install', async (req: Request, res: Response) => {
    const { resourceId, source, name } = req.body as { resourceId?: string; source?: string; name?: string };
    if (!resourceId || !source) return sendError(res, 'resourceId and source are required');

    // Installs are allowed while the server runs — Paper picks new jars
    // up on the next restart. We just make sure the user is told.
    if (ctx.mcProcess) {
      ctx.emit('console', `\n[PLUGIN] Install requested while the server is running — it will load on the next restart.\n`);
    }
    const outcome = await installPlugin(resourceId, source, name ?? '');
    if (outcome.success) {
      res.json({ success: true, name: outcome.name, size: outcome.size, needsRestart: outcome.needsRestart });
    } else {
      sendError(res, outcome.error ?? 'Install failed', outcome.status ?? 500);
    }
  });

  app.post('/api/plugins/starter-pack/install', async (_req: Request, res: Response) => {
    const outcomes = await installStarterPack();
    const okCount = outcomes.filter((o) => o.success).length;
    if (okCount === 0) {
      const first = outcomes.find((o) => !o.success);
      return sendError(res, first?.error ?? 'Starter pack install failed', first?.status ?? 500);
    }
    res.json({ success: true, installed: okCount, total: outcomes.length });
  });

  app.post('/api/plugins/upload', (req: Request, res: Response) => {
    pluginUpload.single('plugin')(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          return sendError(res, err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 100MB limit' : err.message, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
        }
        return sendError(res, (err as Error).message, 400);
      }
      if (!req.file) return sendError(res, 'No file uploaded', 400);

      const { filename, size } = req.file;
      invalidateDiskCache();
      ctx.emit('console', `\n[PLUGIN] Uploaded: ${filename}\n`);
      const needsRestart = !!ctx.mcProcess;
      if (needsRestart) {
        emitConsoleSafe(`\n${COLORS.yellow}[SYSTEM]${COLORS.reset} Restart the server to load ${filename}\n`);
      }
      res.json({ success: true, name: filename, size, needsRestart });
    });
  });

  app.delete('/api/plugins/:name', (req: Request, res: Response) => {
    const name = req.params.name;
    if (!name.endsWith('.jar') || !/^[a-zA-Z0-9._ -]+$/.test(name)) {
      return sendError(res, 'Invalid plugin name');
    }
    try {
      const pluginPath = path.join(SERVER_DIR, 'plugins', name);
      if (fs.existsSync(pluginPath)) {
        fs.unlinkSync(pluginPath);
        invalidateDiskCache();
        res.json({ success: true });
      } else {
        sendError(res, 'Not found', 404);
      }
    } catch {
      sendError(res, 'Failed to delete plugin', 400);
    }
  });
}
