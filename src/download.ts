/**
 * download.ts — shared HTTP(S) file downloader.
 *
 * Used for the Paper server JAR and the self-update source archive.
 * Follows up to 3 redirects, times out after 5 minutes, detects stalled
 * transfers (60s with no data), and reports throttled progress.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { USER_AGENT } from './config';

export type DownloadProgress = (downloadedBytes: number, totalBytes: number) => void;

const HARD_TIMEOUT_MS = 300000;
const STALL_TIMEOUT_MS = 60000;
const PROGRESS_INTERVAL_MS = 500;

export function downloadFile(
  url: string,
  dest: string,
  onProgress?: DownloadProgress,
  redirectsLeft = 3
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let hardTimer: NodeJS.Timeout;
    let stallTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let downloadedBytes = 0;
    let lastEmit = 0;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (stallTimer) clearTimeout(stallTimer);
      try { file.close(); } catch { /* ignore */ }
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    };

    // Hard cap so a slow or hung transfer can never wedge the panel.
    hardTimer = setTimeout(() => fail(new Error('Download timed out after 300s')), HARD_TIMEOUT_MS);

    // Support http:// mirrors as well as https:// so the updater can be
    // pointed at a local test server via PANEL_UPDATE_*_URL.
    const client = url.startsWith('http:') ? http : https;
    const req = client.get(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
      // Follow redirects (up to 3 hops) — CDN links often bounce.
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
        clearTimeout(hardTimer);
        try { file.close(); } catch { /* ignore */ }
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadFile(nextUrl, dest, onProgress, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        fail(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const contentLength = parseInt(response.headers['content-length'] ?? '0', 10) || 0;
      response.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => fail(new Error('Download stalled — no data for 60s')), STALL_TIMEOUT_MS);
        const now = Date.now();
        if (onProgress && now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now;
          onProgress(downloadedBytes, contentLength);
        }
      });
      response.pipe(file);

      file.on('finish', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (stallTimer) clearTimeout(stallTimer);
        try { file.close(); } catch { /* ignore */ }
        onProgress?.(downloadedBytes, contentLength);
        resolve();
      });
    });

    req.on('error', fail);
  });
}
