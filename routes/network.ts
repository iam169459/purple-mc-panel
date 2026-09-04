/**
 * routes/network.ts — network & port mapper endpoints.
 */

import * as os from 'os';
import type { Express, Request, Response } from 'express';
import { sendError } from '../src/context';
import {
  checkPort, getLocalIP, getNetworkStatus, loadAllocations, saveAllocations
} from '../src/network';
import type { PortAllocation } from '../src/types';

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function register(app: Express): void {
  app.get('/api/network/status', async (_req: Request, res: Response) => {
    try {
      const status = await getNetworkStatus();
      res.json(status);
    } catch {
      sendError(res, 'Failed to get network status', 500);
    }
  });

  app.get('/api/network', (_req: Request, res: Response) => {
    res.json({ ip: getLocalIP().address, hostname: os.hostname() });
  });

  app.post('/api/network/allocate', async (req: Request, res: Response) => {
    const body = req.body as { port?: unknown; service?: string; description?: string };
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendError(res, 'Invalid port number (1-65535 required)');
    }

    try {
      const available = await checkPort(port);
      if (!available) {
        return res.status(409).json({ error: 'Port is already in use', port, status: 'in-use' });
      }

      const allocations = loadAllocations();
      const newEntry: PortAllocation = {
        id: makeId('alloc'),
        port,
        service: body.service || 'Unknown',
        description: body.description || '',
        status: 'active',
        allocatedAt: new Date().toISOString()
      };

      const existingIndex = allocations.findIndex((a) => a.port === port);
      if (existingIndex !== -1) {
        allocations[existingIndex] = newEntry;
      } else {
        allocations.push(newEntry);
      }

      saveAllocations(allocations);
      res.json({ success: true, port, service: newEntry.service, message: 'Port allocated successfully' });
    } catch {
      sendError(res, 'Failed to allocate port', 500);
    }
  });

  app.delete('/api/network/allocate/:port', (req: Request, res: Response) => {
    const port = parseInt(req.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return sendError(res, 'Invalid port number');
    }
    try {
      const allocations = loadAllocations();
      const index = allocations.findIndex((a) => a.port === port);
      if (index === -1) return sendError(res, 'Port allocation not found', 404);
      allocations.splice(index, 1);
      saveAllocations(allocations);
      res.json({ success: true, port, message: 'Port deallocated successfully' });
    } catch {
      sendError(res, 'Failed to deallocate port', 500);
    }
  });
}
