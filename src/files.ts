/**
 * files.ts — secure file manager services.
 *
 * All user-supplied paths are resolved against the server directory and
 * rejected on traversal. Provides listing (with recursive folder sizes),
 * read/write/create/rename/delete, upload staging, and streaming folder
 * downloads as zip archives.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import multer from 'multer';
import {
  SERVER_DIR, EDITABLE_EXTENSIONS, FILE_MAX_READ_BYTES, FILE_MAX_UPLOAD_BYTES,
  PLUGIN_MAX_UPLOAD_BYTES
} from './config';
import { log } from './logger';
import { getDiskUsage, invalidateDiskCache } from './disk';
import type { FileEntry } from './types';

export const PATH_TRAVERSAL = 'PATH_TRAVERSAL_DETECTED';

/** Resolve a user-supplied path safely inside basePath. Throws on traversal. */
export function sanitizePath(basePath: string, userPath: string): string {
  const safeBase = path.resolve(basePath);
  const rawNormalized = path.normalize(userPath || '.');
  const resolved = path.isAbsolute(rawNormalized)
    ? path.resolve(safeBase, `.${rawNormalized}`)
    : path.resolve(safeBase, rawNormalized);

  if (!resolved.startsWith(safeBase + path.sep) && resolved !== safeBase) {
    throw new Error(PATH_TRAVERSAL);
  }
  return resolved;
}

export function safeReadDir(dirPath: string): FileEntry[] {
  const items: FileEntry[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.dat' || entry.name.endsWith('.lock')) continue;
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        items.push({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: stat.size,
          modified: stat.mtime.toISOString(),
          extension: path.extname(entry.name).toLowerCase()
        });
      } catch {
        items.push({ name: entry.name, isDirectory: entry.isDirectory(), size: 0, modified: null, extension: '' });
      }
    }
  } catch (err) {
    log(`safeReadDir error: ${(err as Error).message}`, 'error');
  }
  return items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * List a directory, attaching recursive sizes + file counts to folders
 * (cached by getDiskUsage, invalidated on mutation) so the explorer
 * doubles as a storage-triage view.
 */
export function listDir(filePath: string): FileEntry[] {
  const files = safeReadDir(filePath);
  for (const f of files) {
    if (!f.isDirectory) continue;
    const usage = getDiskUsage(path.join(filePath, f.name));
    if (usage && !usage.error) {
      f.size = usage.totalBytes;
      f.fileCount = usage.fileCount;
    }
  }
  return files;
}

export function safeReadFile(filePath: string, maxSize = FILE_MAX_READ_BYTES): string {
  const stat = fs.statSync(filePath);
  if (stat.size > maxSize) throw new Error('FILE_TOO_LARGE');
  return fs.readFileSync(filePath, 'utf8');
}

export function isEditableExt(ext: string): boolean {
  return EDITABLE_EXTENSIONS.includes(ext.toLowerCase());
}

/** True when a directory contains at least one file anywhere in its tree. */
export function dirHasFiles(dirPath: string): boolean {
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (!entry.isDirectory()) return true;
      if (dirHasFiles(full)) return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Stream a folder as a zip archive straight to the response. */
export function streamFolderZip(filePath: string, baseName: string, res: any): void {
  const child = spawn('zip', ['-r', '-', '.'], { cwd: filePath, stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  const fail = (message: string, status: number): void => {
    done = true;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    if (!res.headersSent) {
      res.status(status).json({ error: message });
      return;
    }
    try { res.destroy(); } catch { /* partial stream — abort the download */ }
  };
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
  child.on('error', (err) => {
    fail(`Folder download failed — the 'zip' utility is not installed (${err.message})`, 500);
  });
  child.on('close', (code) => {
    if (code !== 0 && !done) fail(`Folder download failed (zip exit code ${code})`, 500);
    if (code === 0 && !res.writableEnded) res.end();
  });
  child.stdout.pipe(res);
}

// ----------------------------------------------------------------------
// Uploads
// ----------------------------------------------------------------------

// Files are staged in the OS temp dir first; the route handler moves
// them into the (sanitized) target directory once the full body —
// including the `path` field — has been parsed.
const safeUploadName = (original: string, fallback: string): string => {
  const safe = path.basename(original).replace(/[^a-zA-Z0-9._ -]/g, '_');
  return safe || fallback;
};

export const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safe = safeUploadName(file.originalname, 'upload.bin');
      cb(null, `${Date.now()}-${safe}`);
    }
  }),
  limits: { fileSize: FILE_MAX_UPLOAD_BYTES }
});

// Plugins land directly in server/plugins.
export const pluginUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(SERVER_DIR, 'plugins');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '_');
      cb(null, safe);
    }
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.jar')) {
      return cb(new Error('Only .jar files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: PLUGIN_MAX_UPLOAD_BYTES }
});

/** Move a staged upload into its (already validated) target directory. */
export function moveUploadedFile(req: any, targetDir: string): { error: string; status: number } | { ok: true } {
  const targetPath = path.join(targetDir, req.file.filename);
  try {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      throw new Error('A folder with that name already exists');
    }
    fs.renameSync(req.file.path, targetPath);
  } catch (moveErr) {
    try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    return { error: (moveErr as Error).message || 'Failed to save file', status: 500 };
  }
  invalidateDiskCache();
  return { ok: true };
}
