import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Printer, Trash2 } from 'lucide-react';
import { db } from '../lib/db';
import { availableFromBatches } from '../lib/sync';
import { nextInvoiceNo, savePrefill } from '../lib/invoice';
import { fmtDate, money, todayISO } from '../lib/format';
import type { Batch, Drug } from '../lib/types';
import { Badge, Button, Field, Input, Modal } from './ui';
import { ProductSelect } from './ProductSelect';
import { useToast } from './toast';

interface WishLine { wishId: string; wanted: string; drugId: string | null; qty: string }

/**
 * Turns several wish-list requests into ONE invoice: confirm which product each request means, the quantities,
 * and the prices and availability right now, then continue to the point of sale to take payment.
 */
export function WishInvoice({ items, onClose }: { items: any[]; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const drugs = useLiveQuery(() => db.drugs.toArray(), [], [] as Drug[]);
  const batches = useLiveQuery(() => db.batches.toArray(), [], [] as Batch[]);
  const settings = useLiveQuery(async () => (await db.meta.get('settings'))?.value ?? {}, [], {} as Record<string, any>);
  const first = items.find((i) => i.customer_name) ?? items[0];
  const [customer, setCustomer] = useState<string>(first?.customer_name ?? '');
  const [phone, setPhone] = useState<string>(first?.customer_phone ?? '');
  const [lines, setLines] = useState<WishLine[]>(() => items.map((i) => ({ wishId: i.id, wanted: i.product_name, drugId: i.drug_id ?? null, qty: String(i.quantity ?? 1) })));
  const [invoiceNo, setInvoiceNo] = useState<string | null>(null);

  // match free-text requests to products once the catalogue is available
  useEffect(() => {
    if (!drugs.length) return;
    setLines((cur) => cur.map((l) => {
      if (l.drugId) return l;
      const hit = drugs.find((d) => d.is_active && d.name.trim().toLowerCase() === l.wanted.trim().toLowerCase());
      return hit ? { ...l, drugId: hit.id } : l;
    }));
  }, [drugs.length]);

  const byId = useMemo(() => new Map(drugs.map((d) => [d.id, d])), [drugs]);
  const rows = lines.map((l) => {
    const drug = l.drugId ? byId.get(l.drugId) ?? null : null;
    const q = parseInt(l.qty, 10) || 0;
    const have = drug ? availableFromBatches(batches, drug.id) : 0;
    return { ...l, drug, q, have, ok: !!drug && q > 0 && q <= have, total: drug ? q * drug.selling_price : 0 };
  });
  const payable = rows.filter((r) => r.ok);
  const total = payable.reduce((s, r) => s + r.total, 0);
  const setLine = (wishId: string, patch: Partial<WishLine>) => setLines((a) => a.map((l) => (l.wishId === wishId ? { ...l, ...patch } : l)));

  const proceed = async () => {
    if (!payable.length) return toast('Nothing can be invoiced yet: match each request to a product that is in stock.', 'error');
    const no = invoiceNo ?? (await nextInvoiceNo());
    setInvoiceNo(no);
    savePrefill({ customer: customer.trim(), phone: phone.trim(), lines: payable.map((r) => ({ drug_id: r.drug!.id, qty: r.q })), wishIds: payable.map((r) => r.wishId), invoiceNo: no });
    toast(`Invoice ${no} sent to the till.`);
    navigate('/pos');
  };

  const print = async () => {
    if (!payable.length) return toast('Nothing to print yet.', 'error');
    if (!invoiceNo) setInvoiceNo(await nextInvoiceNo());
    setTimeout(() => window.print(), 80);
  };

  return (
    <>
      <Modal title="Create invoice from wish list" wide onClose={onClose}
        footer={<>
          <span className="mr-auto text-sm text-muted">{payable.length} of {rows.length} request(s) ready · <b className="text-fg tnum">{money(total)}</b></span>
          <Button onClick={print}><Printer size={16} />Print invoice</Button>
          <Button variant="primary" onClick={proceed}>Proceed to payment</Button>
        </>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Field label="Customer name"><Input value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>
          <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((r) => (
            <li key={r.wishId} className="grid gap-2 px-3 py-3 sm:grid-cols-[1.2fr_1.4fr_5rem_6rem_auto] sm:items-center">
              <div className="text-sm"><p className="text-xs text-muted">Customer asked for</p><p className="font-medium">{r.wanted}</p></div>
              <ProductSelect drugs={drugs} value={r.drug} onPick={(d) => setLine(r.wishId, { drugId: d?.id ?? null })} placeholder="Match to a product…" />
              <Input aria-label={`Quantity for ${r.wanted}`} inputMode="numeric" value={r.qty} onChange={(e) => setLine(r.wishId, { qty: e.target.value.replace(/\D/g, '') })} />
              <div className="text-right text-sm tnum">{r.drug ? <><div className="font-semibold">{money(r.total)}</div><div className="text-xs text-muted">{money(r.drug.selling_price)} each</div></> : <span className="text-muted">—</span>}</div>
              <div className="flex items-center justify-end gap-2">
                {!r.drug ? <Badge tone="warn">no product</Badge> : r.have < 1 ? <Badge tone="bad">out of stock</Badge> : r.q > r.have ? <Badge tone="bad">only {r.have}</Badge> : <Badge tone="ok">{r.have} in stock</Badge>}
                <button aria-label="Remove from invoice" className="text-muted hover:text-bad" onClick={() => setLines((a) => a.filter((l) => l.wishId !== r.wishId))}><Trash2 size={15} /></button>
              </div>
            </li>
          ))}
          {!rows.length && <li className="p-6 text-center text-sm text-muted">No requests left on this invoice.</li>}
        </ul>
        <p className="mt-3 text-xs text-muted">Requests that cannot be filled now (no product, or not enough stock) are left on the wish list. When the customer pays, the ones on the invoice are marked fulfilled automatically.</p>
      </Modal>
      {createPortal(
        <div className="printable print-only bg-white p-8 text-black">
          <h1 className="text-xl font-bold">{settings.business_name ?? 'AkaaPharmacy'}</h1>
          {settings.business_address && <p>{settings.business_address}</p>}
          <h2 className="mt-4 text-lg font-semibold">INVOICE {invoiceNo ?? ''}</h2>
          <p>Date: {fmtDate(todayISO())}{customer ? ` · Customer: ${customer}` : ''}{phone ? ` · ${phone}` : ''}</p>
          <table className="mt-4 w-full border-collapse text-sm">
            <thead><tr className="border-b border-black text-left"><th className="py-1">Item</th><th>Qty</th><th>Unit price</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{payable.map((r) => <tr key={r.wishId} className="border-b border-gray-300"><td className="py-1">{r.drug!.name}</td><td>{r.q}</td><td>{money(r.drug!.selling_price)}</td><td className="text-right">{money(r.total)}</td></tr>)}</tbody>
          </table>
          <p className="mt-3 text-right text-lg font-bold">Total: {money(total)}</p>
          <p className="mt-4 text-xs">This invoice does not reserve stock. Prices and availability are as at the time of printing.</p>
        </div>, document.body)}
    </>
  );
}
