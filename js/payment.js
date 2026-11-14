/* KL!KPIN — payment adapter (manual payments)
 *
 * The customer pays the shop directly (QR / bank / cash), uploads a screenshot, and the owner approves it in the admin.
 * Every call is a Supabase RPC (contract: docs/go-live-plan.md §1); the browser never decides an order is paid, it only
 * trusts `order_status`. Errors come back as ProviderError(code) with the RPC's error code.
 */
import { supabase } from './db.js';

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable: keep going in memory */ } },
};

export class ProviderError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const CODES = ['shop_closed', 'bad_method', 'bad_lines', 'unknown_pin', 'not_found', 'bad_state', 'proof_required', 'bad_proof'];
const NETWORK = new ProviderError('network', 'We could not reach the shop. Check your connection and try again.');

async function rpc(fn, args) {
  let res;
  try { res = await supabase().rpc(fn, args); } catch (e) { throw NETWORK; }
  const { data, error } = res;
  if (!error) return data;
  if (CODES.includes(error.message)) throw new ProviderError(error.message);
  // no PostgREST code = the request never got an answer
  if (!error.code || /fetch|network/i.test(error.message)) throw NETWORK;
  throw new ProviderError('error', 'Something went wrong. Please try again.');
}

// -> { problems: [{id, available}] } or { order_id, token, total_cents, method }
export const createOrder = (lines, methodId) => rpc('create_order', { lines: lines.map((l) => ({ pin_id: l.id, qty: l.qty })), method_id: methodId });
// -> { problems } | { status }
export const submitPayment = (orderId, token, proofPath) => rpc('submit_payment', { order_id: orderId, token, proof_path: proofPath || null });
// -> { status, reject_reason, order }
export const orderStatus = (orderId, token) => rpc('order_status', { order_id: orderId, token });
export const cancelOrder = (orderId, token) => rpc('cancel_order', { order_id: orderId, token });

// Shrinks a screenshot to max 1280 px on the long side as JPEG 0.75 (~100-200 KB, amounts and reference numbers stay
// readable). Throws ProviderError('bad_image') if the browser can't decode it (e.g. HEIC).
export async function compressImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { throw new ProviderError('bad_image'); }
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * k));
  cv.height = Math.max(1, Math.round(bmp.height * k));
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); // flatten transparent PNGs onto white, not black
  g.drawImage(bmp, 0, 0, cv.width, cv.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.75));
  if (!blob) throw new ProviderError('bad_image');
  return blob;
}

// Insert only (no upsert); the path must start with the order id. -> path
export async function uploadProof(orderId, blob) {
  const path = `${orderId}/${crypto.randomUUID()}.jpg`;
  let res;
  try { res = await supabase().storage.from('payment-proofs').upload(path, blob, { contentType: 'image/jpeg', upsert: false }); } catch (e) { throw NETWORK; }
  if (res.error) {
    if (/fetch|network/i.test(res.error.message)) throw NETWORK;
    throw new ProviderError('upload_failed', 'We could not upload your screenshot. Please try again.');
  }
  return path;
}
