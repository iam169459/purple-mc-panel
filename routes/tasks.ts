/**
 * routes/tasks.ts — scheduled task endpoints.
 */

import type { Express, Request, Response } from 'express';
import { sendError } from '../src/context';
import { loadTasks, saveTasks } from '../src/tasks';
import type { Task } from '../src/types';

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function register(app: Express): void {
  app.get('/api/tasks', (_req: Request, res: Response) => {
    res.json({ success: true, tasks: loadTasks() });
  });

  app.post('/api/tasks', (req: Request, res: Response) => {
    const body = req.body as {
      name?: string; type?: string; command?: string; intervalMinutes?: number; enabled?: boolean;
    };
    const { name, type, command, intervalMinutes, enabled } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return sendError(res, 'Task name is required');
    }
    if (!['command', 'restart', 'backup'].includes(type ?? '')) {
      return sendError(res, 'Invalid task type');
    }
    const interval = parseInt(String(intervalMinutes), 10);
    if (isNaN(interval) || interval < 1 || interval > 24 * 60) {
      return sendError(res, 'Interval must be between 1 and 1440 minutes');
    }
    if (type === 'command' && (!command || !command.trim())) {
      return sendError(res, 'Command is required for command tasks');
    }

    const tasks = loadTasks();
    const task: Task = {
      id: makeId('task'),
      name: (name as string).trim().slice(0, 100),
      type: type as Task['type'],
      command: type === 'command' ? (command as string).trim().slice(0, 500) : '',
      intervalMinutes: interval,
      enabled: enabled !== false,
      lastRun: null,
      createdAt: new Date().toISOString()
    };
    tasks.push(task);
    if (!saveTasks(tasks)) return sendError(res, 'Failed to save task', 500);
    res.json({ success: true, task });
  });

  app.delete('/api/tasks/:id', (req: Request, res: Response) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return sendError(res, 'Task not found', 404);
    tasks.splice(idx, 1);
    if (!saveTasks(tasks)) return sendError(res, 'Failed to save tasks', 500);
    res.json({ success: true });
  });

  app.post('/api/tasks/:id/toggle', (req: Request, res: Response) => {
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === req.params.id);
    if (!task) return sendError(res, 'Task not found', 404);
    task.enabled = !task.enabled;
    if (!saveTasks(tasks)) return sendError(res, 'Failed to save tasks', 500);
    res.json({ success: true, enabled: task.enabled });
  });
}
