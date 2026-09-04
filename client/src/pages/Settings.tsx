import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, HardDrive, Info, Rocket, Save, Settings as SettingsIcon } from 'lucide-react';
import { get, post } from '../api';
import { useAsync } from '../hooks';
import { useLive } from '../live';
import {
  Button, Card, ConfirmDialog, Field, PageHeader, Select, Spinner, TextArea, TextInput, Toggle
} from '../components/ui';
import type { PanelSettings } from '../types';

interface PaperVersionMeta { id: string; status: string; java: number | null }
interface VersionsResponse { success: boolean; latest: string; versions: PaperVersionMeta[] }

// Shown only when the /api/server/paper-versions endpoint is unreachable.
const FALLBACK_VERSIONS: PaperVersionMeta[] = [
  '26.2', '26.1.2', '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4',
  '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.19.2', '1.18.2',
  '1.17.1', '1.16.5', '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.8.8'
].map((id) => ({ id, status: 'unknown', java: null }));

export function SettingsPage(): React.JSX.Element {
  const live = useLive();
  const loader = useCallback(async () => get<{ success: boolean; settings: PanelSettings }>('/api/settings'), []);
  const { data, loading, reload } = useAsync(loader, []);
  const [draft, setDraft] = useState<PanelSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installVersion, setInstallVersion] = useState<string | null>(null);

  const { data: versionsResp } = useAsync<VersionsResponse>(() => get('/api/server/paper-versions'), []);
  const versionMetas = useMemo<PaperVersionMeta[]>(() => {
    const live = versionsResp?.versions;
    return live && live.length > 0 ? live : FALLBACK_VERSIONS;
  }, [versionsResp]);
  const latestId = versionMetas.find((v) => v.status === 'SUPPORTED')?.id ?? versionMetas[0]?.id ?? '';

  const versionOptions = useMemo(() => {
    const list = [...versionMetas];
    if (draft && !list.some((v) => v.id === draft.serverVersion)) {
      list.unshift({ id: draft.serverVersion, status: 'unknown', java: null });
    }
    return list.map((v) => ({
      value: v.id,
      label: `Paper ${v.id}${v.id === latestId ? ' · latest' : ''}`
    }));
  }, [versionMetas, latestId, draft]);
  const installMeta = installVersion ? versionMetas.find((v) => v.id === installVersion) ?? null : null;

  useEffect(() => {
    if (data?.settings && !draft) setDraft(data.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (loading || !data) return <div className="flex justify-center py-20"><Spinner label="Loading settings…" /></div>;
  if (!draft) return <div className="flex justify-center py-20"><Spinner label="Loading…" /></div>;

  const s = draft;
  const set = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]): void => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const r = await post('/api/settings/save', s as unknown as Record<string, unknown>);
    setSaving(false);
    if (!r.ok) { live.pushToast('error', r.error.message); return; }
    live.pushToast('success', 'Settings saved');
    reload();
    setDraft(null);
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="How the panel launches and supervises the Minecraft server."
        actions={<Button variant="primary" icon={<Save className="h-4 w-4" />} loading={saving} onClick={save}>Save settings</Button>}
      />

      <div className="space-y-4">
        {/* runtime */}
        <Card title="Server runtime" subtitle="Java process configuration">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink-850 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-zinc-200">Auto-size RAM</p>
                <p className="text-xs text-zinc-600">recommend ~75% of this machine's memory</p>
              </div>
              <Toggle checked={s.autoResource} onChange={(v) => set('autoResource', v)} />
            </div>
            {!s.autoResource && (
              <Field label="Max heap (RAM)">
                <TextInput value={s.maxRam} onChange={(v) => set('maxRam', v)} placeholder="2G" />
              </Field>
            )}
            <Field label="Java binary" hint="fallbacks: /usr/bin/java, /usr/local/bin/java">
              <TextInput value={s.javaPath} onChange={(v) => set('javaPath', v)} placeholder="java" />
            </Field>
            <Field
              label="Server version"
              hint={latestId
                ? `From the live PaperMC list · newest: ${latestId} · ${s.serverVersion} needs Java ${versionMetas.find((v) => v.id === s.serverVersion)?.java ?? '?'} — “Download” replaces server.jar (world data kept)`
                : 'used for Paper downloads and plugin matching'}
            >
              <div className="flex items-center gap-2">
                <Select className="min-w-0 flex-1" value={s.serverVersion} onChange={(v) => set('serverVersion', v)}
                  options={versionOptions} />
                <Button
                  size="sm" variant="secondary"
                  icon={<Download className="h-4 w-4" />}
                  loading={installing}
                  disabled={live.status === 'online' || !s.serverVersion}
                  title={live.status === 'online' ? 'Stop the Minecraft server before switching versions' : 'Download the Paper JAR for this version'}
                  onClick={() => setInstallVersion(s.serverVersion)}
                >
                  {installing ? 'Downloading…' : 'Download'}
                </Button>
              </div>
            </Field>
            <Field label="Java arguments" hint="Aikar's flags — tune carefully" className="md:col-span-2">
              <TextArea value={s.javaArgs} onChange={(v) => set('javaArgs', v)} rows={4} mono />
            </Field>
          </div>
        </Card>

        {/* behavior */}
        <Card title="Lifecycle" subtitle="startup and crash behavior">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink-850 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-zinc-200">Auto-start on panel boot</p>
                <p className="text-xs text-zinc-600">launch the server 2s after the panel starts</p>
              </div>
              <Toggle checked={s.autoStart} onChange={(v) => set('autoStart', v)} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink-850 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-zinc-200">Auto-restart after crash</p>
                <p className="text-xs text-zinc-600">throttled — max 5 attempts in 2 minutes</p>
              </div>
              <Toggle checked={s.autoRestart} onChange={(v) => set('autoRestart', v)} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink-850 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-zinc-200">Starter plugins on first run</p>
                <p className="text-xs text-zinc-600">downloads the curated pack (LuckPerms, WorldEdit, EssentialsX, PlaceholderAPI, CoreProtect, Geyser, Floodgate, ViaVersion) into an empty plugins folder</p>
              </div>
              <Toggle checked={s.starterPackOnFirstRun} onChange={(v) => set('starterPackOnFirstRun', v)} />
            </div>
            <Field label="Console history (lines)" hint="clamped between 100 and 5000">
              <TextInput type="number" value={String(s.consoleMaxLines)} onChange={(v) => set('consoleMaxLines', Math.max(100, Math.min(5000, Number(v) || 500)))} />
            </Field>
            <Field label="Panel port" hint="read at boot from PORT — this is informational here">
              <TextInput type="number" value={String(s.panelPort)} onChange={(v) => set('panelPort', Number(v) || 3000)} />
            </Field>
          </div>
        </Card>

        {/* backup defaults */}
        <Card title="Scheduled backups" subtitle="defaults for the backup task type">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink-850 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-zinc-200">Retention pruning</p>
                <p className="text-xs text-zinc-600">auto-delete old backups beyond the keep count</p>
              </div>
              <Toggle checked={s.backupEnabled} onChange={(v) => set('backupEnabled', v)} />
            </div>
            <Field label="Keep the newest N backups" hint="older ones are pruned">
              <TextInput type="number" value={String(s.backupMaxKeep)} onChange={(v) => set('backupMaxKeep', Number(v) || 7)} />
            </Field>
            <Field label="Folders to back up" hint="comma-separated, inside server/">
              <TextInput value={s.backupWorlds} onChange={(v) => set('backupWorlds', v)} placeholder="world, world_nether, plugins" />
            </Field>
            <div className="flex items-center gap-2 self-end text-xs text-zinc-600">
              <Info className="h-4 w-4 shrink-0" />
              plugins/ and server.properties are always included.
            </div>
          </div>
        </Card>

        {/* appearance / info */}
        <Card title="About" subtitle="install information">
          <div className="flex items-start gap-2 text-sm text-zinc-400">
            <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
            <p>Runtime data lives in <span className="font-mono text-zinc-300">config/settings.json</span> and is preserved across panel updates.</p>
          </div>
          <div className="mt-3 flex items-start gap-2 text-sm text-zinc-400">
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
            <p>World data stays in <span className="font-mono text-zinc-300">server/</span> — never inside the panel code directory.</p>
          </div>
          <div className="mt-3 flex items-start gap-2 text-sm text-zinc-400">
            <SettingsIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
            <p>Motd, difficulty, gamemode and ports are synced to server.properties automatically when changed here.</p>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={!!installVersion}
        title="Download Paper JAR?"
        tone="primary"
        busy={installing}
        confirmLabel="Download & switch"
        message={
          <span>
            Download Paper <b>{installVersion}</b> (~50 MB) and replace <span className="font-mono">server/server.jar</span>? World
            data in <span className="font-mono">server/</span> is untouched — Paper loads worlds from older versions but
            not from newer ones.
            {installMeta?.java && <span> This version needs <b>Java {installMeta.java}</b>.</span>}
          </span>
        }
        onCancel={() => { if (!installing) setInstallVersion(null); }}
        onConfirm={async () => {
          if (!installVersion) return;
          setInstalling(true);
          const r = await post('/api/server/install-version', { version: installVersion });
          setInstalling(false);
          setInstallVersion(null);
          if (!r.ok) { live.pushToast('error', r.error.message); return; }
          live.pushToast('success', `Paper ${installVersion} downloaded — start the server to run it`);
          reload();
          setDraft(null);
        }}
      />
    </>
  );
}
