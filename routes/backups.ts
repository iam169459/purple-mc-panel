/**
 * routes/backups.ts — backup endpoints.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';
import { sendError } from '../src/context';
import { BACKUPS_DIR } from '../src/config';
import { listBackups, createBackupZip, deleteBackup } from '../src/backups';

const SAFE_NAME = /^[a-zA-Z0-9._-]+\.zip$/;

export function register(app: Express): void {
  app.get('/api/backups', (_req: Request, res: Response) => {
    res.json(listBackups());
  });

  app.post('/api/backups/create', async (_req: Request, res: Response) => {
    try {
      const backupName = await createBackupZip();
      res.json({ success: true, name: backupName });
    } catch (err) {
      sendError(res, (err as Error).message, 500);
    }
  });

  app.delete('/api/backups/:name', (req: Request, res: Response) => {
    const result = deleteBackup(req.params.name);
    if (result.success) return res.json(result);
    sendError(res, result.error ?? 'Failed to delete backup', result.error === 'Not found' ? 404 : 400);
  });

  app.get('/api/backups/:name/download', (req: Request, res: Response) => {
    const name = req.params.name;
    if (!SAFE_NAME.test(name)) return sendError(res, 'Invalid backup name');
    const filePath = path.join(BACKUPS_DIR, name);
    if (!fs.existsSync(filePath)) return sendError(res, 'Backup not found', 404);
    res.download(filePath, name);
  });
}
