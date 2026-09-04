import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { classifyLine, stripAnsi, type LineType } from './format';
import type {
  Lifecycle, PluginProgress, PluginQueue, Player, StatsSnapshot, TpsData
} from './types';

export interface ConsoleEntry {
  id: number;
  text: string;
  type: LineType;
  timestamp: string;
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface LiveState {
  socket: Socket | null;
  connected: boolean;
  status: Lifecycle;
  consoleLines: ConsoleEntry[];
  stats: StatsSnapshot | null;
  cpuHistory: number[];
  memHistory: number[];
  tps: TpsData;
  players: Player[];
  pluginQueue: PluginQueue | null;
  pluginProgress: Record<string, PluginProgress>;
  toasts: Toast[];
  pushToast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
  clearConsole: () => void;
  sendAction: (action: 'start' | 'stop' | 'kill' | 'restart') => void;
  sendCommand: (cmd: string) => void;
  locatePlayer: (name: string) => void;
}

const LiveContext = createContext<LiveState | null>(null);

const HISTORY_MAX = 2000;

let nextLineId = 1;

export function LiveProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<Lifecycle>('offline');
  const [consoleLines, setConsoleLines] = useState<ConsoleEntry[]>([]);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [tps, setTps] = useState<TpsData>({ tps: null, mspt: null });
  const [players, setPlayers] = useState<Player[]>([]);
  const [pluginQueue, setPluginQueue] = useState<PluginQueue | null>(null);
  const [pluginProgress, setPluginProgress] = useState<Record<string, PluginProgress>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pendingTail = useRef('');

  const pushToast = (kind: Toast['kind'], message: string): void => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  };

  const appendConsole = (chunk: string): void => {
    pendingTail.current += chunk;
    const full = pendingTail.current;
    // Guard: a pathological stream without newlines must not grow forever.
    if (full.length > 4096 && !full.includes('\n')) {
      pendingTail.current = '';
      appendEntry(full);
      return;
    }
    const parts = full.split('\n');
    pendingTail.current = parts.pop() ?? '';
    for (const line of parts) appendEntry(line);
  };

  const appendEntry = (raw: string): void => {
    const text = stripAnsi(raw);
    if (text === '' && raw === '') return;
    const entry: ConsoleEntry = {
      id: nextLineId++,
      text,
      type: classifyLine(text),
      timestamp: new Date().toISOString()
    };
    setConsoleLines((prev) => {
      const next = prev.length >= HISTORY_MAX ? prev.slice(prev.length - HISTORY_MAX + 1) : prev;
      return [...next, entry];
    });
  };

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));

    s.on('console-history', (history: Array<{ text: string; type: string; timestamp: string }>) => {
      const entries: ConsoleEntry[] = (history || []).map((h) => ({
        id: nextLineId++,
        text: h.text,
        type: (h.type as LineType) ?? 'default',
        timestamp: h.timestamp
      }));
      setConsoleLines(entries.slice(-HISTORY_MAX));
    });
    s.on('console', (chunk: string) => appendConsole(String(chunk ?? '')));

    s.on('status', (st: Lifecycle) => setStatus(st));
    s.on('stats', (snap: StatsSnapshot) => {
      setStats(snap);
      setCpuHistory((prev) => [...prev.slice(-119), snap.cpu]);
      setMemHistory((prev) => [...prev.slice(-119), snap.memory]);
    });
    s.on('tps', (data: TpsData) => setTps(data));
    s.on('players', (list: Player[]) => setPlayers(list));
    s.on('player-location', () => undefined); // players event carries locations
    s.on('plugin-queue', (q: PluginQueue) => setPluginQueue(q));
    s.on('plugin-progress', (p: PluginProgress) => {
      setPluginProgress((prev) => ({ ...prev, [p.pluginId]: p }));
    });
    s.on('update-progress', () => undefined); // consumed on the Updates page via its own listener
    s.on('task-ran', (t: { id: string; name: string; type: string }) => {
      appendEntry(`[TASK] ${t.name} (${t.type}) ran`);
    });

    setSocket(s);
    return () => { s.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendAction = (action: 'start' | 'stop' | 'kill' | 'restart'): void => {
    if (socket?.connected) socket.emit('action', action);
  };
  const sendCommand = (cmd: string): void => {
    if (socket?.connected) socket.emit('command', cmd);
  };
  const locatePlayer = (name: string): void => {
    if (socket?.connected) socket.emit('locate-player', name);
  };
  const clearConsole = (): void => {
    pendingTail.current = '';
    setConsoleLines([]);
  };

  const value = useMemo<LiveState>(() => ({
    socket, connected, status, consoleLines, stats, cpuHistory, memHistory, tps,
    players, pluginQueue, pluginProgress, toasts, pushToast, dismissToast: (id) =>
      setToasts((prev) => prev.filter((t) => t.id !== id)),
    clearConsole, sendAction, sendCommand, locatePlayer
  }), [socket, connected, status, consoleLines, stats, cpuHistory, memHistory, tps, players, pluginQueue, pluginProgress, toasts]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used inside LiveProvider');
  return ctx;
}
