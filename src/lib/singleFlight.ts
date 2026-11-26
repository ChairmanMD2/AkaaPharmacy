/**
 * Makes sure only one run of an async function is in flight at a time; callers that arrive
 * meanwhile share the running promise. The "busy" marker is ALWAYS cleared when the run ends,
 * whether it returned early, succeeded or threw, so one bad run can never block later ones.
 */
export function singleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let running: Promise<T> | null = null;
  return (...args: A) => {
    if (running) return running;
    const p = Promise.resolve().then(() => fn(...args));
    running = p;
    const clear = () => { if (running === p) running = null; };
    p.then(clear, clear);
    return p;
  };
}
