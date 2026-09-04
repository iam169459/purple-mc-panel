/**
 * logger.ts — timestamped, level-aware panel console output.
 */

import { COLORS } from './config';

export type LogLevel = 'info' | 'warn' | 'error';

function colorFor(level: LogLevel): string {
  switch (level) {
    case 'error': return COLORS.red;
    case 'warn': return COLORS.yellow;
    default: return COLORS.cyan;
  }
}

function labelFor(level: LogLevel): string {
  switch (level) {
    case 'error': return '[ERROR]';
    case 'warn': return '[WARN]';
    default: return '[PurpleMC]';
  }
}

export function log(message: string, level: LogLevel = 'info'): void {
  const timestamp = new Date().toISOString();
  console.log(`${colorFor(level)}${labelFor(level)}${COLORS.reset} ${message}`);
}
