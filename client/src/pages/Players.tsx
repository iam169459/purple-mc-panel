import { useState } from 'react';
import {
  Compass, Crown, UserX, Gavel, PersonStanding, LocateFixed, Users, MapPin
} from 'lucide-react';
import { useLive } from '../live';
import { fmtTime } from '../format';
import { Badge, Button, Card, EmptyState, IconButton, Modal, PageHeader, StatusDot } from '../components/ui';

type Action = 'kick' | 'ban';

export function PlayersPage(): React.JSX.Element {
  const live = useLive();
  const [pending, setPending] = useState<{ action: Action; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const running = live.status === 'online';

  const run = (cmd: string, okMsg: string): void => {
    live.sendCommand(cmd);
    live.pushToast('success', okMsg);
  };

  const submitAction = (): void => {
    if (!pending) return;
    const { action, name } = pending;
    const suffix = reason.trim() ? ` ${reason.trim()}` : '';
    run(action === 'kick' ? `kick ${name}${suffix}` : `ban ${name}${suffix}`, `${action === 'kick' ? 'Kicked' : 'Banned'} ${name}`);
    setPending(null);
    setReason('');
  };

  return (
    <>
      <PageHeader
        title="Players"
        description="Players currently on the server — parsed live from the console."
        actions={
          <>
            <Badge tone={live.players.length > 0 ? 'green' : 'zinc'}>{live.players.length} online</Badge>
            {live.players.length > 0 && (
              <Button size="sm" icon={<LocateFixed className="h-4 w-4" />} disabled={!running}
                onClick={() => live.players.forEach((p) => live.locatePlayer(p.name))}>
                Locate all
              </Button>
            )}
          </>
        }
      />

      <Card pad={false}>
        {!running ? (
          <EmptyState icon={<Users className="h-6 w-6" />} title="Server is offline" hint="Start the server — players who join appear here instantly." />
        ) : live.players.length === 0 ? (
          <EmptyState icon={<Users className="h-6 w-6" />} title="No players online" hint="Watch for joins and leaves to appear here in real time." />
        ) : (
          <ul className="divide-y divide-line-soft">
            {live.players.map((p) => (
              <li key={p.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-ink-850/50">
                <span className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600/30 text-sm font-bold text-brand-200 ring-1 ring-brand-500/40">
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="flex flex-col">
                    <span className="text-sm font-semibold text-zinc-100">{p.name}</span>
                    <span className="text-[11px] text-zinc-600">joined {fmtTime(p.joinedAt)}</span>
                  </span>
                </span>

                <span className="min-w-[170px] flex-1">
                  {p.location ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 font-mono text-[11px] text-emerald-300">
                      <MapPin className="h-3 w-3" />
                      {Math.round(p.location.x)}, {Math.round(p.location.y)}, {Math.round(p.location.z)}
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-600">location unknown</span>
                  )}
                </span>

                <span className="flex items-center gap-1">
                  <IconButton title="Locate (console)" icon={<Compass className="h-4 w-4" />} onClick={() => live.locatePlayer(p.name)} />
                  <IconButton title="Teleport (tp)" icon={<PersonStanding className="h-4 w-4" />} onClick={() => run(`tp ${p.name}`, `Teleporting ${p.name}`)} />
                  <IconButton title="Grant OP" icon={<Crown className="h-4 w-4" />} onClick={() => run(`op ${p.name}`, `OP granted to ${p.name}`)} />
                  <IconButton title="Kick" danger icon={<UserX className="h-4 w-4" />} onClick={() => { setPending({ action: 'kick', name: p.name }); setReason(''); }} />
                  <IconButton title="Ban" danger icon={<Gavel className="h-4 w-4" />} onClick={() => { setPending({ action: 'ban', name: p.name }); setReason(''); }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4" title="Raw command console" subtitle="send any Minecraft command to a targeted player">
        <PlayerCommandBar />
      </Card>

      {pending && (
        <Modal
          title={`${pending.action === 'kick' ? 'Kick' : 'Ban'} ${pending.name}?`}
          onClose={() => { setPending(null); setReason(''); }}
          footer={
            <>
              <Button variant="ghost" onClick={() => { setPending(null); setReason(''); }}>Cancel</Button>
              <Button variant="danger" onClick={submitAction}>
                {pending.action === 'kick' ? 'Kick player' : 'Ban player'}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-zinc-400">
            {pending.action === 'kick'
              ? `Remove ${pending.name} from the server. They can rejoin afterwards.`
              : `${pending.name} will be permanently blocked from joining (unless pardoned in-game).`}
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Reason (optional)…`}
            autoFocus
            className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-brand-500/60"
          />
        </Modal>
      )}
    </>
  );
}

function PlayerCommandBar(): React.JSX.Element {
  const live = useLive();
  const [cmd, setCmd] = useState('');
  const running = live.status === 'online';
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm text-brand-400">$</span>
      <input
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        disabled={!running}
        placeholder={running ? 'e.g. /kick Steve … or any console command' : 'Server offline'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && cmd.trim()) {
            live.sendCommand(cmd.trim().replace(/^\//, ''));
            live.pushToast('info', `Sent: ${cmd.trim()}`);
            setCmd('');
          }
        }}
        spellCheck={false}
        className="h-9 flex-1 rounded-lg border border-line bg-ink-850 px-3 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-brand-500/60 disabled:opacity-60"
      />
      <Button variant="primary" disabled={!cmd.trim() || !running}
        onClick={() => {
          live.sendCommand(cmd.trim().replace(/^\//, ''));
          setCmd('');
        }}>
        Send
      </Button>
    </div>
  );
}
