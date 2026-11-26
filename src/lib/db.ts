import Dexie, { type Table } from 'dexie';
import type { Batch, Drug, PendingSale } from './types';

/** Local (offline) database. Counter reads and writes here; sync happens in the background. */
class AppDB extends Dexie {
  drugs!: Table<Drug, string>;
  batches!: Table<Batch, string>;
  pending!: Table<PendingSale, string>;
  meta!: Table<{ key: string; value: any }, string>;

  constructor() {
    super('akaa_pharmacy');
    this.version(1).stores({
      drugs: 'id, name, barcode',
      batches: 'id, drug_id, expiry_date',
      pending: 'id, status, created_at',
      meta: 'key',
    });
  }
}

export const db = new AppDB();

export async function getMeta<T = any>(key: string, fallback?: T): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row ? (row.value as T) : fallback;
}
export const setMeta = (key: string, value: any) => db.meta.put({ key, value });
