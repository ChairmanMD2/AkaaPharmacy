import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { errMsg, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, type Role } from '../lib/types';
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../components/ui';
import { useToast } from '../components/toast';

export default function Users() {
  const { profile, refreshProfile } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState<any | null>(null);
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

  return (
    <>
      <PageHeader title="Users" subtitle="Staff, riders and couriers" />
      <Card className="mb-4 p-4 text-sm">
        <p><b>Adding someone:</b> create their login in the Supabase dashboard under Authentication → Users (tick auto-confirm), then activate them here and choose a role and branch. {pendingCount > 0 && <Badge tone="warn">{pendingCount} waiting for activation</Badge>}</p>
        <p className="mt-1 text-muted">An in-app invite button will be added later using a secure server function; creating accounts needs a server-side key that must never live in the browser.</p>
      </Card>
      <Card>
        {users.loading && !users.data ? <Spinner /> : users.error ? <ErrorBox message={users.error} onRetry={users.reload} /> : (
          <Table head={['Name', 'Role', 'Branch', 'Phone', 'Status', '']}>
            {users.data!.users.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.full_name || <span className="text-muted">(no name yet)</span>}{u.id === profile?.id && <span className="ml-1 text-xs text-muted">you</span>}</Td>
                <Td>{ROLE_LABEL[u.role as Role]}</Td><Td className="text-muted">{users.data!.branches.find((b) => b.id === u.branch_id)?.name ?? '—'}</Td><Td className="text-muted">{u.phone ?? '—'}</Td>
                <Td><Badge tone={u.is_active ? 'ok' : 'warn'}>{u.is_active ? 'Active' : 'Inactive'}</Badge></Td>
                <Td className="text-right"><Button size="sm" onClick={() => setEdit(u)}><Pencil size={14} />Edit</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && <EditUser user={edit} self={edit.id === profile?.id} branches={users.data?.branches ?? []} onClose={() => setEdit(null)} onSave={save} />}
    </>
  );
}

function EditUser({ user, self, branches, onClose, onSave }: { user: any; self: boolean; branches: any[]; onClose: () => void; onSave: (f: any) => void }) {
  const [f, setF] = useState({ full_name: user.full_name ?? '', phone: user.phone ?? '', role: user.role as Role, branch_id: user.branch_id ?? '', is_active: user.is_active });
  return (
    <Modal title="Edit user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave(f)}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name"><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Role" hint={self ? 'You cannot change your own role.' : undefined}><Select value={f.role} disabled={self} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{(Object.keys(ROLE_LABEL) as Role[]).filter((r) => r !== 'customer').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
        <Field label="Branch"><Select value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })}><option value="">None</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.is_active} disabled={self} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />Account is active{self && <span className="text-xs text-muted">(you cannot deactivate yourself)</span>}</label>
      </div>
    </Modal>
  );
}
