import { supabase } from './supabase';
import { isOnline } from './connectivity';

/**
 * Live updates: when anyone changes stock, a sale, an order, a delivery, the wish list, expenses or receipts,
 * every open screen refreshes within a couple of seconds, with no clicking. (Row security still applies, so a
 * device only hears about rows it is allowed to see.) If the live channel drops, the 60 s refresh and the
 * reconnect sync still keep everything correct.
 */
const TABLES = ['drugs', 'drug_batches', 'sales', 'payments', 'orders', 'delivery_jobs', 'wishlist_items', 'expenses', 'stock_receipts', 'suppliers', 'shifts'] as const;
const STOCK = new Set<string>(['drugs', 'drug_batches', 'stock_receipts']);

type Listener = () => void;
const dataListeners = new Set<Listener>();
let stockHandler: Listener | null = null;
/** Called after something changed elsewhere. Debounced. */
export const onDataChange = (l: Listener) => { dataListeners.add(l); return () => { dataListeners.delete(l); }; };

export function createDebouncer(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

const fireData = createDebouncer(() => { if (isOnline()) dataListeners.forEach((l) => l()); }, 1500);
const fireStock = createDebouncer(() => { if (isOnline()) stockHandler?.(); }, 1200);

let channel: ReturnType<typeof supabase.channel> | null = null;

/** Start listening. `onStockChange` should pull the stock catalogue into the device. Returns a stop function. */
export function startRealtime(onStockChange: Listener): () => void {
  stopRealtime();
  stockHandler = onStockChange;
  const ch = supabase.channel('akaa-live');
  TABLES.forEach((t) => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => { fireData(); if (STOCK.has(t)) fireStock(); }));
  ch.subscribe((status) => { if (status === 'SUBSCRIBED') { fireData(); fireStock(); } });   // (re)connected: catch up on anything missed
  channel = ch;
  return stopRealtime;
}

export function stopRealtime() {
  if (channel) { void supabase.removeChannel(channel); channel = null; }
  stockHandler = null;
}
