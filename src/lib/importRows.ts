/** Stock-import helpers (kept separate from the UI so they can be unit-tested). */
export const COLS = ['name', 'generic_name', 'category', 'nafdac_number', 'barcode', 'unit_type', 'cost_price', 'selling_price', 'wholesale_price', 'reorder_level', 'requires_prescription', 'batch_number', 'expiry_date', 'quantity'];
export const SAMPLE = ['Amoxicillin 500mg Capsules', 'Amoxicillin', 'Antibiotics', 'A4-1234', '6151100012345', 'Pack', '1200', '1800', '1500', '20', 'yes', 'BTX-2026A', '2027-08-31', '45'];

export interface ImpRow { n: number; data: Record<string, string>; errors: string[] }

export function normaliseCell(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2027-02-31 etc.
}

export function validateRow(n: number, data: Record<string, string>): ImpRow {
  const errors: string[] = [];
  if (!data.name) errors.push('name is required');
  ['cost_price', 'selling_price', 'wholesale_price'].forEach((k) => { if (data[k] && !(Number(data[k]) >= 0)) errors.push(`${k} must be a number`); });
  if (data.reorder_level && !/^\d+$/.test(data.reorder_level)) errors.push('reorder_level must be a whole number');
  if (data.requires_prescription && !/^(yes|no|y|n|true|false|1|0)$/i.test(data.requires_prescription)) errors.push('requires_prescription must be yes or no');
  if (data.batch_number) {
    if (!isRealDate(data.expiry_date || '')) errors.push('expiry_date must be a real date in YYYY-MM-DD format');
    if (!/^\d+$/.test(data.quantity || '')) errors.push('quantity must be a whole number');
  } else if (data.quantity || data.expiry_date) errors.push('batch_number is required with quantity / expiry');
  return { n, data, errors };
}
