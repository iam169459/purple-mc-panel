import { useCallback, useState } from 'react';
import {
  CalendarClock, Plus, TerminalSquare, RotateCw, Archive, Trash2, Play, Pause
} from 'lucide-react';
import { del, get, post } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { fmtTime, timeAgo } from '../format';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Modal,
  PageHeader, Select, Spinner, TextInput, Toggle, type Tone
} from '../components/ui';
import type { Task } from '../types';

interface TasksResponse { success: boolean; tasks: Task[] }

const TYPE_META: Record<Task['type'], { label: string; tone: Tone; icon: React.ReactNode }> = {
  command: { label: 'Command', tone: 'brand', icon: <TerminalSquare className="h-3.5 w-3.5" /> },
  restart: { label: 'Restart', tone: 'amber', icon: <RotateCw className="h-3.5 w-3.5" /> },
  backup: { label: 'Backup', tone: 'violet', icon: <Archive className="h-3.5 w-3.5" /> }
};

export function TasksPage(): React.JSX.Element {
  const live = useLive();
  const loader = useCallback(async () => get<TasksResponse>('/api/tasks'), []);
  const { data, loading, reload } = useAsync(loader, []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  const tasks = data?.tasks ?? [];

  const toggle = async (t: Task): Promise<void> => {
    const r = await post(`/api/tasks/${t.id}/toggle`);
    if (!r.ok) { live.pushToast('error', r.error.message); return; }
    live.pushToast('success', (r.data as { enabled: boolean }).enabled ? 'Task enabled' : 'Task disabled');
    reload();
  };

  return (
    <>
      <PageHeader
        title="Scheduled tasks"
        description="Automate console commands, restarts and backups on a repeating interval. The scheduler checks every 30 seconds."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New task</Button>}
      />

      {loading ? (
        <div className="flex justify-center py-20"><Spinner label="Loading tasks…" /></div>
      ) : tasks.length === 0 ? (
        <Card><EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No tasks yet"
          hint="Create one — for example a nightly world backup, a daily restart, or an hourly auto-save command." /></Card>
      ) : (
        <ul className="space-y-2.5">
          {tasks.map((t) => {
            const meta = TYPE_META[t.type];
            const next = t.lastRun
              ? new Date(new Date(t.lastRun).getTime() + t.intervalMinutes * 60_000)
              : null;
            return (
              <li key={t.id} className={`rounded-xl border bg-ink-900/80 p-4 ${t.enabled ? 'border-line' : 'border-line-soft opacity-70'}`}>
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-brand-300">
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-zinc-100">{t.name}</p>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {!t.enabled && <Badge tone="zinc">paused</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">
                      every {t.intervalMinutes} min{t.type === 'command' && ` · “${t.command}”`}
                      {t.type === 'backup' && ' · worlds + plugins'}
                    </p>
                  </div>
                  <div className="hidden text-right sm:block">
                    <p className="text-xs text-zinc-500">last run {t.lastRun ? timeAgo(t.lastRun) : 'never'}</p>
                    <p className="text-[11px] text-zinc-600">
                      {t.enabled && next && next.getTime() > Date.now() ? `next ≈ ${fmtTime(next.toISOString())}` : t.enabled ? 'due on next tick' : 'paused'}
                    </p>
                  </div>
                  <Toggle checked={t.enabled} onChange={() => toggle(t)} />
                  <IconButton title="Delete" danger icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(t)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating && <CreateTaskDialog onClose={() => setCreating(false)} onCreated={() => { reload(); setCreating(false); }} />}

      <ConfirmDialog
        open={!!deleting}
        title="Delete task?"
        message={<span>Remove <b>{deleting?.name}</b>? This cannot be undone.</span>}
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          setBusy(true);
          const r = await del(`/api/tasks/${deleting!.id}`);
          setBusy(false);
          if (!r.ok) { live.pushToast('error', r.error.message); setDeleting(null); return; }
          live.pushToast('success', 'Task deleted');
          setDeleting(null);
          reload();
        }}
      />
    </>
  );
}

function CreateTaskDialog(props: { onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const live = useLive();
  const [name, setName] = useState('');
  const [type, setType] = useState<Task['type']>('command');
  const [command, setCommand] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    const r = await post('/api/tasks', { name, type, command, intervalMinutes: Number(intervalMinutes) });
    setSaving(false);
    if (!r.ok) { live.pushToast('error', r.error.message); return; }
    live.pushToast('success', 'Task created');
    props.onCreated();
  };

  const valid = name.trim() && Number(intervalMinutes) >= 1 && Number(intervalMinutes) <= 1440 && (type !== 'command' || command.trim());

  return (
    <Modal
      title="New scheduled task"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={saving} onClick={save}>Create task</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="Nightly backup" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={type} onChange={(v) => setType(v as Task['type'])}
              options={[
                { value: 'command', label: 'Console command' },
                { value: 'restart', label: 'Server restart' },
                { value: 'backup', label: 'Zip backup' }
              ]} />
          </Field>
          <Field label="Every (minutes)" hint="Between 1 and 1440 (24h)">
            <TextInput type="number" value={intervalMinutes} onChange={setIntervalMinutes} />
          </Field>
        </div>
        {type === 'command' && (
          <Field label="Command to send" hint="Sent to the running server when the task fires.">
            <TextInput value={command} onChange={setCommand} placeholder="save-all" />
          </Field>
        )}
        {type === 'backup' && (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Play className="h-3.5 w-3.5" /> Backs up the folders configured in Settings → Backups.
          </p>
        )}
        {type === 'restart' && (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Pause className="h-3.5 w-3.5" /> Skips silently when the server is offline.
          </p>
        )}
      </div>
    </Modal>
  );
}
