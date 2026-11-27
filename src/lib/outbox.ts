import { db, type OpType, type OutboxOp } from './db';
import { errMsg, isNetworkError, supabase } from './supabase';
import { isOnline, markOffline } from './connectivity';
import { uid } from './format';

/**
 * Anything the user saves that is not a sale (expenses, wish-list entries, suppliers, stock receipts) goes through
 * here. Online: it is sent immediately. Offline (or if the network drops mid-send): it is stored on the device and
 * uploaded automatically, in order, when the connection returns. Every operation carries a client-generated id,
 * so a retry can never create duplicates.
 */

type Handler = (payload: any) => Promise<void>;
const UNIQUE_VIOLATION = '23505';

const asOk = (error: any) => { if (error && error.code !== UNIQUE_VIOLATION) throw error; };   // duplicate = already saved

export const handlers: Record<OpType, Handler> = {
  'expense.add': async (p) => { const { error } = await supabase.from('expenses').insert(p.rows); asOk(error); },
  'wish.add': async (p) => { const { error } = await supabase.from('wishlist_items').insert(p.row); asOk(error); },
  'wish.update': async (p) => { const { error } = await supabase.from('wishlist_items').update(p.patch).eq('id', p.id); if (error) throw error; },
  'wish.fulfil': async (p) => {
    const { error } = await supabase.from('wishlist_items').update({ status: 'fulfilled' }).in('id', p.ids).in('status', ['open', 'sourcing']);
    if (error) throw error;
  },
  'supplier.add': async (p) => { const { error } = await supabase.from('suppliers').insert(p.row); asOk(error); },
  'receipt.create': async (p) => { const { error } = await supabase.rpc('receive_stock_invoice', { p_receipt: p.receipt }); if (error) throw error; },
};

export async function enqueue(type: OpType, payload: any, label: string): Promise<OutboxOp> {
  const op: OutboxOp = { id: uid(), type, payload, label, status: 'pending', attempts: 0, created_at: new Date().toISOString() };
  await db.outbox.add(op);
  return op;
}

export const pendingCount = () => db.outbox.where('status').equals('pending').count();

/**
 * Save something. Returns `{ queued: true }` when it was stored for later upload,
 * `{ error }` when the server rejected it (the user should fix it), or `{ queued: false }` when it is saved.
 */
export async function runOrQueue(type: OpType, payload: any, label: string): Promise<{ queued: boolean; error?: string }> {
  // keep order: if older items are still waiting, this one waits behind them
  const waiting = await db.outbox.count();
  if (isOnline() && waiting === 0) {
    try { await handlers[type](payload); return { queued: false }; }
    catch (e) {
      if (!isNetworkError(e)) return { queued: false, error: errMsg(e) };
      markOffline();
    }
  }
  await enqueue(type, payload, label);
  return { queued: true };
}

/** Upload everything waiting, oldest first. Stops at the first network failure; marks server rejections as errors. */
export async function pushOutbox(): Promise<{ sent: number; failed: number; offline: boolean }> {
  const ops = (await db.outbox.orderBy('created_at').toArray()).filter((o) => o.status === 'pending');
  let sent = 0, failed = 0;
  for (const op of ops) {
    try {
      await handlers[op.type](op.payload);
      await db.outbox.delete(op.id);
      sent++;
    } catch (e) {
      if (isNetworkError(e)) { markOffline(); return { sent, failed, offline: true }; }
      await db.outbox.update(op.id, { status: 'error', error: errMsg(e), attempts: op.attempts + 1 });
      failed++;
    }
  }
  return { sent, failed, offline: false };
}

export const retryOp = (id: string) => db.outbox.update(id, { status: 'pending', error: undefined });
export const discardOp = (id: string) => db.outbox.delete(id);
