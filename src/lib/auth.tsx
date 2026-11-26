import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from './types';

const CACHE_KEY = 'akaa_profile';

interface AuthCtx {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  offlineMode: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

function readCache(): Profile | null {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); return; }
    const { data, error } = await supabase.from('profiles').select('id,full_name,phone,role,branch_id,is_active').eq('id', s.user.id).maybeSingle();
    if (data) {
      setProfile(data as Profile);
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } else if (error) {
      const c = readCache();
      if (c && c.id === s.user.id) setProfile(c); // offline: use the last known profile
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      if (data.session) {
        setSession(data.session);
        await loadProfile(data.session);
      } else if (!navigator.onLine) {
        // No usable session and no connection: allow the counter to keep selling with the cached profile.
        const c = readCache();
        if (c) { setProfile(c); setOfflineMode(true); }
      }
      if (alive) setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_OUT') { setProfile(null); localStorage.removeItem(CACHE_KEY); }
      else if (s) setTimeout(() => loadProfile(s), 0);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return error ? (error.message === 'Failed to fetch' ? 'No internet connection. Sign in once while online.' : error.message) : null;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setOfflineMode(false);
    setProfile(null);
  }, []);

  const refreshProfile = useCallback(async () => { await loadProfile(session); }, [session, loadProfile]);

  const value = useMemo(() => ({ session, profile, loading, offlineMode, signIn, signOut, refreshProfile }), [session, profile, loading, offlineMode, signIn, signOut, refreshProfile]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
