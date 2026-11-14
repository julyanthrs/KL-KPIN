# Go-live plan: real payments + connected admin

Decisions (from the owner, 2026-11-14):
- **Payments: manual.** Customer pays to the shop's GCash/bank (QR or account number), uploads a screenshot, the owner approves it in the admin. No gateway. Demo mode (the `checkout` edge function, `DEMO_PAYMENTS`, the demo-outcome dropdown) is removed.
- **Admin:** <https://github.com/julyanthrs/KL-KPIN-Admin> (cloned at `../KL-KPIN-Admin`), today localStorage-only, is connected to the same Supabase project (`klikpin`, ref `tdpsympwcmwhcedxstgn`). Its passcode lock becomes a real Supabase Auth login.
- **Publishing:** both repos get a `go-live` branch pushed + a PR; the owner merges, Vercel (klikpin.vercel.app, klikpin-admin.vercel.app) redeploys. Public Supabase URL + publishable key go in a committed `.env.production` (they are public by design; RLS protects the data).

## 1. Database (new migration `supabase/migrations/20261114000000_manual_payments.sql`)

Additive on top of `20260101000000_init.sql`; the 2 existing paid orders must survive. Never `db reset`.

### Admins
- `admins(user_id uuid pk references auth.users on delete cascade)`, RLS on, policy: a user can select their own row.
- `is_admin() returns boolean` — `security definer stable`, `exists(select 1 from admins where user_id = auth.uid())`.
- The owner's account is created in the Supabase dashboard (Authentication → Add user); a row is then inserted into `admins` by hand. No sign-up UI anywhere.

### Pins (visuals + pictures)
Add columns: `art text` (built-in art key from pins.js `ART`, null = use `id`), `bg text`, `pat text`, `pat_color text`, `image_url text` (public URL in bucket `pin-images`), `removed boolean not null default false`, `created_at timestamptz not null default now()`.
- `active` = shown in the shop (admin "hidden" = `not active`). `removed` = deleted in the admin; row kept for order history; admin can bring it back.
- Backfill `bg/pat/pat_color` for the 20 seeded pins from `VISUALS` in `js/pins.js` (`VISUALS[id] = { bg, pat: [name, color] }`). Update `seed.sql` the same way.
- Replace the public read policy: anon/authenticated read `active and not removed`. Admin policy: `for all` when `is_admin()`.

### Settings (one row)
`settings(id int pk default 1 check (id = 1), open boolean not null default true, closed_msg text not null default 'Taking a little break. Back soon ♡', order_prefix text not null default 'KP-' check (order_prefix ~ '^[A-Z0-9]{1,6}-$'), max_per_pin int not null default 5 check (max_per_pin between 1 and 50), low_at int not null default 3 check (low_at between 0 and 50), restock_by int not null default 10 check (restock_by between 1 and 100), receipt jsonb not null default '{"name":"KL!KPIN","place":"","contact":"","note":"Thanks for popping by the machine!"}')`. Insert the one row. Anon read; admin update.

### Payment methods
`pay_methods(id text pk, kind text not null check (kind in ('qr','bank','card','cash','other')), name text not null, note text not null default '', acc_name text not null default '', acc_no text not null default '', qr_url text, active boolean not null default false, sort int not null default 0, created_at timestamptz not null default now())`. Anon read `active` rows; admin `for all`. **No seed rows**: until the owner adds one, the shop says payments aren't set up and blocks checkout.

### Orders
- Add: `method_id text`, `method_name text`, `claim_token text not null default encode(gen_random_bytes(16),'hex')` (needs `pgcrypto`, `extensions.` schema on hosted), `proof_path text`, `proof_at timestamptz`, `reject_reason text`, `decided_at timestamptz`, `packed_at timestamptz`, `collected_at timestamptz`, `refunded_at timestamptz`. Keep `method` (= the method's kind) and `provider_intent_id` (unused).
- Status set becomes: `pending` (created, not paid) → `submitted` (customer says paid, proof uploaded, stock taken) → `paid` (owner approved) → `packed` → `collected`; side states `rejected` (owner rejected, stock given back, customer may re-upload), `cancelled`, `refunded`, `needs_refund` (customer paid but stock ran out). Migrate any `failed` rows to `cancelled`, then swap the check constraint.
- `order_lines.qty` check becomes `qty >= 1` (the max comes from `settings.max_per_pin`, enforced in `create_order`).
- RLS: admin `select` + `update` on `orders`, `select` on `order_lines`. Anon: nothing (unchanged). Status changes go through the RPCs below, never raw updates from the UI (raw update is only for `proof_path` when the admin attaches a proof).

### Drop
`create_order(jsonb, text, text)` and `mark_order_paid(text, text)`.

### Customer RPCs — `security definer`, `set search_path = public`, granted to `anon, authenticated`
Errors are `raise exception '<code>'` with these codes as the message (the client maps them): `shop_closed`, `bad_method`, `bad_lines`, `unknown_pin`, `not_found`, `bad_state`, `proof_required`, `bad_proof`.

1. `create_order(lines jsonb, method_id text, cust_name text, cust_phone text, cust_address text) returns jsonb` (name 2-80 chars, phone 7-15 digits, address 8-300 chars, else `bad_customer`; stored in `orders.cust_*`, added by migration 20261114120000)
   - `settings.open` false → `shop_closed`. Method missing/inactive → `bad_method`.
   - `lines` = `[{pin_id, qty}]`, same validation as today (non-empty array, integer qty, no duplicates) but qty max = `settings.max_per_pin` → `bad_lines`; unknown/inactive/removed pin → `unknown_pin`.
   - Stock short → `{ "problems": [{id, available}] }` (no order created). Stock is **not** taken here.
   - Else insert a `pending` order with id `settings.order_prefix || 5 random [A-Z0-9]` (unique), `method = kind`, `method_id`, `method_name`, server-computed `total_cents`, and lines. Return `{ order_id, token, total_cents, method: { id, kind, name, note, acc_name, acc_no, qr_url } }`.
2. `submit_payment(order_id text, token text, proof_path text default null) returns jsonb`
   - Order+token must match → else `not_found`. Status must be `pending` or `rejected` → else `bad_state`.
   - Method kind `cash`: proof optional. Others: `proof_path` required (`proof_required`), must start with `order_id || '/'` and exist in `storage.objects` (bucket `payment-proofs`) → else `bad_proof`.
   - Lock the order's pins (in id order). Any `stock < qty`: kind `cash` → return `{ problems }` and stay `pending`; otherwise set `needs_refund` and return `{ status: 'needs_refund' }`.
   - Else take the stock, set `submitted`, `proof_path`, `proof_at = now()`, `reject_reason = null`. Return `{ status: 'submitted' }`.
3. `order_status(order_id text, token text) returns jsonb` → `not_found` on mismatch, else `{ status, reject_reason, order: { order_id, method_name, method, total_cents, currency, created_at, paid_at, lines: [{pin_id, name, qty, unit_price_cents}] } }`.
4. `cancel_order(order_id text, token text) returns jsonb` → only from `pending` (else returns the current status unchanged) → `cancelled`. Returns `{ status }`.

### Admin RPCs — `security definer`, granted to `authenticated`, first line `if not is_admin() then raise exception 'forbidden'; end if;`
- `approve_order(order_id text)`: `submitted` → `paid`, `paid_at`, `decided_at`. Other states → `bad_state`.
- `reject_order(order_id text, reason text)`: `submitted` → `rejected`, give the stock back, `reject_reason`, `decided_at`.
- `set_order_status(order_id text, status text)`: allowed moves `paid→packed`, `packed→paid` (undo), `packed→collected`, `collected→packed` (undo), and `submitted|paid|packed|collected|needs_refund → refunded`. Refund gives stock back only from `submitted|paid|packed`. Sets the matching `*_at`. Anything else → `bad_state`.
- `adjust_stock(pin_id text, delta int) returns int`: `stock = greatest(0, stock + delta)`, returns the new stock (the admin's +/- and restock buttons use this so they don't clobber concurrent sales; typing an exact number is a plain update).

### Storage (buckets already exist on the hosted project; upsert their settings, `drop policy if exists` then create)
- `pin-images`: public, 3 MB, png/jpeg/webp/gif. Admin insert/update/delete. Used for `pins/<pin-id>-<timestamp>.<ext>` and `qr/<method-id>-<timestamp>.<ext>`.
- `payment-proofs`: private, 5 MB, png/jpeg/webp. Anon+authenticated **insert** only when `proof_upload_ok(name)` — a `security definer` function: the first path segment is an order in `pending` or `rejected`. Admin select/insert/delete.

### Also
- Delete `supabase/functions/checkout/`, `supabase/functions/.env.example`, and the `[functions.checkout]` block in `config.toml`. On the hosted project: `supabase functions delete checkout` and `supabase secrets unset DEMO_PAYMENTS` (done by the lead, not by sub-agents).

## 2. Shop (`KL-PIN`, files `js/*`, `index.html`, `css/styles.css`)

- `db.js`: one `loadShop()` → `{ categories, pins, settings, methods }`. Pins carry `art`, `bg`, `pat: [pat, pat_color]`, `img` (= `image_url`) from the DB, falling back to `VISUALS`/`ART` when null. Hide a pin only if it has no `img` and no art for its art key.
- `pins.js`: `pinSVG` draws `p.img` as an `<image>` like the admin's pins.js does, and uses `ART[p.art || p.id]`.
- Per-pin max = `settings.max_per_pin` (replace the `MAX_PER_PIN` constant everywhere).
- `settings.open === false`: browsing works, checkout is blocked, the LCD and the confirm step show `closed_msg`. No active methods: checkout blocked with "Payments aren't set up yet".
- `payment.js` → thin client over `supabase().rpc(...)` and `supabase().storage.from('payment-proofs').upload(...)`. Map RPC error codes to `ProviderError(code)`; network failure → `ProviderError('network')`.
- Payment modal flow (reuse `renderPay`, persisted `S.checkout`, resume-after-refresh):
  1. **select**: list the active methods from the DB (name + kind icon, in `sort` order).
  2. `create_order` → **instructions**: order number, total, the method's QR picture (big, tappable to enlarge) and/or account name + number with a Copy button, the note, then "Upload your payment screenshot" (file input `accept="image/*"`, preview, change). Compress in the browser to max 1280 px long side, JPEG 0.75, upload to `payment-proofs/<order_id>/<random>.jpg`, then `submit_payment`. Cash kind: no upload; button "Reserve, I'll pay at the stall" calls `submit_payment` without a proof. Cancel → `cancel_order`.
  3. **waiting**: "Payment sent! The shop is checking it." with the order number; poll `order_status` every 5 s while the page is visible (stop when hidden, resume on visibility); the customer may close the page and come back on the same browser.
  4. `paid` → existing `onPaid` (pins drop, receipt). `rejected` → show `reject_reason` and let them upload again (back to step 2 for the same order). `needs_refund` → "Sorry, a pin sold out while you were paying. The shop will refund you." `cancelled` → back to the receipt.
- Remove: the demo-outcome dropdown (`#demoOutcome`) and `setOutcome/getOutcome`, the "Demo Pay · sandbox" label, the old `create/complete/verify` calls.
- Receipt PNG shows `method_name`; it's only offered once the order is `paid`.

## 3. Admin (`../KL-KPIN-Admin`)

- `npm i @supabase/supabase-js`; `js/db.js` client like the shop's; `.env.example` + committed `.env.production` with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values as the shop) and `VITE_SHOP_URL=https://klikpin.vercel.app/`.
- **Login**: the passcode screen becomes email + password (`signInWithPassword`), session restored on load, signed-in non-admins see "This account isn't an admin" + Sign out. The lock button signs out. Remove the passcode change sheet and `klikpin_admin_pass`.
- **Data from the DB** after sign-in: categories, pins (all, incl. hidden and removed), settings, pay_methods, orders + lines. Each edit writes to the DB; on error toast and reload from the DB. Pins.js stops reading localStorage (`KP.load()` builds from DB rows).
- Pins: create/update/soft-delete (`removed=true`) / bring back; stock buttons call `adjust_stock`; pictures upload to `pin-images` (keep the 240 px shrink) and save the public URL. Categories: CRUD + sort; removing one with pins moves them first, then deletes the row.
- Payment methods: CRUD, on/off, QR upload to `pin-images/qr/...`. No default methods when the table is empty (empty state instead).
- Orders: statuses `submitted` "To check", `paid` "To pack", `packed`, `collected`, `rejected`, `refunded`, `needs_refund` "Refund needed"; `pending`/`cancelled` hidden by default (filter). "To check" orders show the proof (signed URL, 1 h) big with **Approve** / **Reject (reason)**. Pack/collect/undo/refund via `set_order_status`. Attach proof from the admin uploads to `payment-proofs/<order>/admin-<ts>.jpg` and updates `proof_path`. Revenue counts `paid|packed|collected` only.
- New orders: poll every 20 s while signed in; a new `submitted` order plays the existing new-order sound / desktop notification and bumps a badge.
- Settings: `open`, `closed_msg`, `max_per_pin`, `low_at`, `restock_by`, `order_prefix`, `receipt` go to the `settings` row. Sound, alert, notify, theme, calm stay in localStorage (per browser). Remove `requireProof` (the shop always asks for a proof except cash).
- Remove: sample orders (sprinkle / clear samples), demo outcome, demo provider intents and "payment attempts", Restore from backup, Reset every pin, Clear all orders. Keep Download (exports what's loaded).
- README: replace the localStorage/connecting sections with the Supabase setup and how to make an admin.

## 4. Testing (lead, after the sub-agents)
- Backend script against hosted: anon create/submit/status/cancel; RLS (anon can't read orders/admins, can't write pins/settings/methods, can't call admin RPCs); storage policy (no upload for unknown or submitted orders); stock taken at submit, given back on reject/refund; `needs_refund`; shop closed; inactive method; qty above `max_per_pin`; admin RPCs with a throwaway test admin (only with the owner's OK), deleted afterwards.
- Browser: shop full flow with a real image upload → admin approve → shop drops the pins; reject → re-upload; closed shop; no methods; phone width.
- Clean up test orders, proof files and the test admin; stock back to before.

## 5. Owner steps (can't be done for you)
1. Supabase dashboard → Authentication → Users → **Add user** (your email + password, auto-confirm). Tell me the email; I add it to `admins`.
2. Optional: Authentication → Sign In / Providers → Email → turn off **Allow new users to sign up** (nobody can then create accounts with the public key; harmless either way since only `admins` rows get access).
3. In the admin: add your GCash / bank methods with QR pictures, turn them on.
4. Merge the two `go-live` PRs.
