import type { Batch } from './types';

export interface ReceiptItemInput { drug_id: string; batch_number: string; expiry_date: string; quantity: number }
export interface ReceiptInput { id: string; branch_id: string; items: ReceiptItemInput[] }

/**
 * Adds the goods of a stock receipt to a list of local batches (same drug + batch number = add to that batch,
 * otherwise a temporary batch is created). Used so stock received while offline is sellable immediately, and
 * re-applied after a catalogue refresh while the receipt is still waiting to upload. The temporary batch
 * disappears once the receipt reaches the server and the real batches are downloaded.
 */
export function applyReceiptToBatches(batches: Batch[], receipt: ReceiptInput): Batch[] {
  const out = batches.map((b) => ({ ...b }));
  receipt.items.forEach((it, i) => {
    const hit = out.find((b) => b.drug_id === it.drug_id && b.branch_id === receipt.branch_id && b.batch_number.toLowerCase() === it.batch_number.trim().toLowerCase());
    if (hit) {
      hit.quantity_remaining += it.quantity;
      hit.expiry_date = it.expiry_date;
    } else {
      out.push({
        id: `local:${receipt.id}:${i}`, drug_id: it.drug_id, branch_id: receipt.branch_id, batch_number: it.batch_number.trim(),
        expiry_date: it.expiry_date, quantity_remaining: it.quantity, quantity_reserved: 0,
      });
    }
  });
  return out;
}
