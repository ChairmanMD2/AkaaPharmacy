import { lazy, Suspense, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './components/toast';
import Layout from './components/Layout';
import Login from './pages/Login';
import SetPassword from './pages/SetPassword';
import { Button, Card, Spinner } from './components/ui';
import { can, isCourier, type Feature } from './lib/permissions';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const POS = lazy(() => import('./pages/POS'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Sales = lazy(() => import('./pages/Sales'));
const Orders = lazy(() => import('./pages/Orders'));
const Deliveries = lazy(() => import('./pages/Deliveries'));
const Wishlist = lazy(() => import('./pages/Wishlist'));
const Shifts = lazy(() => import('./pages/Shifts'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Reports = lazy(() => import('./pages/Reports'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));

function Guard({ feature, children }: { feature: Feature; children: ReactElement }) {
  const { profile } = useAuth();
  if (!can(profile?.role, feature)) return <Navigate to={isCourier(profile?.role) ? '/deliveries' : '/'} replace />;
  return children;
}

function Gate() {
  const { session, profile, loading, signOut, recovery, mustChange } = useAuth();
  if (loading) return <Spinner label="Loading…" />;
  if (session && recovery) return <SetPassword reason="recovery" />;
  if (session && mustChange) return <SetPassword reason="first" />;
  if (!session && !profile) return <Login />;
  if (!profile) return <Spinner label="Loading your account…" />;
  if (!profile.is_active || profile.role === 'customer') {
    return (
      <div className="bg-login flex min-h-full items-center justify-center p-4">
        <Card className="max-w-md p-6 text-center">
          <h1 className="text-lg font-semibold">{profile.role === 'customer' ? 'Staff app' : 'Waiting for activation'}</h1>
          <p className="mt-2 text-sm text-muted">
            {profile.role === 'customer' ? 'This app is for pharmacy staff. The customer storefront is coming soon.' : 'Your account has been created but an administrator has not activated it yet. Please contact your administrator.'}
          </p>
          <Button className="mt-4" onClick={signOut}>Sign out</Button>
        </Card>
      </div>
    );
  }
  return (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={isCourier(profile.role) ? <Navigate to="/deliveries" replace /> : <Guard feature="dashboard"><Dashboard /></Guard>} />
          <Route path="pos" element={<Guard feature="pos"><POS /></Guard>} />
          <Route path="inventory" element={<Guard feature="inventory"><Inventory /></Guard>} />
          <Route path="sales" element={<Guard feature="sales"><Sales /></Guard>} />
          <Route path="orders" element={<Guard feature="orders"><Orders /></Guard>} />
          <Route path="deliveries" element={<Guard feature="deliveries"><Deliveries /></Guard>} />
          <Route path="wishlist" element={<Guard feature="wishlist"><Wishlist /></Guard>} />
          <Route path="shifts" element={<Guard feature="shifts"><Shifts /></Guard>} />
          <Route path="expenses" element={<Guard feature="expenses"><Expenses /></Guard>} />
          <Route path="reports" element={<Guard feature="reports"><Reports /></Guard>} />
          <Route path="users" element={<Guard feature="users"><Users /></Guard>} />
          <Route path="settings" element={<Guard feature="settings"><Settings /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
