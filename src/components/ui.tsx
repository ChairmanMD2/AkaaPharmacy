import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2, X, Search } from 'lucide-react';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; loading?: boolean };
export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...p }: BtnProps) {
  const v = {
    primary: 'bg-brand text-brandfg hover:opacity-90 border-transparent',
    secondary: 'bg-surface text-fg border-line hover:bg-surface2',
    ghost: 'bg-transparent text-fg border-transparent hover:bg-surface2',
    danger: 'bg-bad text-white border-transparent hover:opacity-90',
  }[variant];
  const s = { sm: 'h-8 px-2.5 text-xs', md: 'h-10 px-3.5 text-sm', lg: 'h-12 px-5 text-base' }[size];
  return (
    <button {...p} disabled={disabled || loading} className={cx('inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50', v, s, className)}>
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

const field = 'w-full rounded-lg border border-line bg-surface px-3 text-sm placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:opacity-60';
export function Input({ className, ...p }: React.ComponentProps<'input'>) { return <input {...p} className={cx(field, 'h-10', className)} />; }
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...p} className={cx(field, 'h-10 pr-8', className)}>{children}</select>; }
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={cx(field, 'min-h-20 py-2', className)} />; }

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder, inputRef, className, onKeyDown }: { value: string; onChange: (v: string) => void; placeholder?: string; inputRef?: React.Ref<HTMLInputElement>; className?: string; onKeyDown?: React.KeyboardEventHandler<HTMLInputElement> }) {
  return (
    <div className={cx('relative', className)}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <Input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} className="pl-9" />
    </div>
  );
}

export function Card({ className, children, ...p }: React.ComponentProps<'div'>) {
  return <div {...p} className={cx('rounded-xl border border-line bg-surface shadow-card', className)}>{children}</div>;
}

const tone = {
  neutral: 'bg-surface2 text-muted border-line',
  ok: 'bg-oksoft text-ok border-transparent',
  warn: 'bg-warnsoft text-warn border-transparent',
  bad: 'bg-badsoft text-bad border-transparent',
  info: 'bg-infosoft text-info border-transparent',
  brand: 'bg-brandsoft text-brand border-transparent',
};
export function Badge({ tone: t = 'neutral', children }: { tone?: keyof typeof tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone[t])}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 p-10 text-muted"><Loader2 className="animate-spin" size={18} />{label && <span className="text-sm">{label}</span>}</div>;
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="m-4 flex items-center justify-between gap-3 rounded-lg bg-badsoft p-3 text-sm text-bad">
      <span>{message}</span>{onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold tracking-tight">{title}</h1>{subtitle && <p className="text-sm text-muted">{subtitle}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, hint, tone: t }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tnum', t === 'bad' && 'text-bad', t === 'warn' && 'text-warn', t === 'ok' && 'text-ok')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="mb-3 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', value === t.id ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg')}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded-full bg-surface2 px-1.5 text-xs">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

function useEsc(onClose: () => void) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEsc(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center no-print" role="dialog" aria-modal="true" aria-label={title}>
      <div className="anim-fade absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={cx('anim-up relative flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-card sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface2 hover:text-fg"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEsc(onClose);
  return (
    <div className="fixed inset-0 z-50 no-print" role="dialog" aria-modal="true">
      <div className="anim-fade absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="anim-slide absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-line bg-surface shadow-card">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface2 hover:text-fg"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </aside>
    </div>
  );
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose, children }: { title: string; message?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => unknown; onClose: () => void; children?: ReactNode }) {
  const busy = useRef(false);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} onClick={async () => { if (busy.current) return; busy.current = true; try { await onConfirm(); } finally { busy.current = false; } }}>{confirmLabel}</Button>
    </>}>
      {message && <p className="text-sm text-muted">{message}</p>}
      {children}
    </Modal>
  );
}

export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full min-w-max text-left text-sm">
        <thead><tr className="border-b border-line text-xs uppercase tracking-wide text-muted">{head.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cx('px-3 py-2.5 align-middle', className)}>{children}</td>;
