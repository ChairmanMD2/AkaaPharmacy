import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { passwordProblem } from '../lib/password';
import { Button, Field, Input } from './ui';

/** New password + confirmation. Used for forced change, password recovery and the Account dialog. */
export function PasswordForm({ onDone, submitLabel = 'Save new password' }: { onDone?: () => void; submitLabel?: string }) {
  const { setPassword } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = passwordProblem(pw);
    if (p) return setErr(p);
    if (pw !== pw2) return setErr('The two passwords do not match.');
    setBusy(true); setErr(null);
    const m = await setPassword(pw);
    setBusy(false);
    if (m) return setErr(m);
    onDone?.();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="New password" hint="At least 10 characters, with letters and numbers.">
        <div className="relative">
          <Input type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} className="pr-10" />
          <button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
      </Field>
      <Field label="Confirm new password"><Input type={show ? 'text' : 'password'} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
      {err && <p role="alert" className="rounded-lg bg-badsoft p-2.5 text-sm text-bad">{err}</p>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{submitLabel}</Button>
    </form>
  );
}
