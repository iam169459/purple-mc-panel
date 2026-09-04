import { useCallback, useState } from 'react';
import { Archive, Download, Plus, Trash2, Database } from 'lucide-react';
import { del, downloadUrl, get, post } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { fmtBytes, fmtTime, timeAgo } from '../format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, PageHeader, Spinner
} from '../components/ui';
import type { BackupInfo } from '../types';

export function BackupsPage(): React.JSX.Element {
  const live = useLive();
  const loader = useCallback(async () => get<BackupInfo[]>('/api/backups'), []);
  const { data, loading, reload } = useAsync(loader, []);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const backups = data ?? [];

  const create = async (): Promise<void> => {
    setCreating(true);
    const r = await post<{ name: string }>('/api/backups/create');
    setCreating(false);
    if (!r.ok) { live.pushToast('error', r.error.message); return; }
    live.pushToast('success', `Backup created: ${r.data.name}`);
    reload();
  };

  return (
    <>
      <PageHeader
        title="Backups"
        description="Snapshot the server worlds, plugins folder and server.properties as a zip."
        actions={
          <>
            <Badge tone={backups.length > 0 ? 'green' : 'zinc'}>{backups.length} saved</Badge>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} loading={creating} onClick={create}>
              {creating ? 'Zipping…' : 'Create backup'}
            </Button>
          </>
        }
      />

      <Card pad={false} title="Backup archives"
        subtitle="Manual backups are kept until you delete them; scheduled backups prune by retention.">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner label="Listing backups…" /></div>
        ) : backups.length === 0 ? (
          <EmptyState icon={<Archive className="h-6 w-6" />} title="No backups yet"
            hint="Start the server once so a world folder exists, then create your first backup." />
        ) : (
          <ul className="divide-y divide-line-soft">
            {backups.map((b) => (
              <li key={b.name} className="flex items-center gap-3 px-4 py-3 hover:bg-ink-850/50">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-300">
                  <Database className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm text-zinc-200">{b.name}</p>
                  <p className="text-[11px] text-zinc-600">
                    {fmtBytes(b.size * 1024 * 1024)} · {timeAgo(b.date)} · {fmtTime(b.date)}
                  </p>
                </div>
                <IconButton title="Download" icon={<Download className="h-4 w-4" />}
                  onClick={() => downloadUrl(`/api/backups/${encodeURIComponent(b.name)}/download`)} />
                <IconButton title="Delete" danger icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemoving(b)} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!removing}
        title="Delete backup?"
        message={<span className="break-all">Permanently delete <b>{removing?.name}</b>? This cannot be undone.</span>}
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          setBusy(true);
          const r = await del(`/api/backups/${encodeURIComponent(removing!.name)}`);
          setBusy(false);
          if (!r.ok) { live.pushToast('error', r.error.message); setRemoving(null); return; }
          live.pushToast('success', 'Backup deleted');
          setRemoving(null);
          reload();
        }}
      />
    </>
  );
}
