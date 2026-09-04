export type LineType =
  | 'error' | 'warn' | 'info' | 'success' | 'system' | 'command'
  | 'join' | 'leave' | 'death' | 'advancement' | 'chat' | 'tick'
  | 'debug' | 'default';

export function stripAnsi(s: string): string {
  return String(s)
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][0-9;]*[a-zA-Z]/g, '');
}

const bracketTag = (tag: string) => (l: string): boolean => l.includes(`[${tag}]`) || l.includes(`/${tag}]`);

/** Client mirror of src/line.ts — keep in sync. */
export function classifyLine(line: string): LineType {
  const l = line.toLowerCase();
  if (bracketTag('error')(l) || l.includes('exception') || l.includes('fatal') || l.includes('[severe]') || l.includes('/severe]')) return 'error';
  if (bracketTag('warn')(l) || bracketTag('warning')(l)) return 'warn';
  if (bracketTag('debug')(l)) return 'debug';
  if (bracketTag('info')(l)) return 'info';
  if (l.startsWith('$')) return 'command';
  if (l.includes('joined the game') || l.includes('logged in')) return 'join';
  if (l.includes('left the game') || l.includes('logged out')) return 'leave';
  if (['was slain by', 'was shot by', 'was killed', 'drowned', 'fell from', 'blew up',
    'hit the ground', 'went up in flames', 'burned to death', 'was burned',
    'was struck by lightning', 'was pricked to death', 'suffocated', 'starved',
    'was poked', 'died'].some((k) => l.includes(k))) return 'death';
  if (l.includes('has made the advancement') || l.includes('has completed the challenge') || l.includes('has reached the goal')) return 'advancement';
  if (l.includes('<') && (l.includes('>') || l.includes('»'))) return 'chat';
  if (l.includes('mspt') || l.includes('tps:') || l.includes('tps from last') || l.includes('memory:') || l.includes('tick:') || l.includes('tick times:')) return 'tick';
  if (l.includes('done (') || l.includes('done in ') || l.includes('started')
    || l.includes('running on') || l.includes('preparing spawn') || l.includes('loading world')
    || l.includes('loaded world') || l.includes('default game type') || l.includes('setting spawn')
    || (l.includes('complete') && !l.includes('failed')) || l.includes('success')) return 'success';
  if (l.includes('[system]') || l.startsWith('system')) return 'system';
  return 'default';
}

export function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function clx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
