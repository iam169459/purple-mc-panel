import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Save, ServerCog, Trash2, ChevronDown } from 'lucide-react';
import { get, post } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { fmtTime, timeAgo, clx } from '../format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Field, PageHeader, Segmented,
  Spinner, TextInput
} from '../components/ui';
import type { CrashLogEntry } from '../types';

interface PropsResponse {
  success: boolean;
  properties: Record<string, string>;
  raw: string;
}

const BOOLEAN_KEYS = new Set(['pvp', 'online-mode', 'white-list', 'enable-command-block', 'hardcore', 'allow-nether', 'generate-structures', 'enforce-secure-profile', 'spawn-monsters', 'spawn-animals', 'spawn-npcs', 'allow-flight', 'enable-rcon', 'enable-query', 'force-gamemode', 'hide-online-players', 'sync-chunk-writes', 'broadcast-console-to-ops', 'broadcast-rcon-to-ops', 'view-distance']);

const KNOWN_ORDER = [
  'server-port', 'motd', 'level-name', 'level-seed', 'gamemode', 'difficulty', 'max-players',
  'pvp', 'online-mode', 'white-list', 'view-distance', 'spawn-protection', 'hardcore',
  'allow-nether', 'enable-command-block', 'enforce-secure-profile', 'simulation-distance'
];

export function ServerPage(): React.JSX.Element {
  const [tab, setTab] = useState<'props' | 'crashes'>('props');
  return (
    <>
      <PageHeader title="Server configuration" description="server.properties editor and crash diagnostics." />
      <Segmented<'props' | 'crashes'>
        value={tab}
        onChange={setTab}
        options={[{ value: 'props', label: 'Properties' }, { value: 'crashes', label: 'Crash log' }]}
        className="mb-4"
      />
      {tab === 'props' ? <PropertiesEditor /> : <CrashLogTab />}
    </>
  );
}

// ----------------------------------------------------------------------
// Properties
// ----------------------------------------------------------------------

function PropertiesEditor(): React.JSX.Element {
  const live = useLive();
  const { data, loading, error, reload } = useAsync<PropsResponse>(() => get('/api/server/properties'), []);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !values) setValues(data.properties);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (loading) return <div className="flex justify-center py-20"><Spinner label="Reading server.properties…" /></div>;
  if (error) {
    return (
      <Card>
        <EmptyState icon={<ServerCog className="h-6 w-6" />} title="server.properties not found"
          hint={`${error} — start the server once so Paper generates it, then come back here.`} />
      </Card>
    );
  }
  if (!data) return <div className="flex justify-center py-20"><Spinner label="Reading…" /></div>;

  const props = values ?? data.properties;
  const keys = Object.keys(props);

  // Order: known keys first (canonical order), then the rest alphabetically.
  const ordered = keys.sort((a, b) => {
    const ia = KNOWN_ORDER.indexOf(a);
    const ib = KNOWN_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    const r = await post('/api/server/properties/update', { properties: values ?? {} });
    setSaving(false);
    if (!r.ok) { live.pushToast('error', r.error.message); return; }
    live.pushToast('success', 'Properties saved — restart the server to apply');
    reload();
  };

  return (
    <Card pad={false}
      title="server.properties"
      subtitle={`${ordered.length} settings · edits apply after a server restart`}
      actions={<Button variant="primary" size="sm" icon={<Save className="h-4 w-4" />} loading={saving} onClick={save}>Save changes</Button>}>
      <div className="grid gap-x-6 gap-y-1 px-2 py-2 sm:grid-cols-2">
        {ordered.map((key) => (
          <div key={key} className="flex items-center gap-3 px-2 py-1.5">
            <span className="w-52 shrink-0 truncate font-mono text-xs text-zinc-400" title={key}>{key}</span>
            {BOOLEAN_KEYS.has(key) ? (
              <select
                value={values?.[key] ?? props[key]}
                onChange={(e) => setValues((v) => ({ ...(v ?? props), [key]: e.target.value }))}
                className="h-8 flex-1 rounded-lg border border-line bg-ink-850 px-2 font-mono text-xs text-zinc-100 outline-none focus:border-brand-500/60"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                value={values?.[key] ?? props[key]}
                onChange={(e) => setValues((v) => ({ ...(v ?? props), [key]: e.target.value }))}
                spellCheck={false}
                className="h-8 flex-1 rounded-lg border border-line bg-ink-850 px-2.5 font-mono text-xs text-zinc-100 outline-none focus:border-brand-500/60"
              />
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-line-soft px-4 py-3 text-[11px] text-zinc-600">
        Tip: to add keys Paper doesn't know yet, open <span className="font-mono text-zinc-400">server.properties</span> in the File manager.
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------
// Crash log
// ----------------------------------------------------------------------

function CrashLogTab(): React.JSX.Element {
  const live = useLive();
  const { data, loading, reload } = useAsync<{ success: boolean; logs: CrashLogEntry[] }>(() => get('/api/crash-log'), []);
  const [confirmClear, setConfirmClear] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const logs = data?.logs ?? [];

  return (
    <Card pad={false}
      title="Crash diagnostics" subtitle="auto-diagnosed from the last unexpected exits"
      actions={logs.length > 0
        ? <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmClear(true)}>Clear log</Button>
        : undefined}>
      {loading ? (
        <div className="flex justify-center py-16"><Spinner label="Loading crash log…" /></div>
      ) : logs.length === 0 ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="No crashes recorded" hint="Diagnoses appear here whenever the server exits unexpectedly." />
      ) : (
        <ul className="divide-y divide-line-soft">
          {logs.map((c, i) => (
            <li key={i} className="px-4 py-3">
              <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setExpanded(expanded === i ? null : i)}>
                <Badge tone={c.severity === 'critical' ? 'red' : c.severity === 'high' ? 'amber' : 'zinc'}>{c.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium capitalize text-zinc-200">{c.reason.replace(/_/g, ' ')}</p>
                  <p className="text-[11px] text-zinc-600">{timeAgo(c.timestamp)} · exit code {c.exitCode ?? 'n/a'} · {fmtTime(c.timestamp)}</p>
                </div>
                <ChevronDown className={clx('h-4 w-4 text-zinc-600 transition-transform', expanded === i && 'rotate-180')} />
              </button>
              {expanded === i && (
                <div className="mt-3 space-y-3">
                  {(c.repairs?.length > 0) && (
                    <ul className="space-y-1">
                      {c.repairs.map((r, ri) => (
                        <li key={ri} className="flex items-start gap-2 text-xs text-zinc-400">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" /> {r.label}
                        </li>
                      ))}
                    </ul>
                  )}
                  <pre className="max-h-52 overflow-auto rounded-lg bg-[#0a0a10] p-3 font-mono text-[11px] leading-relaxed text-zinc-500">{c.recentOutput.join('\n') || '— no captured output —'}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear crash log?"
        message="All recorded incidents will be erased."
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          const r = await post('/api/crash-log/clear');
          setConfirmClear(false);
          if (!r.ok) { live.pushToast('error', (r as { error: { message: string } }).error.message); return; }
          live.pushToast('success', 'Crash log cleared');
          reload();
        }}
      />
    </Card>
  );
}
