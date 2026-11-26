import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Minus, Plus, ShieldAlert, Trash2, X, ScanBarcode } from 'lucide-react';
import { db } from '../lib/db';
import { useAuth } from '../lib/auth';
import { availableFromBatches, saveSaleLocal, syncAll } from '../lib/sync';
import { daysUntil, money, num, todayISO } from '../lib/format';
import type { Drug, PayMethod, PendingSale } from '../lib/types';
import { PAY_LABEL } from '../lib/types';
import { Badge, Button, Card, Empty, Input, Select, SearchInput, Spinner } from '../components/ui';
import { useToast } from '../components/toast';
import { ReceiptModal } from '../components/Receipt';
import { useDebounced } from '../lib/hooks';

interface Line { drug: Drug; qty: number; price: number }
interface Pay { method: PayMethod; amount: string; reference: string }
const METHODS: PayMethod[] = ['cash', 'transfer', 'pos_terminal'];

export default function POS() {
  const { profile } = useAuth();
  const toast = useToast();
  const drugs = useLiveQuery(() => db.drugs.toArray(), []);
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 120);
  const [cart, setCart] = useState<Line[]>([]);
  const [discount, setDiscount] = useState('');
  const [customer, setCustomer] = useState('');
  const [pays, setPays] = useState<Pay[]>([{ method: 'cash', amount: '', reference: '' }]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<PendingSale | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const canEditPrice = profile?.role === 'admin' || profile?.role === 'pharmacist';

  const avail = useMemo(() => {
    const m = new Map<string, number>();
    (drugs ?? []).forEach((d) => m.set(d.id, availableFromBatches(batches ?? [], d.id)));
    return m;
  }, [drugs, batches]);
  const nearest = useMemo(() => {
    const m = new Map<string, string>();
    const t = todayISO();
    (batches ?? []).forEach((b) => {
      if (b.expiry_date < t || b.quantity_remaining - b.quantity_reserved <= 0) return;
      const cur = m.get(b.drug_id);
      if (!cur || b.expiry_date < cur) m.set(b.drug_id, b.expiry_date);
    });
    return m;
  }, [batches]);

  const results = useMemo(() => {
    const s = dq.trim().toLowerCase();
    const list = (drugs ?? []).filter((d) => d.is_active);
    if (!s) return list.slice(0, 40);
    return list.filter((d) => d.name.toLowerCase().includes(s) || d.generic_name?.toLowerCase().includes(s) || d.barcode === dq.trim() || d.nafdac_number?.toLowerCase() === s).slice(0, 40);
  }, [drugs, dq]);

  const subtotal = cart.reduce((s, l) => s + l.qty * l.price, 0);
  const disc = Math.min(Math.max(Number(discount) || 0, 0), subtotal);
  const total = subtotal - disc;
  // a single untouched cash line means "exact cash"
  const autoFill = pays.length === 1 && pays[0].method === 'cash' && pays[0].amount === '';
  const paid = autoFill ? total : pays.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const change = Math.max(0, paid - total);
  const due = Math.max(0, total - paid);

  const add = (d: Drug) => {
    const have = avail.get(d.id) ?? 0;
    setCart((c) => {
      const ex = c.find((l) => l.drug.id === d.id);
      if (ex) {
        if (ex.qty + 1 > have) { toast(`Only ${have} in stock for ${d.name}.`, 'error'); return c; }
        return c.map((l) => (l.drug.id === d.id ? { ...l, qty: l.qty + 1 } : l));
      }
      if (have < 1) { toast(`${d.name} is out of stock.`, 'error'); return c; }
      return [...c, { drug: d, qty: 1, price: d.selling_price }];
    });
  };
  const setQty = (id: string, qty: number) => {
    const have = avail.get(id) ?? 0;
    if (qty > have) { toast(`Only ${have} in stock.`, 'error'); qty = have; }
    setCart((c) => (qty < 1 ? c.filter((l) => l.drug.id !== id) : c.map((l) => (l.drug.id === id ? { ...l, qty } : l))));
  };

  const onScan = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const code = q.trim();
    if (!code) return;
    const hit = (drugs ?? []).find((d) => d.barcode === code);
    if (hit) { add(hit); setQ(''); }
    else if (results.length === 1) { add(results[0]); setQ(''); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const validate = (): string | null => {
    if (!cart.length) return 'Add at least one item.';
    if (!profile?.branch_id) return 'Your account has no branch assigned. Ask an administrator.';
    if (paid < total) return `Payment is short by ${money(total - paid)}.`;
    for (const p of pays) {
      if (!(Number(p.amount) > 0)) continue;
      if ((p.method === 'transfer' || p.method === 'pos_terminal') && p.reference.trim().length < 3) return `Enter the ${PAY_LABEL[p.method]} reference / approval code.`;
    }
    return null;
  };

  const complete = async () => {
    const v = validate();
    if (v) { toast(v, 'error'); return; }
    setSaving(true);
    try {
      let payments: PendingSale['payments'] = pays.filter((p) => Number(p.amount) > 0).map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference.trim() || undefined }));
      if (autoFill) payments = [{ method: 'cash', amount: total }];
      const sale = await saveSaleLocal({
        branch_id: profile!.branch_id!,
        cashier_name: profile!.full_name || 'Staff',
        customer_name: customer.trim() || undefined,
        items: cart.map((l) => ({ drug_id: l.drug.id, name: l.drug.name, quantity: l.qty, unit_price: l.price })),
        discount: disc,
        payments,
      });
      setDone(sale);
      setCart([]); setDiscount(''); setCustomer(''); setPays([{ method: 'cash', amount: '', reference: '' }]); setQ('');
      syncAll(profile!.branch_id); // background upload
    } catch (e: any) {
      toast(e.message || 'Could not save the sale.', 'error');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!saving && cart.length) complete(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (!drugs || !batches) return <Spinner label="Loading stock…" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-2">
          <SearchInput inputRef={searchRef} onKeyDown={onScan} value={q} onChange={setQ} placeholder="Search name, generic or scan barcode…  (F2)" className="flex-1" />
          <span className="hidden items-center gap-1 text-xs text-muted sm:flex"><ScanBarcode size={16} />Scanner ready</span>
        </div>
        {!drugs.length ? (
          <Card><Empty title="No products on this device yet" hint="Connect to the internet once so the catalogue can download, or add products in Inventory." /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((d) => {
              const a = avail.get(d.id) ?? 0;
              const exp = nearest.get(d.id);
              const soon = exp ? daysUntil(exp) <= 90 : false;
              return (
                <button key={d.id} disabled={a < 1} onClick={() => add(d)}
                  className="group flex flex-col rounded-xl border border-line bg-surface p-3 text-left shadow-card transition hover:border-brand disabled:cursor-not-allowed disabled:opacity-50">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium leading-snug">{d.name}</p>
                    {d.requires_prescription && <span title="Prescription required" className="shrink-0 text-warn"><ShieldAlert size={16} /></span>}
                  </div>
                  <p className="truncate text-xs text-muted">{d.generic_name || d.category || d.unit_type}</p>
                  <div className="mt-2 flex items-end justify-between">
                    <span className="text-base font-semibold tnum">{money(d.selling_price)}</span>
                    <div className="flex items-center gap-1">
                      {soon && a > 0 && <Badge tone="warn">Exp {exp}</Badge>}
                      <Badge tone={a < 1 ? 'bad' : a <= d.reorder_level ? 'warn' : 'ok'}>{a < 1 ? 'Out' : `${num(a)} left`}</Badge>
                    </div>
                  </div>
                </button>
              );
            })}
            {!results.length && <div className="col-span-full"><Empty title="No matching product" hint="Not stocked? Record it in the Wish List so the pharmacy can plan to stock it." /></div>}
          </div>
        )}
      </div>

      <Card className="flex h-fit flex-col lg:sticky lg:top-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">Current sale</h2>
          {cart.length > 0 && <button className="text-xs text-muted hover:text-bad" onClick={() => setCart([])}>Clear</button>}
        </div>
        <div className="max-h-[38vh] overflow-y-auto">
          {!cart.length && <Empty title="Cart is empty" hint="Search or scan a product to begin." />}
          <ul className="divide-y divide-line">
            {cart.map((l) => (
              <li key={l.drug.id} className="px-4 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium leading-snug">{l.drug.name}</p>
                  <button aria-label={`Remove ${l.drug.name}`} onClick={() => setQty(l.drug.id, 0)} className="text-muted hover:text-bad"><Trash2 size={15} /></button>
                </div>
                {l.drug.requires_prescription && !canEditPrice && <p className="mt-0.5 text-xs text-warn">Prescription item: confirm with the pharmacist.</p>}
                <div className="mt-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Button size="sm" aria-label="Decrease" onClick={() => setQty(l.drug.id, l.qty - 1)}><Minus size={14} /></Button>
                    <input aria-label="Quantity" inputMode="numeric" className="h-8 w-12 rounded-md border border-line bg-surface text-center text-sm tnum" value={l.qty}
                      onChange={(e) => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10); if (!Number.isNaN(n)) setQty(l.drug.id, n); }} />
                    <Button size="sm" aria-label="Increase" onClick={() => setQty(l.drug.id, l.qty + 1)}><Plus size={14} /></Button>
                  </div>
                  <div className="flex items-center gap-2 text-sm tnum">
                    {canEditPrice
                      ? <input aria-label="Unit price" inputMode="decimal" className="h-8 w-20 rounded-md border border-line bg-surface px-2 text-right" value={l.price}
                          onChange={(e) => setCart((c) => c.map((x) => (x.drug.id === l.drug.id ? { ...x, price: Math.max(0, Number(e.target.value) || 0) } : x)))} />
                      : <span className="text-muted">{money(l.price)}</span>}
                    <span className="w-20 text-right font-semibold">{money(l.qty * l.price)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-3 border-t border-line p-4">
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Customer (optional)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <Input inputMode="decimal" placeholder="Discount" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
          <div className="space-y-1 text-sm tnum">
            <div className="flex justify-between text-muted"><span>Subtotal</span><span>{money(subtotal)}</span></div>
            {disc > 0 && <div className="flex justify-between text-muted"><span>Discount</span><span>-{money(disc)}</span></div>}
            <div className="flex justify-between text-lg font-semibold"><span>Total</span><span>{money(total)}</span></div>
          </div>

          <div className="space-y-2">
            {pays.map((p, i) => (
              <div key={i} className="rounded-lg border border-line p-2">
                <div className="flex gap-2">
                  <Select aria-label="Payment method" value={p.method} className="w-36" onChange={(e) => setPays((a) => a.map((x, k) => (k === i ? { ...x, method: e.target.value as PayMethod } : x)))}>
                    {METHODS.map((m) => <option key={m} value={m}>{PAY_LABEL[m]}</option>)}
                  </Select>
                  <Input aria-label="Amount" inputMode="decimal" placeholder={autoFill ? String(total || '') : 'Amount'} value={p.amount}
                    onChange={(e) => setPays((a) => a.map((x, k) => (k === i ? { ...x, amount: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
                  {pays.length > 1 && <button aria-label="Remove payment" className="text-muted hover:text-bad" onClick={() => setPays((a) => a.filter((_, k) => k !== i))}><X size={16} /></button>}
                </div>
                {(p.method === 'transfer' || p.method === 'pos_terminal') && (
                  <Input className="mt-2" placeholder={p.method === 'transfer' ? 'Transfer ID / reference' : 'POS approval code / RRN'} value={p.reference}
                    onChange={(e) => setPays((a) => a.map((x, k) => (k === i ? { ...x, reference: e.target.value } : x)))} />
                )}
                {due > 0 && i === pays.length - 1 && !autoFill && <button className="mt-1 text-xs text-brand" onClick={() => setPays((a) => a.map((x, k) => (k === i ? { ...x, amount: String((Number(x.amount) || 0) + due) } : x)))}>Fill remaining {money(due)}</button>}
              </div>
            ))}
            <button className="text-xs font-medium text-brand" onClick={() => setPays((a) => [...a, { method: 'transfer', amount: '', reference: '' }])}>+ Split payment</button>
          </div>

          {!autoFill && <div className="flex justify-between text-sm tnum"><span className="text-muted">{due > 0 ? 'Still due' : 'Change'}</span><span className={due > 0 ? 'font-semibold text-bad' : 'font-semibold text-ok'}>{money(due > 0 ? due : change)}</span></div>}
          <Button variant="primary" size="lg" className="w-full" loading={saving} disabled={!cart.length} onClick={complete}>Complete sale · {money(total)}</Button>
          <p className="text-center text-[11px] text-muted">Ctrl + Enter to complete · Transfer / POS payments are verified later against the bank statement</p>
        </div>
      </Card>
      {done && <ReceiptModal sale={done} onClose={() => { setDone(null); searchRef.current?.focus(); }} />}
    </div>
  );
}
