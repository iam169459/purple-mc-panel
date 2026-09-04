/**
 * settings.ts — panel settings (config/settings.json) plus the one-way
 * sync of compatible keys into server.properties.
 */

import * as fs from 'fs';
import {
  DEFAULT_SETTINGS, SETTINGS_DB_PATH, SETTINGS_TO_PROPS, SERVER_PROPS_PATH, CONFIG_DIR
} from './config';
import { log } from './logger';
import { escapeRegex } from './line';
import type { PanelSettings } from './types';

export function loadSettings(): PanelSettings {
  try {
    if (fs.existsSync(SETTINGS_DB_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_DB_PATH, 'utf8'));
      // Merge so newly added settings keys get their defaults on older installs.
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (err) {
    log(`Failed to load settings: ${(err as Error).message}`, 'warn');
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: PanelSettings): boolean {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_DB_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (err) {
    log(`Failed to save settings: ${(err as Error).message}`, 'error');
    return false;
  }
}

/**
 * syncSettingsToProps — write settings values that map 1:1 onto
 * server.properties entries. Only touched keys are written.
 */
export function syncSettingsToProps(changedKeys: string[], body: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(SERVER_PROPS_PATH)) return;
    let propsContent = fs.readFileSync(SERVER_PROPS_PATH, 'utf8');
    let modified = false;

    for (const [key, propKey] of Object.entries(SETTINGS_TO_PROPS)) {
      if (body[key] === undefined || !changedKeys.includes(key)) continue;
      const val = String(body[key]);
      const re = new RegExp(`^${escapeRegex(propKey)}=.*$`, 'm');
      if (re.test(propsContent)) {
        propsContent = propsContent.replace(re, `${propKey}=${val}`);
      } else {
        propsContent += `\n${propKey}=${val}`;
      }
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(SERVER_PROPS_PATH, propsContent, 'utf8');
      log('server.properties synced from settings', 'info');
    }
  } catch (err) {
    log(`Failed to sync server.properties: ${(err as Error).message}`, 'warn');
  }
}
