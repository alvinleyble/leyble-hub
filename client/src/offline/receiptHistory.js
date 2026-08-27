import { nativeStore } from './nativeStore';
import { RECEIPT_PREFIX, receiptKey } from './keys';

// D9 — each tablet remembers the last 30 days of receipts, so History and reprint work
// while blind. Piece 1 owns the store; piece 2 fills it from the POS save path and
// from the quiet refresh, and reads it back for reprint.
//
// One key per receipt (see nativeStore.js on why): a day's trading rewrites only the
// receipts of that day, and an interrupted write can cost at most one record.

export const RETENTION_DAYS = 30;

export async function putReceipt(receipt) {
  if (!receipt?.receipt_number) {
    throw new Error('putReceipt: a locally held receipt needs its receipt_number');
  }
  await nativeStore.setJson(receiptKey(receipt.receipt_number), receipt);
}

export async function getReceipt(receiptNumber) {
  return nativeStore.getJson(receiptKey(receiptNumber));
}

// Newest first, matching how History reads.
export async function listReceipts() {
  const keys = await nativeStore.keysWithPrefix(RECEIPT_PREFIX);
  const receipts = [];
  for (const key of keys) {
    const receipt = await nativeStore.getJson(key);
    if (receipt) receipts.push(receipt);
  }
  return receipts.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export async function removeReceipt(receiptNumber) {
  await nativeStore.remove(receiptKey(receiptNumber));
}

/**
 * Drop receipts older than the retention window.
 *
 * `created_at` is the device's sale time (D5), which is what the owners would call the
 * receipt's date — so the window matches the paper. A receipt with no usable date is
 * KEPT: dropping a record because its date is unreadable is the silent loss this
 * release exists to prevent.
 */
export async function pruneReceipts({ now = Date.now(), days = RETENTION_DAYS } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const receipts = await listReceipts();
  let pruned = 0;
  for (const receipt of receipts) {
    const at = Date.parse(receipt.created_at);
    if (Number.isFinite(at) && at < cutoff) {
      await removeReceipt(receipt.receipt_number);
      pruned++;
    }
  }
  return pruned;
}
