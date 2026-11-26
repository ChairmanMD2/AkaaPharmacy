import type { Role } from './types';

export type Feature =
  | 'dashboard' | 'pos' | 'inventory' | 'inventory_write' | 'sales' | 'orders' | 'deliveries'
  | 'wishlist' | 'shifts' | 'expenses' | 'expenses_review' | 'reports' | 'users' | 'settings' | 'void' | 'verify_payment';

const MAP: Record<Feature, Role[]> = {
  dashboard: ['admin', 'pharmacist', 'cashier', 'inventory_officer'],
  pos: ['admin', 'pharmacist', 'cashier'],
  inventory: ['admin', 'pharmacist', 'cashier', 'inventory_officer'],
  inventory_write: ['admin', 'pharmacist', 'inventory_officer'],
  sales: ['admin', 'pharmacist', 'cashier'],
  orders: ['admin', 'pharmacist', 'cashier', 'inventory_officer'],
  deliveries: ['admin', 'pharmacist', 'inventory_officer', 'rider', 'courier'],
  wishlist: ['admin', 'pharmacist', 'cashier', 'inventory_officer'],
  shifts: ['admin', 'pharmacist', 'cashier'],
  expenses: ['admin', 'pharmacist', 'cashier', 'inventory_officer'],
  expenses_review: ['admin', 'pharmacist'],
  reports: ['admin', 'pharmacist'],
  users: ['admin'],
  settings: ['admin'],
  void: ['admin', 'pharmacist'],
  verify_payment: ['admin', 'pharmacist', 'cashier'],
};

export const can = (role: Role | undefined, f: Feature) => !!role && MAP[f].includes(role);
export const isCourier = (role?: Role) => role === 'rider' || role === 'courier';
