import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { db } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { downloadCSV, fmtDate, num, todayISO } from '../lib/format';
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Field, Input, Modal, PageHeader, SearchInput, Select, Spinner, Table, Tabs, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

const STATUS: Record<string, 'info' | 'warn' | 'ok' | 'neutral'> = { open: 'info', sourcing: 'warn', fulfilled: 'ok', declined: 'neutral' };
const REASON: Record<string, string> = { out_of_stock: 'Out of stock', not_stocked: 'Not in inventory', other: 'Other' };
type Tab = 'requests' | 'insights';

export default function Wishlist() {
  const { profile } = useAuth();
  const toast = useToast();
  const manager = ['admin', 'pharmacist', 'inventory_officer'].includes(profile?.role ?? '');
  const canDelete = ['admin', 'pharmacist'].includes(profile?.role ?? '');
  const [tab, setTab] = useState<Tab>('requests');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const items = useAsync(async () => {
    const { data, error } = await supabase.from('wishlist_items').select('*').order('requested_on', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
    if (error) throw error;
    return data as any[];
  }, []);
  const demand = useAsync(async () => {
    const [d, m] = await Promise.all([
      supabase.from('wishlist_demand').select('*').order('request_count', { ascending: false }).limit(25),
      supabase.from('wishlist_monthly').select('*').order('month', { ascending: false }).limit(12),
    ]);
    if (d.error) throw d.error;
    return { top: d.data as any[], months: ((m.data ?? []) as any[]).reverse() };
  }, [items.data]);

  const list = useMemo(() => (items.data ?? []).filter((i) => (status === 'all' || i.status === status) && (!q.trim() || [i.product_name, i.customer_name, i.customer_phone, i.notes].some((x) => (x ?? '').toLowerCase().includes(q.toLowerCase())))), [items.data, q, status]);

  const remove = async () => {
    const { error } = await supabase.rpc('delete_wishlist_item', { p_id: del.id });
    if (error) return toast(errMsg(error), 'error');
    toast('Entry removed.'); setDel(null); items.reload();
  };
  const exportCSV = () => downloadCSV(`wishlist-${todayISO()}.csv`, [['Date', 'Product', 'Qty', 'Customer', 'Phone', 'Reason', 'Status', 'Notes'], ...list.map((i) => [i.requested_on, i.product_name, i.quantity, i.customer_name, i.customer_phone, REASON[i.reason], i.status, i.notes])]);
  const maxM = Math.max(1, ...((demand.data?.months ?? []).map((m: any) => Number(m.requests))));

  return (
    <>
      <PageHeader title="Wish List" subtitle="Products customers asked for that were out of stock or not stocked"
        actions={<><Button onClick={exportCSV}><Download size={16} />Export</Button><Button variant="primary" onClick={() => setEdit({})}><Plus size={16} />Add request</Button></>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'requests', label: 'Requests', count: items.data?.length }, { id: 'insights', label: 'Demand insights' }]} />
      {tab === 'requests' ? (
        <Card>
          <div className="flex flex-wrap gap-2 border-b border-line p-3">
            <SearchInput value={q} onChange={setQ} placeholder="Search product, customer, notes…" className="min-w-52 flex-1" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status"><option value="all">All statuses</option><option value="open">Open</option><option value="sourcing">Sourcing</option><option value="fulfilled">Fulfilled</option><option value="declined">Declined</option></Select>
          </div>
          {items.loading && !items.data ? <Spinner /> : items.error ? <ErrorBox message={items.error} onRetry={items.reload} /> : !list.length ? <Empty title="No requests yet" hint="When a customer asks for something you cannot supply, record it here. Over time this shows what to stock." /> : (
            <Table head={['Date', 'Product', 'Qty', 'Customer', 'Reason', 'Status', '']}>
              {list.map((i) => {
                const mine = i.created_by === profile?.id && i.status === 'open';
                return (
                  <tr key={i.id} className="hover:bg-surface2">
                    <Td className="text-muted">{fmtDate(i.requested_on)}</Td>
                    <Td><div className="font-medium">{i.product_name}</div>{i.notes && <div className="max-w-xs truncate text-xs text-muted">{i.notes}</div>}</Td>
                    <Td className="tnum">{i.quantity}</Td>
                    <Td><div>{i.customer_name || '—'}</div><div className="text-xs text-muted">{i.customer_phone}</div></Td>
                    <Td className="text-muted">{REASON[i.reason]}</Td>
                    <Td><Badge tone={STATUS[i.status]}>{i.status}</Badge></Td>
                    <Td><div className="flex justify-end gap-1">
                      {(manager || mine) && <Button size="sm" onClick={() => setEdit(i)}><Pencil size={14} /></Button>}
                      {canDelete && <Button size="sm" onClick={() => setDel(i)}><Trash2 size={14} /></Button>}
                    </div></Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      ) : demand.loading && !demand.data ? <Spinner /> : demand.error ? <ErrorBox message={demand.error} onRetry={demand.reload} /> : (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Most requested products</h2><p className="text-xs text-muted">How often each product was asked for, and by how many different customers.</p></div>
            {!demand.data?.top.length ? <Empty title="No data yet" /> : (
              <Table head={['Product', 'Requests', 'Total qty', 'Customers', 'Open', 'Not stocked', 'Last asked']}>
                {demand.data.top.map((t: any) => (
                  <tr key={t.demand_key}><Td className="font-medium">{t.product_name}</Td><Td className="tnum font-semibold">{num(t.request_count)}</Td><Td className="tnum">{num(t.total_quantity)}</Td><Td className="tnum">{num(t.distinct_customers)}</Td><Td className="tnum">{num(t.open_requests)}</Td>
                    <Td>{t.not_stocked_requests > 0 ? <Badge tone="warn">candidate to stock</Badge> : <span className="text-muted">—</span>}</Td><Td className="text-muted">{fmtDate(t.last_requested)}</Td></tr>
                ))}
              </Table>
            )}
          </Card>
          <Card className="p-4">
            <h2 className="font-semibold">Requests per month</h2>
            <div className="mt-4 flex h-44 items-end gap-2">
              {(demand.data?.months ?? []).map((m: any) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.requests} requests`}>
                  <span className="text-xs tnum text-muted">{m.requests}</span>
                  <div className="w-full rounded-t bg-brand" style={{ height: `${(Number(m.requests) / maxM) * 100}%`, minHeight: 4 }} />
                  <span className="text-[10px] text-muted">{new Date(m.month).toLocaleDateString('en-GB', { month: 'short' })}</span>
                </div>
              ))}
              {!demand.data?.months.length && <p className="m-auto text-sm text-muted">No data yet</p>}
            </div>
          </Card>
        </div>
      )}
      {edit && <EditModal item={edit} manager={manager} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); items.reload(); }} />}
      {del && <Confirm title="Remove this request?" danger confirmLabel="Remove" onClose={() => setDel(null)} onConfirm={remove} message={`"${del.product_name}" will be hidden from the list. The action is recorded in the audit log.`} />}
    </>
  );
}

function EditModal({ item, manager, onClose, onSaved }: { item: any; manager: boolean; onClose: () => void; onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const drugs = useLiveQuery(() => db.drugs.toArray(), [], []);
  const [f, setF] = useState({ product_name: item.product_name ?? '', quantity: String(item.quantity ?? 1), customer_name: item.customer_name ?? '', customer_phone: item.customer_phone ?? '', reason: item.reason ?? 'out_of_stock', status: item.status ?? 'open', notes: item.notes ?? '', requested_on: item.requested_on ?? todayISO() });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.product_name.trim()) return toast('Product name is required.', 'error');
    const qty = parseInt(f.quantity, 10);
    if (!(qty > 0)) return toast('Quantity must be at least 1.', 'error');
    setBusy(true);
    const match = drugs.find((d) => d.name.toLowerCase() === f.product_name.trim().toLowerCase());
    const body: any = { product_name: f.product_name.trim(), quantity: qty, customer_name: f.customer_name.trim() || null, customer_phone: f.customer_phone.trim() || null, reason: f.reason, notes: f.notes.trim() || null, requested_on: f.requested_on, drug_id: match?.id ?? null };
    if (manager) body.status = f.status;
    const { error } = item.id ? await supabase.from('wishlist_items').update(body).eq('id', item.id) : await supabase.from('wishlist_items').insert({ ...body, branch_id: profile?.branch_id });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    toast(item.id ? 'Request updated.' : 'Request recorded.'); onSaved();
  };
  return (
    <Modal title={item.id ? 'Edit request' : 'Record a request'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Product requested *" className="sm:col-span-2"><Input list="wl-drugs" autoFocus value={f.product_name} onChange={(e) => set('product_name', e.target.value)} /><datalist id="wl-drugs">{drugs.slice(0, 400).map((d) => <option key={d.id} value={d.name} />)}</datalist></Field>
        <Field label="Quantity wanted"><Input inputMode="numeric" value={f.quantity} onChange={(e) => set('quantity', e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Date requested"><Input type="date" value={f.requested_on} onChange={(e) => set('requested_on', e.target.value)} /></Field>
        <Field label="Customer name"><Input value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></Field>
        <Field label="Customer phone"><Input value={f.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} /></Field>
        <Field label="Why unfulfilled"><Select value={f.reason} onChange={(e) => set('reason', e.target.value)}><option value="out_of_stock">Temporarily out of stock</option><option value="not_stocked">Not in our inventory</option><option value="other">Other</option></Select></Field>
        {manager && <Field label="Status"><Select value={f.status} onChange={(e) => set('status', e.target.value)}><option value="open">Open</option><option value="sourcing">Sourcing</option><option value="fulfilled">Fulfilled</option><option value="declined">Declined</option></Select></Field>}
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
