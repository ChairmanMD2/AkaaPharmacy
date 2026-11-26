import { useState } from 'react';
import { Download, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { can } from '../lib/permissions';
import { downloadCSV, fmtDate, money, monthRange, todayISO } from '../lib/format';
import { Button, Card, Confirm, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

interface Row { description: string; unit: string; qty: string; date: string }
const blank = (): Row => ({ description: '', unit: '', qty: '1', date: todayISO() });
const total = (r: { unit: string; qty: string }) => Math.round((Number(r.unit) || 0) * (Number(r.qty) || 0) * 100) / 100;

export default function Expenses() {
  const { profile } = useAuth();
  const toast = useToast();
  const reviewer = can(profile?.role, 'expenses_review');
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'month' | 'range'>('month');
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [from, setFrom] = useState(todayISO().slice(0, 8) + '01');
  const [to, setTo] = useState(todayISO());
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [reason, setReason] = useState('');

  const [rf, rt] = mode === 'month' ? monthRange(month) : [from, to];
  const report = useAsync(async () => {
    const { data, error } = await supabase.rpc('expense_report', { p_from: rf, p_to: rt, p_branch: null });
    if (error) throw error;
    return data as any[];
  }, [rf, rt]);
  const sum = (report.data ?? []).reduce((s, r) => s + Number(r.total_cost), 0);

  const setRow = (i: number, k: keyof Row, v: string) => setRows((a) => a.map((r, x) => (x === i ? { ...r, [k]: v } : r)));
  const filled = rows.filter((r) => r.description.trim() || r.unit);

  const save = async () => {
    if (!filled.length) return toast('Enter at least one expense.', 'error');
    for (const r of filled) {
      if (!r.description.trim()) return toast('Every expense needs a description.', 'error');
      if (!(Number(r.unit) >= 0) || r.unit === '') return toast(`Enter the unit cost for "${r.description}".`, 'error');
      if (!(Number(r.qty) > 0)) return toast(`Quantity must be more than zero for "${r.description}".`, 'error');
    }
    if (!profile?.branch_id) return toast('Your account has no branch assigned.', 'error');
    setSaving(true);
    const { error } = await supabase.from('expenses').insert(filled.map((r) => ({ branch_id: profile.branch_id, expense_date: r.date, description: r.description.trim(), unit_cost: Number(r.unit), quantity: Number(r.qty) })));
    setSaving(false);
    if (error) return toast(errMsg(error), 'error');
    toast(`${filled.length} expense(s) saved.`); setRows([blank()]); report.reload();
  };

  const remove = async () => {
    const { error } = await supabase.rpc('delete_expense', { p_id: del.id, p_reason: reason });
    if (error) return toast(errMsg(error), 'error');
    toast('Expense removed.'); setDel(null); setReason(''); report.reload();
  };

  const exportCSV = () => downloadCSV(`expenses-${rf}-to-${rt}.csv`, [['S/No.', 'Date', 'Description of Expense', 'Unit Cost', 'Number of Units/Quantity', 'Total Cost'], ...(report.data ?? []).map((r) => [r.s_no, r.expense_date, r.description, r.unit_cost, r.quantity, r.total_cost]), ['', '', 'TOTAL', '', '', sum]]);

  return (
    <>
      <PageHeader title="Expenses" subtitle="Record daily spending and review it by month or date range" />
      <Card className="mb-4 no-print">
        <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Record expenses</h2></div>
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="w-12 px-2 py-1">S/No.</th><th className="w-36 px-2 py-1">Date</th><th className="px-2 py-1">Description of Expense</th><th className="w-32 px-2 py-1">Unit Cost</th><th className="w-28 px-2 py-1">Number of Units</th><th className="w-32 px-2 py-1 text-right">Total Cost</th><th className="w-8" /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 text-muted">{i + 1}</td>
                  <td className="px-2 py-1"><Input type="date" max={todayISO()} value={r.date} onChange={(e) => setRow(i, 'date', e.target.value)} /></td>
                  <td className="px-2 py-1"><Input value={r.description} placeholder="e.g. Generator fuel" onChange={(e) => setRow(i, 'description', e.target.value)} /></td>
                  <td className="px-2 py-1"><Input inputMode="decimal" value={r.unit} onChange={(e) => setRow(i, 'unit', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                  <td className="px-2 py-1"><Input inputMode="decimal" value={r.qty} onChange={(e) => setRow(i, 'qty', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                  <td className="px-2 py-1 text-right font-semibold tnum">{money(total(r))}</td>
                  <td className="px-1">{rows.length > 1 && <button aria-label="Remove row" className="text-muted hover:text-bad" onClick={() => setRows((a) => a.filter((_, x) => x !== i))}><Trash2 size={15} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <Button onClick={() => setRows((a) => [...a, blank()])}><Plus size={16} />Add row</Button>
          <div className="flex items-center gap-3"><span className="text-sm text-muted">Batch total <b className="text-fg tnum">{money(filled.reduce((s, r) => s + total(r), 0))}</b></span><Button variant="primary" loading={saving} onClick={save}>Save expenses</Button></div>
        </div>
      </Card>

      <Card className="printable">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4 no-print">
          <Field label="View by"><Select value={mode} onChange={(e) => setMode(e.target.value as any)} className="w-36"><option value="month">Month</option><option value="range">Date range</option></Select></Field>
          {mode === 'month' ? <Field label="Month"><Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
            : <><Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field></>}
          <div className="ml-auto flex gap-2"><Button onClick={exportCSV} disabled={!report.data?.length}><Download size={16} />Export</Button><Button onClick={() => window.print()} disabled={!report.data?.length}><Printer size={16} />Print</Button></div>
        </div>
        <div className="hidden px-4 pt-4 print:block"><h2 className="text-lg font-semibold">Expense report: {fmtDate(rf)} to {fmtDate(rt)}</h2></div>
        {report.loading && !report.data ? <Spinner /> : report.error ? <ErrorBox message={report.error} onRetry={report.reload} /> : !report.data?.length ? <Empty title="No expenses in this period" hint={reviewer ? undefined : 'You can see the expenses you recorded.'} /> : (
          <Table head={['S/No.', 'Date', 'Description of Expense', 'Unit Cost', 'Units', 'Total Cost', '']}>
            {report.data.map((r) => (
              <tr key={r.id}><Td>{r.s_no}</Td><Td className="text-muted">{fmtDate(r.expense_date)}</Td><Td className="font-medium">{r.description}</Td><Td className="tnum">{money(r.unit_cost)}</Td><Td className="tnum">{Number(r.quantity)}</Td><Td className="tnum font-semibold">{money(r.total_cost)}</Td>
                <Td className="no-print"><div className="flex justify-end gap-1"><Button size="sm" onClick={() => setEdit(r)}><Pencil size={14} /></Button>{reviewer && <Button size="sm" onClick={() => setDel(r)}><Trash2 size={14} /></Button>}</div></Td></tr>
            ))}
            <tr className="bg-surface2 font-semibold"><Td colSpan={5} className="text-right">TOTAL</Td><Td className="tnum">{money(sum)}</Td><Td /></tr>
          </Table>
        )}
      </Card>
      {edit && <EditExpense row={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); report.reload(); }} />}
      {del && <Confirm title="Remove this expense?" danger confirmLabel="Remove" onClose={() => setDel(null)} onConfirm={remove} message={`"${del.description}" · ${money(del.total_cost)}. It is hidden from reports and kept in the audit log.`}><div className="mt-3"><Textarea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} /></div></Confirm>}
    </>
  );
}

function EditExpense({ row, onClose, onSaved }: { row: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ description: row.description, unit: String(row.unit_cost), qty: String(Number(row.quantity)), date: row.expense_date });
  const save = async () => {
    if (!f.description.trim() || !(Number(f.unit) >= 0) || !(Number(f.qty) > 0)) return toast('Check the description, unit cost and quantity.', 'error');
    const { error, count } = await supabase.from('expenses').update({ description: f.description.trim(), unit_cost: Number(f.unit), quantity: Number(f.qty), expense_date: f.date }, { count: 'exact' }).eq('id', row.id);
    if (error) return toast(errMsg(error), 'error');
    if (!count) return toast('You can only edit your own expenses on the day you recorded them.', 'error');
    toast('Expense updated.'); onSaved();
  };
  return (
    <Modal title="Edit expense" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Unit cost"><Input inputMode="decimal" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Units"><Input inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Total cost"><Input disabled value={money(total(f))} /></Field>
      </div>
    </Modal>
  );
}
