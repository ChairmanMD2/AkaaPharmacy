export type Role = 'admin' | 'pharmacist' | 'cashier' | 'inventory_officer' | 'courier' | 'rider' | 'customer';

export interface Profile {
  id: string;
  full_name: string;
  email?: string | null;
  phone: string | null;
  role: Role;
  branch_id: string | null;
  is_active: boolean;
}

export interface Drug {
  id: string;
  name: string;
  generic_name: string | null;
  category: string | null;
  nafdac_number: string | null;
  barcode: string | null;
  unit_type: string;
  selling_price: number;
  wholesale_price: number | null;
  requires_prescription: boolean;
  reorder_level: number;
  is_active: boolean;
}

export interface Batch {
  id: string;
  drug_id: string;
  branch_id: string;
  batch_number: string;
  expiry_date: string; // YYYY-MM-DD
  quantity_remaining: number;
  quantity_reserved: number;
}

export type PayMethod = 'cash' | 'card' | 'transfer' | 'pos_terminal' | 'paystack' | 'other';

export interface PendingSale {
  id: string;
  local_ref: string;
  branch_id: string;
  sold_at: string;
  created_at: string;
  cashier_name: string;
  cashier_id?: string;
  customer_name?: string;
  notes?: string;
  items: { drug_id: string; name: string; quantity: number; unit_price: number }[];
  discount: number;
  subtotal: number;
  total: number;
  payments: { method: PayMethod; amount: number; reference?: string }[];
  alloc: { batch_id: string; qty: number }[];
  status: 'pending' | 'syncing' | 'synced' | 'error';
  error?: string;
  attempts: number;
  receipt_no?: string;
  needs_review?: boolean;
}

export type Row = Record<string, any>;

export const PAY_LABEL: Record<PayMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  transfer: 'Bank transfer',
  pos_terminal: 'POS terminal',
  paystack: 'Paystack',
  other: 'Other',
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
  inventory_officer: 'Inventory officer',
  courier: 'Courier',
  rider: 'Rider',
  customer: 'Customer',
};
