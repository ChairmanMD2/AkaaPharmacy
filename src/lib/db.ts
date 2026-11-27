import Dexie, { type Table } from 'dexie';
import type { Batch, Drug, PendingSale } from './types';

export type OpType = 'expense.add' | 'wish.add' | 'wish.update' | 'wish.fulfil' | 'supplier.add' | 'receipt.create';
export interface OutboxOp {
  id: string;
  type: OpType;
  payload: any;
  label: string;
  status: 'pending' | 'error';
  error?: string;
  attempts: number;
  created_at: string;
}
export interface BranchRow { id: string; code: string; name: string }
export interface CacheRow { key: string; data: any; at: string }

/** Local (offline) database. Everything the app shows or saves works against this first; sync runs in the background. */
class AppDB extends Dexie {
  drugs!: Table<Drug, string>;
  batches!: Table<Batch, string>;
  branches!: Table<BranchRow, string>;
  pending_sales!: Table<PendingSale, string>;
  outbox!: Table<OutboxOp, string>;
  cache!: Table<CacheRow, string>;
  meta!: Table<{ key: string; value: any }, string>;

  constructor() {
    super('akaa_pharmacy');
    this.version(1).stores({
      drugs: 'id, name, barcode',
      batches: 'id, drug_id, expiry_date',
      pending: 'id, status, created_at',
      meta: 'key',
    });
    // v2: the offline sales queue is now called `pending_sales`, plus the outbox, a read cache and a branches mirror.
    this.version(2)
      .stores({
        drugs: 'id, name, barcode',
        batches: 'id, drug_id, expiry_date',
        pending: 'id, status, created_at',
        pending_sales: 'id, status, created_at',
        branches: 'id',
        outbox: 'id, status, created_at',
        cache: 'key',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const old = await tx.table('pending').toArray();
        if (old.length) await tx.table('pending_sales').bulkPut(old);
      });
    this.version(3).stores({ pending: null });
  }
}

export const db = new AppDB();

export async function getMeta<T = any>(key: string, fallback?: T): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row ? (row.value as T) : fallback;
}
export const setMeta = (key: string, value: any) => db.meta.put({ key, value });
