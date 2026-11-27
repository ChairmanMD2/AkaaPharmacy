import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key);

export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'akaa_auth' },
});

/** True when an error looks like "no connection" rather than a server-side rejection. */
export function isNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  return !navigator.onLine || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout/i.test(msg);
}

export function errMsg(err: unknown): string {
  if (isNetworkError(err)) return 'No connection right now. This action needs the internet; try again when you are back online.';
  const e = err as any;
  return e?.message || e?.error_description || String(err);
}

/** Calls the admin-only account function (runs server-side with the service key). */
export async function callAdmin<T = any>(body: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep the generic message */ }
    return { error: msg };
  }
  if ((data as any)?.error) return { error: (data as any).error };
  return { data: data as T };
}

/** Fetch every row of a query, 1000 at a time. */
export async function fetchAll<T = any>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
