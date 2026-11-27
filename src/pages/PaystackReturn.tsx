import { useEffect } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Card } from '../components/ui';

/** Where Paystack sends the customer after paying. The till window confirms the payment with the server by itself. */
export default function PaystackReturn() {
  useEffect(() => { const t = setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 1500); return () => clearTimeout(t); }, []);
  return (
    <div className="bg-login flex min-h-full items-center justify-center p-4">
      <Card className="anim-up max-w-sm p-6 text-center shadow-lift">
        <CheckCircle2 className="mx-auto mb-2 text-ok" size={40} />
        <h1 className="text-lg font-semibold">Payment submitted</h1>
        <p className="mt-1 text-sm text-muted">You can close this window and go back to the till. It will confirm the payment automatically.</p>
      </Card>
    </div>
  );
}
