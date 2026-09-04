/**
 * routes/server.ts — Minecraft server control + players + properties.
 */

import * as fs from 'fs';
import type { Express, Request, Response } from 'express';
import { ctx, sendError } from '../src/context';
import { COLORS, SERVER_PROPS_PATH } from '../src/config';
import { startServer, stopServer, killServer, restartServer, sendCommand, listPaperVersions, installServerJarForVersion } from '../src/server';
import { parseServerProperties, serializeServerProperties } from '../src/props';
import type { PropEntry } from '../src/types';

export function register(app: Express): void {
  app.post('/api/server/start', async (_req: Request, res: Response) => {
    const result = await startServer({ resetCrashThrottle: true });
    res.json(result);
  });

  app.post('/api/server/stop', (_req: Request, res: Response) => {
    res.json(stopServer());
  });

  app.post('/api/server/kill', (_req: Request, res: Response) => {
    res.json(killServer());
  });

  app.post('/api/server/restart', (_req: Request, res: Response) => {
    res.json(restartServer());
  });

  // Paper releases for the version picker (newest first, with Java needs).
  app.get('/api/server/paper-versions', async (_req: Request, res: Response) => {
    try {
      const versions = await listPaperVersions();
      const supported = versions.filter((v) => v.status === 'SUPPORTED');
      res.json({
        success: true,
        latest: supported[0]?.id ?? versions[0]?.id ?? '',
        versions
      });
    } catch (err) {
      sendError(res, (err as Error).message, 500);
    }
  });

  // Download the Paper JAR for the chosen version (replaces server.jar).
  app.post('/api/server/install-version', async (req: Request, res: Response) => {
    const { version } = req.body as { version?: string };
    if (!version) return sendError(res, 'version is required', 400);
    try {
      await installServerJarForVersion(String(version));
      res.json({ success: true, version: String(version) });
    } catch (err) {
      sendError(res, (err as Error).message, err instanceof Error && /stop the minecraft server/i.test(err.message) ? 409 : 400);
    }
  });

  app.post('/api/command', (req: Request, res: Response) => {
    const { cmd } = req.body as { cmd?: string };
    res.json(sendCommand(cmd ?? ''));
  });

  app.get('/api/players', (_req: Request, res: Response) => {
    const playersWithLocation = ctx.onlinePlayers.map((p) => ({
      ...p,
      location: ctx.playerLocations[p.name] ?? null
    }));
    res.json({ success: true, count: playersWithLocation.length, players: playersWithLocation });
  });

  // ------------------------------------------------------------------
  // server.properties editor
  // ------------------------------------------------------------------

  app.get('/api/server/properties', (_req: Request, res: Response) => {
    try {
      const result = parseServerProperties();
      if (result.error) {
        return sendError(res, result.error, 404);
      }
      const properties: Record<string, string> = {};
      for (const [key, data] of Object.entries(result.properties)) {
        properties[key] = data.value;
      }
      res.json({
        success: true,
        file: 'server.properties',
        properties,
        raw: fs.existsSync(SERVER_PROPS_PATH) ? fs.readFileSync(SERVER_PROPS_PATH, 'utf8') : ''
      });
    } catch (err) {
      sendError(res, (err as Error).message, 500);
    }
  });

  app.post('/api/server/properties/update', (req: Request, res: Response) => {
    try {
      const { properties } = req.body as { properties?: Record<string, unknown> };
      if (!properties || typeof properties !== 'object') {
        return sendError(res, 'properties object is required');
      }

      const result = parseServerProperties();
      if (result.error) {
        return sendError(res, result.error, 404);
      }

      const updated: Record<string, PropEntry> = { ...result.properties };
      for (const [key, value] of Object.entries(properties)) {
        const stringValue = String(value);
        if (updated[key]) {
          updated[key].value = stringValue;
        } else {
          updated[key] = { value: stringValue, comment: '', raw: `${key}=${stringValue}` };
        }
      }

      const content = serializeServerProperties(updated);
      fs.writeFileSync(SERVER_PROPS_PATH, content, 'utf8');
      ctx.emit('console', `\n${COLORS.yellow}[SYSTEM]${COLORS.reset} server.properties updated. Restart server to apply changes.\n`);

      res.json({
        success: true,
        message: 'Properties updated. Restart server to apply.',
        updated: Object.keys(properties)
      });
    } catch (err) {
      sendError(res, (err as Error).message, 500);
    }
  });
}
