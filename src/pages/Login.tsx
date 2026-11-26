import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';
import { configured } from '../lib/supabase';

export default function Login() {
  const { signIn, sendReset } = useAuth();
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const m = await signIn(email, password);
    if (m) setErr(m);
    setBusy(false);
  };

  const forgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const m = await sendReset(email);
    setBusy(false);
    if (m) setErr(/not authorized|rate limit|over_email/i.test(m) ? 'The email could not be sent right now. Ask your administrator for a temporary password.' : m);
    else setSent(true);
  };

  if (mode === 'forgot') {
    return (
      <div className="bg-login flex min-h-full items-center justify-center p-4">
        <Card className="anim-up w-full max-w-sm p-6 shadow-lift">
          <div className="mb-5 flex flex-col items-center gap-3 text-center">
            <Logo size={48} />
            <div><h1 className="text-xl font-semibold">Forgot password</h1><p className="text-sm text-muted">We will email you a reset link.</p></div>
          </div>
          {sent ? (
            <div className="space-y-3 text-sm">
              <p className="rounded-lg bg-oksoft p-3 text-ok">If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.</p>
              <p className="text-muted">Nothing after a few minutes? Email delivery may not be set up yet. Ask your administrator to give you a temporary password.</p>
              <Button className="w-full" onClick={() => { setMode('login'); setSent(false); }}>Back to sign in</Button>
            </div>
          ) : (
            <form onSubmit={forgot} className="space-y-4">
              <Field label="Your account email"><Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              {err && <p role="alert" className="rounded-lg bg-badsoft p-2.5 text-sm text-bad">{err}</p>}
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Send reset link</Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setMode('login'); setErr(null); }}>Back to sign in</Button>
            </form>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="bg-login flex min-h-full items-center justify-center p-4">
      <Card className="anim-up w-full max-w-sm p-6 shadow-lift">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={52} />
          <div><h1 className="text-xl font-semibold">AkaaPharmacy</h1><p className="text-sm text-muted">Sign in to continue</p></div>
        </div>
        {!configured && <p className="mb-3 rounded-lg bg-badsoft p-3 text-sm text-bad">Server settings are missing (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).</p>}
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email"><Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {err && <p role="alert" className="rounded-lg bg-badsoft p-2.5 text-sm text-bad">{err}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
        </form>
        <button type="button" className="mt-3 block w-full text-center text-sm text-brand hover:underline" onClick={() => { setMode('forgot'); setErr(null); }}>Forgot password?</button>
        <p className="mt-3 text-center text-xs text-muted">Accounts are created by your administrator.</p>
      </Card>
    </div>
  );
}
