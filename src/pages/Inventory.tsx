import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Papa from 'papaparse';
import { readSheet } from 'read-excel-file/browser';
import { Download, FileSpreadsheet, Layers, Pencil, Plus, ShieldAlert, Truck, Upload } from 'lucide-react';
import { db } from '../lib/db';
import { errMsg, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { can } from '../lib/permissions';
import { availableFromBatches, pullCatalog } from '../lib/sync';
import { daysUntil, downloadCSV, fmtDate, money, num, todayISO } from '../lib/format';
import type { Batch, Drug } from '../lib/types';
import { Badge, Button, Card, Drawer, Empty, Field, Input, Modal, PageHeader, SearchInput, Select, Spinner, Table, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';
import { useOnline } from '../lib/hooks';
import { COLS, SAMPLE, normaliseCell, validateRow, type ImpRow } from '../lib/importRows';

type Filter = 'all' | 'low' | 'out' | 'expiring' | 'expired';

export default function Inventory() {
  const { profile } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const write = can(profile?.role, 'inventory_write');
  const drugs = useLiveQuery(() => db.drugs.toArray(), []);
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [edit, setEdit] = useState<Partial<Drug> | null>(null);
  const [receive, setReceive] = useState<Drug | 'new' | null>(null);
  const [batchesOf, setBatchesOf] = useState<Drug | null>(null);
  const [importing, setImporting] = useState(false);

  const rows = useMemo(() => {
    const t = todayISO();
    return (drugs ?? []).map((d) => {
      const bs = (batches ?? []).filter((b) => b.drug_id === d.id && b.quantity_remaining > 0);
      const available = availableFromBatches(batches ?? [], d.id);
      const live = bs.filter((b) => b.expiry_date >= t).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
      const nearest = live[0]?.expiry_date;
      const expiredQty = bs.filter((b) => b.expiry_date < t).reduce((s, b) => s + b.quantity_remaining, 0);
      return { d, available, nearest, expiredQty, expiring: nearest ? daysUntil(nearest) <= 90 : false };
    });
  }, [drugs, batches]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (s && !(r.d.name.toLowerCase().includes(s) || r.d.generic_name?.toLowerCase().includes(s) || r.d.barcode === q.trim() || r.d.category?.toLowerCase().includes(s))) return false;
      if (filter === 'low') return r.d.is_active && r.available > 0 && r.available <= r.d.reorder_level;
      if (filter === 'out') return r.d.is_active && r.available < 1;
      if (filter === 'expiring') return r.expiring;
      if (filter === 'expired') return r.expiredQty > 0;
      return true;
    });
  }, [rows, q, filter]);

  if (!drugs || !batches) return <Spinner />;
  const needOnline = () => { if (!online) { toast('This action needs an internet connection.', 'info'); return true; } return false; };

  return (
    <>
      <PageHeader title="Inventory" subtitle={`${num(drugs.length)} products`}
        actions={write && <>
          <Button onClick={() => !needOnline() && setImporting(true)}><Upload size={16} />Bulk import</Button>
          <Button onClick={() => !needOnline() && setReceive('new')}><Truck size={16} />Receive stock</Button>
          <Button variant="primary" onClick={() => !needOnline() && setEdit({ unit_type: 'Pack', reorder_level: 10, is_active: true })}><Plus size={16} />Add product</Button>
        </>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Search products…" className="min-w-52 flex-1" />
          <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="w-44" aria-label="Filter">
            <option value="all">All products</option><option value="low">Low stock</option><option value="out">Out of stock</option>
            <option value="expiring">Expiring ≤ 90 days</option><option value="expired">Expired stock</option>
          </Select>
        </div>
        {!shown.length ? <Empty title="No products found" hint={drugs.length ? 'Try a different search or filter.' : 'Add products one by one, or use Bulk import with your stock spreadsheet.'} /> : (
          <Table head={['Product', 'Category', 'Price', 'In stock', 'Nearest expiry', 'Status', '']}>
            {shown.slice(0, 300).map(({ d, available, nearest, expiredQty, expiring }) => (
              <tr key={d.id} className="hover:bg-surface2">
                <Td><div className="font-medium">{d.name}{d.requires_prescription && <ShieldAlert size={13} className="ml-1 inline text-warn" aria-label="Prescription" />}</div><div className="text-xs text-muted">{d.generic_name || d.unit_type}{d.barcode ? ` · ${d.barcode}` : ''}</div></Td>
                <Td className="text-muted">{d.category || '—'}</Td>
                <Td className="tnum">{money(d.selling_price)}</Td>
                <Td className="tnum font-medium">{num(available)}</Td>
                <Td className="text-muted">{nearest ? fmtDate(nearest) : '—'}</Td>
                <Td><div className="flex flex-wrap gap-1">
                  {!d.is_active && <Badge>Inactive</Badge>}
                  {d.is_active && available < 1 && <Badge tone="bad">Out</Badge>}
                  {d.is_active && available > 0 && available <= d.reorder_level && <Badge tone="warn">Low</Badge>}
                  {expiring && <Badge tone="warn">Expiring</Badge>}
                  {expiredQty > 0 && <Badge tone="bad">{expiredQty} expired</Badge>}
                </div></Td>
                <Td><div className="flex justify-end gap-1">
                  <Button size="sm" onClick={() => setBatchesOf(d)}><Layers size={14} />Batches</Button>
                  {write && <Button size="sm" onClick={() => !needOnline() && setEdit(d)}><Pencil size={14} /></Button>}
                </div></Td>
              </tr>
            ))}
          </Table>
        )}
        {shown.length > 300 && <p className="border-t border-line p-3 text-center text-xs text-muted">Showing the first 300 of {shown.length}. Refine your search.</p>}
      </Card>
      {edit && <DrugModal drug={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await pullCatalog(profile?.branch_id ?? null); }} />}
      {receive && <ReceiveModal drug={receive === 'new' ? null : receive} drugs={drugs} branch={profile?.branch_id ?? null} onClose={() => setReceive(null)} onSaved={async () => { setReceive(null); await pullCatalog(profile?.branch_id ?? null); }} />}
      {batchesOf && <BatchesDrawer drug={batchesOf} write={write} onClose={() => setBatchesOf(null)} onChanged={() => pullCatalog(profile?.branch_id ?? null)} />}
      {importing && <ImportModal branch={profile?.branch_id ?? null} onClose={() => setImporting(false)} onDone={() => pullCatalog(profile?.branch_id ?? null)} />}
    </>
  );
}

// ───────────── add / edit product ─────────────
function DrugModal({ drug, onClose, onSaved }: { drug: Partial<Drug>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: drug.name ?? '', generic_name: drug.generic_name ?? '', category: drug.category ?? '', nafdac_number: drug.nafdac_number ?? '',
    barcode: drug.barcode ?? '', unit_type: drug.unit_type ?? 'Pack', selling_price: String(drug.selling_price ?? ''), wholesale_price: drug.wholesale_price != null ? String(drug.wholesale_price) : '',
    cost_price: '', reorder_level: String(drug.reorder_level ?? 10), requires_prescription: !!drug.requires_prescription, is_active: drug.is_active ?? true,
  });
  const [costLoaded, setCostLoaded] = useState(!drug.id);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: any) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!drug.id) return;
    supabase.rpc('get_drug_costs').then(({ data }) => {
      const hit = (data as any[] | null)?.find((r) => r.drug_id === drug.id);
      if (hit) { setF((x) => ({ ...x, cost_price: String(hit.cost_price) })); setCostLoaded(true); }
    });
  }, [drug.id]);

  const save = async () => {
    if (!f.name.trim()) return toast('Product name is required.', 'error');
    if (!(Number(f.selling_price) >= 0) || f.selling_price === '') return toast('Enter a selling price.', 'error');
    setBusy(true);
    const body: Record<string, any> = {
      name: f.name.trim(), generic_name: f.generic_name.trim() || null, category: f.category.trim() || null, nafdac_number: f.nafdac_number.trim() || null,
      barcode: f.barcode.trim() || null, unit_type: f.unit_type.trim() || 'Pack', selling_price: Number(f.selling_price),
      wholesale_price: f.wholesale_price === '' ? null : Number(f.wholesale_price), reorder_level: Math.max(0, parseInt(f.reorder_level, 10) || 0),
      requires_prescription: f.requires_prescription, is_active: f.is_active,
    };
    if (costLoaded && f.cost_price !== '') body.cost_price = Number(f.cost_price);
    const { error } = drug.id ? await supabase.from('drugs').update(body).eq('id', drug.id) : await supabase.from('drugs').insert(body);
    setBusy(false);
    if (error) return toast(error.code === '23505' ? 'A product with this name or barcode already exists.' : errMsg(error), 'error');
    toast(drug.id ? 'Product updated.' : 'Product added.');
    onSaved();
  };

  return (
    <Modal title={drug.id ? 'Edit product' : 'Add product'} onClose={onClose} wide footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save product</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Product name *" className="sm:col-span-2"><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Amoxicillin 500mg Capsules" /></Field>
        <Field label="Generic name"><Input value={f.generic_name} onChange={(e) => set('generic_name', e.target.value)} /></Field>
        <Field label="Category"><Input value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Antibiotics" /></Field>
        <Field label="NAFDAC number"><Input value={f.nafdac_number} onChange={(e) => set('nafdac_number', e.target.value)} /></Field>
        <Field label="Barcode" hint="Click here and scan the pack."><Input value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></Field>
        <Field label="Unit type"><Input value={f.unit_type} onChange={(e) => set('unit_type', e.target.value)} placeholder="Card / Pack / Bottle" /></Field>
        <Field label="Reorder level"><Input inputMode="numeric" value={f.reorder_level} onChange={(e) => set('reorder_level', e.target.value)} /></Field>
        <Field label="Selling price *"><Input inputMode="decimal" value={f.selling_price} onChange={(e) => set('selling_price', e.target.value)} /></Field>
        <Field label="Wholesale price"><Input inputMode="decimal" value={f.wholesale_price} onChange={(e) => set('wholesale_price', e.target.value)} /></Field>
        <Field label="Cost price" hint={costLoaded ? undefined : 'Loading…'}><Input inputMode="decimal" disabled={!costLoaded} value={f.cost_price} onChange={(e) => set('cost_price', e.target.value)} /></Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requires_prescription} onChange={(e) => set('requires_prescription', e.target.checked)} />Prescription required</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} />Active (sellable)</label>
        </div>
      </div>
    </Modal>
  );
}

// ───────────── receive stock ─────────────
function ReceiveModal({ drug, drugs, branch, onClose, onSaved }: { drug: Drug | null; drugs: Drug[]; branch: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [drugId, setDrugId] = useState(drug?.id ?? '');
  const [find, setFind] = useState('');
  const [f, setF] = useState({ batch: '', expiry: '', qty: '', cost: '', note: '' });
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => drugs.filter((d) => d.is_active && (!find || d.name.toLowerCase().includes(find.toLowerCase()))).slice(0, 50), [drugs, find]);
  const save = async () => {
    if (!branch) return toast('Your account has no branch assigned.', 'error');
    if (!drugId) return toast('Choose a product.', 'error');
    if (!f.batch.trim() || !f.expiry || !(parseInt(f.qty, 10) > 0)) return toast('Batch number, expiry date and quantity are required.', 'error');
    if (f.expiry < todayISO()) return toast('This expiry date has already passed.', 'error');
    setBusy(true);
    const { error } = await supabase.rpc('receive_stock', { p_branch: branch, p_drug: drugId, p_batch: f.batch.trim(), p_expiry: f.expiry, p_qty: parseInt(f.qty, 10), p_cost: f.cost === '' ? null : Number(f.cost), p_supplier: null, p_note: f.note || null });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    toast('Stock received.');
    onSaved();
  };
  return (
    <Modal title="Receive stock" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Add to stock</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Product *">
            {drug ? <Input disabled value={drug.name} /> : <>
              <Input placeholder="Type to filter…" value={find} onChange={(e) => setFind(e.target.value)} className="mb-2" />
              <Select value={drugId} onChange={(e) => setDrugId(e.target.value)} size={5} className="h-36">
                {options.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </>}
          </Field>
        </div>
        <Field label="Batch number *"><Input value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })} /></Field>
        <Field label="Expiry date *"><Input type="date" min={todayISO()} value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} /></Field>
        <Field label="Quantity received *"><Input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Unit cost"><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Note (supplier / invoice)" className="sm:col-span-2"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// ───────────── batches ─────────────
function BatchesDrawer({ drug, write, onClose, onChanged }: { drug: Drug; write: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const list = useLiveQuery(() => db.batches.where('drug_id').equals(drug.id).toArray(), [drug.id], [] as Batch[]);
  const [adj, setAdj] = useState<Batch | null>(null);
  const [delta, setDelta] = useState('');
  const [type, setType] = useState('adjustment');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const sorted = [...list].sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  const submit = async () => {
    const d = parseInt(delta, 10);
    if (!d) return toast('Enter a non-zero change (use a minus sign to reduce).', 'error');
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', { p_batch: adj!.id, p_delta: d, p_type: type, p_reason: reason });
    setBusy(false);
    if (error) return toast(errMsg(error), 'error');
    toast('Stock adjusted.'); setAdj(null); setDelta(''); setReason(''); onChanged();
  };
  return (
    <Drawer title={`${drug.name} · batches`} onClose={onClose}>
      {!sorted.length ? <Empty title="No batches on record" hint="Receive stock to add a batch." /> : (
        <ul className="divide-y divide-line">
          {sorted.map((b) => {
            const days = daysUntil(b.expiry_date);
            return (
              <li key={b.id} className="flex items-center justify-between gap-3 py-3">
                <div><p className="font-medium">Batch {b.batch_number}</p><p className="text-xs text-muted">Expires {fmtDate(b.expiry_date)}{b.quantity_reserved ? ` · ${b.quantity_reserved} reserved` : ''}</p></div>
                <div className="flex items-center gap-2">
                  {days < 0 ? <Badge tone="bad">Expired</Badge> : days <= 90 ? <Badge tone="warn">{days} days</Badge> : null}
                  <span className="w-14 text-right font-semibold tnum">{num(b.quantity_remaining)}</span>
                  {write && <Button size="sm" onClick={() => { setAdj(b); setType(days < 0 ? 'expired_writeoff' : 'adjustment'); setDelta(days < 0 ? String(-b.quantity_remaining) : ''); }}>Adjust</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adj && (
        <Modal title={`Adjust batch ${adj.batch_number}`} onClose={() => setAdj(null)} footer={<><Button onClick={() => setAdj(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Save adjustment</Button></>}>
          <p className="mb-3 text-sm text-muted">Currently {adj.quantity_remaining} in this batch. Every adjustment is recorded in the stock ledger with your name.</p>
          <div className="grid gap-3">
            <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="adjustment">Stock-take correction</option><option value="expired_writeoff">Expired / damaged write-off</option><option value="return">Return to stock</option></Select></Field>
            <Field label="Change in quantity" hint="Negative removes stock, positive adds."><Input value={delta} inputMode="numeric" onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ''))} /></Field>
            <Field label="Reason *"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </Drawer>
  );
}

// ───────────── bulk import ─────────────

function ImportModal({ branch, onClose, onDone }: { branch: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<ImpRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; batches: number; errors: { row: number; message: string }[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const build = (table: string[][]) => {
    if (table.length < 2) return toast('The file has no data rows.', 'error');
    const head = table[0].map((h) => String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_'));
    if (!head.includes('name')) return toast('The first row must contain column headers, including "name".', 'error');
    const out: ImpRow[] = [];
    table.slice(1).forEach((r, i) => {
      const data: Record<string, string> = {};
      head.forEach((h, c) => { if (COLS.includes(h)) data[h] = normaliseCell(r[c]); });
      if (Object.values(data).every((v) => !v)) return;
      out.push(validateRow(i + 2, data));
    });
    setRows(out); setResult(null);
  };

  const onFile = async (file: File) => {
    try {
      if (file.size > 8 * 1024 * 1024) return toast('File is too large (max 8 MB).', 'error');
      if (/\.csv$/i.test(file.name)) {
        const text = await file.text();
        const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
        build(parsed.data as string[][]);
      } else if (/\.xlsx$/i.test(file.name)) {
        const sheet = await readSheet(file);
        build((sheet as unknown[][]).map((r) => r.map(normaliseCell)));
      } else toast('Please choose a .csv or .xlsx file.', 'error');
    } catch (e) { toast(`Could not read the file: ${errMsg(e)}`, 'error'); }
  };

  const good = rows?.filter((r) => !r.errors.length) ?? [];
  const bad = rows?.filter((r) => r.errors.length) ?? [];

  const run = async () => {
    if (!branch) return toast('Your account has no branch assigned.', 'error');
    setBusy(true);
    const total = { created: 0, updated: 0, batches: 0, errors: [] as { row: number; message: string }[] };
    try {
      for (let i = 0; i < good.length; i += 200) {
        const chunk = good.slice(i, i + 200).map((r) => ({ ...r.data, _row: r.n }));
        const { data, error } = await supabase.rpc('import_inventory', { p_branch: branch, p_rows: chunk });
        if (error) throw error;
        total.created += data.created; total.updated += data.updated; total.batches += data.batches; total.errors.push(...data.errors);
      }
      setResult(total);
      await onDone();
      toast(`Import finished: ${total.created} new, ${total.updated} updated.`);
    } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };

  return (
    <Modal title="Bulk import inventory (CSV / Excel)" wide onClose={onClose}
      footer={<><Button onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>{rows && !result && <Button variant="primary" loading={busy} disabled={!good.length} onClick={run}>Import {good.length} row(s)</Button>}</>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => fileRef.current?.click()}><FileSpreadsheet size={16} />Choose file</Button>
        <Button onClick={() => downloadCSV('stock-import-template.csv', [COLS, SAMPLE])}><Download size={16} />Download template</Button>
        <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      </div>
      <p className="mb-3 text-xs text-muted">Existing products are matched by barcode or name and updated. <b>quantity</b> is the physical count for that batch, so importing the same sheet twice never double-counts. Dates use YYYY-MM-DD.</p>
      {rows && (
        <>
          <div className="mb-2 flex gap-2"><Badge tone="ok">{good.length} ready</Badge>{bad.length > 0 && <Badge tone="bad">{bad.length} with errors (skipped)</Badge>}</div>
          <div className="max-h-72 overflow-auto rounded-lg border border-line">
            <Table head={['Row', 'Name', 'Batch', 'Expiry', 'Qty', 'Price', 'Check']}>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.n} className={r.errors.length ? 'bg-badsoft' : ''}>
                  <Td>{r.n}</Td><Td>{r.data.name}</Td><Td>{r.data.batch_number}</Td><Td>{r.data.expiry_date}</Td><Td>{r.data.quantity}</Td><Td>{r.data.selling_price}</Td>
                  <Td className={r.errors.length ? 'text-bad' : 'text-ok'}>{r.errors.length ? r.errors.join('; ') : 'OK'}</Td>
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}
      {result && (
        <div className="mt-3 rounded-lg bg-surface2 p-3 text-sm">
          <p><b>{result.created}</b> products created, <b>{result.updated}</b> updated, <b>{result.batches}</b> batches set.</p>
          {result.errors.length > 0 && <ul className="mt-2 list-disc pl-5 text-bad">{result.errors.slice(0, 20).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}</ul>}
        </div>
      )}
    </Modal>
  );
}
