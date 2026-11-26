import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';
import { configured } from '../lib/supabase';

export default function Login() {
  const { signIn } = useAuth();
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

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
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
        <p className="mt-4 text-center text-xs text-muted">Accounts are created by your administrator.</p>
      </Card>
    </div>
  );
}
