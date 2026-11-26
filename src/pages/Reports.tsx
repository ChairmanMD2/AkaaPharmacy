import { useState } from 'react';
import { Download } from 'lucide-react';
import { supabase, fetchAll } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { downloadCSV, fmtDate, money, num, todayISO } from '../lib/format';
import { PAY_LABEL, type PayMethod } from '../lib/types';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Spinner, Stat, Table, Td } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Reports() {
  const { profile } = useAuth();
  const [from, setFrom] = useState(todayISO().slice(0, 8) + '01');
  const [to, setTo] = useState(todayISO());

  // Profit uses hidden purchase costs, so only the administrator's server function returns it.
  const profit = useAsync(async () => {
    if (profile?.role !== 'admin') return null;
    const { data, error } = await supabase.rpc('profit_report', { p_from: new Date(from + 'T00:00:00').toISOString(), p_to: new Date(to + 'T23:59:59.999').toISOString() });
    if (error) throw error;
    return data as { revenue: number; cost_of_goods: number; gross_profit: number; lines_without_cost: number; top_products: { name: string; qty: number; revenue: number; cost: number; profit: number }[] };
  }, [from, to, profile?.role]);

  const r = useAsync(async () => {
    const start = new Date(from + 'T00:00:00').toISOString();
    const end = new Date(to + 'T23:59:59.999').toISOString();
    const sales = await fetchAll<any>((a, b) => supabase.from('sales').select('id,total,discount,sold_at,channel').eq('status', 'completed').gte('sold_at', start).lte('sold_at', end).order('sold_at').range(a, b));
    const items = await fetchAll<any>((a, b) => supabase.from('sale_items').select('quantity,line_total,drug_id,drugs(name),sales!inner(sold_at,status)').eq('sales.status', 'completed').gte('sales.sold_at', start).lte('sales.sold_at', end).range(a, b));
    const pays = await fetchAll<any>((a, b) => supabase.from('payments').select('method,amount,status,sales!inner(sold_at,status)').eq('sales.status', 'completed').gte('sales.sold_at', start).lte('sales.sold_at', end).range(a, b));
    const exp = await supabase.rpc('expense_report', { p_from: from, p_to: to, p_branch: null });

    const byDay = new Map<string, { n: number; total: number }>();
    sales.forEach((s) => { const d = s.sold_at.slice(0, 10); const x = byDay.get(d) ?? { n: 0, total: 0 }; x.n++; x.total += Number(s.total); byDay.set(d, x); });
    const prod = new Map<string, { name: string; qty: number; value: number }>();
    items.forEach((i) => { const x = prod.get(i.drug_id) ?? { name: i.drugs?.name ?? '?', qty: 0, value: 0 }; x.qty += i.quantity; x.value += Number(i.line_total); prod.set(i.drug_id, x); });
    const method = new Map<string, number>();
    pays.filter((p) => p.status !== 'rejected').forEach((p) => method.set(p.method, (method.get(p.method) ?? 0) + Number(p.amount)));
    const expenses = ((exp.data ?? []) as any[]).reduce((s, e) => s + Number(e.total_cost), 0);
    const revenue = sales.reduce((s, x) => s + Number(x.total), 0);
    return { count: sales.length, revenue, discounts: sales.reduce((s, x) => s + Number(x.discount), 0), expenses,
      byDay: [...byDay.entries()].sort(), top: [...prod.values()].sort((a, b) => b.value - a.value).slice(0, 20), method: [...method.entries()].sort((a, b) => b[1] - a[1]) };
  }, [from, to]);

  const d = r.data;
  const exportCSV = () => d && downloadCSV(`sales-report-${from}-to-${to}.csv`, [['Date', 'Sales', 'Total'], ...d.byDay.map(([k, v]) => [k, v.n, v.total]), [], ['Product', 'Qty sold', 'Value'], ...d.top.map((t) => [t.name, t.qty, t.value])]);

  return (
    <>
      <PageHeader title="Reports" subtitle="Sales summary for a period" actions={<Button onClick={exportCSV} disabled={!d}><Download size={16} />Export CSV</Button>} />
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
      </Card>
      {r.loading && !d ? <Spinner label="Crunching numbers…" /> : r.error ? <ErrorBox message={r.error} onRetry={r.reload} /> : d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Sales revenue" value={money(d.revenue)} hint={`${num(d.count)} sales`} />
            <Stat label="Average sale" value={money(d.count ? d.revenue / d.count : 0)} />
            <Stat label="Discounts given" value={money(d.discounts)} />
            <Stat label="Expenses" value={money(d.expenses)} hint={`Sales minus expenses: ${money(d.revenue - d.expenses)}`} />
          </div>
          {profit.data ? (
            <Card className="mt-4">
              <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Profit (administrator only)</h2><p className="text-xs text-muted">Product revenue minus the purchase cost recorded for the batches that were sold. Delivery fees are excluded.</p></div>
              <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
                <Stat label="Product revenue" value={money(profit.data.revenue)} />
                <Stat label="Cost of goods sold" value={money(profit.data.cost_of_goods)} />
                <Stat label="Gross profit" value={money(profit.data.gross_profit)} tone={profit.data.gross_profit < 0 ? 'bad' : 'ok'} hint={profit.data.revenue ? `${((profit.data.gross_profit / profit.data.revenue) * 100).toFixed(1)}% margin` : undefined} />
                <Stat label="After expenses" value={money(profit.data.gross_profit - d.expenses)} tone={profit.data.gross_profit - d.expenses < 0 ? 'bad' : undefined} />
              </div>
              {profit.data.lines_without_cost > 0 && <p className="mx-4 mb-3 rounded-lg bg-warnsoft p-2.5 text-xs text-warn">{profit.data.lines_without_cost} sold line(s) have no purchase cost recorded, so profit is overstated for them. Add the cost price in Inventory.</p>}
              {profit.data.top_products.length > 0 && <Table head={['Most profitable products', 'Qty', 'Revenue', 'Cost', 'Profit']}>{profit.data.top_products.map((t) => <tr key={t.name}><Td className="font-medium">{t.name}</Td><Td className="tnum">{num(t.qty)}</Td><Td className="tnum">{money(t.revenue)}</Td><Td className="tnum">{money(t.cost)}</Td><Td className="tnum font-semibold">{money(t.profit)}</Td></tr>)}</Table>}
            </Card>
          ) : profit.error ? <p className="mt-2 text-xs text-bad">Profit could not be loaded: {profit.error}</p> : (
            <p className="mt-2 text-xs text-muted">Sales minus expenses is before the cost of goods sold. The profit breakdown is shown to administrators only.</p>
          )}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card><div className="border-b border-line px-4 py-3"><h2 className="font-semibold">By day</h2></div>
              {!d.byDay.length ? <Empty title="No sales in this period" /> : <Table head={['Date', 'Sales', 'Total']}>{d.byDay.map(([k, v]) => <tr key={k}><Td>{fmtDate(k)}</Td><Td className="tnum">{v.n}</Td><Td className="tnum font-medium">{money(v.total)}</Td></tr>)}</Table>}</Card>
            <Card><div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Payment methods</h2></div>
              {!d.method.length ? <Empty title="No payments" /> : <Table head={['Method', 'Amount']}>{d.method.map(([k, v]) => <tr key={k}><Td>{PAY_LABEL[k as PayMethod] ?? k}</Td><Td className="tnum font-medium">{money(v)}</Td></tr>)}</Table>}</Card>
            <Card className="lg:col-span-2"><div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Top products by value</h2></div>
              {!d.top.length ? <Empty title="No products sold" /> : <Table head={['Product', 'Qty sold', 'Value']}>{d.top.map((t) => <tr key={t.name}><Td className="font-medium">{t.name}</Td><Td className="tnum">{num(t.qty)}</Td><Td className="tnum">{money(t.value)}</Td></tr>)}</Table>}</Card>
          </div>
        </>
      )}
    </>
  );
}
