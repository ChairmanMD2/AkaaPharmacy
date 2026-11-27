import { describe, expect, it, vi } from 'vitest';
import { createScanDetector, findByBarcode } from './scanner';
import { changeOf, summarizeWaiting } from './localSales';
import { createDebouncer } from './realtime';
import type { PendingSale } from './types';

const type = (det: ReturnType<typeof createScanDetector>, text: string, start: number, gap: number, enter = true) => {
  let t = start, out: string | null = null;
  for (const ch of text) { det.key(ch, t); t += gap; }
  if (enter) out = det.key('Enter', t);
  return out;
};

describe('scan detector', () => {
  it('accepts a fast burst ending with Enter as a scan', () => {
    expect(type(createScanDetector(), '6151100012345', 1000, 8)).toBe('6151100012345');
  });
  it('does not treat normal typing speed as a scan', () => {
    expect(type(createScanDetector(), '6151100012345', 1000, 140)).toBeNull();
  });
  it('ignores a short fast entry (fewer than 4 characters)', () => {
    expect(type(createScanDetector(), '12', 1000, 8)).toBeNull();
  });
  it('a pause starts a new code, so earlier stray keys do not stick to the scan', () => {
    const d = createScanDetector();
    d.key('x', 100); d.key('y', 220);                       // a person typed two letters, then paused
    expect(type(d, '5000123456789', 2000, 10)).toBe('5000123456789');
  });
  it('ignores modifier keys inside a burst', () => {
    const d = createScanDetector();
    d.key('1', 10); d.key('Shift', 14); d.key('2', 18); d.key('3', 22); d.key('4', 26); d.key('5', 30);
    expect(d.key('Enter', 34)).toBe('12345');
  });
});

describe('barcode matching', () => {
  const items = [{ id: 1, barcode: '0123456789012' }, { id: 2, barcode: '6151100012345' }, { id: 3, barcode: null }];
  it('matches exactly', () => expect(findByBarcode(items, '6151100012345')?.id).toBe(2));
  it('matches when a scanner drops the leading zero', () => expect(findByBarcode(items, '123456789012')?.id).toBe(1));
  it('returns nothing for unknown codes', () => expect(findByBarcode(items, '999999999')).toBeUndefined());
});

describe('waiting sales arithmetic (matches the server cash-up)', () => {
  const sale = (total: number, payments: { method: any; amount: number }[]) => ({ total, payments } as unknown as PendingSale);
  it('counts cash received and change', () => {
    const a = sale(850, [{ method: 'cash', amount: 1000 }]);
    const b = sale(500, [{ method: 'transfer', amount: 500 }]);
    expect(changeOf(a)).toBe(150);
    const s = summarizeWaiting([a, b]);
    expect(s).toMatchObject({ count: 2, total: 1350, cash_received: 1000, change_given: 150 });
    expect(s.by_method.transfer).toBe(500);
  });
});

describe('debouncer', () => {
  it('runs once after a burst of events', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(fn, 1000);
    d(); d(); d();
    vi.advanceTimersByTime(999); expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2); expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
