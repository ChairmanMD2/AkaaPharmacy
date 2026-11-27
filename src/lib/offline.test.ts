import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', async () => {
  const mod: any = { calls: [] as any[], mode: 'ok' as 'ok' | 'network' | 'reject' | 'duplicate' };
  const result = () => {
    if (mod.mode === 'network') return { error: { message: 'TypeError: Failed to fetch' } };
    if (mod.mode === 'reject') return { error: { message: 'new row violates row-level security policy', code: '42501' } };
    if (mod.mode === 'duplicate') return { error: { message: 'duplicate key', code: '23505' } };
    return { error: null };
  };
  const q: any = (table: string) => ({
    insert: (rows: any) => { mod.calls.push(['insert', table, rows]); return Promise.resolve(result()); },
    update: (patch: any) => ({ eq: (c: string, v: any) => { mod.calls.push(['update', table, patch, v]); return Promise.resolve(result()); }, in: () => ({ in: () => Promise.resolve(result()) }) }),
  });
  return {
    __mod: mod,
    supabase: { from: q, rpc: (fn: string, args: any) => { mod.calls.push(['rpc', fn, args]); return Promise.resolve(result()); } },
    isNetworkError: (e: any) => /failed to fetch/i.test(String(e?.message ?? e)),
    errMsg: (e: any) => e?.message ?? String(e),
  };
});

import * as supa from './supabase';
import { db } from './db';
import { enqueue, pushOutbox, runOrQueue, discardOp } from './outbox';
import { __setOnlineForTests } from './connectivity';
import { clearCache, getCache, putCache, setCacheScope } from './cache';

const mod = (supa as any).__mod;
beforeEach(async () => { await db.outbox.clear(); await db.cache.clear(); mod.calls.length = 0; mod.mode = 'ok'; __setOnlineForTests(true); });

describe('outbox: save now if online, otherwise queue and upload later', () => {
  it('sends immediately when online and nothing is waiting', async () => {
    const r = await runOrQueue('wish.add', { row: { id: 'w1', product_name: 'X' } }, 'Wish list: X');
    expect(r).toEqual({ queued: false });
    expect(mod.calls).toHaveLength(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('queues when offline, then uploads in order when the connection returns', async () => {
    __setOnlineForTests(false);
    expect((await runOrQueue('wish.add', { row: { id: 'w1' } }, 'one')).queued).toBe(true);
    expect((await runOrQueue('wish.add', { row: { id: 'w2' } }, 'two')).queued).toBe(true);
    expect(mod.calls).toHaveLength(0);
    __setOnlineForTests(true);
    const r = await pushOutbox();
    expect(r).toEqual({ sent: 2, failed: 0, offline: false });
    expect(mod.calls.map((c: any) => c[2].id)).toEqual(['w1', 'w2']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps order: a new save waits behind older queued items even when online', async () => {
    await enqueue('wish.add', { row: { id: 'old' } }, 'old');
    const r = await runOrQueue('wish.add', { row: { id: 'new' } }, 'new');
    expect(r.queued).toBe(true);
    expect(mod.calls).toHaveLength(0);
  });

  it('falls back to the queue when the network drops during the save', async () => {
    mod.mode = 'network';
    const r = await runOrQueue('expense.add', { rows: [{ id: 'e1' }] }, 'Expense');
    expect(r.queued).toBe(true);
    expect(await db.outbox.count()).toBe(1);
  });

  it('stops at a network failure and keeps everything pending', async () => {
    await enqueue('wish.add', { row: { id: 'a' } }, 'a'); await enqueue('wish.add', { row: { id: 'b' } }, 'b');
    mod.mode = 'network';
    const r = await pushOutbox();
    expect(r.offline).toBe(true);
    expect(await db.outbox.where('status').equals('pending').count()).toBe(2);
  });

  it('marks a server rejection as an error (with the reason) and carries on with the rest', async () => {
    await enqueue('wish.add', { row: { id: 'bad' } }, 'bad');
    mod.mode = 'reject';
    const r = await pushOutbox();
    expect(r.failed).toBe(1);
    const op = (await db.outbox.toArray())[0];
    expect(op.status).toBe('error');
    expect(op.error).toMatch(/row-level security/);
    await discardOp(op.id);
    expect(await db.outbox.count()).toBe(0);
  });

  it('treats a duplicate (already saved by an earlier attempt) as success, so a retry never double-saves', async () => {
    await enqueue('expense.add', { rows: [{ id: 'e1' }] }, 'Expense');
    mod.mode = 'duplicate';
    expect((await pushOutbox()).sent).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('server-side stock receipt carries its client id for idempotency', async () => {
    await enqueue('receipt.create', { receipt: { id: 'r1', items: [] } }, 'Receipt');
    await pushOutbox();
    expect(mod.calls[0]).toEqual(['rpc', 'receive_stock_invoice', { p_receipt: { id: 'r1', items: [] } }]);
  });
});

describe('read cache is private to each signed-in user', () => {
  it('returns what was saved for the same user only', async () => {
    setCacheScope('user-a'); await putCache('sales.list', [1, 2, 3]);
    expect((await getCache('sales.list'))?.data).toEqual([1, 2, 3]);
    setCacheScope('user-b');
    expect(await getCache('sales.list')).toBeNull();
    setCacheScope('user-a');
    expect((await getCache('sales.list'))?.data).toEqual([1, 2, 3]);
  });
  it('is wiped on sign-out', async () => {
    setCacheScope('user-a'); await putCache('k', { a: 1 }); await clearCache();
    expect(await getCache('k')).toBeNull();
  });
});

describe('the offline sales queue was renamed without losing old data', () => {
  it('exposes pending_sales and no longer has the old table', () => {
    expect(db.tables.map((t) => t.name)).toContain('pending_sales');
    expect(db.tables.map((t) => t.name)).not.toContain('pending');
  });
});
