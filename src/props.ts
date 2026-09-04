/**
 * props.ts — server.properties parsing/serialization.
 * Comments are preserved and re-emitted with their property so editing
 * one value never destroys the file's documentation.
 */

import * as fs from 'fs';
import { SERVER_PROPS_PATH } from './config';
import type { PropEntry } from './types';

export interface PropsParseResult {
  error?: string;
  properties: Record<string, PropEntry>;
  comment?: string;
}

export function parseServerProperties(): PropsParseResult {
  try {
    if (!fs.existsSync(SERVER_PROPS_PATH)) {
      return { error: 'server.properties not found', properties: {} };
    }
    const content = fs.readFileSync(SERVER_PROPS_PATH, 'utf8');
    const properties: Record<string, PropEntry> = {};
    let currentComment = '';

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        currentComment += `${trimmed}\n`;
      } else if (trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        properties[key] = { value, comment: currentComment.trim(), raw: line };
        currentComment = '';
      } else if (trimmed !== '') {
        currentComment = '';
      }
    }

    return { properties, comment: currentComment };
  } catch (err) {
    return { error: (err as Error).message, properties: {} };
  }
}

export function serializeServerProperties(propertiesMap: Record<string, PropEntry>): string {
  const lines: string[] = [];
  for (const [key, data] of Object.entries(propertiesMap)) {
    if (data.comment) {
      for (const comment of data.comment.split('\n').filter((c) => c.trim())) {
        lines.push(comment);
      }
    }
    let value = data.value;
    if (value.includes(' ') || value.includes('#') || value.includes('=')) {
      value = `"${value}"`;
    }
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n');
}
