import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, ArrowDown, Terminal as TerminalIcon } from 'lucide-react';
import { useLive, type ConsoleEntry } from '../live';
import { clx } from '../format';
import { Badge, Button, Card, EmptyState, PageHeader, Segmented } from '../components/ui';
import { ServerActions } from '../components/ServerActions';

const TYPE_STYLE: Record<string, string> = {
  error: 'text-red-300',
  warn: 'text-amber-300',
  info: 'text-zinc-400',
  debug: 'text-zinc-600 italic',
  success: 'text-emerald-300',
  system: 'text-sky-300',
  command: 'text-brand-300',
  join: 'text-emerald-400',
  leave: 'text-zinc-400',
  death: 'text-red-400/80',
  advancement: 'text-violet-300',
  chat: 'text-zinc-100',
  tick: 'text-violet-300/90',
  default: 'text-zinc-300'
};

type Filter = 'all' | 'errors' | 'warnings' | 'chat' | 'activity' | 'system';

const QUICK: Array<{ label: string; cmd: string }> = [
  { label: 'list', cmd: 'list' },
  { label: 'tps', cmd: 'tps' },
  { label: 'save-all', cmd: 'save-all' },
  { label: 'help', cmd: 'help' }
];

function matchesFilter(e: ConsoleEntry, f: Filter): boolean {
  switch (f) {
    case 'errors': return e.type === 'error';
    case 'warnings': return e.type === 'warn';
    case 'chat': return e.type === 'chat' || e.type === 'join' || e.type === 'leave' || e.type === 'death' || e.type === 'advancement';
    case 'activity': return e.type === 'success' || e.type === 'tick' || e.type === 'command' || e.type === 'info';
    case 'system': return e.type === 'system' || e.type === 'error' || e.type === 'warn';
    default: return true;
  }
}

export function ConsolePage(): React.JSX.Element {
  const live = useLive();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const lines = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = live.consoleLines.filter((l) => matchesFilter(l, filter));
    if (q) out = out.filter((l) => l.text.toLowerCase().includes(q));
    return out.slice(-1400);
  }, [live.consoleLines, filter, search]);

  // Autoscroll while the user is reading the bottom of the stream.
  useEffect(() => {
    const el = viewportRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, lines[lines.length - 1]?.text]);

  const onScroll = (): void => {
    const el = viewportRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = (): void => {
    const c = cmd.trim();
    if (!c) return;
    live.sendCommand(c);
    setHistory((h) => [...h.slice(-49), c]);
    setCmd('');
    setHistIdx(-1);
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setCmd(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(-1); setCmd(''); return; }
      setHistIdx(idx);
      setCmd(history[idx]);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: live.consoleLines.length };
    for (const l of live.consoleLines) {
      if (l.type === 'error' || l.type === 'warn') c.errors = (c.errors ?? 0) + 1;
      if (l.type === 'chat' || l.type === 'join' || l.type === 'leave') c.chat = (c.chat ?? 0) + 1;
      if (l.type === 'system' || l.type === 'error' || l.type === 'warn') c.system = (c.system ?? 0) + 1;
    }
    return c;
  }, [live.consoleLines]);

  return (
    <>
      <PageHeader
        title="Console"
        description="Live Minecraft server output — commands go straight to the process."
        actions={<ServerActions size="sm" />}
      />

      <Card pad={false}>
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${counts.all ?? 0}` },
              { value: 'errors', label: `Errors ${counts.errors ?? 0}` },
              { value: 'warnings', label: 'Warnings' },
              { value: 'chat', label: 'Chat' },
              { value: 'system', label: 'System' }
            ]}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter lines…"
            className="ml-auto h-8 w-48 rounded-lg border border-line bg-ink-850 px-3 text-xs text-zinc-200 outline-none focus:border-brand-500/60"
          />
          <Button size="sm" variant="ghost" icon={<Eraser className="h-3.5 w-3.5" />} onClick={() => live.clearConsole()}>
            Clear
          </Button>
        </div>

        {/* terminal */}
        <div className="relative">
          <div
            ref={viewportRef}
            onScroll={onScroll}
            className="h-[62vh] min-h-[360px] overflow-y-auto bg-[#0a0a10] px-4 py-3 font-mono text-[12.5px] leading-[1.55]"
          >
            {lines.length === 0 ? (
              <EmptyState
                icon={<TerminalIcon className="h-6 w-6" />}
                title={live.consoleLines.length === 0 ? 'Console is empty' : 'No lines match your filters'}
                hint={live.status === 'offline'
                  ? 'Start the server — its output streams here in real time.'
                  : 'Output will appear as soon as the server writes to stdout.'}
              />
            ) : (
              lines.map((l) => (
                <div key={l.id} className={clx('flex gap-3 whitespace-pre-wrap break-words', TYPE_STYLE[l.type] ?? TYPE_STYLE.default)}>
                  <span className="shrink-0 select-none text-zinc-700">
                    {new Date(l.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                  </span>
                  <span className="min-w-0 flex-1">{l.text || '\u00A0'}</span>
                </div>
              ))
            )}
          </div>

          {!stickToBottom.current && lines.length > 0 && (
            <button
              type="button"
              onClick={() => {
                stickToBottom.current = true;
                const el = viewportRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="absolute bottom-3 right-4 flex items-center gap-1.5 rounded-full border border-brand-500/40 bg-ink-800 px-3 py-1.5 text-xs font-medium text-brand-300 shadow-lg hover:bg-ink-700"
            >
              <ArrowDown className="h-3.5 w-3.5" /> Resume scroll
            </button>
          )}
        </div>

        {/* input */}
        <div className="border-t border-line-soft px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-brand-400">$</span>
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={onKey}
              disabled={live.status !== 'online'}
              placeholder={live.status === 'online' ? 'Type a Minecraft command… (e.g. say hello)' : 'Start the server to send commands'}
              spellCheck={false}
              autoComplete="off"
              className="h-9 flex-1 rounded-lg border border-line bg-ink-850 px-3 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-brand-500/60 disabled:opacity-60"
            />
            <Button variant="primary" onClick={submit} disabled={!cmd.trim() || live.status !== 'online'}>Send</Button>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-zinc-600">Quick</span>
            {QUICK.map((q) => (
              <button
                key={q.cmd}
                type="button"
                disabled={live.status !== 'online'}
                onClick={() => { setCmd(q.cmd); }}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition-colors hover:border-brand-500/40 hover:text-brand-300 disabled:opacity-50"
              >
                {q.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              {live.connected && <Badge tone="green"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" /> streaming</Badge>}
              <Badge tone="zinc">{lines.length} shown</Badge>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
