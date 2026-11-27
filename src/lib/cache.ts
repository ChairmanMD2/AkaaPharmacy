import { db } from './db';

/**
 * Read cache: the last successful result of each page query, so pages still show real
 * figures when the connection is down. Entries are tied to the signed-in user so that
 * one person's data is never shown to another on a shared PC.
 */
let scope = 'anon';
export const setCacheScope = (userId: string | null | undefined) => { scope = userId || 'anon'; };
const k = (key: string) => `${scope}::${key}`;

export async function getCache<T = any>(key: string): Promise<{ data: T; at: string } | null> {
  try {
    const r = await db.cache.get(k(key));
    return r ? { data: r.data as T, at: r.at } : null;
  } catch { return null; }
}

export async function putCache(key: string, data: unknown): Promise<void> {
  try { await db.cache.put({ key: k(key), data, at: new Date().toISOString() }); } catch { /* storage full or blocked: ignore */ }
}

/** Remove every cached page result (used on sign-out). */
export async function clearCache(): Promise<void> {
  try { await db.cache.clear(); } catch { /* ignore */ }
}
