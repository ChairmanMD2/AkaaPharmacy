import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { db } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync, useOnline } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { runOrQueue } from '../lib/outbox';
import { pullCatalog } from '../lib/sync';
import { applyReceiptToBatches } from '../lib/receiptLocal';
import { downloadCSV, fmtDate, fmtDateTime, money, monthRange, num, todayISO, uid } from '../lib/format';
import type { Drug } from '../lib/types';
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Stat, Table, Tabs, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';
import { ProductSelect } from '../components/ProductSelect';

type Tab = 'new' | 'history' | 'suppliers';
interface Supplier { id: string; name: string; contact_person?: string | null; phone?: string | null; email?: string | null; address?: string | null; is_active: boolean }

function useSuppliers() {
  return useAsync(async () => {
    const { data, error } = await supabase.from('suppliers').select('*').order('name');
    if (error) throw error;
    return data as Supplier[];
  }, [], { cacheKey: 'suppliers.list' });
}

export default function Receiving() {
  const [tab, setTab] = useState<Tab>('new');
  const waiting = useLiveQuery(() => db.outbox.toArray().then((a) => a.filter((o) => o.type === 'receipt.create' || o.type === 'supplier.add').length), [], 0);
  return (
    <>
      <PageHeader title="Receiving stock" subtitle="Record goods from suppliers, then look them up by period, invoice number or supplier" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'new', label: 'New receipt' }, { id: 'history', label: 'History' }, { id: 'suppliers', label: 'Suppliers' }]} />
      {waiting > 0 && <p className="mb-3 rounded-lg bg-warnsoft p-2.5 text-sm text-warn">{waiting} entr{waiting === 1 ? 'y' : 'ies'} saved on this device and waiting to upload. The stock is already available for sale here.</p>}
      {tab === 'new' && <NewReceipt onSaved={() => setTab('history')} />}
      {tab === 'history' && <History />}
      {tab === 'suppliers' && <Suppliers />}
    </>
  );
}

// ───────────── new receipt ─────────────
interface Line { key: string; drug: Drug | null; batch: string; expiry: string; qty: string; cost: string }
const blankLine = (): Line => ({ key: uid(), drug: null, batch: '', expiry: '', qty: '', cost: '' });

function NewReceipt({ onSaved }: { onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const suppliers = useSuppliers();
  const drugs = useLiveQuery(() => db.drugs.toArray(), [], [] as Drug[]);
  const [supplierText, setSupplierText] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [supplyDate, setSupplyDate] = useState(todayISO());
  const [receivedDate, setReceivedDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [busy, setBusy] = useState(false);

  const list = suppliers.data ?? [];
  const match = list.find((s) => s.name.toLowerCase() === supplierText.trim().toLowerCase());
  const total = lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0) * (Number(l.cost) || 0), 0);
  const setLine = (key: string, patch: Partial<Line>) => setLines((a) => a.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const validate = (): string | null => {
    if (!profile?.branch_id) return 'Your account has no branch assigned.';
    if (!supplierText.trim()) return 'Choose the supplier or type their name.';
    if (!supplyDate || !receivedDate) return 'Both dates are required.';
    if (supplyDate > receivedDate) return 'The date of supply cannot be after the date received.';
    if (receivedDate > todayISO()) return 'The date received cannot be in the future.';
    const used = lines.filter((l) => l.drug || l.batch || l.qty);
    if (!used.length) return 'Add at least one product.';
    for (const l of used) {
      const n = l.drug?.name ?? 'a line';
      if (!l.drug) return 'Pick a product for every line (or remove the empty line).';
      if (!l.batch.trim()) return `Enter the batch number for ${n}.`;
      if (!l.expiry) return `Enter the expiry date for ${n}.`;
      if (l.expiry < todayISO()) return `${n}: this expiry date has already passed.`;
      if (!(parseInt(l.qty, 10) > 0)) return `Enter the quantity received for ${n}.`;
    }
    return null;
  };

  const save = async () => {
    const v = validate();
    if (v) return toast(v, 'error');
    const used = lines.filter((l) => l.drug);
    const receipt = {
      id: uid(), branch_id: profile!.branch_id!, supplier_id: match?.id ?? null, supplier_name: match?.name ?? supplierText.trim(),
      invoice_no: invoiceNo.trim() || null, supply_date: supplyDate, received_date: receivedDate, note: note.trim() || null,
      items: used.map((l) => ({ drug_id: l.drug!.id, batch_number: l.batch.trim(), expiry_date: l.expiry, quantity: parseInt(l.qty, 10), unit_cost: l.cost === '' ? null : Number(l.cost) })),
    };
    setBusy(true);
    // the goods are on the shelf now: make them sellable at once, even offline
    const before = await db.batches.toArray();
    await db.batches.bulkPut(applyReceiptToBatches(before, receipt));
    const r = await runOrQueue('receipt.create', { receipt }, `Stock receipt: ${receipt.supplier_name}${receipt.invoice_no ? ` · invoice ${receipt.invoice_no}` : ''} (${used.length} product${used.length === 1 ? '' : 's'})`);
    if (r.error) {
      await db.batches.clear(); await db.batches.bulkPut(before);         // the server said no: undo the local change
      setBusy(false);
      return toast(r.error, 'error');
    }
    if (!r.queued) await pullCatalog(profile!.branch_id);
    setBusy(false);
    toast(r.queued ? 'Saved on this device. It will upload automatically when you are back online.' : 'Stock received and recorded.', r.queued ? 'info' : 'ok');
    if (!match && !r.queued) suppliers.reload();
    setSupplierText(''); setInvoiceNo(''); setNote(''); setLines([blankLine()]); setSupplyDate(todayISO()); setReceivedDate(todayISO());
    onSaved();
  };

  return (
    <Card>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Supplier *" hint={supplierText.trim() ? (match ? 'Existing supplier' : 'New supplier: will be added to the list') : 'Pick from the list or type a new name'}>
          <Input list="supplier-names" value={supplierText} onChange={(e) => setSupplierText(e.target.value)} placeholder="Supplier name" autoFocus />
          <datalist id="supplier-names">{list.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.name} />)}</datalist>
        </Field>
        <Field label="Supplier invoice / receipt no."><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="e.g. INV-20418" /></Field>
        <Field label="Date of supply *" hint="Date on the supplier's invoice"><Input type="date" max={todayISO()} value={supplyDate} onChange={(e) => { setSupplyDate(e.target.value); if (e.target.value > receivedDate) setReceivedDate(e.target.value); }} /></Field>
        <Field label="Date received *" hint="Date the goods came into the system"><Input type="date" min={supplyDate} max={todayISO()} value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} /></Field>
      </div>
      <div className="overflow-x-auto p-3">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="w-[30%] px-2 py-1">Product</th><th className="px-2 py-1">Batch no.</th><th className="px-2 py-1">Expiry date</th><th className="w-24 px-2 py-1">Quantity</th><th className="w-28 px-2 py-1">Unit cost</th><th className="w-28 px-2 py-1 text-right">Line total</th><th className="w-8" /></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="align-top">
                <td className="px-2 py-1"><ProductSelect drugs={drugs} value={l.drug} onPick={(d) => setLine(l.key, { drug: d })} /></td>
                <td className="px-2 py-1"><Input value={l.batch} onChange={(e) => setLine(l.key, { batch: e.target.value })} /></td>
                <td className="px-2 py-1"><Input type="date" min={todayISO()} value={l.expiry} onChange={(e) => setLine(l.key, { expiry: e.target.value })} /></td>
                <td className="px-2 py-1"><Input inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.replace(/\D/g, '') })} /></td>
                <td className="px-2 py-1"><Input inputMode="decimal" value={l.cost} onChange={(e) => setLine(l.key, { cost: e.target.value.replace(/[^\d.]/g, '') })} /></td>
                <td className="px-2 py-2.5 text-right font-semibold tnum">{money((parseInt(l.qty, 10) || 0) * (Number(l.cost) || 0))}</td>
                <td className="px-1 pt-2.5">{lines.length > 1 && <button aria-label="Remove line" className="text-muted hover:text-bad" onClick={() => setLines((a) => a.filter((x) => x.key !== l.key))}><Trash2 size={15} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button className="mt-2" onClick={() => setLines((a) => [...a, blankLine()])}><Plus size={16} />Add product</Button>
        {!drugs.length && <p className="mt-2 text-xs text-warn">No products on this device yet. Connect once to download the catalogue, or add products in Inventory first.</p>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line px-4 py-3">
        <Field label="Note" className="min-w-60 flex-1"><Textarea className="min-h-12" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional (delivery person, condition of goods…)" /></Field>
        <div className="flex items-center gap-4">
          <div className="text-right"><p className="text-xs text-muted">Invoice total</p><p className="text-lg font-semibold tnum">{money(total)}</p></div>
          <Button variant="primary" size="lg" loading={busy} onClick={save}>{online ? 'Receive stock' : 'Save (offline)'}</Button>
        </div>
      </div>
    </Card>
  );
}

// ───────────── history ─────────────
function History() {
  const toast = useToast();
  const suppliers = useSuppliers();
  const [field, setField] = useState<'received_date' | 'supply_date'>('received_date');
  const [from, setFrom] = useState(monthRange(todayISO().slice(0, 7))[0]);
  const [to, setTo] = useState(todayISO());
  const [supplierId, setSupplierId] = useState('');
  const [invoiceQ, setInvoiceQ] = useState('');
  const [open, setOpen] = useState<any | null>(null);
  const queued = useLiveQuery(() => db.outbox.toArray().then((a) => a.filter((o) => o.type === 'receipt.create')), [], []);

  const hist = useAsync(async () => {
    let q = supabase.from('stock_receipts')
      .select('*, stock_receipt_items(id,quantity,unit_cost,line_total,batch_number,expiry_date,drugs(name))')
      .gte(field, from).lte(field, to).order(field, { ascending: false }).order('created_at', { ascending: false }).limit(500);
    if (supplierId) q = q.eq('supplier_id', supplierId);
    if (invoiceQ.trim()) q = q.ilike('invoice_no', `%${invoiceQ.trim().replace(/[%_]/g, '')}%`);
    const { data, error } = await q;
    if (error) throw error;
    return data as any[];
  }, [field, from, to, supplierId, invoiceQ], { cacheKey: `receiving.history.${field}.${from}.${to}.${supplierId}.${invoiceQ.trim()}` });

  const rows = hist.data ?? [];
  const totalValue = rows.reduce((s, r) => s + Number(r.total_cost), 0);
  const bySupplier = useMemo(() => {
    const m = new Map<string, { name: string; n: number; total: number }>();
    rows.forEach((r) => { const x = m.get(r.supplier_name) ?? { name: r.supplier_name, n: 0, total: 0 }; x.n++; x.total += Number(r.total_cost); m.set(r.supplier_name, x); });
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const exportCSV = () => {
    if (!rows.length) return toast('Nothing to export for this selection.', 'error');
    const head = ['GRN', 'Date received', 'Date of supply', 'Supplier', 'Invoice no.', 'Product', 'Batch', 'Expiry', 'Quantity', 'Unit cost', 'Line total', 'Invoice total', 'Note'];
    const body = rows.flatMap((r) => (r.stock_receipt_items as any[]).map((i) => [r.grn_no, r.received_date, r.supply_date, r.supplier_name, r.invoice_no ?? '', i.drugs?.name ?? '', i.batch_number, i.expiry_date, i.quantity, i.unit_cost ?? '', i.line_total, r.total_cost, r.note ?? '']));
    downloadCSV(`stock-receipts-${from}-to-${to}.csv`, [head, ...body]);
  };

  return (
    <>
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="Search by"><Select value={field} onChange={(e) => setField(e.target.value as any)} className="w-44"><option value="received_date">Date received</option><option value="supply_date">Date of supply</option></Select></Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-52"><option value="">All suppliers</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Invoice number"><Input value={invoiceQ} onChange={(e) => setInvoiceQ(e.target.value)} placeholder="Type part of it" /></Field>
        <div className="ml-auto flex gap-2"><Button onClick={() => { setFrom(monthRange(todayISO().slice(0, 7))[0]); setTo(todayISO()); setSupplierId(''); setInvoiceQ(''); }}>This month</Button><Button onClick={exportCSV}><Download size={16} />Export CSV</Button></div>
      </Card>
      {queued.length > 0 && (
        <Card className="mb-4"><div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Waiting to upload ({queued.length})</div>
          <ul className="divide-y divide-line text-sm">{queued.map((o) => <li key={o.id} className="flex justify-between px-4 py-2"><span>{o.label}</span><Badge tone={o.status === 'error' ? 'bad' : 'warn'}>{o.status === 'error' ? 'needs attention' : 'waiting'}</Badge></li>)}</ul></Card>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Receipts" value={num(rows.length)} hint={rows.length >= 500 ? 'showing the latest 500' : undefined} />
        <Stat label="Total value received" value={money(totalValue)} />
        <Stat label="Suppliers" value={num(bySupplier.length)} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card>
          {hist.loading && !hist.data ? <Spinner /> : hist.error ? <ErrorBox message={hist.error} onRetry={hist.reload} /> : !rows.length ? <Empty title="No receipts for this selection" hint="Change the dates, supplier or invoice number." /> : (
            <Table head={['GRN', 'Received', 'Supplied', 'Supplier', 'Invoice no.', 'Items', 'Total']}>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-surface2" onClick={() => setOpen(r)}>
                  <Td className="font-medium tnum">{r.grn_no}</Td><Td className="text-muted">{fmtDate(r.received_date)}</Td><Td className="text-muted">{fmtDate(r.supply_date)}</Td>
                  <Td>{r.supplier_name}</Td><Td className="tnum">{r.invoice_no ?? '—'}</Td><Td className="tnum">{r.stock_receipt_items.length}</Td><Td className="tnum font-medium">{money(r.total_cost)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card>
          <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">By supplier</h2></div>
          {!bySupplier.length ? <Empty title="No data" /> : <Table head={['Supplier', 'Receipts', 'Value']}>{bySupplier.map((s) => <tr key={s.name}><Td className="font-medium">{s.name}</Td><Td className="tnum">{s.n}</Td><Td className="tnum">{money(s.total)}</Td></tr>)}</Table>}
        </Card>
      </div>
      {open && (
        <Drawer title={`${open.grn_no}${open.invoice_no ? ` · ${open.invoice_no}` : ''}`} onClose={() => setOpen(null)}>
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-muted">Supplier</dt><dd className="font-medium">{open.supplier_name}</dd></div>
            <div><dt className="text-xs text-muted">Invoice number</dt><dd>{open.invoice_no ?? '—'}</dd></div>
            <div><dt className="text-xs text-muted">Date of supply</dt><dd>{fmtDate(open.supply_date)}</dd></div>
            <div><dt className="text-xs text-muted">Date received</dt><dd>{fmtDate(open.received_date)}</dd></div>
            <div><dt className="text-xs text-muted">Recorded</dt><dd>{fmtDateTime(open.created_at)}</dd></div>
            <div><dt className="text-xs text-muted">Invoice total</dt><dd className="font-semibold tnum">{money(open.total_cost)}</dd></div>
          </dl>
          {open.note && <p className="mb-3 rounded-lg bg-surface2 p-3 text-sm">{open.note}</p>}
          <Table head={['Product', 'Batch', 'Expiry', 'Qty', 'Unit cost', 'Total']}>
            {open.stock_receipt_items.map((i: any) => <tr key={i.id}><Td className="font-medium">{i.drugs?.name}</Td><Td>{i.batch_number}</Td><Td className="text-muted">{fmtDate(i.expiry_date)}</Td><Td className="tnum">{i.quantity}</Td><Td className="tnum">{i.unit_cost != null ? money(i.unit_cost) : '—'}</Td><Td className="tnum">{money(i.line_total)}</Td></tr>)}
          </Table>
        </Drawer>
      )}
    </>
  );
}

// ───────────── suppliers ─────────────
function Suppliers() {
  const toast = useToast();
  const suppliers = useSuppliers();
  const [edit, setEdit] = useState<Partial<Supplier> | null>(null);
  return (
    <>
      <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setEdit({ is_active: true })}><Plus size={16} />Add supplier</Button></div>
      <Card>
        {suppliers.loading && !suppliers.data ? <Spinner /> : suppliers.error ? <ErrorBox message={suppliers.error} onRetry={suppliers.reload} /> : !suppliers.data?.length ? <Empty title="No suppliers yet" hint="They are added automatically the first time you receive stock from a new supplier name, or you can add one here." /> : (
          <Table head={['Supplier', 'Contact', 'Phone', 'Email', 'Status', '']}>
            {suppliers.data.map((s) => (
              <tr key={s.id}><Td className="font-medium">{s.name}</Td><Td className="text-muted">{s.contact_person ?? '—'}</Td><Td className="text-muted">{s.phone ?? '—'}</Td><Td className="text-muted">{s.email ?? '—'}</Td>
                <Td><Badge tone={s.is_active ? 'ok' : 'neutral'}>{s.is_active ? 'Active' : 'Inactive'}</Badge></Td>
                <Td className="text-right"><Button size="sm" onClick={() => setEdit(s)}><Pencil size={14} />Edit</Button></Td></tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && <SupplierModal supplier={edit} onClose={() => setEdit(null)} onSaved={(queued) => { setEdit(null); if (queued) toast('Saved on this device; it will upload when you are online.', 'info'); else { toast('Supplier saved.'); suppliers.reload(); } }} />}
    </>
  );
}

function SupplierModal({ supplier, onClose, onSaved }: { supplier: Partial<Supplier>; onClose: () => void; onSaved: (queued: boolean) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: supplier.name ?? '', contact_person: supplier.contact_person ?? '', phone: supplier.phone ?? '', email: supplier.email ?? '', address: supplier.address ?? '', is_active: supplier.is_active ?? true });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f.name.trim()) return toast('Supplier name is required.', 'error');
    const row: any = { name: f.name.trim(), contact_person: f.contact_person.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, address: f.address.trim() || null, is_active: f.is_active };
    setBusy(true);
    if (supplier.id) {
      const { error } = await supabase.from('suppliers').update(row).eq('id', supplier.id);
      setBusy(false);
      if (error) return toast(error.code === '23505' ? 'Another supplier already has this name.' : errMsg(error), 'error');
      return onSaved(false);
    }
    const r = await runOrQueue('supplier.add', { row: { id: uid(), ...row } }, `New supplier: ${row.name}`);
    setBusy(false);
    if (r.error) return toast(r.error, 'error');
    onSaved(r.queued);
  };
  return (
    <Modal title={supplier.id ? 'Edit supplier' : 'Add supplier'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier name *" className="sm:col-span-2"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Contact person"><Input value={f.contact_person} onChange={(e) => setF({ ...f, contact_person: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        {supplier.id && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />Active (shown in the supplier list)</label>}
      </div>
    </Modal>
  );
}
