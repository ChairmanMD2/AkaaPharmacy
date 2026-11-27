// Paystack webhook (backup confirmation path). Public endpoint, so it never trusts what it is told:
// it only re-checks a payment that WE started, by asking Paystack directly.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Settle = { status: 'success' | 'pending' | 'failed'; message?: string };

/**
 * Asks Paystack directly whether this payment really succeeded, and records the answer.
 * This is the ONLY place a payment becomes "success". The amount must match exactly what we asked for.
 */
async function settle(admin: any, ref: string, secret: string): Promise<Settle> {
  const { data: row } = await admin.from('paystack_transactions').select('*').eq('reference', ref).maybeSingle();
  if (!row) return { status: 'failed', message: 'Unknown payment reference.' };
  if (row.status === 'success') return { status: 'success' };
  if (row.status === 'failed') return { status: 'failed', message: row.gateway_response ?? 'The payment failed.' };

  let r: Response;
  try {
    r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${secret}` } });
  } catch { return { status: 'pending', message: 'Could not reach Paystack.' }; }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.status) return { status: 'pending', message: j?.message ?? 'Paystack did not confirm yet.' };

  const d = j.data ?? {};
  const now = new Date().toISOString();
  if (d.status === 'success') {
    const expected = Math.round(Number(row.amount) * 100);                    // Paystack amounts are in kobo
    if (Number(d.amount) !== expected || (d.currency && d.currency !== row.currency)) {
      await admin.from('paystack_transactions').update({ status: 'failed', gateway_response: 'Amount or currency did not match', verified_at: now }).eq('reference', ref);
      return { status: 'failed', message: 'The amount Paystack received does not match the sale. Contact your administrator.' };
    }
    await admin.from('paystack_transactions').update({
      status: 'success', channel: d.channel ?? null, gateway_response: d.gateway_response ?? null, paid_at: d.paid_at ?? now, verified_at: now,
    }).eq('reference', ref).eq('status', 'initiated');
    return { status: 'success' };
  }
  if (d.status === 'failed' || d.status === 'reversed') {
    await admin.from('paystack_transactions').update({ status: 'failed', gateway_response: d.gateway_response ?? d.status, verified_at: now }).eq('reference', ref).eq('status', 'initiated');
    return { status: 'failed', message: d.gateway_response ?? 'The payment failed.' };
  }
  return { status: 'pending' };            // not paid (yet): abandoned / ongoing / pending
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!secret) return json(503, { error: 'Not configured.' });
  const raw = await req.text();

  // legacy signature header: HMAC-SHA512 of the raw body with the secret key. If it is present it must be right.
  const sig = req.headers.get('x-paystack-signature');
  if (sig && !safeEqual((await hmacHex(secret, raw)).toLowerCase(), sig.toLowerCase())) return json(401, { error: 'Bad signature.' });

  let ref = '';
  try { ref = String(JSON.parse(raw)?.data?.reference ?? ''); } catch { /* ignore */ }
  if (ref) {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    try { await settle(admin, ref, secret); } catch { /* answered below; Paystack will retry */ }
  }
  return json(200, { ok: true });
});
