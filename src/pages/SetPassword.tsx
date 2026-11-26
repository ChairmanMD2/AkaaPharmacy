import { useAuth } from '../lib/auth';
import { Button, Card } from '../components/ui';
import { Logo } from '../components/Layout';
import { PasswordForm } from '../components/PasswordForm';

export default function SetPassword({ reason }: { reason: 'recovery' | 'first' }) {
  const { signOut } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <Logo size={48} />
          <div>
            <h1 className="text-xl font-semibold">{reason === 'first' ? 'Choose your own password' : 'Reset your password'}</h1>
            <p className="mt-1 text-sm text-muted">{reason === 'first' ? 'You signed in with a temporary password. Set a private one to continue.' : 'Enter a new password for your account.'}</p>
          </div>
        </div>
        <PasswordForm />
        <Button variant="ghost" className="mt-3 w-full" onClick={signOut}>Cancel and sign out</Button>
      </Card>
    </div>
  );
}
