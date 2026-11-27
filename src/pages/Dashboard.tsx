import { useMemo } from 'react';
import { AlertTriangle, BadgeCheck, CloudUpload, ClipboardList, Hourglass, ListPlus, PackageMinus, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { availableFromBatches } from '../lib/sync';
import { daysUntil, fmtDate, money, num } from '../lib/format';
import { Badge, Card, PageHeader, Stat } from '../components/ui';
import { can } from '../lib/permissions';

async function count(table: string, f: (q: any) => any) {
  const { count: c, error } = await f(supabase.from(table).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return c ?? 0;
}

export default function Dashboard() {
  const { profile } = useAuth();
  const drugs = useLiveQuery(() => db.drugs.toArray(), [], []);
  const batches = useLiveQuery(() => db.batches.toArray(), [], []);
  const waiting = useLiveQuery(() => db.pending_sales.where('status').anyOf('pending', 'syncing', 'error').count(), [], 0);

  const online = useAsync(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const [sales, pendingPay, review, orders, wish] = await Promise.all([
      supabase.from('sales').select('total').eq('status', 'completed').gte('sold_at', start.toISOString()),
      count('payments', (q) => q.eq('status', 'pending_verification')),
      count('sales', (q) => q.eq('needs_review', true).eq('status', 'completed')),
      count('orders', (q) => q.not('status', 'in', '(delivered,cancelled,returned)')),
      count('wishlist_items', (q) => q.eq('status', 'open').eq('is_deleted', false)),
    ]);
    if (sales.error) throw sales.error;
    const rows = sales.data ?? [];
    return { todayTotal: rows.reduce((s: number, r: any) => s + Number(r.total), 0), todayCount: rows.length, pendingPay, review, orders, wish };
  }, [], { cacheKey: 'dashboard.online' });

  const stock = useMemo(() => {
    const low: { name: string; have: number; level: number }[] = [];
    drugs.filter((d) => d.is_active).forEach((d) => {
      const have = availableFromBatches(batches, d.id);
      if (have <= d.reorder_level) low.push({ name: d.name, have, level: d.reorder_level });
    });
    const byId = new Map(drugs.map((d) => [d.id, d.name]));
    const exp = batches.filter((b) => b.quantity_remaining > 0).map((b) => ({ ...b, days: daysUntil(b.expiry_date), name: byId.get(b.drug_id) ?? '?' }));
    return {
      low: low.sort((a, b) => a.have - b.have),
      soon: exp.filter((b) => b.days >= 0 && b.days <= 90).sort((a, b) => a.days - b.days),
      expired: exp.filter((b) => b.days < 0),
    };
  }, [drugs, batches]);

  const o = online.data;
  return (
    <>
      <PageHeader title={`Hello, ${profile?.full_name?.split(' ')[0] || 'there'}`} subtitle="Here is what needs attention today." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={TrendingUp} label="Today's sales" value={o ? money(o.todayTotal) : '—'} hint={o ? `${o.todayCount} sale(s)` : online.loading ? 'loading…' : 'needs connection'} />
        <Stat icon={CloudUpload} label="Waiting to upload" value={num(waiting)} tone={waiting ? 'warn' : undefined} hint="sales on this device" />
        <Stat icon={BadgeCheck} label="Payments to verify" value={o ? num(o.pendingPay) : '—'} tone={o && o.pendingPay ? 'warn' : undefined} hint="transfers / POS / COD" />
        <Stat icon={AlertTriangle} label="Sales needing review" value={o ? num(o.review) : '—'} tone={o && o.review ? 'bad' : undefined} />
        <Stat icon={ClipboardList} label="Open orders" value={o ? num(o.orders) : '—'} />
        <Stat icon={ListPlus} label="Open wish list" value={o ? num(o.wish) : '—'} hint="unmet requests" />
        <Stat icon={PackageMinus} label="Low / out of stock" value={num(stock.low.length)} tone={stock.low.length ? 'warn' : 'ok'} />
        <Stat icon={Hourglass} label="Expiring ≤ 90 days" value={num(stock.soon.length)} tone={stock.expired.length ? 'bad' : stock.soon.length ? 'warn' : 'ok'} hint={stock.expired.length ? `${stock.expired.length} batch(es) expired in stock` : undefined} />
      </div>
      {online.error && <p className="mt-3 text-xs text-muted">Live figures unavailable right now ({online.error}). Stock figures come from this device.</p>}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-3"><h2 className="font-semibold">Low stock</h2>{can(profile?.role, 'inventory') && <Link to="/inventory" className="text-xs text-brand">Open inventory</Link>}</div>
          <ul className="divide-y divide-line">
            {stock.low.slice(0, 8).map((x) => <li key={x.name} className="flex items-center justify-between px-4 py-2.5"><span>{x.name}</span><Badge tone={x.have < 1 ? 'bad' : 'warn'}>{x.have < 1 ? 'Out of stock' : `${x.have} left (min ${x.level})`}</Badge></li>)}
            {!stock.low.length && <li className="px-4 py-6 text-center text-sm text-muted">Everything is above its reorder level.</li>}
          </ul>
        </Card>
        <Card>
          <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Expiring soon</h2></div>
          <ul className="divide-y divide-line">
            {[...stock.expired, ...stock.soon].slice(0, 8).map((b) => <li key={b.id} className="flex items-center justify-between px-4 py-2.5"><span>{b.name} <span className="text-xs text-muted">· batch {b.batch_number} · {b.quantity_remaining} pcs</span></span><Badge tone={b.days < 0 ? 'bad' : 'warn'}>{b.days < 0 ? 'Expired' : fmtDate(b.expiry_date)}</Badge></li>)}
            {!stock.soon.length && !stock.expired.length && <li className="px-4 py-6 text-center text-sm text-muted">No batches expiring in the next 90 days.</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}
