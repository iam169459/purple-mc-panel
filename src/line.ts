/**
 * line.ts — console line utilities: ANSI stripping + type classification.
 * Pure functions with no dependencies, so any module can use them.
 */

import type { ConsoleLineType } from './types';

const ANSI_PATTERNS = [
  /\x1B\[[0-9;]*[a-zA-Z]/g,
  /\x1B\][0-9;]*[a-zA-Z]/g
];

export function stripAnsi(str: unknown): string {
  let out = String(str ?? '');
  for (const re of ANSI_PATTERNS) out = out.replace(re, '');
  return out;
}

/** Precedence-ordered classifiers; the first match wins. */
/**
 * Matches Paper's real log prefix forms: `[Server thread/ERROR]` (lowered
 * to `thread/error]`) as well as the generic `[ERROR]` tag.
 */
const bracketTag = (tag: string) => (l: string): boolean => l.includes(`[${tag}]`) || l.includes(`/${tag}]`);

/** Precedence-ordered classifiers; the first match wins. */
const CLASSIFIERS: Array<{ type: ConsoleLineType; test: (lower: string) => boolean }> = [
  { type: 'error', test: (l) => bracketTag('error')(l) || l.includes('exception') || l.includes('fatal') || l.includes('[severe]') || l.includes('/severe]') },
  { type: 'warn', test: (l) => bracketTag('warn')(l) || bracketTag('warning')(l) },
  { type: 'debug', test: (l) => bracketTag('debug')(l) || l.includes('[fine]') || l.includes('/fine]') || l.includes('[finer]') || l.includes('[finest]') },
  { type: 'info', test: (l) => bracketTag('info')(l) },
  { type: 'command', test: (l) => l.startsWith('$') },
  { type: 'join', test: (l) => l.includes('joined the game') || l.includes('logged in') },
  { type: 'leave', test: (l) => l.includes('left the game') || l.includes('logged out') },
  {
    type: 'death',
    test: (l) => ['was slain by', 'was shot by', 'was killed', 'drowned', 'fell from', 'blew up',
      'hit the ground', 'went up in flames', 'burned to death', 'was burned',
      'was struck by lightning', 'was pricked to death', 'suffocated', 'starved',
      'was poked', 'died'].some(k => l.includes(k))
  },
  { type: 'advancement', test: (l) => l.includes('has made the advancement') || l.includes('has completed the challenge') || l.includes('has reached the goal') },
  { type: 'chat', test: (l) => l.includes('<') && (l.includes('>') || l.includes('»')) },
  { type: 'tick', test: (l) => l.includes('mspt') || l.includes('tps:') || l.includes('tps from last') || l.includes('memory:') || l.includes('tick:') || l.includes('tick times:') },
  {
    type: 'success',
    test: (l) => l.includes('done (') || l.includes('done in ') || l.includes('started')
      || l.includes('running on') || l.includes('preparing spawn') || l.includes('loading world')
      || l.includes('loaded world') || l.includes('default game type') || l.includes('setting spawn')
      || (l.includes('complete') && !l.includes('failed')) || l.includes('success')
  },
  { type: 'system', test: (l) => l.includes('[system]') || l.startsWith('system') }
];

/**
 * classifyLine — tag a raw console line with a semantic type the
 * frontend uses for color-coding and filter chips.
 */
export function classifyLine(line: unknown): ConsoleLineType {
  const lower = String(line ?? '').toLowerCase();
  for (const c of CLASSIFIERS) {
    if (c.test(lower)) return c.type;
  }
  return 'default';
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}
