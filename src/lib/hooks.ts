import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isOnline, markOffline, onReconnect, subscribeConnectivity } from './connectivity';
import { getCache, putCache } from './cache';
import { isNetworkError } from './supabase';
import { onDataChange } from './realtime';

/** True when the server is actually reachable (not just "connected to Wi-Fi"). */
export function useOnline() {
  return useSyncExternalStore(subscribeConnectivity, isOnline);
}

interface AsyncOpts {
  /** Remember the last good result under this key so the page still shows real data offline. Include every filter in the key. */
  cacheKey?: string;
}

/**
 * Data loader: { data, loading, error, reload, cachedAt }.
 * - Shows the saved copy immediately (if any), then refreshes from the server.
 * - Offline or network failure: keeps showing the saved copy instead of an error.
 * - Refreshes by itself the moment the connection returns.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: AsyncOpts = {}) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const tick = useRef(0);
  const dataRef = useRef<T | null>(null);
  const key = opts.cacheKey;

  const setBoth = (d: T | null) => { dataRef.current = d; setData(d); };

  const run = useCallback(async () => {
    const my = ++tick.current;
    setLoading(true);
    if (key && dataRef.current == null) {
      const c = await getCache<T>(key);
      if (c && my === tick.current) { setBoth(c.data); setCachedAt(c.at); }
    }
    if (!isOnline()) {
      // no point asking the server: show what we have
      if (my === tick.current) {
        setLoading(false);
        setError(dataRef.current == null ? 'Nothing saved for this page yet. Open it once while online and it will be available offline.' : null);
      }
      return;
    }
    try {
      const d = await fn();
      if (my === tick.current) { setBoth(d); setError(null); setCachedAt(null); if (key) void putCache(key, d); }
    } catch (e: any) {
      if (my === tick.current) {
        if (isNetworkError(e)) {
          markOffline();
          setError(dataRef.current == null ? 'No connection and nothing saved for this page yet. It will load by itself when you are back online.' : null);
        } else setError(e?.message || String(e));
      }
    } finally {
      if (my === tick.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key]);

  useEffect(() => { dataRef.current = null; setData(null); setCachedAt(null); }, [key]);
  useEffect(() => { void run(); }, [run]);
  useEffect(() => onReconnect(() => { void run(); }), [run]);
  useEffect(() => onDataChange(() => { void run(); }), [run]);      // someone changed something: refresh quietly
  return { data, loading, error, reload: run, setData: setBoth, cachedAt };
}

export function useDebounced<T>(value: T, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
