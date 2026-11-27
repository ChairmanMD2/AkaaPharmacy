import { db, getMeta, setMeta } from './db';
import { uid } from './format';

/** Invoice numbers are made on the device (so they work offline): INV-<device>-<yymmdd>-<counter>. */
export async function nextInvoiceNo(): Promise<string> {
  let dev = await getMeta<string>('device_code');
  if (!dev) { dev = uid().slice(0, 3).toUpperCase(); await setMeta('device_code', dev); }
  return db.transaction('rw', db.meta, async () => {
    const n = ((await getMeta<number>('invoice_counter')) ?? 0) + 1;
    await setMeta('invoice_counter', n);
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `INV-${dev}-${ymd}-${String(n).padStart(4, '0')}`;
  });
}

/** Hand-off from the Wish List invoice to the point of sale (survives the page change, not a browser restart). */
export interface PosPrefill { customer?: string; phone?: string; lines: { drug_id: string; qty: number }[]; wishIds: string[]; invoiceNo: string }
const KEY = 'akaa_pos_prefill';
export const savePrefill = (p: PosPrefill) => sessionStorage.setItem(KEY, JSON.stringify(p));
export function takePrefill(): PosPrefill | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (!v) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(v) as PosPrefill;
  } catch { return null; }
}

/** Carts put on hold at the counter ("park this customer, serve the next one"). Stored on the device, so it works offline. */
export interface HeldCart { id: string; at: string; customer: string; lines: { drug_id: string; qty: number; price: number }[] }
const HELD = 'held_carts';
export const getHeld = async () => (await getMeta<HeldCart[]>(HELD)) ?? [];
export const putHeld = (list: HeldCart[]) => setMeta(HELD, list);
