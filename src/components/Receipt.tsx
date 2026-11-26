import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PendingSale } from '../lib/types';
import { PAY_LABEL } from '../lib/types';
import { db } from '../lib/db';
import { fmtDateTime, money } from '../lib/format';
import { Button, Modal } from './ui';

/** 80mm thermal receipt. Placeholder layout until the client supplies their receipt model. */
export function ReceiptBody({ sale, settings }: { sale: PendingSale; settings: Record<string, any> }) {
  const change = Math.max(0, sale.payments.reduce((s, p) => s + p.amount, 0) - sale.total);
  return (
    <div className="receipt">
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{settings.business_name ?? 'AkaaPharmacy'}</div>
        {settings.business_address && <div>{settings.business_address}</div>}
        {settings.business_phone && <div>Tel: {settings.business_phone}</div>}
      </div>
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      <div>Receipt: {sale.receipt_no ?? sale.local_ref}</div>
      <div>Date: {fmtDateTime(sale.sold_at)}</div>
      <div>Cashier: {sale.cashier_name}</div>
      {sale.customer_name && <div>Customer: {sale.customer_name}</div>}
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      {sale.items.map((i, k) => (
        <div key={k} style={{ marginBottom: 3 }}>
          <div>{i.name}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{i.quantity} x {money(i.unit_price)}</span><span>{money(i.quantity * i.unit_price)}</span></div>
        </div>
      ))}
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      <Line a="Subtotal" b={money(sale.subtotal)} />
      {sale.discount > 0 && <Line a="Discount" b={`-${money(sale.discount)}`} />}
      <Line a="TOTAL" b={money(sale.total)} bold />
      {sale.payments.map((p, k) => <Line key={k} a={`${PAY_LABEL[p.method]}${p.reference ? ` (${p.reference})` : ''}`} b={money(p.amount)} />)}
      {change > 0 && <Line a="Change" b={money(change)} />}
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      <div style={{ textAlign: 'center' }}>{settings.receipt_footer ?? 'Thank you for your patronage.'}</div>
      {!sale.receipt_no && <div style={{ textAlign: 'center', marginTop: 4, fontSize: 10 }}>Provisional receipt – final number is assigned when uploaded.</div>}
    </div>
  );
}
const Line = ({ a, b, bold }: { a: string; b: string; bold?: boolean }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: bold ? 700 : 400 }}><span>{a}</span><span>{b}</span></div>
);

export function ReceiptModal({ sale, onClose, title = 'Sale complete' }: { sale: PendingSale; onClose: () => void; title?: string }) {
  const settings = useLiveQuery(async () => (await db.meta.get('settings'))?.value ?? {}, [], {} as Record<string, any>);
  return (
    <>
      <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => window.print()}><Printer size={16} />Print receipt</Button></>}>
        {title === 'Sale complete' && (
          <div className="mb-3 flex flex-col items-center gap-1" aria-hidden>
            <svg width="56" height="56" viewBox="0 0 56 56" className="check-ring">
              <circle cx="28" cy="28" r="26" fill="var(--ok-soft)" stroke="var(--ok)" strokeWidth="2" />
              <path className="check-path" d="M17 29l8 8 14-17" fill="none" stroke="var(--ok)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
        <div className="mx-auto w-fit rounded-lg border border-line bg-white shadow-card"><ReceiptBody sale={sale} settings={settings} /></div>
      </Modal>
      {createPortal(<div className="receipt-print"><ReceiptBody sale={sale} settings={settings} /></div>, document.body)}
    </>
  );
}
