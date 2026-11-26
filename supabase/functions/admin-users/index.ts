// Admin-only account management. Runs server-side with the service-role key (never exposed to the browser).
// Every request is authenticated with the caller's JWT, and the caller must be an ACTIVE ADMIN.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ROLES = ['admin', 'pharmacist', 'cashier', 'inventory_officer', 'courier', 'rider'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no look-alike characters

function tempPassword(len = 12): string {
  let out = '';
  while (out.length < len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const b of bytes) {
      if (b < 224 && out.length < len) out += ALPHABET[b % ALPHABET.length]; // 224 = 4 * 56: no modulo bias
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization') ?? '';
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: who, error: whoErr } = await caller.auth.getUser();
    if (whoErr || !who?.user) return json(401, { error: 'Please sign in again.' });

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me } = await admin.from('profiles').select('role,is_active').eq('id', who.user.id).maybeSingle();
    if (!me || !me.is_active || me.role !== 'admin') return json(403, { error: 'Only an administrator can do this.' });

    const body = await req.json().catch(() => ({}));

    if (body.action === 'create_user') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const full_name = String(body.full_name ?? '').trim();
      const role = String(body.role ?? '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });
      if (!full_name) return json(400, { error: 'Full name is required.' });
      if (!ROLES.includes(role)) return json(400, { error: 'Choose a valid role.' });
      const branch_id = body.branch_id ? String(body.branch_id) : null;
      const password = tempPassword();

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { full_name, must_change_password: true },
      });
      if (cErr || !created?.user) {
        const msg = /already|registered|exists/i.test(cErr?.message ?? '') ? 'A user with this email already exists.' : (cErr?.message ?? 'Could not create the user.');
        return json(400, { error: msg });
      }
      const { error: pErr } = await admin.from('profiles').update({
        full_name, role, branch_id, phone: body.phone ? String(body.phone).trim() : null, is_active: true,
      }).eq('id', created.user.id);
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id); // roll back so no half-created account is left
        return json(500, { error: 'Could not set up the profile: ' + pErr.message });
      }
      return json(200, { id: created.user.id, email, temp_password: password });
    }

    if (body.action === 'set_password') {
      const user_id = String(body.user_id ?? '');
      if (!user_id) return json(400, { error: 'user_id is required.' });
      const { data: target, error: gErr } = await admin.auth.admin.getUserById(user_id);
      if (gErr || !target?.user) return json(404, { error: 'User not found.' });
      const password = tempPassword();
      const { error: uErr } = await admin.auth.admin.updateUserById(user_id, {
        password,
        user_metadata: { ...(target.user.user_metadata ?? {}), must_change_password: true },
      });
      if (uErr) return json(400, { error: uErr.message });
      return json(200, { id: user_id, email: target.user.email, temp_password: password });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: 'Unexpected error: ' + (e instanceof Error ? e.message : String(e)) });
  }
});
