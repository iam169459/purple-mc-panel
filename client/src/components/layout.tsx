import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, TerminalSquare, FolderTree, Users, Puzzle, CalendarClock,
  Archive, Globe, ServerCog, Settings as SettingsIcon, RefreshCcw,
  HardDriveDownload, Boxes
} from 'lucide-react';
import type { ReactNode } from 'react';
import { clx } from '../format';
import { useLive } from '../live';
import { Badge, StatusDot, ToastHost } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const GROUPS: Array<{ caption?: string; items: NavItem[] }> = [
  {
    items: [{ to: '/', label: 'Dashboard', icon: <LayoutDashboard className="h-[18px] w-[18px]" />, end: true }]
  },
  {
    caption: 'Server',
    items: [
      { to: '/console', label: 'Console', icon: <TerminalSquare className="h-[18px] w-[18px]" /> },
      { to: '/players', label: 'Players', icon: <Users className="h-[18px] w-[18px]" /> },
      { to: '/files', label: 'Files', icon: <FolderTree className="h-[18px] w-[18px]" /> },
      { to: '/plugins', label: 'Plugins', icon: <Puzzle className="h-[18px] w-[18px]" /> }
    ]
  },
  {
    caption: 'Automation',
    items: [
      { to: '/tasks', label: 'Tasks', icon: <CalendarClock className="h-[18px] w-[18px]" /> },
      { to: '/backups', label: 'Backups', icon: <Archive className="h-[18px] w-[18px]" /> }
    ]
  },
  {
    caption: 'System',
    items: [
      { to: '/network', label: 'Network', icon: <Globe className="h-[18px] w-[18px]" /> },
      { to: '/server', label: 'Properties', icon: <ServerCog className="h-[18px] w-[18px]" /> },
      { to: '/settings', label: 'Settings', icon: <SettingsIcon className="h-[18px] w-[18px]" /> },
      { to: '/updates', label: 'Updates', icon: <RefreshCcw className="h-[18px] w-[18px]" /> }
    ]
  }
];

const STATUS_META: Record<string, { color: string; label: string; pulse?: boolean }> = {
  online: { color: 'bg-emerald-400', label: 'Server online', pulse: true },
  starting: { color: 'bg-amber-400', label: 'Starting…', pulse: true },
  stopping: { color: 'bg-amber-400', label: 'Stopping…', pulse: true },
  offline: { color: 'bg-zinc-600', label: 'Server offline' }
};

function Brand(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <div className="brand-chip flex h-8 w-8 items-center justify-center rounded-lg">
        <Boxes className="h-4.5 w-4.5 text-white" />
      </div>
      <div>
        <p className="text-sm font-bold leading-tight tracking-[0.02em] text-zinc-100">PurpleMC</p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-brand-300/70">Control Panel</p>
      </div>
    </div>
  );
}

/** Fixed decorative layers behind the whole app (aurora, stars, holo-grid). */
function SciBackdrop(): React.JSX.Element {
  return (
    <div aria-hidden className="sci-bg pointer-events-none absolute inset-0 z-0">
      <div className="sci-bg__aurora" />
      <div className="sci-bg__stars" />
      <div className="sci-bg__grid" />
      <div className="sci-bg__scanlines" />
      <div className="sci-bg__vignette" />
    </div>
  );
}

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const { status, players, connected } = useLive();
  const meta = STATUS_META[status] ?? STATUS_META.offline;

  const sidebar = (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto py-4">
      {GROUPS.map((group, gi) => (
        <div key={gi}>
          {group.caption && (
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{group.caption}</p>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => clx(
                  'nav-item flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium',
                  isActive
                    ? 'nav-item-active'
                    : 'text-zinc-500 hover:bg-ink-800/70 hover:text-zinc-200'
                )}
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  const statusPill = (
    <div className="border-t border-line-soft p-3">
      <div className={clx('sci-panel flex items-center justify-between gap-2 rounded-xl px-3 py-2', meta.pulse && 'sci-active-border')}>
        <div className="flex items-center gap-2.5">
          <StatusDot color={meta.color} pulse={meta.pulse} />
          <div>
            <p className="text-xs font-semibold text-zinc-200">{meta.label}</p>
            <p className="text-[10px] text-zinc-500">{players.length} player{players.length === 1 ? '' : 's'} online</p>
          </div>
        </div>
        <Badge tone={connected ? 'green' : 'zinc'} className={connected ? 'badge-live' : undefined}>{connected ? 'live' : 'offline'}</Badge>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full">
      <SciBackdrop />

      {/* Desktop sidebar */}
      <aside className="relative z-10 hidden w-60 shrink-0 flex-col border-r border-line-soft bg-ink-950/55 backdrop-blur-xl md:flex">
        <div className="border-b border-line-soft px-4 py-4"><Brand /></div>
        {sidebar}
        {statusPill}
      </aside>

      {/* Mobile header */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line-soft bg-ink-950/55 px-4 py-3 backdrop-blur-xl md:hidden">
          <Brand />
          <div className="flex items-center gap-2">
            <StatusDot color={meta.color} pulse={meta.pulse} />
            <Badge tone={connected ? 'green' : 'zinc'} className={connected ? 'badge-live' : undefined}>{status}</Badge>
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-line-soft px-3 py-2 md:hidden">
          {GROUPS.flatMap((g) => g.items).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => clx(
                'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
                isActive ? 'bg-ink-800 text-zinc-100' : 'text-zinc-500'
              )}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div key={location.pathname} className="animate-rise-in mx-auto max-w-6xl px-4 py-6 md:px-8">
            <Outlet />
          </div>
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
