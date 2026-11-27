/**
 * Real "can we reach the server?" detection.
 * `navigator.onLine` only says a network adapter is connected (Wi-Fi with no internet still reads "online"),
 * so we also probe the server. When the state flips back to online, listeners fire and everything
 * (sync, page refresh) resumes by itself, with no clicking Retry.
 */
type Listener = () => void;

let online = typeof navigator === 'undefined' ? true : navigator.onLine;
const stateListeners = new Set<Listener>();
const reconnectListeners = new Set<Listener>();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing = false;

export const isOnline = () => online;
export const subscribeConnectivity = (l: Listener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; };
/** Called every time we go from offline to online. */
export const onReconnect = (l: Listener) => { reconnectListeners.add(l); return () => { reconnectListeners.delete(l); }; };

function set(next: boolean) {
  if (next === online) return;
  online = next;
  stateListeners.forEach((l) => l());
  if (next) reconnectListeners.forEach((l) => l());
  schedule();
}

/** Call when a request failed because of the network. */
export function markOffline() { set(false); probeSoon(); }

async function ping(): Promise<boolean> {
  const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url) return navigator.onLine;
  try {
    const res = await fetch(`${url}/auth/v1/health`, { headers: key ? { apikey: key } : {}, cache: 'no-store', signal: AbortSignal.timeout(6000) });
    return res.status < 500; // 200 or 401 both mean "the server answered"
  } catch {
    return false;
  }
}

export async function probe(): Promise<boolean> {
  if (probing) return online;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { set(false); return false; }
  probing = true;
  try { const ok = await ping(); set(ok); return ok; } finally { probing = false; }
}

function probeSoon() { setTimeout(() => { void probe(); }, 1500); }

function schedule() {
  if (timer) clearTimeout(timer);
  // While offline, look for the connection every few seconds; while online, a light check now and then.
  timer = setTimeout(async () => { await probe(); schedule(); }, online ? 45000 : 5000);
}

export function startConnectivity() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => { void probe(); });
  window.addEventListener('offline', () => set(false));
  window.addEventListener('focus', () => { void probe(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void probe(); });
  void probe();
  schedule();
}

/** Test helper. */
export function __setOnlineForTests(v: boolean) { online = v; }
