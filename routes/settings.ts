/**
 * routes/settings.ts — panel settings endpoints.
 */

import type { Express, Request, Response } from 'express';
import { DEFAULT_SETTINGS } from '../src/config';
import { loadSettings, saveSettings, syncSettingsToProps } from '../src/settings';
import type { PanelSettings } from '../src/types';

export function register(app: Express): void {
  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json({ success: true, settings: loadSettings() });
  });

  app.post('/api/settings/save', (req: Request, res: Response) => {
    const current = loadSettings();
    const allowedKeys = Object.keys(DEFAULT_SETTINGS);
    const changed: string[] = [];
    const body = req.body as Partial<Record<keyof PanelSettings, unknown>>;

    for (const key of allowedKeys) {
      if (body[key as keyof PanelSettings] !== undefined) {
        (current as unknown as Record<string, unknown>)[key] = body[key as keyof PanelSettings];
        changed.push(key);
      }
    }

    if (saveSettings(current)) {
      // Sync compatible settings to server.properties.
      syncSettingsToProps(changed, body as Record<string, unknown>);
      res.json({ success: true, settings: current });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
  });
}
