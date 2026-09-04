import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronRight, Download, FilePlus2, Folder as FolderIcon, FolderDown, FolderOpen,
  File as FileIcon, Pencil, Trash2, RefreshCw, Upload, Save, ArrowUp, FileCode2, AlertTriangle
} from 'lucide-react';
import { del, downloadUrl, get, post, upload } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import { clx, fmtBytes, fmtTime } from '../format';
import {
  Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Modal,
  PageHeader, Select, Spinner, TextInput
} from '../components/ui';
import type { FileEntry, FileStorage } from '../types';

const join = (a: string, b: string): string => (a ? `${a}/${b}` : b);
const encodePath = (p: string): string => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

const EDITABLE_EXT = new Set([
  '.txt', '.yml', '.yaml', '.properties', '.json', '.xml', '.cfg', '.conf',
  '.log', '.md', '.sh', '.bat', '.toml', '.env', '.java', '.js', '.ts', '.css', '.html'
]);
const isEditableName = (f: FileEntry): boolean => !f.isDirectory && EDITABLE_EXT.has(f.extension);

export function FilesPage(): React.JSX.Element {
  const live = useLive();
  const [params, setParams] = useSearchParams();
  const path = params.get('path') ?? '';

  const [sort, setSort] = useState<'name' | 'size'>('name');
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [editor, setEditor] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const listLoader = useCallback(async () => {
    const r = await get<{ success: boolean; files: FileEntry[] }>(`/api/files/list?path=${encodeURIComponent(path)}`);
    return r;
  }, [path]);
  const { data, loading, error, reload } = useAsync(listLoader, [path]);
  const { data: storage, reload: reloadStorage } = useAsync<FileStorage>(() => get('/api/files/storage'), []);

  useEffect(() => { reloadStorage(); }, [path, reloadStorage]);

  const go = (p: string): void => {
    const next = new URLSearchParams(params);
    if (p) next.set('path', p); else next.delete('path');
    setParams(next, { replace: true });
  };

  const items = useMemo(() => {
    const list = [...(data?.files ?? [])];
    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (sort === 'size') return b.size - a.size;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [data, sort]);

  const segments = path ? path.split('/') : [];

  const toastErr = (r: { ok: false; error: { message: string } }): void => live.pushToast('error', r.error.message);
  const doAction = async (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, okMsg: string): Promise<void> => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { if ('error' in r) live.pushToast('error', (r.error as { message: string }).message); return; }
    live.pushToast('success', okMsg);
    reload();
    reloadStorage();
  };

  return (
    <>
      <PageHeader
        title="File manager"
        description="Browse and edit the server directory — server.jar, worlds, plugins, configs."
        actions={
          <>
            <Button size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => document.getElementById('file-upload')?.click()}>
              Upload
            </Button>
            <Button size="sm" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New</Button>
            <input id="file-upload" type="file" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const r = await upload('/api/files/upload', 'file', f, { path });
              if (!r.ok) { live.pushToast('error', r.error.message); return; }
              live.pushToast('success', `Uploaded ${f.name}`);
              reload(); reloadStorage();
            }} />
          </>
        }
      />

      {/* storage strip */}
      {storage && (
        <Card className="mb-4" pad={false}>
          <div className="grid gap-4 px-4 py-3 sm:grid-cols-[auto_1fr] sm:items-center">
            <div className="flex items-baseline gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">Server size</p>
                <p className="font-mono text-lg font-semibold text-zinc-100">{fmtBytes(storage.server.totalBytes)}</p>
              </div>
              {storage.host && (
                <div className="text-right">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-600">Host free</p>
                  <p className="font-mono text-sm text-zinc-400">{storage.host.freeGB} GB</p>
                </div>
              )}
            </div>
            <div>
              <div className="flex gap-0.5 overflow-hidden rounded-full border border-line h-2">
                {(storage.folders.length > 0 ? storage.folders : [{ name: 'server', totalBytes: storage.server.totalBytes }]).map((f) => (
                  <div
                    key={f.name}
                    title={f.name}
                    className="h-full bg-brand-500/70 first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${storage.server.totalBytes > 0 ? Math.max(2, (f.totalBytes / storage.server.totalBytes) * 100) : 0}%` }}
                  />
                ))}
              </div>
              <p className="mt-1 text-[11px] text-zinc-600">
                {storage.folders.slice(0, 5).map((f) => `${f.name} ${(f.totalBytes / Math.max(1, storage.server.totalBytes) * 100).toFixed(0)}%`).join(' · ')}
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card pad={false}>
        {/* breadcrumb + sort */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
          <button onClick={() => go('')} className={clx('rounded px-1.5 py-0.5 text-sm font-medium hover:text-zinc-200', path === '' ? 'text-brand-300' : 'text-zinc-300')}>server</button>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
              <button
                onClick={() => go(segments.slice(0, i + 1).join('/'))}
                className={clx('rounded px-1.5 py-0.5 text-sm hover:text-zinc-200', i === segments.length - 1 ? 'font-semibold text-brand-300' : 'text-zinc-300')}
              >
                {seg}
              </button>
            </span>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <Select value={sort} onChange={(v) => setSort(v as 'name' | 'size')} options={[{ value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }]} className="!h-7 !w-24 !py-0 text-xs" />
            <IconButton icon={<RefreshCw className="h-4 w-4" />} title="Refresh" onClick={() => { reload(); reloadStorage(); }} />
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Spinner label="Loading directory…" /></div>
        ) : error ? (
          <EmptyState title="Could not load this folder" hint={error} />
        ) : (
          <div className="overflow-x-auto">
            {path !== '' && (
              <button onClick={() => go(segments.slice(0, -1).join('/'))} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-zinc-500 hover:bg-ink-850 hover:text-zinc-200">
                <ArrowUp className="h-4 w-4" /> ..
              </button>
            )}
            <ul className="divide-y divide-line-soft">
              {items.map((f) => (
                <li key={f.name} className="group flex items-center gap-3 px-4 py-2 hover:bg-ink-850/60">
                  {f.isDirectory
                    ? <FolderIcon className="h-4 w-4 shrink-0 text-brand-400/80" />
                    : <FileIcon className="h-4 w-4 shrink-0 text-zinc-600" />}
                  <button
                    className="min-w-0 flex-1 truncate text-left text-sm text-zinc-200 hover:text-brand-300"
                    onClick={() => {
                      if (f.isDirectory) go(join(path, f.name));
                      else if (isEditableName(f)) setEditor({ path: join(path, f.name), name: f.name });
                      else downloadUrl(`/api/files/download?file=${encodeURIComponent(join(path, f.name))}`);
                    }}
                    title={!f.isDirectory && !isEditableName(f) ? 'Not editable — downloads instead' : undefined}
                  >
                    {f.name}
                  </button>
                  <span className="hidden w-36 shrink-0 text-right font-mono text-xs text-zinc-500 sm:block">
                    {fmtBytes(f.size)}
                  </span>
                  <span className="hidden w-28 shrink-0 text-right text-xs text-zinc-600 md:block">{fmtTime(f.modified)}</span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                    {!f.isDirectory && isEditableName(f) && (
                      <IconButton title="Edit" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditor({ path: join(path, f.name), name: f.name })} />
                    )}
                    <IconButton
                      title={f.isDirectory ? 'Download as zip' : 'Download'}
                      icon={f.isDirectory ? <FolderDown className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                      onClick={() => downloadUrl(f.isDirectory ? `/api/files/download-dir?path=${encodeURIComponent(join(path, f.name))}` : `/api/files/download?file=${encodeURIComponent(join(path, f.name))}`)}
                    />
                    <IconButton title="Rename" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setRenameTarget(f)} />
                    <IconButton title="Delete" danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleteTarget(f)} />
                  </span>
                </li>
              ))}
            </ul>
            {items.length === 0 && <EmptyState icon={<FolderOpen className="h-6 w-6" />} title="Empty folder" hint="Upload files or create a new folder here." />}
          </div>
        )}
      </Card>

      {editor && (
        <EditorModal
          filePath={editor.path}
          onClose={() => setEditor(null)}
          onSaved={() => { reload(); reloadStorage(); }}
        />
      )}

      {createOpen && (
        <CreateDialog
          currentPath={path}
          onClose={() => setCreateOpen(false)}
          onCreate={async (name, type) => {
            await doAction(async () => {
              const r = await post('/api/files/create', { name, type, path });
              return r;
            }, `${type === 'folder' ? 'Folder' : 'File'} "${name}" created`);
            setCreateOpen(false);
          }}
        />
      )}

      {renameTarget && (
        <RenameDialog
          entry={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRename={async (newName) => {
            const oldPath = join(path, renameTarget.name);
            await doAction(async () => post('/api/files/rename', { path: oldPath, name: newName }), 'Renamed');
            setRenameTarget(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteTarget?.isDirectory ? 'Delete folder?' : 'Delete file?'}
        message={<span className="break-all">Permanently delete <b>{join(path, deleteTarget?.name ?? '')}</b>? This cannot be undone.</span>}
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const target = deleteTarget!;
          await doAction(async () => del(`/api/files/${encodePath(join(path, target.name))}`), `Deleted ${target.name}`);
          setDeleteTarget(null);
        }}
      />
    </>
  );
}

// ----------------------------------------------------------------------
// Editor modal
// ----------------------------------------------------------------------

function EditorModal(props: { filePath: string; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const live = useLive();
  const { filePath, onClose, onSaved } = props;
  const [content, setContent] = useState<string | null>(null);
  const [editable, setEditable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadErr(null);
    get<{ success: boolean; content: string; isEditable: boolean; name: string }>(`/api/files/read?file=${encodeURIComponent(filePath)}`)
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setContent(r.data.content);
          setEditable(r.data.isEditable);
        } else {
          setLoadErr(r.error.message);
        }
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filePath]);

  const save = async (): Promise<void> => {
    setSaving(true);
    const r = await post('/api/files/save', { path: filePath, content });
    setSaving(false);
    if (!r.ok) { live.pushToast('error', r.error.message); return; }
    live.pushToast('success', 'File saved');
    onSaved();
    onClose();
  };

  return (
    <Modal
      wide
      title={<span className="flex items-center gap-2"><FileCode2 className="h-4 w-4 text-brand-400" /><span className="font-mono text-[13px]">{filePath}</span></span>}
      onClose={onClose}
      footer={
        <>
          {content != null && (
            <span className="mr-auto text-xs text-zinc-600 font-mono">{content.split('\n').length} lines · {(content.length / 1024).toFixed(1)} KB</span>
          )}
          {editable
            ? <Button variant="ghost" onClick={onClose}>Cancel</Button>
            : <Button variant="primary" onClick={onClose}>Close</Button>}
          {editable && <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={saving} onClick={save}>Save file</Button>}
        </>
      }
    >
      {loading ? (
        <div className="flex justify-center py-20"><Spinner label="Reading file…" /></div>
      ) : loadErr ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="Could not read file" hint={loadErr} />
      ) : (
        <textarea
          value={content ?? ''}
          onChange={(e) => setContent(e.target.value)}
          readOnly={!editable}
          spellCheck={false}
          className="h-[60vh] w-full resize-none rounded-lg border border-line bg-[#0a0a10] p-4 font-mono text-[12.5px] leading-relaxed text-zinc-200 outline-none focus:border-brand-500/40 read-only:opacity-70"
        />
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------------
// Dialogs
// ----------------------------------------------------------------------

function CreateDialog(props: { currentPath: string; onClose: () => void; onCreate: (name: string, type: 'file' | 'folder') => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [type, setType] = useState<'folder' | 'file'>('folder');
  return (
    <Modal
      title="Create new"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => props.onCreate(name.trim(), type)}>Create</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          value={type}
          onChange={(v) => setType(v as 'folder' | 'file')}
          options={[{ value: 'folder', label: 'Folder' }, { value: 'file', label: 'Text file' }]}
        />
        <Field label={type === 'folder' ? 'Folder name' : 'File name (text files only)'}>
          <TextInput value={name} onChange={setName} autoFocus placeholder={type === 'folder' ? 'my-folder' : 'notes.txt'} onEnter={() => name.trim() && props.onCreate(name.trim(), type)} />
        </Field>
        <p className="text-xs text-zinc-600">Creating in <span className="font-mono text-zinc-400">{props.currentPath || 'server/'}</span></p>
      </div>
    </Modal>
  );
}

function RenameDialog(props: { entry: FileEntry; onClose: () => void; onRename: (newName: string) => void }): React.JSX.Element {
  const [name, setName] = useState(props.entry.name);
  return (
    <Modal
      title="Rename"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || name === props.entry.name} onClick={() => props.onRename(name.trim())}>Rename</Button>
        </>
      }
    >
      <Field label="New name" hint="Letters, numbers, dots, spaces, _ and - only.">
        <TextInput value={name} onChange={setName} autoFocus onEnter={() => name.trim() && name !== props.entry.name && props.onRename(name.trim())} />
      </Field>
    </Modal>
  );
}
