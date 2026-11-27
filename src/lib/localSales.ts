import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { PendingSale } from './types';

/** Sales that happened on this device but are not on the server yet. */
export const isWaiting = (s: PendingSale) => s.status !== 'synced';

export function useWaitingSales(): PendingSale[] {
  return useLiveQuery(async () => (await db.pending_sales.toArray()).filter(isWaiting).sort((a, b) => b.sold_at.localeCompare(a.sold_at)), [], [] as PendingSale[]);
}

export const paidOf = (s: PendingSale) => s.payments.reduce((t, p) => t + p.amount, 0);
export const changeOf = (s: PendingSale) => Math.max(0, paidOf(s) - s.total);

/** Same arithmetic the server uses for a cash-up, applied to the sales still waiting on this device. */
export function summarizeWaiting(sales: PendingSale[]) {
  const by_method: Record<string, number> = {};
  let total = 0, change = 0;
  for (const s of sales) {
    total += s.total; change += changeOf(s);
    for (const p of s.payments) by_method[p.method] = (by_method[p.method] ?? 0) + p.amount;
  }
  return { count: sales.length, total, by_method, cash_received: by_method.cash ?? 0, change_given: change };
}

export const isToday = (iso: string) => {
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};
