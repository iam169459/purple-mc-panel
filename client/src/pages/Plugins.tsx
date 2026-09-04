import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CloudDownload, Puzzle, Search, Trash2, Upload, Rocket, AlertCircle, CheckCircle2, Loader2
} from 'lucide-react';
import { del, get, post, upload } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { clx, fmtBytes, fmtNumber, fmtTime } from '../format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, PageHeader,
  ProgressBar, Segmented, Spinner, TextInput
} from '../components/ui';
import type { EssentialPlugin, InstalledPlugin, PluginHit } from '../types';

interface EssentialResponse { success: boolean; plugins: EssentialPlugin[] }
interface InstalledResponse { success: boolean; plugins: InstalledPlugin[] }
interface SearchResponse {
  success: boolean; page: number; perPage: number; count: number;
  plugins: PluginHit[];
}

export function PluginsPage(): React.JSX.Element {
  const live = useLive();
  const [tab, setTab] = useState<'installed' | 'market'>('installed');
  return (
    <>
      <PageHeader
        title="Plugins"
        description="Manage jars in the plugins folder and discover new ones from Modrinth."
        actions={
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-ink-800 px-3.5 text-sm font-medium text-zinc-200 hover:bg-ink-700">
            <Upload className="h-4 w-4" />
            Upload .jar
            <input type="file" accept=".jar" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const r = await upload('/api/plugins/upload', 'plugin', f);
              if (!r.ok) { live.pushToast('error', r.error.message); return; }
              live.pushToast('success', `${f.name} uploaded${(r.data as { needsRestart?: boolean }).needsRestart ? ' — restart to load' : ''}`);
            }} />
          </label>
        }
      />

      <div className="mb-4 flex items-center justify-between gap-3">
        <Segmented<'installed' | 'market'>
          value={tab}
          onChange={setTab}
          options={[{ value: 'installed', label: 'Installed' }, { value: 'market', label: 'Marketplace' }]}
        />
        <QueuePill />
      </div>

      {tab === 'installed' ? <InstalledTab /> : <MarketTab />}
      <QueuePanel />
    </>
  );
}

function QueuePill(): React.JSX.Element | null {
  const { pluginQueue } = useLive();
  const active = pluginQueue?.active ?? 0;
  const queued = pluginQueue?.queued ?? 0;
  if (!active && !queued) return null;
  return (
    <Badge tone="brand">
      <Loader2 className="h-3 w-3 animate-spin" />
      {active ? '1 installing' : ''}{queued ? ` · ${queued} queued` : ''}
    </Badge>
  );
}

// ----------------------------------------------------------------------
// Installed
// ----------------------------------------------------------------------

function InstalledTab(): React.JSX.Element {
  const live = useLive();
  const { data, loading, reload } = useAsync<InstalledResponse>(() => get('/api/plugins/installed'), []);
  const [remove, setRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Card pad={false} title={`Installed plugins (${data?.plugins.length ?? 0})`}
      actions={loading ? <Spinner /> : <Button size="sm" variant="ghost" onClick={reload}>Refresh</Button>}>
      {loading ? (
        <div className="flex justify-center py-16"><Spinner label="Scanning plugins folder…" /></div>
      ) : (data?.plugins.length ?? 0) === 0 ? (
        <EmptyState icon={<Puzzle className="h-6 w-6" />} title="No plugins installed"
          hint="Upload a .jar, or grab one from the Marketplace tab." />
      ) : (
        <ul className="divide-y divide-line-soft">
          {data!.plugins.map((p) => (
            <li key={p.name} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-850/50">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-brand-300"><Puzzle className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm text-zinc-200">{p.name}</p>
                <p className="text-[11px] text-zinc-600">{fmtBytes(p.size)} · modified {fmtTime(p.modified)}</p>
              </div>
              {live.status === 'online' && <Badge tone="amber">loads on restart</Badge>}
              <IconButton title="Delete plugin" danger icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemove(p.name)} />
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!remove}
        title="Delete plugin?"
        message={<span className="break-all">Remove <b>{remove}</b> from the plugins folder? It will take effect after the next restart.</span>}
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setRemove(null)}
        onConfirm={async () => {
          setBusy(true);
          const r = await del(`/api/plugins/${encodeURIComponent(remove!)}`);
          setBusy(false);
          if (!r.ok) { live.pushToast('error', r.error.message); setRemove(null); return; }
          live.pushToast('success', `Deleted ${remove}`);
          setRemove(null);
          reload();
        }}
      />
    </Card>
  );
}

// ----------------------------------------------------------------------
// Marketplace
// ----------------------------------------------------------------------

function MarketTab(): React.JSX.Element {
  const live = useLive();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 450);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => { setPage(1); }, [debounced]);

  const { data: essential } = useAsync<EssentialResponse>(() => get('/api/plugins/essential'), []);
  const { data: installed, reload: reloadInstalled } = useAsync<InstalledResponse>(() => get('/api/plugins/installed'), []);
  const [installingAll, setInstallingAll] = useState(false);

  // Match an essential plugin to jars already on disk by their alpha slug, so
  // versioned filenames like "LuckPerms-Bukkit-5.4.164.jar" count as installed.
  const installedJarSlugs = useMemo(
    () => (installed?.plugins ?? []).map((p) => p.name.toLowerCase().replace(/[^a-z0-9]/g, '')),
    [installed]
  );
  const isInstalled = (p: EssentialPlugin | PluginHit): boolean => {
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return installedJarSlugs.some((jar) => jar.includes(slug));
  };
  const essentials = essential?.plugins ?? [];
  const allInstalled = essentials.length > 0 && essentials.every(isInstalled);

  const install = async (hit: PluginHit | EssentialPlugin): Promise<boolean> => {
    setInstalling((s) => new Set(s).add(hit.id));
    const r = await post('/api/plugins/install', { resourceId: hit.id, source: hit.source, name: hit.name });
    setInstalling((s) => { const n = new Set(s); n.delete(hit.id); return n; });
    if (!r.ok) {
      // Queue errors surface over sockets too; avoid double-reporting.
      if (r.error.status === 404) live.pushToast('error', r.error.message);
      else live.pushToast('info', `${hit.name}: ${r.error.message}`);
      return false;
    }
    reloadInstalled();
    return true;
  };
  const loader = useCallback(async () => {
    if (debounced.length < 2) return { ok: true as const, data: { success: false, page: 1, perPage: 12, count: 0, plugins: [] as PluginHit[] } };
    return get<SearchResponse>(`/api/plugins/search?q=${encodeURIComponent(debounced)}&page=${page}&per_page=12`);
  }, [debounced, page]);
  const { data: search, loading, error } = useAsync(loader, [debounced, page]);

  return (
    <div className="space-y-4">
      {/* essential pack */}
      <Card
        title="Essential starter pack"
        subtitle="Curated, Paper-compatible essentials — installed automatically on a fresh setup unless disabled in Settings"
        actions={
          <Button
            size="sm" variant="primary"
            icon={installingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : allInstalled ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Rocket className="h-3.5 w-3.5" />}
            loading={installingAll}
            disabled={allInstalled || essentials.length === 0}
            onClick={async () => {
              setInstallingAll(true);
              for (const p of essentials) await install(p);
              setInstallingAll(false);
              reloadInstalled();
              live.pushToast('success', 'Starter pack installs finished — they load on the next server restart');
            }}
          >
            {installingAll ? 'Installing…' : allInstalled ? 'All installed' : 'Install all'}
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2">
          {essentials.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-lg border border-line bg-ink-850 py-1.5 pl-1.5 pr-2">
              <img src={p.icon} alt="" className="h-6 w-6 rounded" loading="lazy" />
              <span className="text-xs font-medium text-zinc-300">{p.name}</span>
              {isInstalled(p) ? (
                <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Installed
                </span>
              ) : (
                <button
                  disabled={installing.has(p.id) || installingAll}
                  onClick={async () => { if (await install(p)) live.pushToast('success', `${p.name} installed — loads on next server restart`); }}
                  className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand-300 hover:bg-brand-500/10 disabled:opacity-50"
                >
                  {installing.has(p.id) ? 'Queued…' : 'Install'}
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Modrinth for plugins… (e.g. essentials, griefprevention)"
          className="h-10 w-full rounded-xl border border-line bg-ink-850 pl-9 pr-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/15"
        />
      </div>

      {debounced.length < 2 ? (
        <EmptyState icon={<Rocket className="h-6 w-6" />} title="Search the marketplace"
          hint="Type at least two characters. Results are filtered to Paper/Spigot-compatible builds." />
      ) : loading ? (
        <div className="flex justify-center py-14"><Spinner label="Searching marketplaces…" /></div>
      ) : error ? (
        <EmptyState icon={<AlertCircle className="h-6 w-6" />} title="Search failed" hint={error} />
      ) : (search?.plugins.length ?? 0) === 0 ? (
        <EmptyState icon={<Search className="h-6 w-6" />} title={`Nothing found for “${debounced}”`}
          hint="Try a broader term, or check the Spigot fallback worked." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {search!.plugins.map((p) => (
            <div key={`${p.source}-${p.id}`} className="flex flex-col rounded-xl border border-line bg-ink-900/80 p-3.5 transition-colors hover:border-brand-500/30">
              <div className="flex items-start gap-3">
                {p.icon
                  ? <img src={p.icon} alt="" className="h-9 w-9 shrink-0 rounded-lg bg-ink-800 object-cover" loading="lazy" />
                  : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-brand-300"><Puzzle className="h-4 w-4" /></span>}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-100">{p.name}</p>
                  <p className="text-[11px] text-zinc-600">{p.author} · {fmtNumber(p.downloads)} downloads</p>
                </div>
              </div>
              <p className="mt-2.5 line-clamp-3 flex-1 text-xs leading-relaxed text-zinc-500">{p.description || 'No description available.'}</p>
              <div className="mt-3 flex items-center justify-between">
                <Badge tone={p.source === 'modrinth' ? 'violet' : 'sky'}>{p.source}</Badge>
                <Button
                  size="sm" variant="secondary"
                  icon={installing.has(p.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
                  disabled={installing.has(p.id)}
                  onClick={() => install(p)}
                >
                  {installing.has(p.id) ? 'Installing' : 'Install'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(search?.plugins.length ?? 0) > 0 && (
        <div className="flex items-center justify-between">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</Button>
          <span className="text-xs text-zinc-600">page {search?.page}</span>
          <Button size="sm" variant="ghost" disabled={(search?.plugins.length ?? 0) < 12} onClick={() => setPage((p) => p + 1)}>Next →</Button>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Install queue readout
// ----------------------------------------------------------------------

function QueuePanel(): React.JSX.Element | null {
  const { pluginProgress, pluginQueue } = useLive();
  const entries = Object.entries(pluginProgress).filter(([, p]) => p.stage !== 'complete');
  if (!pluginQueue && entries.length === 0) return null;
  if (entries.length === 0 && (pluginQueue?.active ?? 0) === 0) return null;

  return (
    <Card className="mt-4" title="Install queue" subtitle="Installs run one at a time; jars load on the next server restart">
      <ul className="space-y-2.5">
        {entries.map(([id, p]) => (
          <li key={id} className={clx('rounded-lg border px-3 py-2.5', p.stage === 'error' ? 'border-red-500/30 bg-red-500/5' : 'border-line bg-ink-850')}>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 font-medium text-zinc-300">
                {p.stage === 'error'
                  ? <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                  : p.stage === 'complete'
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    : <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-400" />}
                <span className="font-mono">{id.slice(0, 40)}{id.length > 40 ? '…' : ''}</span>
              </span>
              <Badge tone={p.stage === 'error' ? 'red' : p.stage === 'downloading' ? 'brand' : 'zinc'}>{p.stage}</Badge>
            </div>
            {p.stage === 'downloading' && <ProgressBar value={p.percent} tone="brand" />}
            <p className={clx('mt-1 truncate text-[11px]', p.stage === 'error' ? 'text-red-300' : 'text-zinc-500')}>{p.message}</p>
          </li>
        ))}
        {entries.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {pluginQueue?.queued} more queued…</p>
        )}
      </ul>
    </Card>
  );
}
