import { useCallback, useState } from 'react';
import { CheckCircle2, Copy, Globe, Loader2, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react';
import { del, get, post } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { fmtTime } from '../format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, PageHeader,
  Select, Spinner, TextInput
} from '../components/ui';
import type { NetworkStatus } from '../types';

export function NetworkPage(): React.JSX.Element {
  const live = useLive();
  const loader = useCallback(async () => get<NetworkStatus>('/api/network/status'), []);
  const { data, loading, error, reload } = useAsync(loader, []);
  const [copied, setCopied] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState<{ port: number; service: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <>
      <PageHeader
        title="Network"
        description="This host's identity, reachable ports and your port map."
        actions={<Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={reload}>Re-scan</Button>}
      />

      {loading ? (
        <div className="flex justify-center py-20"><Spinner label="Scanning network…" /></div>
      ) : error ? (
        <Card><EmptyState title="Network scan failed" hint={error} /></Card>
      ) : !data ? null : (
        <div className="space-y-4">
          {/* identity */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Card title="Public IP">
              <div className="flex items-center gap-2">
                <p className="flex-1 truncate font-mono text-lg text-zinc-100">{data.publicIP ?? 'unknown'}</p>
                {data.publicIP && (
                  <button onClick={() => copy(data.publicIP!)} title="Copy" className="text-zinc-500 hover:text-brand-300">
                    {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] text-zinc-600">via api.ipify.org — internet-facing address</p>
            </Card>
            <Card title="Local address">
              <p className="font-mono text-lg text-zinc-100">{data.localIP}</p>
              <p className="mt-1 text-[11px] text-zinc-600">{data.mac ?? ''}</p>
            </Card>
            <Card title="Hostname">
              <p className="truncate font-mono text-lg text-zinc-100">{data.hostname}</p>
              <p className="mt-1 text-[11px] text-zinc-600">scanned {fmtTime(data.timestamp)}</p>
            </Card>
          </div>

          {/* default ports */}
          <Card pad={false} title="Port reachability" subtitle="can this machine bind the common Minecraft ports?">
            <ul className="divide-y divide-line-soft">
              {data.defaultPorts.map((p) => (
                <li key={p.port} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-20 font-mono text-sm text-zinc-200">{p.port}</span>
                  <span className="flex-1 text-sm text-zinc-400">{p.service}</span>
                  <Badge tone={p.status === 'free' ? 'green' : 'red'}>
                    {p.status === 'free' ? <><CheckCircle2 className="h-3 w-3" /> free</> : 'in use'}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>

          {/* allocations */}
          <Card pad={false} title="Port allocations" subtitle="booked ports tracked by the panel"
            actions={<Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setShowAdd(true)}>Allocate port</Button>}>
            {data.allocations.length === 0 ? (
              <EmptyState icon={<Wifi className="h-6 w-6" />} title="No allocations yet"
                hint="Book the ports your services use so the panel's map stays tidy." />
            ) : (
              <ul className="divide-y divide-line-soft">
                {data.allocations.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-850/40">
                    <span className="w-20 font-mono text-sm font-semibold text-brand-300">{a.port}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200">{a.service}</p>
                      {a.description && <p className="truncate text-[11px] text-zinc-600">{a.description}</p>}
                    </div>
                    <Badge tone="green">active</Badge>
                    <IconButton title="Remove" danger icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemoving({ port: a.port, service: a.service })} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {showAdd && (
        <AllocateDialog
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); reload(); }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        title="Remove allocation?"
        message={<span>Release port <b>{removing?.port}</b> ({removing?.service}) from the map?</span>}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          setBusy(true);
          const r = await del(`/api/network/allocate/${removing!.port}`);
          setBusy(false);
          if (!r.ok) { live.pushToast('error', r.error.message); setRemoving(null); return; }
          live.pushToast('success', 'Allocation removed');
          setRemoving(null);
          reload();
        }}
      />
    </>
  );
}

function AllocateDialog(props: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const live = useLive();
  const [port, setPort] = useState('');
  const [service, setService] = useState('Minecraft Server');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    setChecking(true);
    const r = await post('/api/network/allocate', { port: Number(port), service, description });
    setSaving(false);
    setChecking(false);
    if (!r.ok) { live.pushToast(r.error.status === 409 ? 'error' : 'error', r.error.message); return; }
    live.pushToast('success', `Port ${port} allocated`);
    props.onDone();
  };

  const valid = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 && service.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="mt-[15vh] w-full max-w-md rounded-2xl border border-line bg-ink-900 p-5 shadow-2xl animate-rise-in">
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Allocate a port</h3>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port">
              <TextInput value={port} onChange={setPort} placeholder="25565" type="number" />
            </Field>
            <Field label="Service">
              <TextInput value={service} onChange={setService} placeholder="Dynmap Web" />
            </Field>
          </div>
          <Field label="Description (optional)">
            <TextInput value={description} onChange={setDescription} placeholder="Web map for the survival world" />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={saving || checking} onClick={save}>
            {checking ? 'Checking port…' : 'Allocate'}
          </Button>
        </div>
      </div>
    </div>
  );
}
