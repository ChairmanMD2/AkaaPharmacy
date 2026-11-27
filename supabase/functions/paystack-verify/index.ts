// Asks Paystack whether a payment succeeded. Staff only.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: who } = await caller.auth.getUser();
    if (!who?.user) return json(401, { error: 'Please sign in again.' });
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me } = await admin.from('profiles').select('role,is_active,branch_id').eq('id', who.user.id).maybeSingle();
    if (!me?.is_active || !['admin', 'pharmacist', 'cashier'].includes(me.role)) return json(403, { error: 'Not allowed.' });
    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) return json(503, { error: 'Paystack is not set up yet.' });

    const body = await req.json().catch(() => ({}));
    const reference = String(body.reference ?? '');
    const { data: row } = await admin.from('paystack_transactions').select('branch_id').eq('reference', reference).maybeSingle();
    if (!row) return json(404, { error: 'Unknown payment reference.' });
    if (me.role !== 'admin' && row.branch_id !== me.branch_id) return json(403, { error: 'Not allowed.' });
    return json(200, await settle(admin, reference, secret));
  } catch (e) {
    return json(500, { error: 'Unexpected error: ' + (e instanceof Error ? e.message : String(e)) });
  }
});
