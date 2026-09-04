import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, DownloadCloud, RefreshCcw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { get, post } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { clx } from '../format';
import {
  Badge, Button, Card, EmptyState, PageHeader, Select, Spinner, StatusDot
} from '../components/ui';
import type { UpdateCheck } from '../types';

interface ProgressLine {
  text: string;
  level: 'system' | 'info' | 'warn' | 'error' | 'success';
  timestamp: string;
}

const LEVEL_STYLE: Record<ProgressLine['level'], string> = {
  system: 'text-sky-300',
  info: 'text-zinc-400',
  warn: 'text-amber-300',
  error: 'text-red-300',
  success: 'text-emerald-300'
};

export function UpdatesPage(): React.JSX.Element {
  const live = useLive();
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState<{ success: boolean; message: string } | null>(null);
  const [branch, setBranch] = useState<string>('main');
  const logRef = useRef<HTMLDivElement>(null);

  const loader = useCallback(async () => get<UpdateCheck>('/api/update/check'), []);
  const { data, loading, reload } = useAsync(loader, []);
  const check = data;

  // Sync branch from server response
  useEffect(() => {
    if (check?.branch) setBranch(check.branch);
  }, [check?.branch]);

  useEffect(() => {
    const s = live.socket;
    if (!s) return;
    const onProgress = (line: ProgressLine): void => {
      setProgress((prev) => [...prev.slice(-400), line]);
      setCompleted(null);
    };
    const onComplete = (payload: { success: boolean; message: string }): void => {
      setRunning(false);
      setCompleted(payload);
      if (!payload.success) live.pushToast('error', payload.message);
    };
    s.on('update-progress', onProgress);
    s.on('update-complete', onComplete);
    return () => {
      s.off('update-progress', onProgress);
      s.off('update-complete', onComplete);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.socket]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress.length]);

  const checkForUpdates = async (): Promise<void> => {
    const r = await get<UpdateCheck>(`/api/update/check?branch=${branch}`);
    if (r.ok) reload();
  };

  const install = async (): Promise<void> => {
    setRunning(true);
    setProgress([]);
    setCompleted(null);
    const r = await post('/api/update/install', { branch });
    if (!r.ok) {
      setRunning(false);
      live.pushToast('error', r.error.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Updates"
        description="The panel updates itself straight from its GitHub repository — runtime data is preserved."
        actions={
          <div className="flex items-center gap-2">
            <Select
              className="w-32"
              value={branch}
              onChange={setBranch}
              options={[
                { value: 'main', label: 'main — stable' },
                { value: 'dev', label: 'dev — latest' }
              ]}
            />
            <Button size="sm" variant="ghost" icon={<RefreshCcw className="h-4 w-4" />} onClick={checkForUpdates} disabled={running}>Check</Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <Spinner label="Checking for updates…" />
        ) : !check ? null : (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-800 text-brand-300">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">installed</p>
                <p className="font-mono text-xl font-semibold text-zinc-100">v{check.currentVersion}</p>
              </div>
            </div>
            <div className="text-zinc-600">→</div>
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-800 text-zinc-300">
                <DownloadCloud className="h-5 w-5" />
              </span>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">repository</p>
                <p className="font-mono text-xl font-semibold text-zinc-100">v{check.latestVersion}</p>
              </div>
            </div>

            <div className="ml-auto flex flex-col items-end gap-2">
              {check.checkBlocked ? (
                <Badge tone="red">check blocked</Badge>
              ) : check.updateAvailable ? (
                <Button variant="primary" icon={<DownloadCloud className="h-4 w-4" />} loading={running} onClick={install}>
                  Install update
                </Button>
              ) : (
                <Badge tone="green"><CheckCircle2 className="h-3 w-3" /> up to date</Badge>
              )}
              <Badge tone="zinc">branch {branch}</Badge>
            </div>
          </div>
        )}
        {check && (
          <p className="mt-4 border-t border-line-soft pt-3 text-sm text-zinc-500">{check.message}</p>
        )}
      </Card>

      {(progress.length > 0 || completed) && (
        <Card className="mt-4" title="Install log" subtitle="live output from the deployment pipeline">
          <div ref={logRef} className="h-64 overflow-y-auto rounded-lg bg-[#0a0a10] p-3 font-mono text-[12px] leading-relaxed">
            {progress.map((l, i) => (
              <p key={i} className={clx('whitespace-pre-wrap', LEVEL_STYLE[l.level])}>
                <span className="mr-2 select-none text-zinc-700">
                  {new Date(l.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                {l.text}
              </p>
            ))}
            {completed && (
              <p className={clx('mt-1 font-semibold', completed.success ? 'text-emerald-300' : 'text-red-300')}>
                {completed.success ? '✓ ' : '✗ '}{completed.message}
              </p>
            )}
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <div className="flex items-start gap-2 text-xs leading-relaxed text-zinc-600">
          <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
          <p>
            Updates compare <span className="font-mono text-zinc-400">version.json</span> against the repo, stream progress
            here over sockets, and never touch <span className="font-mono text-zinc-400">server/</span>,{' '}
            <span className="font-mono text-zinc-400">config/</span>, <span className="font-mono text-zinc-400">backups/</span>{' '}
            or <span className="font-mono text-zinc-400">node_modules/</span>. After new files land, the panel rebuilds the
            server and web client automatically, then restarts itself.
          </p>
        </div>
      </Card>
    </>
  );
}
