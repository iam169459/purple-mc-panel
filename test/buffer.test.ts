import { describe, expect, it, beforeEach } from 'vitest';
import { ctx } from '../src/context';
import { pushToLogBuffer, effectiveMaxLines } from '../src/console-buffer';
import { sanitizePath, PATH_TRAVERSAL } from '../src/files';

describe('effectiveMaxLines', () => {
  it('clamps to the absolute bounds', () => {
    expect(effectiveMaxLines(10)).toBe(100);
    expect(effectiveMaxLines(10000)).toBe(5000);
    expect(effectiveMaxLines(250)).toBe(250);
    expect(effectiveMaxLines(0)).toBe(500);
  });
});

describe('pushToLogBuffer', () => {
  beforeEach(() => {
    ctx.logBuffer = [];
  });

  it('appends classified lines and strips ANSI', () => {
    pushToLogBuffer('\x1b[32mSteve joined the game\x1b[0m\n');
    expect(ctx.logBuffer).toHaveLength(1);
    expect(ctx.logBuffer[0].text).toBe('Steve joined the game');
    expect(ctx.logBuffer[0].type).toBe('join');
  });

  it('drops empty split fragments', () => {
    pushToLogBuffer('hello\n');
    expect(ctx.logBuffer).toHaveLength(1);
  });

  it('tracks players from join lines', () => {
    ctx.onlinePlayers = [];
    pushToLogBuffer('Steve joined the game\n');
    expect(ctx.onlinePlayers.some((p) => p.name === 'Steve')).toBe(true);
  });
});

describe('sanitizePath', () => {
  it('rejects traversal attempts', () => {
    expect(() => sanitizePath('/srv/mc/server', '../secret')).toThrow(PATH_TRAVERSAL);
    expect(() => sanitizePath('/srv/mc/server', '../../etc/passwd')).toThrow(PATH_TRAVERSAL);
  });

  it('accepts nested and absolute-style paths that stay inside the base', () => {
    expect(sanitizePath('/srv/mc/server', 'plugins/WorldEdit/config.yml')).toBe('/srv/mc/server/plugins/WorldEdit/config.yml');
    // Absolute input is anchored to the base, never the filesystem root.
    expect(sanitizePath('/srv/mc/server', '/etc/passwd')).toBe('/srv/mc/server/etc/passwd');
    expect(sanitizePath('/srv/mc/server', '')).toBe('/srv/mc/server');
  });
});
