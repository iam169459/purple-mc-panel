/**
 * console-buffer.ts — rolling console history with a hard memory cap.
 *
 * Every Minecraft server output chunk flows through here; each line is
 * also fed to the player/TPS parsers. A ring buffer keeps history
 * bounded by the configured consoleMaxLines without O(n) shifts.
 */

import { ctx } from './context';
import { stripAnsi, classifyLine } from './line';
import { parsePlayerEvents } from './players';
import { parseTpsEvents } from './tps';
import { loadSettings } from './settings';
import { CONSOLE_ABSOLUTE_MIN, CONSOLE_ABSOLUTE_MAX, CONSOLE_DEFAULT_MAX } from './config';
import type { ConsoleLine, ClientConsoleLine } from './types';

/** Cap enforcement: settings value clamped into the sane range. */
export function effectiveMaxLines(configured: number): number {
  const raw = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 500;
  return Math.max(CONSOLE_ABSOLUTE_MIN, Math.min(CONSOLE_ABSOLUTE_MAX, raw));
}

/** Cached max-lines value to avoid reading settings.json on every chunk. */
let cachedMaxLines = effectiveMaxLines(CONSOLE_DEFAULT_MAX);
let settingsLoadedAt = 0;

function getCachedMaxLines(): number {
  const now = Date.now();
  // Re-read settings at most once every 5 seconds.
  if (now - settingsLoadedAt > 5000) {
    try {
      cachedMaxLines = effectiveMaxLines(loadSettings().consoleMaxLines);
    } catch { /* keep cached value */ }
    settingsLoadedAt = now;
  }
  return cachedMaxLines;
}

export function pushToLogBuffer(rawChunk: unknown, _type?: string): void {
  const text = (rawChunk as Buffer)?.toString ? (rawChunk as Buffer).toString('utf8') : String(rawChunk);
  const lines = text.split('\n');
  const maxLines = getCachedMaxLines();

  for (const lineText of lines) {
    // Skip the trailing empty fragment that split('\n') always produces.
    if (lineText === '') continue;

    parsePlayerEvents(lineText);
    parseTpsEvents(lineText);

    const entry: ConsoleLine = {
      raw: lineText,
      text: stripAnsi(lineText),
      type: classifyLine(lineText),
      timestamp: new Date().toISOString()
    };

    ctx.logBuffer.push(entry);
    if (ctx.logBuffer.length > maxLines) {
      ctx.logBuffer.splice(0, ctx.logBuffer.length - maxLines);
    }
  }
}

/** Snapshot of history for a newly connected client. */
export function getConsoleHistory(): ClientConsoleLine[] {
  return ctx.logBuffer.map((entry) => ({
    text: entry.text,
    type: entry.type,
    timestamp: entry.timestamp
  }));
}

export function clearConsoleHistory(): void {
  ctx.logBuffer = [];
}
