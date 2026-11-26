import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Trash2, Upload } from 'lucide-react';
import { db, getMeta } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync, useOnline } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { fmtDateTime, money, uid } from '../lib/format';
import { PAY_LABEL, type Drug, type PayMethod, type Role } from '../lib/types';
import { Badge, Button, Card, Confirm, Drawer, Empty, ErrorBox, Field, Input, Modal, PageHeader, SearchInput, Select, Spinner, Table, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

export const ORDER_STATUS: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand' }> = {
  placed: { label: 'Placed', tone: 'info' },
  payment_confirmed: { label: 'Payment confirmed', tone: 'info' },
  pharmacist_approved: { label: 'Pharmacist approved', tone: 'info' },
  allocated: { label: 'Stock reserved', tone: 'brand' },
  packed: { label: 'Packed', tone: 'brand' },
  dispatched: { label: 'Out for delivery', tone: 'warn' },
  delivered: { label: 'Delivered', tone: 'ok' },
  failed_delivery: { label: 'Delivery failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  returned: { label: 'Returned to stock', tone: 'neutral' },
};
const FILTERS = [['open', 'Open'], ['all', 'All'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled / returned']] as const;

export default function Orders() {
  const online = useOnline();
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('open');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { profile } = useAuth();
  const canCreate = profile?.role === 'admin' || profile?.role === 'pharmacist' || profile?.role === 'cashier';

  const orders = useAsync(async () => {
    const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    return data as any[];
  }, []);

  const list = useMemo(() => (orders.data ?? []).filter((o) => {
    if (filter === 'open' && ['delivered', 'cancelled', 'returned'].includes(o.status)) return false;
    if (filter === 'delivered' && o.status !== 'delivered') return false;
    if (filter === 'cancelled' && !['cancelled', 'returned'].includes(o.status)) return false;
    const t = q.trim().toLowerCase();
    return !t || o.order_no.toLowerCase().includes(t) || o.customer_name.toLowerCase().includes(t) || (o.customer_phone ?? '').includes(t);
  }), [orders.data, filter, q]);

  if (!online && !orders.data) return <Card><Empty title="Orders need an internet connection" hint="Point-of-sale keeps working offline. Reconnect to manage orders and deliveries." /></Card>;

  return (
    <>
      <PageHeader title="Orders" subtitle="Phone, online and pickup orders through to delivery"
        actions={canCreate && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} />New order</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Search order no., customer or phone…" className="min-w-52 flex-1" />
          <Select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="w-48" aria-label="Filter">{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
        {orders.loading && !orders.data ? <Spinner /> : orders.error ? <ErrorBox message={orders.error} onRetry={orders.reload} /> : !list.length ? <Empty title="No orders" /> : (
          <Table head={['Order', 'Customer', 'Type', 'Total', 'Status', 'Created']}>
            {list.map((o) => (
              <tr key={o.id} className="cursor-pointer hover:bg-surface2" onClick={() => setOpenId(o.id)}>
                <Td className="font-medium tnum">{o.order_no}</Td>
                <Td><div>{o.customer_name}</div><div className="text-xs text-muted">{o.customer_phone}</div></Td>
                <Td className="text-muted">{o.fulfilment === 'pickup' ? 'Pickup' : 'Delivery'}{o.payment_mode === 'cod' ? ' · COD' : ''}{o.requires_prescription ? ' · Rx' : ''}</Td>
                <Td className="tnum font-medium">{money(o.total)}</Td>
                <Td><Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>{o.refund_due && <Badge tone="warn">Refund due</Badge>}</Td>
                <Td className="text-muted">{fmtDateTime(o.created_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {creating && <NewOrder onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); orders.reload(); setOpenId(id); }} />}
      {openId && <OrderDrawer id={openId} onClose={() => setOpenId(null)} onChanged={orders.reload} />}
    </>
  );
}

// ───────────── new order ─────────────
function NewOrder({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const drugs = useLiveQuery(() => db.drugs.toArray(), [], [] as Drug[]);
  const [f, setF] = useState({ customer_name: '', customer_phone: '', delivery_address: '', delivery_notes: '', fulfilment: 'delivery', payment_mode: 'prepaid', channel: 'phone', delivery_fee: '' });
  const [lines, setLines] = useState<{ drug: Drug; qty: number }[]>([]);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const feeDefault = useAsync(async () => Number((await getMeta<any>('settings'))?.default_delivery_fee ?? 500), []);
  const fee = f.fulfilment === 'delivery' ? (f.delivery_fee === '' ? feeDefault.data ?? 0 : Number(f.delivery_fee) || 0) : 0;
  const sub = lines.reduce((s, l) => s + l.qty * l.drug.selling_price, 0);
  const hits = find.trim() ? drugs.filter((d) => d.is_active && (d.name.toLowerCase().includes(find.toLowerCase()) || d.generic_name?.toLowerCase().includes(find.toLowerCase()))).slice(0, 6) : [];
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    if (!f.customer_name.trim()) return toast('Customer name is required.', 'error');
    if (!lines.length) return toast('Add at least one product.', 'error');
    if (f.fulfilment === 'delivery' && (!f.customer_phone.trim() || !f.delivery_address.trim())) return toast('Delivery needs a phone number and address.', 'error');
    setBusy(true);
    const { data, error } = await supabase.rpc('create_order', { p_order: { ...f, delivery_fee: fee, items: lines.map((l) => ({ drug_id: l.drug.id, quantity: l.qty })) } });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    toast('Order created.');
    onCreated(data as string);
  };

  return (
    <Modal title="New order" wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Create order · {money(sub + fee)}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer name *"><Input value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} autoFocus /></Field>
        <Field label="Phone"><Input value={f.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} /></Field>
        <Field label="Fulfilment"><Select value={f.fulfilment} onChange={(e) => set('fulfilment', e.target.value)}><option value="delivery">Delivery</option><option value="pickup">Customer pickup</option></Select></Field>
        <Field label="Payment"><Select value={f.payment_mode} onChange={(e) => set('payment_mode', e.target.value)}><option value="prepaid">Pay before dispatch</option><option value="cod">Cash on delivery / pickup</option></Select></Field>
        {f.fulfilment === 'delivery' && <>
          <Field label="Delivery address *" className="sm:col-span-2"><Textarea value={f.delivery_address} onChange={(e) => set('delivery_address', e.target.value)} /></Field>
          <Field label="Delivery fee"><Input inputMode="decimal" placeholder={String(feeDefault.data ?? 500)} value={f.delivery_fee} onChange={(e) => set('delivery_fee', e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          <Field label="Delivery notes"><Input value={f.delivery_notes} onChange={(e) => set('delivery_notes', e.target.value)} placeholder="Landmark, gate code…" /></Field>
        </>}
      </div>
      <h3 className="mb-1 mt-4 text-sm font-semibold">Products</h3>
      <div className="relative">
        <SearchInput value={find} onChange={setFind} placeholder="Search a product to add…" />
        {hits.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-card">
            {hits.map((d) => <li key={d.id}><button className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-surface2" onClick={() => { setLines((l) => l.some((x) => x.drug.id === d.id) ? l : [...l, { drug: d, qty: 1 }]); setFind(''); }}><span>{d.name}{d.requires_prescription && <Badge tone="warn">Rx</Badge>}</span><span className="tnum">{money(d.selling_price)}</span></button></li>)}
          </ul>
        )}
      </div>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
        {!lines.length && <li className="p-4 text-center text-sm text-muted">No products yet.</li>}
        {lines.map((l) => (
          <li key={l.drug.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{l.drug.name}</span>
            <input aria-label="Quantity" className="h-8 w-16 rounded-md border border-line bg-surface text-center tnum" inputMode="numeric" value={l.qty}
              onChange={(e) => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10) || 1; setLines((a) => a.map((x) => (x.drug.id === l.drug.id ? { ...x, qty: n } : x))); }} />
            <span className="w-24 text-right tnum">{money(l.qty * l.drug.selling_price)}</span>
            <button aria-label="Remove" onClick={() => setLines((a) => a.filter((x) => x.drug.id !== l.drug.id))} className="text-muted hover:text-bad"><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-right text-sm text-muted">Subtotal {money(sub)} · Delivery {money(fee)}</p>
      <p className="mt-1 text-xs text-muted">Prices are taken from the system when the order is created.</p>
    </Modal>
  );
}

// ───────────── order detail + pipeline actions ─────────────
function OrderDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const role = profile?.role as Role;
  const [modal, setModal] = useState<null | 'pay' | 'dispatch' | 'cancel' | 'reject' | 'pickup' | 'return'>(null);
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const d = useAsync(async () => {
    const { data: o, error } = await supabase.from('orders').select('*, order_items(id,quantity,unit_price,line_total,drugs(name,requires_prescription)), order_events(id,from_status,to_status,note,created_at,actor), prescriptions(id,status,file_path,prescriber,created_at), delivery_jobs(id,status,courier_name,provider,cod_amount,collected_amount,proof_name,failure_reason,assigned_at,delivered_at)').eq('id', id).single();
    if (error) throw error;
    const { data: pays } = await supabase.from('payments').select('id,method,amount,status,reference,note,created_at').eq('order_id', id).order('created_at');
    const actorIds = Array.from(new Set((o.order_events ?? []).map((e: any) => e.actor).filter(Boolean)));
    const { data: names } = actorIds.length ? await supabase.from('profiles').select('id,full_name').in('id', actorIds as string[]) : { data: [] as any[] };
    return { o: o as any, pays: (pays ?? []) as any[], names: new Map((names ?? []).map((n: any) => [n.id, n.full_name])) };
  }, [id]);

  const act = async (fn: () => PromiseLike<{ error: any; data?: any }>, ok: string) => {
    const { error } = await fn();
    if (error) { toast(errMsg(error), 'error'); return false; }
    toast(ok); setModal(null); setText(''); d.reload(); onChanged(); return true;
  };

  if (!d.data) return <Drawer title="Order" onClose={onClose}>{d.error ? <ErrorBox message={d.error} onRetry={d.reload} /> : <Spinner />}</Drawer>;
  const { o, pays, names } = d.data;
  const verified = pays.filter((p) => p.status === 'verified').reduce((s, p) => s + Number(p.amount), 0);
  const job = (o.delivery_jobs ?? []).find((j: any) => ['assigned', 'picked_up', 'in_transit'].includes(j.status)) ?? (o.delivery_jobs ?? [])[0];
  const cashierish = ['admin', 'pharmacist', 'cashier'].includes(role);
  const pharm = ['admin', 'pharmacist'].includes(role);
  const stockish = ['admin', 'pharmacist', 'inventory_officer'].includes(role);
  const rpc = (fn: string, args: any) => supabase.rpc(fn, args);

  const upload = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) return toast('File too large (max 8 MB).', 'error');
    const path = `${o.id}/${uid()}-${file.name.replace(/[^\w.-]/g, '_')}`;
    const up = await supabase.storage.from('prescriptions').upload(path, file, { contentType: file.type });
    if (up.error) return toast(errMsg(up.error), 'error');
    await act(() => rpc('add_prescription', { p_order: o.id, p_file_path: path, p_prescriber: null, p_note: null }), 'Prescription attached.');
  };
  const viewRx = async (path: string) => {
    const { data } = await supabase.storage.from('prescriptions').createSignedUrl(path, 120);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener');
  };

  const actions: React.ReactNode[] = [];
  if (o.status === 'placed' && cashierish) {
    actions.push(<Button key="pay" onClick={() => setModal('pay')}>Record payment</Button>);
    actions.push(<Button key="conf" variant="primary" onClick={() => act(() => rpc('order_confirm_payment', { p_order: o.id }), 'Payment confirmed.')}>{o.payment_mode === 'cod' ? 'Accept (cash on delivery)' : 'Confirm payment'}</Button>);
  }
  if (o.status === 'payment_confirmed' && o.requires_prescription && pharm) {
    actions.push(<Button key="rej" onClick={() => setModal('reject')}>Reject prescription</Button>);
    actions.push(<Button key="app" variant="primary" onClick={() => act(() => rpc('order_pharmacist_review', { p_order: o.id, p_approve: true }), 'Prescription approved.')}>Approve prescription</Button>);
  }
  if (((o.status === 'payment_confirmed' && !o.requires_prescription) || o.status === 'pharmacist_approved') && stockish)
    actions.push(<Button key="alloc" variant="primary" onClick={() => act(() => rpc('order_allocate', { p_order: o.id }), 'Stock reserved.')}>Reserve stock</Button>);
  if (o.status === 'allocated' && stockish) actions.push(<Button key="pack" variant="primary" onClick={() => act(() => rpc('order_pack', { p_order: o.id }), 'Marked as packed.')}>Mark packed</Button>);
  if (o.status === 'packed' && stockish) actions.push(o.fulfilment === 'delivery'
    ? <Button key="disp" variant="primary" onClick={() => setModal('dispatch')}>Dispatch…</Button>
    : <Button key="pick" variant="primary" onClick={() => setModal('pickup')}>Customer collected…</Button>);
  if (o.status === 'failed_delivery' && stockish) actions.push(<Button key="ret" variant="primary" onClick={() => setModal('return')}>Return stock to shelf</Button>);
  if (['placed', 'payment_confirmed', 'pharmacist_approved', 'allocated', 'packed'].includes(o.status) && cashierish) actions.push(<Button key="can" variant="danger" onClick={() => setModal('cancel')}>Cancel order</Button>);

  return (
    <Drawer title={<span>{o.order_no} <Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label}</Badge></span>} onClose={onClose} footer={actions.length ? <>{actions}</> : undefined}>
      <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-muted">Customer</dt><dd>{o.customer_name}<br /><span className="text-muted">{o.customer_phone}</span></dd></div>
        <div><dt className="text-xs text-muted">{o.fulfilment === 'pickup' ? 'Pickup' : 'Deliver to'}</dt><dd>{o.fulfilment === 'pickup' ? 'Customer collects at the pharmacy' : o.delivery_address}{o.delivery_notes ? <><br /><span className="text-muted">{o.delivery_notes}</span></> : null}</dd></div>
      </dl>
      <h3 className="mb-1 text-sm font-semibold">Items</h3>
      <ul className="mb-1 divide-y divide-line rounded-lg border border-line">
        {o.order_items.map((i: any) => <li key={i.id} className="flex justify-between px-3 py-2 text-sm"><span>{i.quantity} × {i.drugs?.name}{i.drugs?.requires_prescription && <Badge tone="warn">Rx</Badge>}</span><span className="tnum">{money(i.line_total)}</span></li>)}
      </ul>
      <p className="mb-4 text-right text-sm tnum"><span className="text-muted">Delivery {money(o.delivery_fee)} · </span><b>Total {money(o.total)}</b></p>

      <h3 className="mb-1 text-sm font-semibold">Payments <span className="font-normal text-muted">({o.payment_mode === 'cod' ? 'cash on delivery' : 'prepaid'} · verified {money(verified)})</span></h3>
      <ul className="mb-4 divide-y divide-line rounded-lg border border-line">
        {!pays.length && <li className="px-3 py-2 text-sm text-muted">No payment recorded.</li>}
        {pays.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>{PAY_LABEL[p.method as PayMethod]}{p.reference ? ` · ${p.reference}` : ''}{p.note ? <span className="block text-xs text-muted">{p.note}</span> : null}</span>
            <span className="flex items-center gap-2">
              <span className="tnum">{money(p.amount)}</span>
              {p.status === 'pending_verification' && cashierish
                ? <><Button size="sm" variant="primary" onClick={() => act(() => rpc('verify_payment', { p_payment: p.id, p_accept: true }), 'Payment verified.')}>Verify</Button><Button size="sm" onClick={() => act(() => rpc('verify_payment', { p_payment: p.id, p_accept: false }), 'Payment rejected.')}>Reject</Button></>
                : <Badge tone={p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}>{p.status === 'pending_verification' ? 'to verify' : p.status}</Badge>}
            </span>
          </li>
        ))}
      </ul>

      {o.requires_prescription && (
        <>
          <h3 className="mb-1 flex items-center justify-between text-sm font-semibold">Prescription
            {['placed', 'payment_confirmed'].includes(o.status) && cashierish && <><Button size="sm" onClick={() => fileRef.current?.click()}><Upload size={14} />Attach</Button><input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></>}
          </h3>
          <ul className="mb-4 divide-y divide-line rounded-lg border border-line">
            {!o.prescriptions.length && <li className="px-3 py-2 text-sm text-warn">A prescription is required before the pharmacist can approve.</li>}
            {o.prescriptions.map((r: any) => <li key={r.id} className="flex items-center justify-between px-3 py-2 text-sm"><span>{fmtDateTime(r.created_at)}</span><span className="flex items-center gap-2">{r.file_path && <Button size="sm" onClick={() => viewRx(r.file_path)}>View</Button>}<Badge tone={r.status === 'verified' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'}>{r.status}</Badge></span></li>)}
          </ul>
        </>
      )}

      {job && <DeliveryBox job={job} staff={['admin', 'pharmacist', 'cashier', 'inventory_officer'].includes(role)} />}

      <h3 className="mb-1 mt-4 text-sm font-semibold">History</h3>
      <ol className="space-y-2 border-l border-line pl-4">
        {[...o.order_events].sort((a: any, b: any) => a.created_at.localeCompare(b.created_at)).map((e: any) => (
          <li key={e.id} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand" />
            <b>{ORDER_STATUS[e.to_status]?.label ?? e.to_status}</b>{e.note ? <span className="text-muted"> · {e.note}</span> : null}
            <div className="text-xs text-muted">{fmtDateTime(e.created_at)} · {names.get(e.actor) ?? 'system'}</div></li>
        ))}
      </ol>

      {modal === 'pay' && <PayModal order={o} onClose={() => setModal(null)} act={act} />}
      {modal === 'dispatch' && <DispatchModal order={o} onClose={() => setModal(null)} act={act} />}
      {modal === 'pickup' && <Confirm title="Customer collected?" confirmLabel="Hand over" onClose={() => setModal(null)} onConfirm={() => act(() => rpc('order_complete_pickup', { p_order: o.id, p_collected_by: text }), 'Order handed over.')}><Field label="Collected by (name)"><Input value={text} onChange={(e) => setText(e.target.value)} autoFocus /></Field></Confirm>}
      {modal === 'cancel' && <Confirm title="Cancel this order?" danger confirmLabel="Cancel order" onClose={() => setModal(null)} onConfirm={() => act(() => rpc('order_cancel', { p_order: o.id, p_reason: text }), 'Order cancelled.')} message="Reserved stock is released. If the customer already paid, the order is flagged for refund."><Field label="Reason *"><Textarea value={text} onChange={(e) => setText(e.target.value)} /></Field></Confirm>}
      {modal === 'reject' && <Confirm title="Reject prescription?" danger confirmLabel="Reject & cancel" onClose={() => setModal(null)} onConfirm={() => act(() => rpc('order_pharmacist_review', { p_order: o.id, p_approve: false, p_note: text }), 'Prescription rejected; order cancelled.')}><Field label="Reason"><Textarea value={text} onChange={(e) => setText(e.target.value)} /></Field></Confirm>}
      {modal === 'return' && <Confirm title="Return goods to shelf?" confirmLabel="Return to stock" onClose={() => setModal(null)} onConfirm={() => act(() => rpc('order_return', { p_order: o.id, p_note: text || null }), 'Stock returned.')} message="Use this once the courier has physically brought the goods back and you have checked them."><Field label="Note"><Input value={text} onChange={(e) => setText(e.target.value)} /></Field></Confirm>}
    </Drawer>
  );
}

function DeliveryBox({ job, staff }: { job: any; staff: boolean }) {
  const code = useAsync(async () => {
    if (!staff || !['assigned', 'picked_up', 'in_transit'].includes(job.status)) return null;
    const { data, error } = await supabase.rpc('get_delivery_code', { p_job: job.id });
    if (error) throw error;
    return data as string;
  }, [job.id, job.status]);
  return (
    <div className="mt-4 rounded-lg border border-line p-3 text-sm">
      <div className="flex items-center justify-between"><h3 className="font-semibold">Delivery</h3><Badge tone={job.status === 'delivered' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}>{job.status.replace('_', ' ')}</Badge></div>
      <p className="mt-1 text-muted">{job.provider === 'third_party' ? 'Courier' : 'Rider'}: {job.courier_name ?? '—'}</p>
      {job.cod_amount > 0 && <p className="text-muted">Cash to collect: <b className="text-fg">{money(job.cod_amount)}</b>{job.collected_amount != null && ` · collected ${money(job.collected_amount)}`}</p>}
      {code.data && <p className="mt-2 rounded-md bg-brandsoft p-2 text-brand">Customer delivery code: <b className="tnum text-base tracking-widest">{code.data}</b><span className="block text-xs">Give this to the customer. The rider must enter it to confirm delivery.</span></p>}
      {job.proof_name && <p className="mt-1 text-muted">Received by {job.proof_name} · {fmtDateTime(job.delivered_at)}</p>}
      {job.failure_reason && <p className="mt-1 text-bad">Failed: {job.failure_reason}</p>}
    </div>
  );
}

function PayModal({ order, onClose, act }: { order: any; onClose: () => void; act: (fn: () => PromiseLike<any>, ok: string) => Promise<boolean> }) {
  const [method, setMethod] = useState<PayMethod>('transfer');
  const [amount, setAmount] = useState(String(order.total));
  const [ref, setRef] = useState('');
  return (
    <Modal title="Record payment" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => act(() => supabase.rpc('add_order_payment', { p_order: order.id, p_method: method, p_amount: Number(amount), p_reference: ref || null }), 'Payment recorded.')}>Save</Button></>}>
      <div className="grid gap-3">
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>{(['transfer', 'pos_terminal', 'cash', 'card'] as PayMethod[]).map((m) => <option key={m} value={m}>{PAY_LABEL[m]}</option>)}</Select></Field>
        <Field label="Amount"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        {(method === 'transfer' || method === 'pos_terminal') && <Field label={method === 'transfer' ? 'Transfer ID / reference *' : 'POS approval code *'} hint="Each reference can be used once."><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
        <p className="text-xs text-muted">Transfers and POS payments stay "to verify" until matched to the bank statement. Cash is verified immediately.</p>
      </div>
    </Modal>
  );
}

function DispatchModal({ order, onClose, act }: { order: any; onClose: () => void; act: (fn: () => PromiseLike<any>, ok: string) => Promise<boolean> }) {
  const riders = useAsync(async () => {
    const { data, error } = await supabase.from('profiles').select('id,full_name,role').in('role', ['rider', 'courier']).eq('is_active', true).order('full_name');
    if (error) throw error;
    return data as any[];
  }, []);
  const [assignee, setAssignee] = useState('');
  const [provider, setProvider] = useState('own_rider');
  return (
    <Modal title="Dispatch order" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!assignee} onClick={() => act(() => supabase.rpc('order_dispatch', { p_order: order.id, p_assignee: assignee, p_provider: provider }), 'Dispatched.')}>Dispatch</Button></>}>
      <p className="mb-3 text-sm text-muted">Stock is issued from the shelf now. The rider or courier signs in to the delivery app, sees only this job, and confirms delivery with the customer's code.</p>
      <div className="grid gap-3">
        <Field label="Delivery by"><Select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="own_rider">Our own rider</option><option value="third_party">Courier company</option></Select></Field>
        <Field label="Assign to">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">{riders.loading ? 'Loading…' : 'Choose…'}</option>{(riders.data ?? []).filter((r) => (provider === 'own_rider' ? r.role === 'rider' : r.role === 'courier')).map((r) => <option key={r.id} value={r.id}>{r.full_name || r.id.slice(0, 8)}</option>)}</Select>
        </Field>
        {riders.data && !riders.data.some((r) => (provider === 'own_rider' ? r.role === 'rider' : r.role === 'courier')) && <p className="text-xs text-warn">No active {provider === 'own_rider' ? 'riders' : 'couriers'} yet. An administrator can add them under Users.</p>}
      </div>
    </Modal>
  );
}
