import { describe, expect, it } from 'vitest';
import { singleFlight } from './singleFlight';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('singleFlight (regression: a sync call made while offline used to block every later sync)', () => {
  it('lets a later call run after an earlier one returned early', async () => {
    let online = false; let runs = 0;
    const f = singleFlight(async () => { if (!online) return 'offline'; runs++; return 'synced'; });
    expect(await f()).toBe('offline');
    await tick();
    online = true;
    expect(await f()).toBe('synced');
    expect(runs).toBe(1);
  });

  it('shares one run between concurrent callers', async () => {
    let runs = 0;
    const f = singleFlight(async () => { runs++; await tick(); return runs; });
    const [a, b, c] = await Promise.all([f(), f(), f()]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
  });

  it('recovers after a failure', async () => {
    let fail = true;
    const f = singleFlight(async () => { if (fail) throw new Error('boom'); return 'ok'; });
    await expect(f()).rejects.toThrow('boom');
    fail = false;
    expect(await f()).toBe('ok');
  });

  it('allows a new run once the previous one has finished', async () => {
    let runs = 0;
    const f = singleFlight(async () => ++runs);
    expect(await f()).toBe(1);
    await tick();
    expect(await f()).toBe(2);
  });
});
