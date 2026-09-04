import { useState } from 'react';
import { Play, Square, RotateCw, Skull, Loader2 } from 'lucide-react';
import { useLive } from '../live';
import { Button, ConfirmDialog } from './ui';

export function ServerActions(props: { size?: 'sm' | 'md' }): React.JSX.Element {
  const { status, sendAction } = useLive();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const size = props.size ?? 'md';

  const act = (a: 'start' | 'stop' | 'kill' | 'restart'): void => {
    setBusy(a);
    sendAction(a);
    // The socket event flips status quickly; release the spinner shortly after.
    setTimeout(() => setBusy(null), 900);
  };

  if (status === 'starting' || status === 'stopping') {
    return <Button loading>Working…</Button>;
  }

  return (
    <div className="flex items-center gap-2">
      {status === 'offline' ? (
        <Button variant="success" size={size} icon={<Play className="h-4 w-4" />} loading={busy === 'start'} onClick={() => act('start')}>
          Start server
        </Button>
      ) : (
        <>
          <Button variant="danger" size={size} icon={<Square className="h-3.5 w-3.5" />} loading={busy === 'stop'} onClick={() => act('stop')}>
            Stop
          </Button>
          <Button variant="secondary" size={size} icon={<RotateCw className="h-3.5 w-3.5" />} loading={busy === 'restart'} onClick={() => act('restart')}>
            Restart
          </Button>
          <Button variant="ghost" size={size} icon={<Skull className="h-3.5 w-3.5" />} onClick={() => setConfirmKill(true)} title="Force kill">
            Kill
          </Button>
        </>
      )}
      <ConfirmDialog
        open={confirmKill}
        title="Force kill the server?"
        message="This skips the clean shutdown and may lose unsaved world data. Only use this if the server is hung."
        confirmLabel="Force kill"
        onCancel={() => setConfirmKill(false)}
        onConfirm={() => { setConfirmKill(false); act('kill'); }}
      />
    </div>
  );
}
