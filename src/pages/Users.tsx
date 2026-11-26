import { useState } from 'react';
import { Copy, KeyRound, Mail, Pencil, UserPlus } from 'lucide-react';
import { callAdmin, errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, type Role } from '../lib/types';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../components/ui';
import { useToast } from '../components/toast';

const ASSIGNABLE = (Object.keys(ROLE_LABEL) as Role[]).filter((r) => r !== 'customer');

export default function Users() {
  const { profile, refreshProfile, sendReset } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<any | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string; created: boolean } | null>(null);

  const users = useAsync(async () => {
    const [p, b] = await Promise.all([supabase.from('profiles').select('*').order('created_at'), supabase.from('branches').select('id,name,code').order('name')]);
    if (p.error) throw p.error;
    return { users: p.data as any[], branches: (b.data ?? []) as any[] };
  }, []);
  const pendingCount = users.data?.users.filter((u) => !u.is_active).length ?? 0;

  const save = async (f: any) => {
    const { error } = await supabase.from('profiles').update({ full_name: f.full_name.trim(), phone: f.phone.trim() || null, role: f.role, branch_id: f.branch_id || null, is_active: f.is_active }).eq('id', edit.id);
    if (error) return toast(errMsg(error), 'error');
    toast('User updated.'); setEdit(null); users.reload(); if (edit.id === profile?.id) refreshProfile();
  };

  const create = async (f: any) => {
    const { data, error } = await callAdmin<{ email: string; temp_password: string }>({ action: 'create_user', ...f });
    if (error || !data) return toast(error ?? 'Could not create the user.', 'error');
    setAdding(false); users.reload();
    setSecret({ email: data.email, password: data.temp_password, created: true });
  };

  const tempPassword = async () => {
    const { data, error } = await callAdmin<{ email: string; temp_password: string }>({ action: 'set_password', user_id: resetFor.id });
    setResetFor(null);
    if (error || !data) return toast(error ?? 'Could not reset the password.', 'error');
    setSecret({ email: data.email, password: data.temp_password, created: false });
  };

  const emailReset = async (u: any) => {
    if (!u.email) return toast('This user has no email on file.', 'error');
    const m = await sendReset(u.email);
    if (m) toast(/not authorized|rate limit|over_email/i.test(m) ? 'Email could not be sent (email delivery is not set up for outside addresses yet). Use "Temporary password" instead.' : m, 'error');
    else toast(`Reset link sent to ${u.email}.`);
  };

  return (
    <>
      <PageHeader title="Users" subtitle="Staff, riders and couriers" actions={<Button variant="primary" onClick={() => setAdding(true)}><UserPlus size={16} />Add user</Button>} />
      {pendingCount > 0 && <Card className="mb-4 p-3 text-sm"><Badge tone="warn">{pendingCount} waiting for activation</Badge> <span className="text-muted">These accounts exist but cannot sign in to anything until you activate them (Edit).</span></Card>}
      <Card>
        {users.loading && !users.data ? <Spinner /> : users.error ? <ErrorBox message={users.error} onRetry={users.reload} /> : (
          <Table head={['Name', 'Email', 'Role', 'Branch', 'Status', '']}>
            {users.data!.users.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.full_name || <span className="text-muted">(no name yet)</span>}{u.id === profile?.id && <span className="ml-1 text-xs text-muted">you</span>}<div className="text-xs font-normal text-muted">{u.phone ?? ''}</div></Td>
                <Td className="text-muted">{u.email ?? '—'}</Td>
                <Td>{ROLE_LABEL[u.role as Role]}</Td><Td className="text-muted">{users.data!.branches.find((b) => b.id === u.branch_id)?.name ?? '—'}</Td>
                <Td><Badge tone={u.is_active ? 'ok' : 'warn'}>{u.is_active ? 'Active' : 'Inactive'}</Badge></Td>
                <Td><div className="flex justify-end gap-1">
                  <Button size="sm" title="Give a temporary password" onClick={() => setResetFor(u)}><KeyRound size={14} /></Button>
                  <Button size="sm" title="Email a reset link" onClick={() => emailReset(u)}><Mail size={14} /></Button>
                  <Button size="sm" onClick={() => setEdit(u)}><Pencil size={14} />Edit</Button>
                </div></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Temporary passwords always work. Emailed reset links only reach outside addresses after you connect your official email (SMTP) in Supabase.</p>
      {edit && <EditUser user={edit} self={edit.id === profile?.id} branches={users.data?.branches ?? []} onClose={() => setEdit(null)} onSave={save} />}
      {adding && <AddUser branches={users.data?.branches ?? []} onClose={() => setAdding(false)} onCreate={create} />}
      {resetFor && <Confirm title="Give a temporary password?" confirmLabel="Generate password" onClose={() => setResetFor(null)} onConfirm={tempPassword}
        message={`This replaces the current password for ${resetFor.full_name || resetFor.email}. They must choose a new private password the next time they sign in.`} />}
      {secret && <SecretDialog {...secret} onClose={() => setSecret(null)} />}
    </>
  );
}

function SecretDialog({ email, password, created, onClose }: { email: string; password: string; created: boolean; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title={created ? 'Account created' : 'Temporary password ready'} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>I have saved it</Button>}>
      <p className="mb-3 text-sm text-muted">Share these details with the user privately (not in a group chat). <b className="text-fg">This password is shown only once.</b> They will be asked to choose their own password at first sign-in.</p>
      <div className="space-y-2 rounded-lg border border-line bg-surface2 p-3 text-sm">
        <div><span className="text-xs text-muted">Email</span><div className="font-medium">{email}</div></div>
        <div><span className="text-xs text-muted">Temporary password</span>
          <div className="flex items-center justify-between gap-2"><code className="select-all text-lg font-semibold tracking-wider">{password}</code>
            <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(password); toast('Copied.'); } catch { toast('Copy failed. Select and copy it manually.', 'error'); } }}><Copy size={14} />Copy</Button></div>
        </div>
      </div>
    </Modal>
  );
}

function AddUser({ branches, onClose, onCreate }: { branches: any[]; onClose: () => void; onCreate: (f: any) => Promise<void> }) {
  const [f, setF] = useState({ email: '', full_name: '', phone: '', role: 'cashier' as Role, branch_id: branches[0]?.id ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title="Add user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!f.email || !f.full_name} onClick={async () => { setBusy(true); await onCreate(f); setBusy(false); }}>Create account</Button></>}>
      <p className="mb-3 text-sm text-muted">A temporary password is generated for you to hand over. The user must replace it when they first sign in.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name *"><Input autoFocus value={f.full_name} onChange={(e) => set('full_name', e.target.value)} /></Field>
        <Field label="Email *"><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Role"><Select value={f.role} onChange={(e) => set('role', e.target.value)}>{ASSIGNABLE.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
        <Field label="Branch"><Select value={f.branch_id} onChange={(e) => set('branch_id', e.target.value)}><option value="">None</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Phone" className="sm:col-span-2"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function EditUser({ user, self, branches, onClose, onSave }: { user: any; self: boolean; branches: any[]; onClose: () => void; onSave: (f: any) => void }) {
  const [f, setF] = useState({ full_name: user.full_name ?? '', phone: user.phone ?? '', role: user.role as Role, branch_id: user.branch_id ?? '', is_active: user.is_active });
  return (
    <Modal title="Edit user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave(f)}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name"><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Role" hint={self ? 'You cannot change your own role.' : undefined}><Select value={f.role} disabled={self} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ASSIGNABLE.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
        <Field label="Branch"><Select value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })}><option value="">None</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.is_active} disabled={self} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />Account is active{self && <span className="text-xs text-muted">(you cannot deactivate yourself)</span>}</label>
      </div>
    </Modal>
  );
}
