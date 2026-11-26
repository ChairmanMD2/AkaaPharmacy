import { useState } from 'react';
import { AlertTriangle, Ban, Check, Printer, X } from 'lucide-react';
import { ReceiptModal } from '../components/Receipt';
import { supabase, errMsg } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { can } from '../lib/permissions';
import { fmtDateTime, money } from '../lib/format';
import { PAY_LABEL, type PayMethod } from '../lib/types';
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Modal, PageHeader, SearchInput, Spinner, Table, Tabs, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

type Tab = 'all' | 'review' | 'payments';

export default function Sales() {
  const { profile } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<any | null>(null);

  const sales = useAsync(async () => {
    const { data, error } = await supabase.from('sales').select('*').order('sold_at', { ascending: false }).limit(300);
    if (error) throw error;
    const ids = Array.from(new Set((data ?? []).map((s: any) => s.cashier_id)));
    const { data: ps } = ids.length ? await supabase.from('profiles').select('id,full_name').in('id', ids) : { data: [] as any[] };
    const names = new Map((ps ?? []).map((p: any) => [p.id, p.full_name]));
    return (data ?? []).map((s: any) => ({ ...s, cashier: names.get(s.cashier_id) ?? '—' }));
  }, []);

  const pending = useAsync(async () => {
    const { data, error } = await supabase.from('payments').select('*').eq('status', 'pending_verification').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const sIds = (data ?? []).map((p: any) => p.sale_id).filter(Boolean);
    const oIds = (data ?? []).map((p: any) => p.order_id).filter(Boolean);
    const [s, o] = await Promise.all([
      sIds.length ? supabase.from('sales').select('id,receipt_no').in('id', sIds) : Promise.resolve({ data: [] as any[] }),
      oIds.length ? supabase.from('orders').select('id,order_no').in('id', oIds) : Promise.resolve({ data: [] as any[] }),
    ]);
    const sm = new Map((s.data ?? []).map((x: any) => [x.id, x.receipt_no]));
    const om = new Map((o.data ?? []).map((x: any) => [x.id, x.order_no]));
    return (data ?? []).map((p: any) => ({ ...p, ref_no: sm.get(p.sale_id) ?? om.get(p.order_id) ?? '—' }));
  }, []);

  const verify = async (id: string, accept: boolean) => {
    const { error } = await supabase.rpc('verify_payment', { p_payment: id, p_accept: accept });
    if (error) return toast(errMsg(error), 'error');
    toast(accept ? 'Payment verified.' : 'Payment rejected and flagged.');
    pending.reload(); sales.reload();
  };

  const list = (sales.data ?? []).filter((s: any) => {
    if (tab === 'review' && !(s.needs_review && s.status === 'completed')) return false;
    const t = q.trim().toLowerCase();
    return !t || s.receipt_no.toLowerCase().includes(t) || (s.local_ref ?? '').toLowerCase().includes(t) || String(s.cashier).toLowerCase().includes(t);
  });
  const reviewCount = (sales.data ?? []).filter((s: any) => s.needs_review && s.status === 'completed').length;

  return (
    <>
      <PageHeader title="Sales" subtitle="Receipts, payment verification and exceptions" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'All sales' }, { id: 'review', label: 'Needs review', count: reviewCount }, { id: 'payments', label: 'Payments to verify', count: pending.data?.length }]} />
      {tab !== 'payments' ? (
        <Card>
          <div className="border-b border-line p-3"><SearchInput value={q} onChange={setQ} placeholder="Search receipt number or cashier…" /></div>
          {sales.loading && !sales.data ? <Spinner /> : sales.error ? <ErrorBox message={sales.error} onRetry={sales.reload} /> : !list.length ? <Empty title="No sales to show" /> : (
            <Table head={['Receipt', 'Time', 'Cashier', 'Total', 'Status', '']}>
              {list.map((s: any) => (
                <tr key={s.id} className="cursor-pointer hover:bg-surface2" onClick={() => setOpen(s)}>
                  <Td className="font-medium tnum">{s.receipt_no}{s.channel === 'online' && <span className="ml-1 text-xs text-muted">(order)</span>}</Td>
                  <Td className="text-muted">{fmtDateTime(s.sold_at)}</Td><Td>{s.cashier}</Td><Td className="tnum font-medium">{money(s.total)}</Td>
                  <Td><div className="flex gap-1">{s.status === 'voided' ? <Badge tone="bad">Voided</Badge> : <Badge tone="ok">Completed</Badge>}{s.needs_review && s.status === 'completed' && <Badge tone="warn">Review</Badge>}</div></Td>
                  <Td className="text-right text-xs text-brand">Details</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : (
        <Card>
          <p className="border-b border-line p-3 text-xs text-muted">Bank transfers, POS terminal payments and courier cash collected on delivery stay here until someone matches them to the bank statement / cash remittance.</p>
          {pending.loading && !pending.data ? <Spinner /> : pending.error ? <ErrorBox message={pending.error} onRetry={pending.reload} /> : !pending.data?.length ? <Empty title="Nothing waiting for verification" /> : (
            <Table head={['For', 'Method', 'Reference / code', 'Amount', 'Recorded', '']}>
              {pending.data.map((p: any) => (
                <tr key={p.id}>
                  <Td className="font-medium">{p.ref_no}</Td><Td>{PAY_LABEL[p.method as PayMethod]}</Td>
                  <Td className="tnum">{p.reference ?? <span className="text-bad">{p.note || 'none'}</span>}</Td><Td className="tnum font-medium">{money(p.amount)}</Td><Td className="text-muted">{fmtDateTime(p.created_at)}</Td>
                  <Td><div className="flex justify-end gap-1">
                    {can(profile?.role, 'verify_payment') && <><Button size="sm" variant="primary" onClick={() => verify(p.id, true)}><Check size={14} />Verify</Button><Button size="sm" onClick={() => verify(p.id, false)}><X size={14} />Reject</Button></>}
                  </div></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {open && <SaleDrawer sale={open} onClose={() => setOpen(null)} onChanged={() => { sales.reload(); pending.reload(); }} />}
    </>
  );
}

function SaleDrawer({ sale, onClose, onChanged }: { sale: any; onClose: () => void; onChanged: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [voiding, setVoiding] = useState(false);
  const [reprint, setReprint] = useState(false);
  const [reason, setReason] = useState('');
  const detail = useAsync(async () => {
    const { data, error } = await supabase.from('sales')
      .select('id, sale_items(id,quantity,unit_price,line_total,batch_id,drug_id,drugs(name)), payments(id,method,amount,status,reference,note)').eq('id', sale.id).single();
    if (error) throw error;
    return data as any;
  }, [sale.id]);
  const doVoid = async () => {
    const { error } = await supabase.rpc('void_sale', { p_sale: sale.id, p_reason: reason });
    if (error) return toast(errMsg(error), 'error');
    toast('Sale voided and stock restored.'); setVoiding(false); onChanged(); onClose();
  };
  return (
    <Drawer title={`Receipt ${sale.receipt_no}`} onClose={onClose}
      footer={<>
        {detail.data && <Button onClick={() => setReprint(true)}><Printer size={16} />Reprint receipt</Button>}
        {sale.status === 'completed' && can(profile?.role, 'void') && <Button variant="danger" onClick={() => setVoiding(true)}><Ban size={16} />Void sale</Button>}
      </>}>
      <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-muted">Time</dt><dd>{fmtDateTime(sale.sold_at)}</dd></div>
        <div><dt className="text-xs text-muted">Cashier</dt><dd>{sale.cashier}</dd></div>
        <div><dt className="text-xs text-muted">Total</dt><dd className="font-semibold tnum">{money(sale.total)}</dd></div>
        <div><dt className="text-xs text-muted">Device ref</dt><dd>{sale.local_ref ?? '—'}</dd></div>
      </dl>
      {sale.needs_review && <div className="mb-4 flex gap-2 rounded-lg bg-warnsoft p-3 text-sm text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{sale.review_note || 'Flagged for review.'}</span></div>}
      {sale.status === 'voided' && <div className="mb-4 rounded-lg bg-badsoft p-3 text-sm text-bad">Voided: {sale.void_reason}</div>}
      {detail.loading && !detail.data ? <Spinner /> : detail.error ? <ErrorBox message={detail.error} /> : (
        <>
          <h3 className="mb-1 text-sm font-semibold">Items</h3>
          <ul className="mb-4 divide-y divide-line rounded-lg border border-line">
            {detail.data.sale_items.map((i: any) => (
              <li key={i.id} className="flex justify-between px-3 py-2 text-sm"><span>{i.quantity} × {i.drugs?.name}{!i.batch_id && <Badge tone="bad">No stock found</Badge>}</span><span className="tnum">{money(i.line_total)}</span></li>
            ))}
          </ul>
          <h3 className="mb-1 text-sm font-semibold">Payments</h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {detail.data.payments.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm"><span>{PAY_LABEL[p.method as PayMethod]}{p.reference ? ` · ${p.reference}` : ''}</span>
                <span className="flex items-center gap-2"><Badge tone={p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}>{p.status === 'pending_verification' ? 'to verify' : p.status}</Badge><span className="tnum">{money(p.amount)}</span></span></li>
            ))}
          </ul>
        </>
      )}
      {reprint && detail.data && (
        <ReceiptModal title={`Receipt ${sale.receipt_no}${sale.status === 'voided' ? ' (VOIDED)' : ''}`} onClose={() => setReprint(false)} sale={{
          id: sale.id, local_ref: sale.local_ref ?? '', receipt_no: sale.receipt_no, branch_id: sale.branch_id, sold_at: sale.sold_at, created_at: sale.sold_at,
          cashier_name: sale.cashier, items: detail.data.sale_items.map((i: any) => ({ drug_id: i.drug_id ?? '', name: i.drugs?.name ?? 'Item', quantity: i.quantity, unit_price: Number(i.unit_price) })),
          discount: Number(sale.discount), subtotal: Number(sale.subtotal), total: Number(sale.total),
          payments: detail.data.payments.filter((p: any) => p.status !== 'rejected').map((p: any) => ({ method: p.method, amount: Number(p.amount), reference: p.reference ?? undefined })),
          alloc: [], status: 'synced', attempts: 0,
        }} />
      )}
      {voiding && (
        <Modal title="Void this sale?" onClose={() => setVoiding(false)} footer={<><Button onClick={() => setVoiding(false)}>Cancel</Button><Button variant="danger" disabled={!reason.trim()} onClick={doVoid}>Void and restore stock</Button></>}>
          <p className="mb-2 text-sm text-muted">Stock goes back to the batches it came from. This cannot be undone, and your name is recorded.</p>
          <Textarea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </Drawer>
  );
}
