import { useState } from 'react';
import { MapPin, Phone } from 'lucide-react';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { isCourier } from '../lib/permissions';
import { fmtDateTime, money } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Tabs, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

const COLS = 'id,order_id,status,provider,courier_name,recipient_name,recipient_phone,address,notes,items_summary,cod_amount,collected_amount,proof_name,failure_reason,assigned_at,delivered_at';
type Tab = 'active' | 'done';

export default function Deliveries() {
  const { profile } = useAuth();
  const toast = useToast();
  const mine = isCourier(profile?.role);
  const [tab, setTab] = useState<Tab>('active');
  const [deliver, setDeliver] = useState<any | null>(null);
  const [fail, setFail] = useState<any | null>(null);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [collected, setCollected] = useState('');

  const jobs = useAsync(async () => {
    const { data, error } = await supabase.from('delivery_jobs').select(COLS).order('assigned_at', { ascending: false }).limit(200);
    if (error) throw error;
    return data as any[];
  }, []);

  const update = async (job: any, status: string, note?: string) => {
    const { error } = await supabase.rpc('courier_update_job', { p_job: job.id, p_status: status, p_note: note ?? null });
    if (error) return toast(errMsg(error), 'error');
    toast(status === 'failed' ? 'Marked as failed.' : 'Status updated.'); setFail(null); setText(''); jobs.reload();
  };
  const confirm = async () => {
    const { error } = await supabase.rpc('confirm_delivery', { p_job: deliver.id, p_code: code, p_recipient: text, p_collected: collected === '' ? null : Number(collected), p_photo: null });
    if (error) return toast(errMsg(error), 'error');
    toast('Delivery confirmed.'); setDeliver(null); setCode(''); setText(''); setCollected(''); jobs.reload();
  };

  const isActive = (s: string) => ['assigned', 'picked_up', 'in_transit'].includes(s);
  const list = (jobs.data ?? []).filter((j) => (tab === 'active' ? isActive(j.status) : !isActive(j.status)));

  return (
    <>
      <PageHeader title={mine ? 'My deliveries' : 'Deliveries'} subtitle={mine ? 'Jobs assigned to you' : 'All dispatched orders and their delivery status'} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'active', label: 'In progress', count: (jobs.data ?? []).filter((j) => isActive(j.status)).length }, { id: 'done', label: 'Completed / failed' }]} />
      {jobs.loading && !jobs.data ? <Spinner /> : jobs.error ? <ErrorBox message={jobs.error} onRetry={jobs.reload} /> : !list.length ? <Card><Empty title={tab === 'active' ? 'No deliveries in progress' : 'Nothing here yet'} /></Card> : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((j) => (
            <Card key={j.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div><p className="font-semibold">{j.recipient_name}</p><p className="text-xs text-muted">Assigned {fmtDateTime(j.assigned_at)}{!mine && j.courier_name ? ` · ${j.courier_name}` : ''}</p></div>
                <Badge tone={j.status === 'delivered' ? 'ok' : ['failed', 'returned'].includes(j.status) ? 'bad' : 'warn'}>{j.status.replace('_', ' ')}</Badge>
              </div>
              <p className="mt-2 flex gap-2 text-sm"><MapPin size={16} className="mt-0.5 shrink-0 text-muted" />{j.address}{j.notes ? ` (${j.notes})` : ''}</p>
              {j.recipient_phone && <a href={`tel:${j.recipient_phone}`} className="mt-1 flex gap-2 text-sm text-brand"><Phone size={16} />{j.recipient_phone}</a>}
              <p className="mt-2 text-sm text-muted">{j.items_summary}</p>
              {j.cod_amount > 0 && <p className="mt-2 rounded-md bg-warnsoft px-2 py-1 text-sm text-warn">Collect cash: <b>{money(j.cod_amount)}</b></p>}
              {j.failure_reason && <p className="mt-2 text-sm text-bad">Failed: {j.failure_reason}</p>}
              {isActive(j.status) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {j.status === 'assigned' && <Button size="sm" onClick={() => update(j, 'picked_up')}>Picked up</Button>}
                  {j.status !== 'in_transit' && <Button size="sm" onClick={() => update(j, 'in_transit')}>On the way</Button>}
                  <Button size="sm" variant="primary" onClick={() => { setDeliver(j); setCollected(j.cod_amount > 0 ? String(j.cod_amount) : ''); }}>Delivered…</Button>
                  <Button size="sm" onClick={() => setFail(j)}>Failed…</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {deliver && (
        <Modal title="Confirm delivery" onClose={() => setDeliver(null)} footer={<><Button onClick={() => setDeliver(null)}>Cancel</Button><Button variant="primary" onClick={confirm}>Confirm delivered</Button></>}>
          <div className="grid gap-3">
            <Field label="Customer's 6-digit delivery code" hint={mine ? 'Ask the customer for the code they were given.' : 'Staff may confirm without the code; this is recorded.'}><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus className="text-center text-lg tracking-widest" /></Field>
            <Field label="Received by (name) *"><Input value={text} onChange={(e) => setText(e.target.value)} /></Field>
            {deliver.cod_amount > 0 && <Field label="Cash collected" hint={`Expected ${money(deliver.cod_amount)}. Any difference is flagged.`}><Input inputMode="decimal" value={collected} onChange={(e) => setCollected(e.target.value.replace(/[^\d.]/g, ''))} /></Field>}
          </div>
        </Modal>
      )}
      {fail && (
        <Modal title="Delivery failed" onClose={() => setFail(null)} footer={<><Button onClick={() => setFail(null)}>Cancel</Button><Button variant="danger" disabled={!text.trim()} onClick={() => update(fail, 'failed', text)}>Mark failed</Button></>}>
          <Field label="What happened? *"><Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Customer unreachable, wrong address…" /></Field>
        </Modal>
      )}
    </>
  );
}
