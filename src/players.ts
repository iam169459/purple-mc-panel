/**
 * players.ts — live player tracking driven by console output parsing.
 * Handles joins, leaves, /list output and /data get entity position
 * responses, broadcasting state changes to connected clients.
 */

import { ctx, emit } from './context';
import { stripAnsi } from './line';
import { log } from './logger';
import type { Player, PlayerLocation } from './types';

const NAME = '\\w{3,16}';

function upsertPlayerList(names: string[]): void {
  ctx.onlinePlayers = names.map((name): Player => {
    const existing = ctx.onlinePlayers.find((p) => p.name === name);
    return existing ?? { name, joinedAt: new Date().toISOString() };
  });
  emit('players', ctx.onlinePlayers);
}

/**
 * parsePlayerEvents — extract player state from a console line.
 * Called for every line that flows through the rolling buffer.
 */
export function parsePlayerEvents(text: unknown): void {
  const clean = stripAnsi(text).trim();

  // Join: "Steve joined the game"
  const joinMatch = clean.match(new RegExp(`^(${NAME}) joined the game$`));
  if (joinMatch) {
    const name = joinMatch[1];
    if (!ctx.onlinePlayers.some((p) => p.name === name)) {
      ctx.onlinePlayers.push({ name, joinedAt: new Date().toISOString() });
      emit('players', ctx.onlinePlayers);
      log(`Player joined: ${name}`, 'info');
    }
    return;
  }

  // Leave: "Steve left the game"
  const leaveMatch = clean.match(new RegExp(`^(${NAME}) left the game$`));
  if (leaveMatch) {
    const name = leaveMatch[1];
    ctx.onlinePlayers = ctx.onlinePlayers.filter((p) => p.name !== name);
    delete ctx.playerLocations[name];
    emit('players', ctx.onlinePlayers);
    log(`Player left: ${name}`, 'info');
    return;
  }

  // /list output: "There are X of Y players online: player1, player2, ..."
  const listMatch = clean.match(/^There are \d+ of a max of \d+ players online:\s*(.*)$/);
  if (listMatch) {
    const names = listMatch[1]
      ? listMatch[1].split(',').map((n) => n.trim()).filter(Boolean)
      : [];
    upsertPlayerList(names);
    return;
  }

  // /data get entity <player> Pos response:
  // "Steve has the following entity data: [123.456d, 64.0d, 789.012d]"
  const locMatch = clean.match(
    new RegExp(`^(${NAME}) has the following entity data: \\[(-?[\\d.]+)d?, (-?[\\d.]+)d?, (-?[\\d.]+)d?\\]`)
  );
  if (locMatch) {
    const name = locMatch[1];
    const coords: PlayerLocation = {
      x: parseFloat(locMatch[2]),
      y: parseFloat(locMatch[3]),
      z: parseFloat(locMatch[4]),
      updatedAt: new Date().toISOString()
    };
    ctx.playerLocations[name] = coords;
    const player = ctx.onlinePlayers.find((p) => p.name === name);
    if (player) {
      player.location = coords;
      emit('players', ctx.onlinePlayers);
      emit('player-location', { name, location: coords });
    }
  }
}
