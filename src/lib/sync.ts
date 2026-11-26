import { db, getMeta, setMeta } from './db';
import { fetchAll, isNetworkError, errMsg, supabase } from './supabase';
import type { Batch, Drug, PendingSale } from './types';
import { setCurrency, todayISO, uid } from './format';

const DRUG_COLS =
  'id,name,generic_name,category,nafdac_number,barcode,unit_type,selling_price,wholesale_price,requires_prescription,reorder_level,is_active';
const BATCH_COLS = 'id,drug_id,branch_id,batch_number,expiry_date,quantity_remaining,quantity_reserved';

let running: Promise<SyncResult> | null = null;
export interface SyncResult { pushed: number; failed: number; offline: boolean; message?: string }

type Listener = () => void;
const listeners = new Set<Listener>();
let state: { syncing: boolean; lastSync: string | null; lastError: string | null } = { syncing: false, lastSync: null, lastError: null };
export const getSyncState = () => state;
export const subscribeSync = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
const setState = (p: Partial<typeof state>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };

/** Download the catalogue + this branch's batches, then re-apply local deductions of sales not yet confirmed by the server. */
export async function pullCatalog(branchId: string | null) {
  const drugs = await fetchAll<Drug>((f, t) => supabase.from('drugs').select(DRUG_COLS).order('name').range(f, t));
  let batches: Batch[] = [];
  if (branchId) {
    batches = await fetchAll<Batch>((f, t) => supabase.from('drug_batches').select(BATCH_COLS).eq('branch_id', branchId).range(f, t));
  }
  const unsynced = await db.pending.where('status').anyOf('pending', 'syncing', 'error').toArray();
  const dec = new Map<string, number>();
  unsynced.forEach((s) => s.alloc.forEach((a) => dec.set(a.batch_id, (dec.get(a.batch_id) ?? 0) + a.qty)));
  batches = batches.map((b) => (dec.has(b.id) ? { ...b, quantity_remaining: Math.max(0, b.quantity_remaining - dec.get(b.id)!) } : b));
  await db.transaction('rw', db.drugs, db.batches, async () => {
    await db.drugs.clear();
    await db.drugs.bulkPut(drugs);
    await db.batches.clear();
    await db.batches.bulkPut(batches);
  });
  await setMeta('catalog_at', new Date().toISOString());
}

export async function pullSettings() {
  const { data } = await supabase.from('app_settings').select('key,value');
  if (!data) return;
  const s: Record<string, any> = {};
  data.forEach((r: any) => (s[r.key] = r.value));
  await setMeta('settings', s);
  if (s.currency_symbol) setCurrency(s.currency_symbol);
}

export async function pushSales(): Promise<{ pushed: number; failed: number; offline: boolean }> {
  const queue = await db.pending.where('status').anyOf('pending', 'syncing').sortBy('created_at');
  let pushed = 0, failed = 0;
  for (const s of queue) {
    await db.pending.update(s.id, { status: 'syncing' });
    const payload = {
      id: s.id,
      local_ref: s.local_ref,
      branch_id: s.branch_id,
      sold_at: s.sold_at,
      discount: s.discount,
      notes: [s.notes, s.customer_name ? `Customer: ${s.customer_name}` : ''].filter(Boolean).join(' | ') || null,
      items: s.items.map((i) => ({ drug_id: i.drug_id, quantity: i.quantity, unit_price: i.unit_price })),
      payments: s.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference ?? null })),
    };
    const { data, error } = await supabase.rpc('process_offline_sale', { p_sale: payload });
    if (error) {
      if (isNetworkError(error)) {
        await db.pending.update(s.id, { status: 'pending' });
        return { pushed, failed, offline: true };
      }
      await db.pending.update(s.id, { status: 'error', error: errMsg(error), attempts: s.attempts + 1 });
      failed++;
      continue;
    }
    await db.pending.update(s.id, { status: 'synced', receipt_no: data?.receipt_no, needs_review: !!data?.needs_review, error: undefined });
    pushed++;
  }
  // keep a week of synced history locally for reprints
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  await db.pending.where('status').equals('synced').filter((s) => s.created_at < cutoff).delete();
  return { pushed, failed, offline: false };
}

/** One sync cycle: push queued sales, then refresh stock/prices. Safe to call from anywhere; concurrent calls share one run. */
export function syncAll(branchId: string | null): Promise<SyncResult> {
  if (running) return running;
  running = (async () => {
    if (!navigator.onLine) return { pushed: 0, failed: 0, offline: true };
    setState({ syncing: true });
    try {
      const r = await pushSales();
      if (!r.offline) {
        await pullCatalog(branchId);
        await pullSettings();
        setState({ lastSync: new Date().toISOString(), lastError: null });
      }
      return r;
    } catch (e) {
      const offline = isNetworkError(e);
      setState({ lastError: offline ? null : errMsg(e) });
      return { pushed: 0, failed: 0, offline, message: errMsg(e) };
    } finally {
      setState({ syncing: false });
      running = null;
    }
  })();
  return running;
}

export async function retrySale(id: string) {
  await db.pending.update(id, { status: 'pending', error: undefined });
}

// ───── local selling helpers ─────
export function availableFromBatches(batches: Batch[], drugId: string): number {
  const t = todayISO();
  return batches
    .filter((b) => b.drug_id === drugId && b.expiry_date >= t)
    .reduce((s, b) => s + Math.max(0, b.quantity_remaining - b.quantity_reserved), 0);
}

/** Earliest-expiry-first allocation against local batches. */
export function allocateFEFO(batches: Batch[], drugId: string, qty: number): { batch_id: string; qty: number }[] {
  const t = todayISO();
  const list = batches
    .filter((b) => b.drug_id === drugId && b.expiry_date >= t && b.quantity_remaining - b.quantity_reserved > 0)
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  const out: { batch_id: string; qty: number }[] = [];
  let need = qty;
  for (const b of list) {
    if (need <= 0) break;
    const take = Math.min(need, b.quantity_remaining - b.quantity_reserved);
    out.push({ batch_id: b.id, qty: take });
    need -= take;
  }
  return out;
}

async function nextLocalRef(): Promise<string> {
  let dev = await getMeta<string>('device_code');
  if (!dev) { dev = uid().slice(0, 3).toUpperCase(); await setMeta('device_code', dev); }
  return db.transaction('rw', db.meta, async () => {
    const n = ((await getMeta<number>('local_counter')) ?? 0) + 1;
    await setMeta('local_counter', n);
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${dev}-${ymd}-${String(n).padStart(4, '0')}`;
  });
}

export interface NewSaleInput {
  branch_id: string;
  cashier_name: string;
  customer_name?: string;
  notes?: string;
  items: PendingSale['items'];
  discount: number;
  payments: PendingSale['payments'];
}

/** Writes the sale and deducts local stock atomically. Works fully offline. */
export async function saveSaleLocal(input: NewSaleInput): Promise<PendingSale> {
  const local_ref = await nextLocalRef();
  return db.transaction('rw', db.batches, db.pending, async () => {
    const batches = await db.batches.toArray();
    const alloc: PendingSale['alloc'] = [];
    for (const it of input.items) {
      const a = allocateFEFO(batches, it.drug_id, it.quantity);
      const got = a.reduce((s, x) => s + x.qty, 0);
      if (got < it.quantity) throw new Error(`Not enough in-date stock for ${it.name} (have ${got}).`);
      for (const x of a) {
        const b = batches.find((y) => y.id === x.batch_id)!;
        b.quantity_remaining -= x.qty; // keep in-memory copy right for the next line item
        alloc.push(x);
      }
    }
    for (const x of alloc) {
      const b = await db.batches.get(x.batch_id);
      if (b) await db.batches.put({ ...b, quantity_remaining: b.quantity_remaining - x.qty });
    }
    const subtotal = input.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    const discount = Math.min(Math.max(input.discount, 0), subtotal);
    const sale: PendingSale = {
      id: uid(),
      local_ref,
      branch_id: input.branch_id,
      sold_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      cashier_name: input.cashier_name,
      customer_name: input.customer_name,
      notes: input.notes,
      items: input.items,
      discount,
      subtotal,
      total: subtotal - discount,
      payments: input.payments,
      alloc,
      status: 'pending',
      attempts: 0,
    };
    await db.pending.add(sale);
    return sale;
  });
}
