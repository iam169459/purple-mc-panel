import { useNavigate } from 'react-router-dom';
import {
  Activity, Cpu, MemoryStick, Users, Timer, Gauge, AlertTriangle,
  Radio, HardDrive, FolderOpen, Megaphone, Save, Crosshair
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { get } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { fmtBytes, fmtDuration, timeAgo } from '../format';
import { Badge, Button, Card, EmptyState, PageHeader, ProgressBar, Sparkline, StatCard, StatusDot } from '../components/ui';
import { ServerActions } from '../components/ServerActions';
import type { CrashLogEntry, FileStorage } from '../types';

interface StatusPayload {
  running: boolean;
  uptime: number;
  players: Array<{ name: string }>;
  allocation: { maxRam: string; autoResource: boolean };
}

export function Dashboard(): React.JSX.Element {
  const live = useLive();
  const navigate = useNavigate();
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [message, setMessage] = useState('');

  const { data: status, loading: statusLoading } = useAsync<StatusPayload>(() => get('/api/status'), []);
  const { data: storage, reload: reloadStorage } = useAsync<FileStorage>(() => get('/api/files/storage'), []);
  const { data: crashes, reload: reloadCrashes } = useAsync<{ success: boolean; logs: CrashLogEntry[] }>(() => get('/api/crash-log'), []);

  // Refresh REST-backed bits periodically (storage sizes change with the world).
  useEffect(() => {
    const t = setInterval(() => { reloadStorage(); reloadCrashes(); }, 30000);
    return () => clearInterval(t);
  }, [reloadStorage, reloadCrashes]);

  const sys = live.stats?.system;
  const processMem = live.stats?.memory ?? 0;
  const running = live.status === 'online';
  const tpsVal = live.tps.tps?.tps5m;

  const quick = (cmd: string): void => { live.sendCommand(cmd); live.pushToast('info', `Sent: ${cmd}`); };

  const totalBytes = storage?.server.totalBytes ?? 0;
  const folders = (storage?.folders ?? []).slice(0, 7);
  const totalMem = sys?.ram.totalMB ?? 1;
  const totalCpu = sys?.cpu.cores ?? 1;
  const hostUsed = storage?.host?.usedPercent;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Node ${sys?.hostname ?? '…'} · ${sys?.cpu.cores ?? 0} cores · ${fmtBytes((sys?.ram.totalGB ?? 0) * 1073741824)} RAM`}
        actions={<ServerActions />}
      />

      {/* ── live stat cards ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Status" accent={running ? 'ok' : live.status === 'starting' || live.status === 'stopping' ? 'warn' : 'default'}
          value={<span className="flex items-center gap-2 text-lg">
            <StatusDot color={running ? 'bg-emerald-400' : 'bg-zinc-600'} pulse={running} />
            {running ? 'Online' : live.status === 'starting' ? 'Starting' : live.status === 'stopping' ? 'Stopping' : 'Offline'}
          </span>}
          sub={running ? 'accepting players' : 'not running'}
          icon={<Radio className="h-4 w-4" />}
        />
        <StatCard
          label="Uptime"
          value={fmtDuration(live.stats?.uptime ?? status?.uptime ?? 0)}
          sub={running ? 'since start' : 'session ended'}
          icon={<Timer className="h-4 w-4" />}
        />
        <StatCard
          label="Players"
          value={live.players.length}
          sub="parsed live from console"
          icon={<Users className="h-4 w-4" />}
        />
        <StatCard
          label="CPU"
          value={`${live.stats?.cpu ?? 0}%`}
          sub={`${totalCpu} cores available`}
          icon={<Cpu className="h-4 w-4" />}
          accent="brand"
        />
        <StatCard
          label="Server RAM"
          value={`${processMem} MB`}
          sub={`heap max ${live.stats?.allocation?.maxRam ?? '—'}`}
          icon={<MemoryStick className="h-4 w-4" />}
        />
        <StatCard
          label="TPS"
          value={tpsVal ? tpsVal.toFixed(1) : '—'}
          sub={live.tps.mspt ? `${live.tps.mspt.toFixed(1)} mspt` : 'no reading yet'}
          icon={<Gauge className="h-4 w-4" />}
          accent={tpsVal != null && tpsVal < 18 ? 'warn' : 'default'}
        />
      </div>

      {/* ── history + actions ── */}
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card title="CPU history" subtitle="process CPU · 2s samples" pad={false}>
          <div className="flex items-center justify-between p-4 pb-1">
            <span className="text-2xl font-semibold font-mono text-zinc-100">{live.stats?.cpu ?? 0}%</span>
            <Sparkline data={live.cpuHistory} width={200} height={48} stroke="#818cf8" />
          </div>
          <div className="px-4 pb-3"><ProgressBar value={live.stats?.cpu ?? 0} tone="brand" /></div>
        </Card>
        <Card title="Memory" subtitle="process RSS (MB)" pad={false}>
          <div className="flex items-center justify-between p-4 pb-1">
            <span className="text-2xl font-semibold font-mono text-zinc-100">{live.stats?.memory ?? 0} MB</span>
            <Sparkline data={live.memHistory} width={200} height={48} stroke="#34d399" />
          </div>
          <div className="px-4 pb-3"><ProgressBar value={Math.min(100, ((live.stats?.memory ?? 0) / Math.max(1, parseRamMB(live.stats?.allocation?.maxRam))) * 100)} tone="green" /></div>
        </Card>
        <Card title="Quick actions" subtitle="send commands to the running server">
          <div className="grid grid-cols-2 gap-2">
            <Button icon={<Megaphone className="h-4 w-4" />} onClick={() => { setBroadcastOpen(true); }} disabled={!running}>Broadcast</Button>
            <Button icon={<Save className="h-4 w-4" />} onClick={() => quick('save-all')} disabled={!running}>Save all</Button>
            <Button icon={<Activity className="h-4 w-4" />} onClick={() => quick('tps')} disabled={!running}>Check TPS</Button>
            <Button icon={<Crosshair className="h-4 w-4" />} onClick={() => quick('list')} disabled={!running}>Player list</Button>
          </div>
          {!running && <p className="mt-3 text-xs text-zinc-600">Start the server to use console commands.</p>}
        </Card>
      </div>

      {/* ── system + storage ── */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card title="Host resources" subtitle="machine-wide usage">
          {sys ? (
            <div className="space-y-4">
              <div>
                <div className="mb-1 flex justify-between text-xs text-zinc-400">
                  <span>System memory — {sys.ram.usedGB}/{sys.ram.totalGB} GB used</span>
                  <span className="font-mono">{sys.ram.usagePercent}%</span>
                </div>
                <ProgressBar value={sys.ram.usagePercent} tone={sys.ram.usagePercent > 85 ? 'red' : sys.ram.usagePercent > 70 ? 'amber' : 'brand'} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs text-zinc-400">
                  <span>Load average (1/5/15m)</span>
                  <span className="font-mono">{sys.cpu.loadAvg1m.toFixed(2)} / {sys.cpu.loadAvg5m.toFixed(2)} / {sys.cpu.loadAvg15m.toFixed(2)}</span>
                </div>
                <ProgressBar value={Math.min(100, (sys.cpu.loadAvg1m / Math.max(1, sys.cpu.cores)) * 100)} tone="brand" />
              </div>
              {hostUsed != null && (
                <div>
                  <div className="mb-1 flex justify-between text-xs text-zinc-400">
                    <span>Host disk — {storage?.host?.freeGB} GB free</span>
                    <span className="font-mono">{hostUsed}% used</span>
                  </div>
                  <ProgressBar value={hostUsed} tone={hostUsed > 90 ? 'red' : 'brand'} />
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon={<Cpu className="h-6 w-6" />} title="No telemetry yet" hint="Metrics appear while a client is connected." />
          )}
        </Card>

        <Card
          title="Server storage" pad={false}
          subtitle={!storage ? 'measuring…' : `${fmtBytes(totalBytes)} across the server directory`}
          actions={<Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => navigate('/files')}>Open files</Button>}
        >
          <div className="p-4">
            {folders.length === 0 ? (
              <EmptyState icon={<HardDrive className="h-6 w-6" />} title="Nothing stored yet" hint="Worlds, plugins and logs will show up here once the server runs." />
            ) : (
              <ul className="space-y-2.5">
                {folders.map((f) => (
                  <li key={f.name}>
                    <button
                      type="button"
                      onClick={() => navigate(`/files?path=${encodeURIComponent(f.name)}`)}
                      className="group block w-full text-left"
                    >
                      <div className="mb-1 flex items-baseline justify-between text-xs">
                        <span className="font-medium text-zinc-300 group-hover:text-brand-300">{f.name}</span>
                        <span className="font-mono text-zinc-500">{fmtBytes(f.totalBytes)}</span>
                      </div>
                      <ProgressBar value={totalBytes > 0 ? (f.totalBytes / totalBytes) * 100 : 0} tone="brand" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* ── players + incidents ── */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card
          title="Online players" pad={false}
          actions={live.players.length > 0 ? <Button size="sm" variant="ghost" onClick={() => navigate('/players')}>Manage</Button> : undefined}
        >
          {live.players.length === 0 ? (
            <EmptyState icon={<Users className="h-6 w-6" />} title="No players online" hint="Joins and leaves appear here in real time." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {live.players.slice(0, 8).map((p) => (
                <li key={p.name} className="flex items-center justify-between px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm text-zinc-300">
                    <StatusDot color="bg-emerald-400" pulse />
                    {p.name}
                  </span>
                  <span className="text-xs text-zinc-600">{timeAgo(p.joinedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent incidents" pad={false}
          subtitle="crash log entries"
          actions={(crashes?.logs.length ?? 0) > 0
            ? <Button size="sm" variant="ghost" onClick={() => navigate('/server')}>View crash log</Button>
            : undefined}
        >
          {(crashes?.logs.length ?? 0) === 0 ? (
            <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="No crashes recorded" hint="If the server ever crashes, the diagnosis lands here." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {crashes!.logs.slice(0, 5).map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-300">{c.reason.replace(/_/g, ' ')}</p>
                    <p className="text-xs text-zinc-600">{timeAgo(c.timestamp)} · exit code {c.exitCode ?? '—'}</p>
                  </div>
                  <Badge tone={c.severity === 'critical' ? 'red' : c.severity === 'high' ? 'amber' : 'zinc'}>{c.severity}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {broadcastOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setBroadcastOpen(false); }}>
          <div className="mt-[20vh] w-full max-w-md rounded-2xl border border-line bg-ink-900 p-5 shadow-2xl animate-rise-in">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Broadcast a message</h3>
            <input
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && message.trim()) {
                  live.sendCommand(`say ${message.trim()}`); live.pushToast('success', 'Message sent');
                  setMessage(''); setBroadcastOpen(false);
                }
              }}
              placeholder="Hello everyone…"
              className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setBroadcastOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => { live.sendCommand(`say ${message.trim()}`); live.pushToast('success', 'Message sent'); setMessage(''); setBroadcastOpen(false); }}>Send</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function parseRamMB(ram: string | undefined): number {
  if (!ram) return 2048;
  const m = ram.match(/^(\d+)([MG])$/i);
  if (!m) return 2048;
  return Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1);
}
