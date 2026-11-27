import { useState } from 'react';
import { db, getMeta } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { pullSettings } from '../lib/sync';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Spinner } from '../components/ui';
import { useToast } from '../components/toast';
import { useLiveQuery } from 'dexie-react-hooks';
import { paystackConfigured } from '../lib/paystack';

const KEYS: { key: string; label: string; hint?: string; number?: boolean }[] = [
  { key: 'business_name', label: 'Business name' },
  { key: 'business_address', label: 'Address (printed on receipts)' },
  { key: 'business_phone', label: 'Phone (printed on receipts)' },
  { key: 'currency_symbol', label: 'Currency symbol' },
  { key: 'default_delivery_fee', label: 'Default delivery fee', number: true },
  { key: 'expiry_warning_days', label: 'Expiry warning (days)', number: true },
  { key: 'receipt_footer', label: 'Receipt footer message' },
];

export default function Settings() {
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pendingCount = useLiveQuery(() => db.pending_sales.where('status').anyOf('pending', 'syncing', 'error').count(), [], 0);
  const s = useAsync(async () => {
    const { data, error } = await supabase.from('app_settings').select('key,value');
    if (error) throw error;
    const v: Record<string, string> = {};
    (data ?? []).forEach((r: any) => (v[r.key] = String(r.value ?? '')));
    setVals(v);
    return v;
  }, []);
  const device = useAsync(async () => ({ code: await getMeta<string>('device_code'), at: await getMeta<string>('catalog_at') }), []);

  const [psStatus, setPsStatus] = useState<null | { ok: boolean; text: string }>(null);
  const checkPaystack = async () => {
    setPsStatus(null);
    try {
      const ok = await paystackConfigured();
      setPsStatus(ok ? { ok: true, text: 'The Paystack secret key is installed on the server. You can switch Paystack on.' } : { ok: false, text: 'The secret key has not been added on the server yet. Add it (steps below), then check again.' });
    } catch (e: any) { setPsStatus({ ok: false, text: e?.message || 'Could not reach the Paystack function.' }); }
  };

  const save = async () => {
    setBusy(true);
    const rows: { key: string; value: any }[] = KEYS.map((k) => ({ key: k.key, value: k.number ? Number(vals[k.key] || 0) : (vals[k.key] ?? '') }));
    rows.push({ key: 'paystack_enabled', value: vals.paystack_enabled === 'true' });
    const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    await pullSettings();
    toast('Settings saved.');
  };

  const reset = async () => {
    if (pendingCount > 0 || (await db.outbox.count()) > 0) return toast('This device still has sales or entries waiting to upload. Sync first.', 'error');
    await db.drugs.clear(); await db.batches.clear();
    toast('Local catalogue cleared. It will re-download on the next sync.', 'info');
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Business details used on receipts and defaults" />
      {s.loading && !s.data ? <Spinner /> : s.error ? <ErrorBox message={s.error} onRetry={s.reload} /> : (
        <Card className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {KEYS.map((k) => <Field key={k.key} label={k.label} className={k.key === 'receipt_footer' || k.key === 'business_address' ? 'sm:col-span-2' : ''}><Input value={vals[k.key] ?? ''} inputMode={k.number ? 'decimal' : undefined} onChange={(e) => setVals({ ...vals, [k.key]: e.target.value })} /></Field>)}
          </div>
          <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} onClick={save}>Save settings</Button></div>
        </Card>
      )}
      <Card className="mt-4 p-4 text-sm">
        <h2 className="mb-1 font-semibold">Paystack payments</h2>
        <p className="text-muted">Lets staff take card, bank-transfer and USSD payments at the till and on orders. The sale is only recorded as paid after the server has confirmed the money with Paystack.</p>
        <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={vals.paystack_enabled === 'true'} onChange={(e) => setVals({ ...vals, paystack_enabled: String(e.target.checked) })} />Accept Paystack payments (remember to press <b>Save settings</b>)</label>
        <div className="mt-3 flex flex-wrap items-center gap-2"><Button onClick={checkPaystack}>Check Paystack connection</Button>{psStatus && <span className={psStatus.ok ? 'text-ok' : 'text-bad'}>{psStatus.text}</span>}</div>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-muted">
          <li>In Supabase, open <b>Edge Functions → Secrets</b> and add a secret named <code>PAYSTACK_SECRET_KEY</code> with your Paystack secret key. Never paste this key into the app or into chat.</li>
          <li>In your Paystack dashboard, set the webhook URL to <code className="break-all">{(import.meta.env.VITE_SUPABASE_URL as string) || 'your-project-url'}/functions/v1/paystack-webhook</code> (a backup confirmation path; payments are also confirmed directly with Paystack).</li>
          <li>Press <b>Check Paystack connection</b>, tick the box above and save.</li>
        </ol>
      </Card>
      <Card className="mt-4 p-4 text-sm">
        <h2 className="mb-1 font-semibold">Silent receipt printing (counter PC)</h2>
        <p className="text-muted">By default the browser shows a print dialog for each receipt. To print straight to the default thermal printer with one click:</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
          <li>Install the app (Chrome or Edge address bar → <b>Install app</b>) and pin it to the taskbar.</li>
          <li>Right-click the new desktop shortcut → <b>Properties</b>.</li>
          <li>At the very end of the <b>Target</b> box, add a space and then <code>--kiosk-printing</code>, and click OK.</li>
          <li>Set the 80&nbsp;mm thermal printer as the Windows <b>default printer</b>. Receipts then print immediately when you press <b>Print receipt</b>.</li>
        </ol>
      </Card>
      <Card className="mt-4 p-4 text-sm">
        <h2 className="mb-1 font-semibold">This device</h2>
        <p className="text-muted">Device code: <b className="text-fg">{device.data?.code ?? 'not set yet'}</b> (prefix of offline receipt numbers) · Catalogue downloaded: {device.data?.at ? new Date(device.data.at).toLocaleString() : 'never'}</p>
        <Button className="mt-3" onClick={reset}>Clear local stock cache</Button>
      </Card>
    </>
  );
}
