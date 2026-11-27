import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { allocateFEFO, availableFromBatches } from './sync';
import { passwordProblem } from './password';
import { validateRow, normaliseCell } from './importRows';
import { can, isCourier } from './permissions';
import { daysUntil, monthRange, money, setCurrency } from './format';
import type { Batch } from './types';

const TODAY = '2026-11-26';
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(TODAY + 'T10:00:00Z')); });
afterAll(() => vi.useRealTimers());

const batch = (id: string, expiry: string, remaining: number, reserved = 0, drug = 'd1'): Batch =>
  ({ id, drug_id: drug, branch_id: 'b', batch_number: id, expiry_date: expiry, quantity_remaining: remaining, quantity_reserved: reserved });

describe('FEFO stock allocation', () => {
  const stock = [batch('late', '2028-01-01', 10), batch('early', '2027-01-01', 5), batch('other', '2026-12-01', 99, 0, 'd2')];

  it('takes from the earliest-expiring batch first', () => {
    expect(allocateFEFO(stock, 'd1', 3)).toEqual([{ batch_id: 'early', qty: 3 }]);
  });
  it('spills into the next batch when the first is not enough', () => {
    expect(allocateFEFO(stock, 'd1', 8)).toEqual([{ batch_id: 'early', qty: 5 }, { batch_id: 'late', qty: 3 }]);
  });
  it('never sells expired stock', () => {
    const s = [batch('expired', '2026-11-25', 50), batch('ok', '2027-06-01', 4)];
    expect(allocateFEFO(s, 'd1', 10)).toEqual([{ batch_id: 'ok', qty: 4 }]);
    expect(availableFromBatches(s, 'd1')).toBe(4);
  });
  it('treats a batch expiring today as still sellable', () => {
    expect(availableFromBatches([batch('t', TODAY, 7)], 'd1')).toBe(7);
  });
  it('does not touch reserved quantities', () => {
    const s = [batch('r', '2027-01-01', 10, 8)];
    expect(availableFromBatches(s, 'd1')).toBe(2);
    expect(allocateFEFO(s, 'd1', 5)).toEqual([{ batch_id: 'r', qty: 2 }]);
  });
  it('returns less than requested when stock is short (caller must handle it)', () => {
    expect(allocateFEFO(stock, 'd1', 100).reduce((s, a) => s + a.qty, 0)).toBe(15);
  });
  it('ignores other products', () => {
    expect(allocateFEFO(stock, 'nope', 1)).toEqual([]);
  });
});

describe('password rules', () => {
  it.each([
    ['short1', 'at least 10'],
    ['onlyletterspassword', 'letter and one number'],
    ['1234567890123', 'letter and one number'],
    ['aaaaaaaaaaaa', 'letter and one number'],
  ])('rejects %s', (pw, text) => { expect(passwordProblem(pw)).toContain(text); });
  it('accepts a decent password', () => { expect(passwordProblem('Brand-New-Pass-2026')).toBeNull(); });
});

describe('stock import validation', () => {
  const ok = { name: 'Paracetamol', selling_price: '250', batch_number: 'B1', expiry_date: '2027-08-31', quantity: '20', requires_prescription: 'no' };
  it('accepts a good row', () => { expect(validateRow(2, ok).errors).toEqual([]); });
  it('needs a name', () => { expect(validateRow(2, { ...ok, name: '' }).errors).toContain('name is required'); });
  it('rejects impossible dates and wrong formats', () => {
    expect(validateRow(2, { ...ok, expiry_date: '2027-02-31' }).errors.join()).toContain('expiry_date');
    expect(validateRow(2, { ...ok, expiry_date: '31/08/2027' }).errors.join()).toContain('expiry_date');
  });
  it('requires a batch when quantity or expiry is given', () => {
    expect(validateRow(2, { name: 'X', quantity: '5' }).errors.join()).toContain('batch_number');
  });
  it('allows a product with no batch at all', () => { expect(validateRow(2, { name: 'X', selling_price: '10' }).errors).toEqual([]); });
  it('rejects non-numeric prices and quantities', () => {
    expect(validateRow(2, { ...ok, selling_price: 'abc' }).errors.join()).toContain('selling_price');
    expect(validateRow(2, { ...ok, quantity: '2.5' }).errors.join()).toContain('quantity');
    expect(validateRow(2, { ...ok, quantity: '-3' }).errors.join()).toContain('quantity');
  });
  it('accepts yes/no flags in any case, rejects others', () => {
    expect(validateRow(2, { ...ok, requires_prescription: 'YES' }).errors).toEqual([]);
    expect(validateRow(2, { ...ok, requires_prescription: 'maybe' }).errors.join()).toContain('requires_prescription');
  });
  it('turns Excel date cells into ISO text', () => {
    expect(normaliseCell(new Date('2027-08-31T00:00:00Z'))).toBe('2027-08-31');
    expect(normaliseCell('  hello ')).toBe('hello');
    expect(normaliseCell(null)).toBe('');
  });
});

describe('permissions', () => {
  it('lets only admin manage users and settings', () => {
    expect(can('admin', 'users')).toBe(true);
    for (const r of ['pharmacist', 'cashier', 'inventory_officer', 'rider', 'courier'] as const) {
      expect(can(r, 'users')).toBe(false);
      expect(can(r, 'settings')).toBe(false);
    }
  });
  it('keeps couriers and riders away from stock, sales and money', () => {
    for (const f of ['pos', 'inventory', 'sales', 'orders', 'wishlist', 'expenses', 'reports', 'dashboard'] as const) {
      expect(can('rider', f)).toBe(false);
      expect(can('courier', f)).toBe(false);
    }
    expect(can('rider', 'deliveries')).toBe(true);
    expect(isCourier('courier')).toBe(true);
    expect(isCourier('cashier')).toBe(false);
  });
  it('limits stock writing, voiding and expense review to the right roles', () => {
    expect(can('cashier', 'inventory_write')).toBe(false);
    expect(can('cashier', 'void')).toBe(false);
    expect(can('cashier', 'expenses_review')).toBe(false);
    expect(can('inventory_officer', 'inventory_write')).toBe(true);
    expect(can('pharmacist', 'void')).toBe(true);
    expect(can(undefined, 'dashboard')).toBe(false);
  });
});

describe('local date handling', () => {
  it('uses the device local date, not UTC (Nigeria is UTC+1)', async () => {
    const { todayISO } = await import('./format');
    vi.setSystemTime(new Date(2026, 10, 27, 0, 30, 0)); // 00:30 local on 27 Nov, whatever the machine timezone
    expect(todayISO()).toBe('2026-11-27');
    vi.setSystemTime(new Date(TODAY + 'T10:00:00Z'));
  });
});

describe('format helpers', () => {
  it('formats naira with grouping', () => { setCurrency('₦'); expect(money(1234567.5)).toBe('₦1,234,567.5'); expect(money(null)).toBe('₦0'); });
  it('computes day differences', () => { expect(daysUntil('2026-11-27')).toBe(1); expect(daysUntil(TODAY)).toBe(0); expect(daysUntil('2026-11-20')).toBe(-6); });
  it('finds month ends, including leap years', () => {
    expect(monthRange('2026-11')).toEqual(['2026-11-01', '2026-11-30']);
    expect(monthRange('2028-02')).toEqual(['2028-02-01', '2028-02-29']);
    expect(monthRange('2027-02')).toEqual(['2027-02-01', '2027-02-28']);
  });
});

import { applyReceiptToBatches } from './receiptLocal';
describe('stock received offline is sellable straight away', () => {
  const base: Batch[] = [batch('b1', '2027-06-01', 10)];
  const r = (items: any[]) => ({ id: 'rcpt1', branch_id: 'b', items });
  it('adds to an existing batch with the same number (case-insensitive)', () => {
    const out = applyReceiptToBatches(base, r([{ drug_id: 'd1', batch_number: 'B1', expiry_date: '2027-06-01', quantity: 5 }]));
    expect(out).toHaveLength(1); expect(out[0].quantity_remaining).toBe(15);
  });
  it('creates a temporary batch for a new batch number, and leaves the input untouched', () => {
    const out = applyReceiptToBatches(base, r([{ drug_id: 'd1', batch_number: 'NEW', expiry_date: '2028-01-01', quantity: 7 }]));
    expect(out).toHaveLength(2); expect(out[1].id).toBe('local:rcpt1:0'); expect(out[1].quantity_remaining).toBe(7);
    expect(base[0].quantity_remaining).toBe(10); expect(base).toHaveLength(1);
  });
  it('then sells earliest-expiry first, including the new stock', () => {
    const out = applyReceiptToBatches(base, r([{ drug_id: 'd1', batch_number: 'NEW', expiry_date: '2026-12-15', quantity: 4 }]));
    expect(allocateFEFO(out, 'd1', 6)).toEqual([{ batch_id: 'local:rcpt1:0', qty: 4 }, { batch_id: 'b1', qty: 2 }]);
  });
});
