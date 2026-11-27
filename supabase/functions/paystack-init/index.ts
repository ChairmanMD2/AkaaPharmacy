// Starts a Paystack payment. Staff only (cashier, pharmacist, admin). The secret key lives only in Supabase secrets.
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

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReference(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `AKP${ymd}${[...b].map((x) => ALNUM[x % ALNUM.length]).join('')}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: who } = await caller.auth.getUser();
    if (!who?.user) return json(401, { error: 'Please sign in again.' });
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me } = await admin.from('profiles').select('id,role,is_active,branch_id').eq('id', who.user.id).maybeSingle();
    if (!me?.is_active || !['admin', 'pharmacist', 'cashier'].includes(me.role)) return json(403, { error: 'Not allowed.' });

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    const body = await req.json().catch(() => ({}));
    if (body.action === 'status') return json(200, { configured: Boolean(secret) });
    if (!secret) return json(503, { error: 'Paystack is not set up yet. An administrator must add the Paystack secret key on the server.' });

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 100) return json(400, { error: 'The amount must be at least 100.' });
    if (amount > 20000000) return json(400, { error: 'That amount is too large for a single payment.' });
    const purpose = body.purpose === 'order' ? 'order' : 'pos';
    let order_id: string | null = null;
    if (purpose === 'order') {
      const { data: o } = await admin.from('orders').select('id,branch_id').eq('id', String(body.order_id ?? '')).maybeSingle();
      if (!o) return json(400, { error: 'Order not found.' });
      if (me.role !== 'admin' && o.branch_id !== me.branch_id) return json(403, { error: 'Not allowed.' });
      order_id = o.id;
    }
    const email = (typeof body.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) ? body.email.trim() : (who.user.email ?? 'customer@example.com');

    // only allow returning to our own site
    let callback_url: string | undefined;
    try { const cb = new URL(String(body.callback_url ?? '')); if (cb.origin === req.headers.get('origin')) callback_url = cb.toString(); } catch { /* none */ }

    const reference = newReference();
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount: Math.round(amount * 100), currency: 'NGN', reference, callback_url, metadata: { purpose, order_id, branch_id: me.branch_id, staff: me.id } }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.status || !j?.data?.authorization_url) return json(502, { error: j?.message ?? 'Paystack could not start the payment.' });

    const { error } = await admin.from('paystack_transactions').insert({
      reference, branch_id: me.branch_id, purpose, amount, currency: 'NGN', customer_email: email, status: 'initiated', initiated_by: me.id,
    });
    if (error) return json(500, { error: 'Could not record the payment: ' + error.message });
    return json(200, { reference, authorization_url: j.data.authorization_url });
  } catch (e) {
    return json(500, { error: 'Unexpected error: ' + (e instanceof Error ? e.message : String(e)) });
  }
});
