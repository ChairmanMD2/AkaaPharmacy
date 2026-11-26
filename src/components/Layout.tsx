import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BarChart3, CloudOff, Cloud, Command, LayoutDashboard, ListPlus, LogOut, Menu, Moon, Package, Receipt, RefreshCw,
  Settings as Cog, ShoppingCart, Sun, Truck, Users, Wallet, ClipboardList, X, AlertTriangle, KeyRound, Coins,
} from 'lucide-react';
import { PasswordForm } from './PasswordForm';
import { useAuth } from '../lib/auth';
import { can, type Feature } from '../lib/permissions';
import { ROLE_LABEL } from '../lib/types';
import { db } from '../lib/db';
import { getSyncState, retrySale, subscribeSync, syncAll } from '../lib/sync';
import { useOnline } from '../lib/hooks';
import { cx, Badge, Button, Drawer, Modal } from './ui';
import { fmtDateTime, money } from '../lib/format';
import { useToast } from './toast';

interface NavDef { to: string; label: string; icon: any; feature: Feature }
const NAV: NavDef[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, feature: 'dashboard' },
  { to: '/pos', label: 'Point of Sale', icon: ShoppingCart, feature: 'pos' },
  { to: '/inventory', label: 'Inventory', icon: Package, feature: 'inventory' },
  { to: '/sales', label: 'Sales', icon: Receipt, feature: 'sales' },
  { to: '/orders', label: 'Orders', icon: ClipboardList, feature: 'orders' },
  { to: '/deliveries', label: 'Deliveries', icon: Truck, feature: 'deliveries' },
  { to: '/wishlist', label: 'Wish List', icon: ListPlus, feature: 'wishlist' },
  { to: '/shifts', label: 'Cash-up', icon: Coins, feature: 'shifts' },
  { to: '/expenses', label: 'Expenses', icon: Wallet, feature: 'expenses' },
  { to: '/reports', label: 'Reports', icon: BarChart3, feature: 'reports' },
  { to: '/users', label: 'Users', icon: Users, feature: 'users' },
  { to: '/settings', label: 'Settings', icon: Cog, feature: 'settings' },
];

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="var(--brand)" />
      <path d="M26 14h12v12h12v12H38v12H26V38H14V26h12z" fill="var(--brand-fg)" />
    </svg>
  );
}

function useSync() {
  return useSyncExternalStore(subscribeSync, getSyncState);
}

function SyncPill({ onOpen }: { onOpen: () => void }) {
  const online = useOnline();
  const sync = useSync();
  const waiting = useLiveQuery(() => db.pending.where('status').anyOf('pending', 'syncing').count(), [], 0);
  const errors = useLiveQuery(() => db.pending.where('status').equals('error').count(), [], 0);
  return (
    <button onClick={onOpen} className={cx('flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium transition', sync.syncing && 'animate-pulse',
      !online ? 'border-transparent bg-warnsoft text-warn' : errors ? 'border-transparent bg-badsoft text-bad' : 'border-line bg-surface text-muted hover:text-fg')}
      title="Sync status">
      {sync.syncing ? <RefreshCw size={14} className="animate-spin" /> : online ? <Cloud size={14} /> : <CloudOff size={14} />}
      <span>{!online ? 'Offline' : sync.syncing ? 'Syncing…' : 'Online'}</span>
      {(waiting > 0 || errors > 0) && <span className="rounded-full bg-brand px-1.5 text-[11px] text-brandfg">{waiting + errors}</span>}
    </button>
  );
}

function SyncDrawer({ onClose }: { onClose: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const sync = useSync();
  const list = useLiveQuery(() => db.pending.orderBy('created_at').reverse().limit(60).toArray(), [], []);
  const catalogAt = useLiveQuery(() => db.meta.get('catalog_at'), [], undefined);
  const run = async () => {
    const r = await syncAll(profile?.branch_id ?? null);
    if (r.offline) toast('No connection. Sales stay safely queued on this device.', 'info');
    else toast(`Synced ${r.pushed} sale(s)${r.failed ? `, ${r.failed} need attention` : ''}.`, r.failed ? 'error' : 'ok');
  };
  return (
    <Drawer title="Sync & offline queue" onClose={onClose}
      footer={<Button variant="primary" onClick={run} loading={sync.syncing} disabled={!online}><RefreshCw size={16} />Sync now</Button>}>
      <div className="mb-4 rounded-lg bg-surface2 p-3 text-sm">
        <p><b>{online ? 'Connected' : 'Offline'}</b>. Sales are saved on this device first and uploaded automatically when the internet returns.</p>
        <p className="mt-1 text-xs text-muted">Stock last refreshed: {catalogAt?.value ? fmtDateTime(catalogAt.value) : 'never'}{sync.lastError ? ` · Last error: ${sync.lastError}` : ''}</p>
      </div>
      {!list.length && <p className="py-6 text-center text-sm text-muted">No sales recorded on this device yet.</p>}
      <ul className="divide-y divide-line">
        {list.map((s) => (
          <li key={s.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="font-medium tnum">{s.receipt_no ?? s.local_ref} · {money(s.total)}</p>
              <p className="text-xs text-muted">{fmtDateTime(s.sold_at)} · {s.items.length} item(s)</p>
              {s.error && <p className="mt-1 flex items-start gap-1 text-xs text-bad"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{s.error}</p>}
              {s.needs_review && <p className="mt-1 text-xs text-warn">Flagged for manager review.</p>}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge tone={s.status === 'synced' ? 'ok' : s.status === 'error' ? 'bad' : 'warn'}>{s.status === 'synced' ? 'Uploaded' : s.status === 'error' ? 'Needs attention' : 'Waiting'}</Badge>
              {s.status === 'error' && <Button size="sm" onClick={async () => { await retrySale(s.id); run(); }}>Retry</Button>}
            </div>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

function CommandPalette({ items, onClose }: { items: { label: string; to: string }[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  const list = useMemo(() => items.filter((x) => x.label.toLowerCase().includes(q.toLowerCase())), [items, q]);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => setI(0), [q]);
  const go = (to: string) => { nav(to); onClose(); };
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] no-print" role="dialog" aria-label="Command palette">
      <div className="anim-fade absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="anim-up relative w-[min(92vw,520px)] overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Go to…"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, list.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            if (e.key === 'Enter' && list[i]) go(list[i].to);
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none" />
        <ul className="max-h-72 overflow-y-auto p-1">
          {list.map((x, idx) => (
            <li key={x.to}><button onClick={() => go(x.to)} onMouseEnter={() => setI(idx)}
              className={cx('flex w-full items-center rounded-lg px-3 py-2 text-left text-sm', idx === i && 'bg-brandsoft text-brand')}>{x.label}</button></li>
          ))}
          {!list.length && <li className="px-3 py-6 text-center text-sm text-muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

export default function Layout() {
  const { profile, signOut, offlineMode } = useAuth();
  const [open, setOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [account, setAccount] = useState(false);
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const loc = useLocation();
  const online = useOnline();

  const nav = NAV.filter((n) => can(profile?.role, n.feature));
  const title = nav.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)))?.label ?? 'AkaaPharmacy';

  useEffect(() => { setOpen(false); document.title = `${title} · AkaaPharmacy`; }, [loc.pathname, title]);

  // Auto-sync: at start, when the connection returns, and every minute while online.
  useEffect(() => {
    const branch = profile?.branch_id ?? null;
    const go = () => { if (navigator.onLine) syncAll(branch); };
    go();
    window.addEventListener('online', go);
    const t = setInterval(go, 60000);
    return () => { window.removeEventListener('online', go); clearInterval(t); };
  }, [profile?.branch_id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    const root = document.documentElement;
    root.classList.add('theme-anim');                 // smooth cross-fade of colours for a moment
    root.classList.toggle('dark', next);
    setTimeout(() => root.classList.remove('theme-anim'), 350);
    try { localStorage.setItem('akaa_theme', next ? 'dark' : 'light'); } catch { /* ignore */ }
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-4"><Logo /><div><p className="font-semibold leading-tight">AkaaPharmacy</p><p className="text-xs text-muted">Pharmacy management</p></div></div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}
            className={({ isActive }) => cx('group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150',
              isActive ? 'bg-brandsoft text-brand before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-brand' : 'text-muted hover:bg-surface2 hover:text-fg hover:translate-x-0.5')}>
            <n.icon size={18} className="transition-transform duration-150 group-hover:scale-110" />{n.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <div className="mb-2 px-1"><p className="truncate text-sm font-medium">{profile?.full_name || 'Signed in'}</p><p className="text-xs text-muted">{profile ? ROLE_LABEL[profile.role] : ''}</p></div>
        <div className="flex gap-2">
          <Button className="flex-1 whitespace-nowrap px-2" onClick={() => { setOpen(false); setAccount(true); }}><KeyRound size={15} />Account</Button>
          <Button className="flex-1 whitespace-nowrap px-2" onClick={signOut}><LogOut size={15} />Sign out</Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:block no-print">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden no-print">
          <div className="anim-fade absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="anim-slide absolute left-0 top-0 h-full w-72 bg-surface shadow-card">
            <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-2 top-3 rounded-md p-1 text-muted"><X size={18} /></button>
            {sidebar}
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 no-print sm:px-4">
          <button aria-label="Open menu" onClick={() => setOpen(true)} className="rounded-md p-2 text-muted hover:bg-surface2 lg:hidden"><Menu size={20} /></button>
          <h2 className="truncate text-base font-semibold lg:hidden">{title}</h2>
          <button onClick={() => setPalette(true)} className="ml-auto hidden h-9 items-center gap-2 rounded-lg border border-line bg-surface2 px-3 text-xs text-muted hover:text-fg sm:flex lg:ml-0 lg:w-72">
            <Command size={14} />Search pages…<kbd className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px]">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <SyncPill onOpen={() => setSyncOpen(true)} />
            <button onClick={toggleTheme} aria-label="Toggle dark mode" className="rounded-lg border border-line p-2 text-muted hover:text-fg">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
          </div>
        </header>
        {(offlineMode || !online) && (
          <div className="no-print bg-warnsoft px-4 py-1.5 text-center text-xs font-medium text-warn">
            {offlineMode ? 'Offline mode: signed in with the last known account. Sales are saved on this device and sync later.' : 'You are offline. Selling continues normally; everything uploads when the connection returns.'}
          </div>
        )}
        <main className="flex-1 overflow-y-auto p-3 sm:p-5"><div key={loc.pathname} className="route-enter mx-auto max-w-7xl"><Outlet /></div></main>
      </div>
      {account && (
        <Modal title="My account" onClose={() => setAccount(false)}>
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-muted">Name</dt><dd>{profile?.full_name || '—'}</dd></div>
            <div><dt className="text-xs text-muted">Role</dt><dd>{profile ? ROLE_LABEL[profile.role] : ''}</dd></div>
            <div className="col-span-2"><dt className="text-xs text-muted">Email</dt><dd>{profile?.email || '—'}</dd></div>
          </dl>
          <h3 className="mb-2 text-sm font-semibold">Change password</h3>
          <PasswordForm submitLabel="Update password" onDone={() => setAccount(false)} />
        </Modal>
      )}
      {syncOpen && <SyncDrawer onClose={() => setSyncOpen(false)} />}
      {palette && <CommandPalette items={nav.map((n) => ({ label: n.label, to: n.to }))} onClose={() => setPalette(false)} />}
    </div>
  );
}
