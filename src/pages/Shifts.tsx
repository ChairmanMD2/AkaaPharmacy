import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Printer, RefreshCw } from 'lucide-react';
import { db } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { syncAll } from '../lib/sync';
import { useAsync, useOnline } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { fmtDateTime, money } from '../lib/format';
import { PAY_LABEL, type PayMethod } from '../lib/types';
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Input, PageHeader, Spinner, Table, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

interface Summary {
  sales_count: number; sales_total: number; by_method: Record<string, number>; cash_received: number; change_given: number;
  cash_refunds: number; pending_verification: number; opening_float: number; expected_cash: number; counted_cash?: number; difference?: number;
}

export default function Shifts() {
  const { profile } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const [openFloat, setOpenFloat] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<any | null>(null);
  const [tick, setTick] = useState(0);
  const waiting = useLiveQuery(() => db.pending.where('status').anyOf('pending', 'syncing', 'error').count(), [], 0);

  const current = useAsync(async () => {
    const { data, error } = await supabase.from('shifts').select('*').eq('cashier_id', profile!.id).eq('status', 'open').maybeSingle();
    if (error) throw error;
    return data as any | null;
  }, [profile?.id]);

  const summary = useAsync(async () => {
    if (!current.data) return null;
    const { data, error } = await supabase.rpc('shift_summary', { p_shift: current.data.id });
    if (error) throw error;
    return data as Summary;
  }, [current.data?.id, tick]);

  useEffect(() => { if (!current.data) return; const t = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(t); }, [current.data]);

  const history = useAsync(async () => {
    const { data, error } = await supabase.from('shifts').select('*').order('opened_at', { ascending: false }).limit(60);
    if (error) throw error;
    const ids = Array.from(new Set((data ?? []).map((s: any) => s.cashier_id)));
    const { data: ps } = ids.length ? await supabase.from('profiles').select('id,full_name').in('id', ids) : { data: [] as any[] };
    const names = new Map((ps ?? []).map((p: any) => [p.id, p.full_name]));
    return (data ?? []).map((s: any) => ({ ...s, cashier: names.get(s.cashier_id) ?? '—' }));
  }, [current.data?.id]);

  const start = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('open_shift', { p_float: Number(openFloat || 0) });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    toast('Shift started.'); setOpenFloat(''); current.reload();
  };

  const s = summary.data;
  const diff = s && counted !== '' ? Number(counted) - s.expected_cash : null;

  const close = async () => {
    if (!current.data || counted === '') return toast('Enter the cash you counted in the drawer.', 'error');
    setBusy(true);
    const { error } = await supabase.rpc('close_shift', { p_shift: current.data.id, p_counted: Number(counted), p_note: note || null });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    toast('Shift closed.'); setCounted(''); setNote(''); current.reload(); history.reload();
  };

  if (!online && !current.data) return <Card><Empty title="Cash-up needs an internet connection" hint="Selling keeps working offline. Reconnect to open or close a shift." /></Card>;

  return (
    <>
      <PageHeader title="Cash-up" subtitle="Start a shift with the till float and close it by counting the drawer" />
      {current.loading && !current.data && current.data !== null ? <Spinner /> : current.error ? <ErrorBox message={current.error} onRetry={current.reload} /> : !current.data ? (
        <Card className="mb-4 max-w-xl p-5">
          <h2 className="font-semibold">No shift open</h2>
          <p className="mb-3 text-sm text-muted">Count the cash already in your drawer and enter it as the opening float (0 if the drawer is empty).</p>
          <div className="flex items-end gap-2">
            <Field label="Opening float" className="flex-1"><Input inputMode="decimal" value={openFloat} onChange={(e) => setOpenFloat(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
            <Button variant="primary" loading={busy} onClick={start}>Start shift</Button>
          </div>
        </Card>
      ) : (
        <Card className="mb-4">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div><h2 className="font-semibold">Shift open <Badge tone="ok">since {fmtDateTime(current.data.opened_at)}</Badge></h2></div>
            <Button size="sm" onClick={() => setTick((x) => x + 1)}><RefreshCw size={14} />Refresh</Button>
          </div>
          {!s ? <Spinner /> : (
            <div className="grid gap-6 p-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold">Expected cash in the drawer</h3>
                <dl className="space-y-1.5 text-sm tnum">
                  <Row a="Opening float" b={money(s.opening_float)} />
                  <Row a={`Cash received (${s.sales_count} sale${s.sales_count === 1 ? '' : 's'}, ${money(s.sales_total)} total)`} b={`+ ${money(s.cash_received)}`} />
                  <Row a="Change given to customers" b={`− ${money(s.change_given)}`} />
                  <Row a="Cash refunds paid out" b={`− ${money(s.cash_refunds)}`} />
                  <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold"><dt>Expected cash</dt><dd>{money(s.expected_cash)}</dd></div>
                </dl>
                <h3 className="mb-1 mt-4 text-sm font-semibold">Not cash (check against bank / POS terminal)</h3>
                <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                  {Object.entries(s.by_method).filter(([m]) => m !== 'cash').map(([m, v]) => <li key={m} className="flex justify-between px-3 py-2"><span>{PAY_LABEL[m as PayMethod] ?? m}</span><span className="tnum">{money(v)}</span></li>)}
                  {!Object.keys(s.by_method).some((m) => m !== 'cash') && <li className="px-3 py-2 text-muted">No card, transfer or POS payments this shift.</li>}
                </ul>
                {s.pending_verification > 0 && <p className="mt-2 text-xs text-warn">{money(s.pending_verification)} of these is still waiting to be verified against the bank statement.</p>}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Close shift</h3>
                {waiting > 0 && (
                  <div className="mb-3 rounded-lg bg-warnsoft p-3 text-sm text-warn">
                    {waiting} sale(s) on this device have not uploaded yet, so the figures are incomplete. Upload them before closing.
                    <Button size="sm" className="mt-2" disabled={!online} onClick={async () => { await syncAll(profile?.branch_id ?? null); setTick((x) => x + 1); }}>Sync now</Button>
                  </div>
                )}
                <Field label="Cash counted in the drawer *"><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
                {diff !== null && (
                  <p className={`mt-2 rounded-lg p-2.5 text-sm font-medium ${diff === 0 ? 'bg-oksoft text-ok' : 'bg-badsoft text-bad'}`}>
                    {diff === 0 ? 'The drawer balances.' : diff < 0 ? `Short by ${money(Math.abs(diff))}.` : `Over by ${money(diff)}.`}
                  </p>
                )}
                <Field label={diff ? 'Explain the difference *' : 'Note (optional)'} className="mt-3"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <Button variant="primary" size="lg" className="mt-3 w-full" loading={busy} disabled={waiting > 0 || counted === '' || (!!diff && !note.trim())} onClick={close}>Close shift</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card>
        <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Past shifts</h2></div>
        {history.loading && !history.data ? <Spinner /> : history.error ? <ErrorBox message={history.error} onRetry={history.reload} /> : !history.data?.length ? <Empty title="No shifts yet" /> : (
          <Table head={['Cashier', 'Opened', 'Closed', 'Float', 'Expected', 'Counted', 'Difference']}>
            {history.data.map((h: any) => (
              <tr key={h.id} className="cursor-pointer hover:bg-surface2" onClick={() => setView(h)}>
                <Td className="font-medium">{h.cashier}</Td><Td className="text-muted">{fmtDateTime(h.opened_at)}</Td>
                <Td className="text-muted">{h.status === 'open' ? <Badge tone="ok">open</Badge> : fmtDateTime(h.closed_at)}</Td>
                <Td className="tnum">{money(h.opening_float)}</Td><Td className="tnum">{h.expected_cash != null ? money(h.expected_cash) : '—'}</Td><Td className="tnum">{h.counted_cash != null ? money(h.counted_cash) : '—'}</Td>
                <Td>{h.difference == null ? '—' : Number(h.difference) === 0 ? <Badge tone="ok">balanced</Badge> : <Badge tone="bad">{Number(h.difference) > 0 ? '+' : '−'}{money(Math.abs(Number(h.difference)))}</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {view && <ShiftDrawer shift={view} onClose={() => setView(null)} />}
    </>
  );
}

const Row = ({ a, b }: { a: string; b: string }) => <div className="flex justify-between gap-3"><dt className="text-muted">{a}</dt><dd>{b}</dd></div>;

function ShiftDrawer({ shift, onClose }: { shift: any; onClose: () => void }) {
  const sum = useAsync(async () => {
    const { data, error } = await supabase.rpc('shift_summary', { p_shift: shift.id });
    if (error) throw error;
    return data as Summary;
  }, [shift.id]);
  const body = (s: Summary) => (
    <div className="text-sm">
      <h2 className="text-base font-semibold">Cash-up report</h2>
      <p className="text-muted">{shift.cashier} · {fmtDateTime(shift.opened_at)} → {shift.closed_at ? fmtDateTime(shift.closed_at) : 'still open'}</p>
      <dl className="mt-3 space-y-1.5 tnum">
        <Row a="Opening float" b={money(s.opening_float)} />
        <Row a={`Cash received (${s.sales_count} sales, ${money(s.sales_total)} total)`} b={`+ ${money(s.cash_received)}`} />
        <Row a="Change given" b={`− ${money(s.change_given)}`} />
        <Row a="Cash refunds" b={`− ${money(s.cash_refunds)}`} />
        <div className="flex justify-between border-t border-line pt-1.5 font-semibold"><dt>Expected cash</dt><dd>{money(s.expected_cash)}</dd></div>
        {s.counted_cash != null && <Row a="Counted" b={money(s.counted_cash)} />}
        {s.difference != null && <div className="flex justify-between font-semibold"><dt>Difference</dt><dd>{Number(s.difference) === 0 ? 'Balanced' : money(s.difference)}</dd></div>}
      </dl>
      {Object.entries(s.by_method).filter(([m]) => m !== 'cash').length > 0 && <p className="mt-3 text-muted">Non-cash: {Object.entries(s.by_method).filter(([m]) => m !== 'cash').map(([m, v]) => `${PAY_LABEL[m as PayMethod] ?? m} ${money(v)}`).join(' · ')}</p>}
      {shift.note && <p className="mt-3"><b>Note:</b> {shift.note}</p>}
    </div>
  );
  return (
    <>
      <Drawer title="Shift details" onClose={onClose} footer={<Button onClick={() => window.print()} disabled={!sum.data}><Printer size={16} />Print</Button>}>
        {sum.loading && !sum.data ? <Spinner /> : sum.error ? <ErrorBox message={sum.error} /> : sum.data && body(sum.data)}
      </Drawer>
      {sum.data && createPortal(<div className="printable print-only bg-white p-6 text-black">{body(sum.data)}</div>, document.body)}
    </>
  );
}
