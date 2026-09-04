/**
 * routes/files.ts — secure file manager endpoints.
 */

import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import type { Express, Request, Response } from 'express';
import { sendError } from '../src/context';
import { SERVER_DIR } from '../src/config';
import { getDiskUsage, getDiskBreakdown, getHostDiskInfo, invalidateDiskCache } from '../src/disk';
import {
  sanitizePath, PATH_TRAVERSAL, listDir, safeReadFile, isEditableExt, dirHasFiles,
  streamFolderZip, fileUpload, moveUploadedFile
} from '../src/files';

const traversal = (res: Response): void => sendError(res, 'Access denied', 403);

const EDITABLE_LIMIT = 5 * 1024 * 1024;

export function register(app: Express): void {
  app.get('/api/files/list', (req: Request, res: Response) => {
    const userPath = String(req.query.path ?? '');
    try {
      const filePath = sanitizePath(SERVER_DIR, userPath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
        return sendError(res, 'Directory not found', 404);
      }
      res.json({ success: true, path: userPath, files: listDir(filePath) });
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return traversal(res);
      sendError(res, (err as Error).message);
    }
  });

  app.get('/api/files/read', (req: Request, res: Response) => {
    const userPath = String(req.query.file ?? '');
    if (!userPath) return sendError(res, 'file parameter is required');
    try {
      const filePath = sanitizePath(SERVER_DIR, userPath);
      if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
      if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot read a directory', 400);

      const ext = path.extname(filePath).toLowerCase();
      const editable = isEditableExt(ext);
      try {
        const content = safeReadFile(filePath);
        res.json({ success: true, path: userPath, name: path.basename(filePath), extension: ext, isEditable: editable, content });
      } catch (readErr) {
        if ((readErr as Error).message === 'FILE_TOO_LARGE') return sendError(res, 'File too large to read (>5MB)', 413);
        throw readErr;
      }
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return traversal(res);
      sendError(res, (err as Error).message);
    }
  });

  app.post('/api/files/save', (req: Request, res: Response) => {
    const { path: userPath, content } = req.body as { path?: string; content?: unknown };
    if (!userPath) return sendError(res, 'path is required');
    if (typeof content !== 'string') return sendError(res, 'content must be a string');
    if (content.length > EDITABLE_LIMIT) return sendError(res, 'Content exceeds 5MB limit', 413);

    try {
      const filePath = sanitizePath(SERVER_DIR, userPath);
      if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
      if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot write to a directory', 400);
      if (!isEditableExt(path.extname(filePath))) {
        return sendError(res, 'Editing this file type is not allowed', 403);
      }
      fs.writeFileSync(filePath, content, 'utf8');
      invalidateDiskCache();
      res.json({ success: true, path: userPath });
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return traversal(res);
      sendError(res, (err as Error).message);
    }
  });

  app.post('/api/files/create', (req: Request, res: Response) => {
    const { name, type, path: dir } = req.body as { name?: string; type?: string; path?: string };
    if (!name || !/^[a-zA-Z0-9._ -]+$/.test(name) || name.includes('..')) {
      return sendError(res, 'Invalid name');
    }
    if (!['folder', 'file'].includes(type ?? '')) return sendError(res, 'Invalid type');

    try {
      const targetDir = sanitizePath(SERVER_DIR, dir ?? '');
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return sendError(res, 'Target directory not found', 404);
      }
      const target = sanitizePath(targetDir, name as string);

      if (type === 'folder') {
        fs.mkdirSync(target, { recursive: true });
      } else {
        const ext = path.extname(name as string).toLowerCase();
        if (!isEditableExt(ext)) return sendError(res, 'Cannot create files with this extension', 403);
        fs.writeFileSync(target, '');
      }
      invalidateDiskCache();
      res.json({ success: true });
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return sendError(res, 'Access denied', 403);
      sendError(res, (err as Error).message);
    }
  });

  // PUT/DELETE operate on an arbitrary relative path (Express 4 wildcard).
  app.put('/api/files/:path(*)', (req: Request, res: Response) => {
    const { content } = req.body as { content?: unknown };
    try {
      const filePath = sanitizePath(SERVER_DIR, decodeURIComponent(req.params.path ?? ''));
      if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
      if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot write to directory', 400);
      if (!isEditableExt(path.extname(filePath))) return sendError(res, 'Editing not allowed', 403);
      if (typeof content !== 'string' || content.length > EDITABLE_LIMIT) return sendError(res, 'Invalid content', 413);
      fs.writeFileSync(filePath, content, 'utf8');
      invalidateDiskCache();
      res.json({ success: true });
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return sendError(res, 'Access denied', 403);
      sendError(res, (err as Error).message);
    }
  });

  app.delete('/api/files/:path(*)', (req: Request, res: Response) => {
    try {
      const filePath = sanitizePath(SERVER_DIR, decodeURIComponent(req.params.path ?? ''));
      if (!fs.existsSync(filePath)) return sendError(res, 'Not found', 404);
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
      invalidateDiskCache();
      res.json({ success: true });
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return sendError(res, 'Access denied', 403);
      sendError(res, (err as Error).message);
    }
  });

  app.get('/api/files/download', (req: Request, res: Response) => {
    const userPath = String(req.query.file ?? '');
    if (!userPath) return sendError(res, 'file parameter is required');
    try {
      const filePath = sanitizePath(SERVER_DIR, userPath);
      if (!fs.existsSync(filePath)) return sendError(res, 'File not found', 404);
      if (fs.statSync(filePath).isDirectory()) return sendError(res, 'Cannot download a directory', 400);
      res.download(filePath, path.basename(filePath));
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return traversal(res);
      sendError(res, (err as Error).message);
    }
  });

  // Combined storage overview for the file explorer header: recursive
  // server usage, host-disk free space, and per-folder breakdown.
  app.get('/api/files/storage', (_req: Request, res: Response) => {
    const server = getDiskUsage(SERVER_DIR);
    const host = getHostDiskInfo();
    const folders = getDiskBreakdown().slice(0, 14);
    res.json({ success: true, server, host, folders });
  });

  // Stream any folder (a world, plugins/, logs/, ...) as a zip archive.
  app.get('/api/files/download-dir', (req: Request, res: Response) => {
    const userPath = String(req.query.path ?? '');
    if (!userPath) return sendError(res, 'path parameter is required');
    try {
      const filePath = sanitizePath(SERVER_DIR, userPath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
        return sendError(res, 'Folder not found', 404);
      }
      if (!dirHasFiles(filePath)) return sendError(res, 'Folder is empty', 400);
      const baseName = String(path.basename(filePath) || 'server').replace(/"/g, '');
      streamFolderZip(filePath, baseName, res);
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return traversal(res);
      sendError(res, (err as Error).message);
    }
  });

  app.post('/api/files/rename', (req: Request, res: Response) => {
    const { path: userPath, name: newName } = req.body as { path?: string; name?: unknown };
    if (!userPath || typeof newName !== 'string' || !newName.trim()) {
      return sendError(res, 'path and name are required');
    }
    const clean = newName.trim();
    if (!/^[a-zA-Z0-9._ -]+$/.test(clean) || clean.includes('..')) {
      return sendError(res, 'Invalid name — use letters, numbers, dots, spaces, _ and - only');
    }
    try {
      const oldPath = sanitizePath(SERVER_DIR, userPath);
      if (!fs.existsSync(oldPath)) return sendError(res, 'Not found', 404);
      if (path.resolve(oldPath) === path.resolve(SERVER_DIR)) {
        return sendError(res, 'Cannot rename the server root', 400);
      }
      const target = sanitizePath(path.dirname(oldPath), clean);
      if (path.resolve(target) === path.resolve(oldPath)) return res.json({ success: true });
      if (fs.existsSync(target)) {
        return sendError(res, `A file or folder named "${clean}" already exists`, 409);
      }
      fs.renameSync(oldPath, target);
      invalidateDiskCache();
      res.json({ success: true, newPath: path.relative(path.resolve(SERVER_DIR), target).split(path.sep).join('/') });
    } catch (err) {
      if ((err as Error).message === PATH_TRAVERSAL) return sendError(res, 'Access denied', 403);
      sendError(res, (err as Error).message);
    }
  });

  app.post('/api/files/upload', (req: Request, res: Response) => {
    fileUpload.single('file')(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          return sendError(res, err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 500MB limit' : err.message, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
        }
        return sendError(res, (err as Error).message, 400);
      }
      if (!req.file) return sendError(res, 'No file uploaded', 400);

      // Resolve and validate the target directory AFTER multer has fully
      // parsed the multipart body (including the path field).
      let targetDir: string;
      try {
        targetDir = sanitizePath(SERVER_DIR, String((req.body as { path?: string }).path ?? ''));
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          throw new Error('Target directory not found');
        }
      } catch (sanitizeErr) {
        try { fs.unlinkSync((req as any).file.path); } catch { /* ignore */ }
        if ((sanitizeErr as Error).message === PATH_TRAVERSAL) {
          return sendError(res, 'Access denied', 403);
        }
        return sendError(res, (sanitizeErr as Error).message, 400);
      }

      const moveResult = moveUploadedFile(req as any, targetDir);
      if (!('ok' in moveResult)) return sendError(res, moveResult.error, moveResult.status);

      const relDir = path.relative(path.resolve(SERVER_DIR), path.resolve(targetDir)).replace(/\\/g, '/');
      const relPath = (relDir && relDir !== '.' ? `${relDir}/` : '') + (req as any).file.filename;
      res.json({ success: true, path: relPath, name: (req as any).file.filename, size: (req as any).file.size });
    });
  });
}
