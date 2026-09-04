/**
 * tps.ts — live TPS / MSPT parsing from vanilla/Paper `/tps` and
 * `/mspt` output, streamed to connected clients in real time.
 */

import { ctx, emit } from './context';
import { stripAnsi } from './line';
import type { TpsReading } from './types';

function emitTpsUpdate(): void {
  emit('tps', { tps: ctx.lastTps, mspt: ctx.lastMspt });
}

export function parseTpsEvents(text: unknown): void {
  const clean = stripAnsi(text);

  const tpsMatch = clean.match(/TPS from last 5s: ([\d.]+), 1m: ([\d.]+), 5m: ([\d.]+)/);
  if (tpsMatch) {
    const reading: TpsReading = {
      tps5s: parseFloat(tpsMatch[1]),
      tps1m: parseFloat(tpsMatch[2]),
      tps5m: parseFloat(tpsMatch[3]),
      timestamp: new Date().toISOString()
    };
    ctx.lastTps = reading;
    emitTpsUpdate();
    return;
  }

  const msptMatch = clean.match(/Server tick times: ([\d.]+) average/);
  if (msptMatch) {
    ctx.lastMspt = parseFloat(msptMatch[1]);
    emitTpsUpdate();
  }
}
