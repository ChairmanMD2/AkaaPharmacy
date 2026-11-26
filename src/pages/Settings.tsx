import { useState } from 'react';
import { db, getMeta } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { pullSettings } from '../lib/sync';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Spinner } from '../components/ui';
import { useToast } from '../components/toast';
import { useLiveQuery } from 'dexie-react-hooks';

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
  const pendingCount = useLiveQuery(() => db.pending.where('status').anyOf('pending', 'syncing', 'error').count(), [], 0);
  const s = useAsync(async () => {
    const { data, error } = await supabase.from('app_settings').select('key,value');
    if (error) throw error;
    const v: Record<string, string> = {};
    (data ?? []).forEach((r: any) => (v[r.key] = String(r.value ?? '')));
    setVals(v);
    return v;
  }, []);
  const device = useAsync(async () => ({ code: await getMeta<string>('device_code'), at: await getMeta<string>('catalog_at') }), []);

  const save = async () => {
    setBusy(true);
    const rows = KEYS.map((k) => ({ key: k.key, value: k.number ? Number(vals[k.key] || 0) : (vals[k.key] ?? '') }));
    const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    await pullSettings();
    toast('Settings saved.');
  };

  const reset = async () => {
    if (pendingCount > 0) return toast('This device still has sales waiting to upload. Sync first.', 'error');
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
        <h2 className="mb-1 font-semibold">This device</h2>
        <p className="text-muted">Device code: <b className="text-fg">{device.data?.code ?? 'not set yet'}</b> (prefix of offline receipt numbers) · Catalogue downloaded: {device.data?.at ? new Date(device.data.at).toLocaleString() : 'never'}</p>
        <Button className="mt-3" onClick={reset}>Clear local stock cache</Button>
      </Card>
    </>
  );
}
