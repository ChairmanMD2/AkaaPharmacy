import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { initPaystack, verifyPaystack } from '../lib/paystack';
import { money } from '../lib/format';
import { Button, Field, Input, Modal } from './ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collects one Paystack payment: open the Paystack page, then wait until the server confirms it. */
export function PaystackModal({ amount, purpose, orderId, onSuccess, onClose }: { amount: number; purpose: 'pos' | 'order'; orderId?: string; onSuccess: (reference: string) => void; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'ready' | 'starting' | 'waiting' | 'failed'>('ready');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const popup = useRef<Window | null>(null);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);

  const poll = async (reference: string) => {
    for (let i = 0; i < 200 && !stop.current; i++) {         // about 10 minutes
      await sleep(3000);
      if (stop.current) return;
      try {
        const v = await verifyPaystack(reference);
        if (v.status === 'success') { try { popup.current?.close(); } catch { /* ignore */ } onSuccess(reference); return; }
        if (v.status === 'failed') { setPhase('failed'); setMsg(v.message || 'The payment was declined or not completed.'); return; }
      } catch { /* a connection blip: keep watching */ }
    }
    if (!stop.current) { setPhase('failed'); setMsg('We did not receive a confirmation in time. If the customer was charged, ask your administrator to check Paystack before trying again.'); }
  };

  const start = async () => {
    setPhase('starting'); setMsg('');
    popup.current = window.open('', 'akaa_paystack', 'width=520,height=760');   // opened straight from the click so browsers allow it
    try {
      const r = await initPaystack({ amount, email: email.trim() || undefined, purpose, order_id: orderId });
      setUrl(r.authorization_url);
      if (popup.current && !popup.current.closed) popup.current.location.href = r.authorization_url;
      setPhase('waiting');
      void poll(r.reference);
    } catch (e: any) {
      try { popup.current?.close(); } catch { /* ignore */ }
      setPhase('failed'); setMsg(e?.message || 'Could not start the payment.');
    }
  };

  return (
    <Modal title="Pay with Paystack" onClose={onClose}
      footer={<>
        <Button onClick={onClose}>{phase === 'waiting' ? 'Cancel' : 'Close'}</Button>
        {(phase === 'ready' || phase === 'failed') && <Button variant="primary" onClick={start}>{phase === 'failed' ? 'Try again' : 'Open Paystack'}</Button>}
      </>}>
      <p className="mb-1 text-center text-3xl font-semibold tnum">{money(amount)}</p>
      <p className="mb-4 text-center text-sm text-muted">Card, bank transfer or USSD, whichever Paystack offers the customer.</p>
      {phase === 'ready' && <Field label="Customer email (optional)" hint="Paystack sends the customer a receipt here."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" /></Field>}
      {phase === 'starting' && <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted"><Loader2 className="animate-spin" size={16} />Starting payment…</p>}
      {phase === 'waiting' && (
        <div className="space-y-3 text-center">
          <p className="flex items-center justify-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} />Waiting for the customer to pay…</p>
          <p className="text-xs text-muted">The payment page opens in a new window. This screen continues by itself once Paystack confirms the payment.</p>
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand hover:underline"><ExternalLink size={14} />Payment window did not open? Open it here</a>
        </div>
      )}
      {phase === 'failed' && <p role="alert" className="rounded-lg bg-badsoft p-3 text-sm text-bad">{msg}</p>}
      {phase === 'ready' && <p className="mt-3 flex items-start gap-1.5 text-xs text-muted"><CheckCircle2 size={14} className="mt-0.5 shrink-0" />The sale is only recorded as paid after Paystack confirms the money.</p>}
    </Modal>
  );
}
