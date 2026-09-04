import { describe, expect, it } from 'vitest';
import { stripAnsi, classifyLine, escapeRegex } from '../src/line';

describe('stripAnsi', () => {
  it('removes CSI escape sequences', () => {
    expect(stripAnsi('\x1b[32m[INFO]\x1b[0m hello')).toBe('[INFO] hello');
  });

  it('handles non-string input', () => {
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi(42)).toBe('42');
  });
});

describe('classifyLine', () => {
  it('tags chat messages', () => {
    expect(classifyLine('Steve: <Alex> hello everyone')).toBe('chat');
  });

  it('tags join/leave lines', () => {
    expect(classifyLine('Alex joined the game')).toBe('join');
    expect(classifyLine('Alex left the game')).toBe('leave');
    expect(classifyLine('Steve logged in with entity id 123')).toBe('join');
  });

  it('tags errors, warnings and successes', () => {
    expect(classifyLine('[14:32:01] [Server thread/ERROR]: java.lang.OutOfMemoryError')).toBe('error');
    expect(classifyLine('[WARN]: A plugin failed to load')).toBe('warn');
    expect(classifyLine('Done (5.432s)! For help, type "help"')).toBe('success');
    // INFO-tagged boot lines classify as info; bare startup lines as success.
    expect(classifyLine('[Server thread/INFO]: Preparing spawn area: 100%')).toBe('info');
    expect(classifyLine('Preparing spawn area: 100%')).toBe('success');
  });

  it('tags command echoes', () => {
    expect(classifyLine('$ say hello')).toBe('command');
  });

  it('tags system messages', () => {
    expect(classifyLine('[SYSTEM] Auto-restart in 5s')).toBe('system');
  });

  it('tags tick readings', () => {
    expect(classifyLine('TPS from last 5s: 20.0, 1m: 19.8, 5m: 19.5')).toBe('tick');
    expect(classifyLine('Server tick times: 45.2 average')).toBe('tick');
  });

  it('falls back to default', () => {
    expect(classifyLine('[14:30:00] something mundane happened')).toBe('default');
  });
});

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });
});
