import { useEffect, type ReactNode } from 'react';
import { X, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { clx } from '../format';
import { useLive } from '../live';

// ----------------------------------------------------------------------
// Button
// ----------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md';

const BTN: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  success: 'btn-success'
};

export function Button(props: {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
  onClick?: () => void;
}): React.JSX.Element {
  const {
    children, variant = 'secondary', size = 'md', icon, loading, disabled,
    type = 'button', title, className, onClick
  } = props;
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      className={clx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors whitespace-nowrap select-none',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        BTN[variant],
        (disabled || loading) && 'opacity-50 pointer-events-none',
        className
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton(props: {
  icon: ReactNode;
  title: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const { icon, title, onClick, danger, disabled, className } = props;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent transition-colors',
        danger
          ? 'text-zinc-500 hover:bg-red-500/15 hover:text-red-300 hover:border-red-500/30'
          : 'text-zinc-400 hover:bg-ink-700 hover:text-zinc-100 hover:border-line',
        disabled && 'opacity-40 pointer-events-none',
        className
      )}
    >
      {icon}
    </button>
  );
}

// ----------------------------------------------------------------------
// Card + Stat
// ----------------------------------------------------------------------

export function Card(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}): React.JSX.Element {
  const { title, subtitle, actions, children, className, pad = true } = props;
  return (
    <section className={clx('sci-panel rounded-xl', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function StatCard(props: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  accent?: 'default' | 'ok' | 'warn' | 'danger' | 'brand';
  className?: string;
}): React.JSX.Element {
  const accents = {
    default: 'text-brand-300',
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    danger: 'text-red-400',
    brand: 'text-brand-300'
  } as const;
  return (
    <div className={clx('sci-panel rounded-xl p-4', props.className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{props.label}</p>
        {props.icon && <span className={clx(accents[props.accent ?? 'default'], 'drop-shadow-[0_0_8px_currentColor]')}>{props.icon}</span>}
      </div>
      <div className="hud-value mt-1.5 text-2xl font-semibold tracking-tight font-mono">{props.value}</div>
      {props.sub && <div className="mt-0.5 text-xs text-zinc-500">{props.sub}</div>}
    </div>
  );
}

// ----------------------------------------------------------------------
// Badges / chips / progress
// ----------------------------------------------------------------------

export type Tone = 'zinc' | 'green' | 'amber' | 'red' | 'brand' | 'sky' | 'violet';

const TONES: Record<Tone, string> = {
  zinc: 'bg-ink-800/80 text-zinc-300 border-line-soft',
  green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 shadow-[0_0_12px_-4px_rgb(52_211_153/0.7)]',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30 shadow-[0_0_12px_-4px_rgb(251_191_36/0.7)]',
  red: 'bg-red-500/10 text-red-300 border-red-500/30 shadow-[0_0_12px_-4px_rgb(251_113_133/0.7)]',
  brand: 'bg-brand-500/10 text-brand-300 border-brand-500/35 shadow-[0_0_12px_-4px_rgb(123_134_255/0.8)]',
  sky: 'bg-sky-500/10 text-sky-300 border-sky-500/30 shadow-[0_0_12px_-4px_rgb(56_189_248/0.7)]',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/30 shadow-[0_0_12px_-4px_rgb(167_139_250/0.7)]'
};

export function Badge(props: { tone?: Tone; children: ReactNode; className?: string }): React.JSX.Element {
  const { tone = 'zinc', children, className } = props;
  return (
    <span className={clx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function StatusDot(props: { color: string; pulse?: boolean }): React.JSX.Element {
  return (
    <span
      className={clx('inline-block h-2 w-2 rounded-full', props.color, props.pulse && 'dot-pulse animate-pulse-dot')}
    />
  );
}

export function ProgressBar(props: { value: number; tone?: Tone; className?: string }): React.JSX.Element {
  const tones: Record<Tone, string> = {
    zinc: 'bg-zinc-400', green: 'bg-emerald-400', amber: 'bg-amber-400',
    red: 'bg-red-400', brand: 'bg-brand-400', sky: 'bg-sky-400', violet: 'bg-violet-400'
  };
  return (
    <div className={clx('h-1.5 w-full overflow-hidden rounded-full bg-ink-700/70 shadow-[inset_0_1px_2px_rgb(0_0_0/0.5)]', props.className)}>
      <div
        className={clx('bar-fill h-full rounded-full transition-[width] duration-300', tones[props.tone ?? 'brand'])}
        style={{ width: `${Math.max(0, Math.min(100, props.value))}%` }}
      />
    </div>
  );
}

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-400">
      <Loader2 className="h-4 w-4 animate-spin text-brand-400" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState(props: { icon?: ReactNode; title: string; hint?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {props.icon && <div className="text-zinc-600">{props.icon}</div>}
      <p className="text-sm font-medium text-zinc-400">{props.title}</p>
      {props.hint && <p className="max-w-sm text-xs text-zinc-600">{props.hint}</p>}
    </div>
  );
}

// ----------------------------------------------------------------------
// Form controls
// ----------------------------------------------------------------------

export function Field(props: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <label className={clx('block', props.className)}>
      <span className="mb-1.5 block text-xs font-medium text-zinc-400">{props.label}</span>
      {props.children}
      {props.hint && <span className="mt-1 block text-[11px] text-zinc-600">{props.hint}</span>}
    </label>
  );
}

const inputCls = 'w-full rounded-lg border border-line bg-ink-850 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20';

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  onEnter?: () => void;
  autoFocus?: boolean;
}): React.JSX.Element {
  const { value, onChange, placeholder, type = 'text', className, onEnter, autoFocus } = props;
  return (
    <input
      type={type}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
      className={clx(inputCls, className)}
    />
  );
}

export function TextArea(props: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  mono?: boolean;
}): React.JSX.Element {
  const { value, onChange, rows = 4, placeholder, className, mono } = props;
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className={clx(inputCls, 'resize-y font-mono text-[13px]', mono && 'font-mono', className)}
    />
  );
}

export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}): React.JSX.Element {
  const { value, onChange, options, className } = props;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clx(inputCls, 'appearance-none pr-8', className)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string }): React.JSX.Element {
  const { checked, onChange, label } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors border',
        checked ? 'bg-brand-500 border-brand-400/50' : 'bg-ink-700 border-line'
      )}
    >
      <span className={clx('inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-[3px]')} />
      {label && <span className="ml-2 text-sm text-zinc-300">{label}</span>}
    </button>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
}): React.JSX.Element {
  const { value, onChange, options, className } = props;
  return (
    <div className={clx('inline-flex rounded-lg border border-line bg-ink-850 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clx(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === o.value ? 'bg-ink-700 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------
// Modal
// ----------------------------------------------------------------------

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  const { title, onClose, children, footer, wide } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={clx('mt-[6vh] w-full rounded-2xl border border-line bg-ink-900 shadow-2xl animate-rise-in', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
          <IconButton icon={<X className="h-4 w-4" />} title="Close" onClick={onClose} />
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line-soft px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}): React.JSX.Element | null {
  if (!props.open) return null;
  const { title, message, confirmLabel = 'Confirm', tone = 'danger', onConfirm, onCancel, busy } = props;
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {tone === 'danger' ? <AlertTriangle className="h-4 w-4" /> : undefined}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-zinc-400">{message}</div>
    </Modal>
  );
}

// ----------------------------------------------------------------------
// Toasts + sparkline
// ----------------------------------------------------------------------

export function ToastHost(): React.JSX.Element {
  const { toasts, dismissToast } = useLive();
  const icons = {
    success: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
    error: <AlertTriangle className="h-4 w-4 text-red-400" />,
    info: <Info className="h-4 w-4 text-sky-400" />
  };
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="toast-sci pointer-events-auto flex items-start gap-2.5 rounded-xl pl-4.5 px-3.5 py-3 animate-rise-in">
          <span className="mt-0.5 shrink-0">{icons[t.kind]}</span>
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-zinc-200">{t.message}</p>
          <button onClick={() => dismissToast(t.id)} className="text-zinc-600 hover:text-zinc-300"><X className="h-3.5 w-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

export function Sparkline(props: { data: number[]; width?: number; height?: number; stroke?: string; max?: number }): React.JSX.Element {
  const { data, width = 120, height = 34, stroke = '#818cf8', max } = props;
  const values = data.slice(-60);
  if (values.length < 2) {
    return <div className="text-[11px] text-zinc-600 font-mono">no data</div>;
  }
  const top = max ?? Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(top - min, 1);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`).join(' ');
  const area = `0,${height} ${points} ${width},${height}`;
  const gid = `sg-${stroke.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function PageHeader(props: { title: string; description?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="page-title text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && <p className="mt-1 text-sm text-zinc-500">{props.description}</p>}
      </div>
      {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
    </div>
  );
}
