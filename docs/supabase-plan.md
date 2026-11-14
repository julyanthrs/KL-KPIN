# Plan: move KL!KPIN data to Supabase

Status: **implemented, then partly replaced.** The `checkout` edge function and demo payments described here were removed when the shop went live with manual (screenshot) payments; see [go-live-plan.md](go-live-plan.md) for the current design.

## Goal

Today everything is fake and local: the catalog is hard-coded in `js/pins.js`, stock is a static number, orders go to `localStorage` (`klikpin_orders`), and the order ID is made up in the browser. With Supabase, the catalog, stock and orders live in Postgres, and stock is checked and taken off **on the server**, so two customers can't buy the last pin.

The demo payment provider (`DemoPay`) stays for now. A real provider (e.g. PayMongo) is a later phase.

## What moves to the database, and what stays in code

| Data | Where | Why |
|---|---|---|
| Categories (id, name, icon, sort) | DB | shop can edit without a deploy |
| Pins: id, category, name, price, stock, sort, active | DB | prices and stock are the real business data |
| Pin artwork (`ART[id]`, `bg`, `pat`) | **stays in `pins.js`** | the art is code. Linked to the DB by `id`; a DB pin with no art entry is hidden |
| Orders + order lines | DB | real order records instead of localStorage |
| Cart, checkout progress, mute | stays in localStorage | per-browser state, no reason to sync |
| Analytics (`dataLayer`) | unchanged | out of scope |

Admin editing is done in the Supabase dashboard (Table Editor). No admin UI.

## Schema (`supabase/migrations/0001_init.sql`)

```sql
create table categories (
  id    text primary key,          -- 'animals', 'food', … ('all' stays a client-only tab)
  name  text not null,
  icon  text not null,             -- key into ART in pins.js
  sort  int  not null default 0
);

create table pins (
  id           text primary key,   -- must match ART key in pins.js ('puppy', 'cat', …)
  category_id  text not null references categories(id),
  name         text not null,
  price_cents  int  not null check (price_cents >= 0),  -- ₱60 = 6000 (payment providers use centavos)
  stock        int  not null check (stock >= 0),
  sort         int  not null default 0,                 -- order in the "All" tab, drives the A1/B2 code
  active       boolean not null default true
);

create table orders (
  id                  text primary key,                 -- 'KP-XXXXX', generated on the server
  status              text not null default 'pending'
                      check (status in ('pending','paid','failed','cancelled','needs_refund')),
  method              text,
  total_cents         int  not null,
  currency            text not null default 'PHP',
  provider_intent_id  text unique,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);

create table order_lines (
  order_id          text not null references orders(id) on delete cascade,
  pin_id            text not null references pins(id),
  name              text not null,     -- copied at order time, so renames don't change old receipts
  unit_price_cents  int  not null,
  qty               int  not null check (qty between 1 and 5),   -- MAX_PER_PIN
  primary key (order_id, pin_id)
);
```

`supabase/seed.sql` holds the current 6 categories and 20 pins from `pins.js`, with prices ×100.

### Row-level security

- `categories`, `pins`: RLS on, **public `select` only** (`active = true` for pins).
- `orders`, `order_lines`: RLS on, **no anon policies at all**. The browser never reads or writes them directly; only the server functions below do, using the service role.

The anon key in the browser can therefore only read the catalog.

### Server logic (Postgres functions, called through RPC)

Prices and totals are **always recalculated on the server** from `pins.price_cents`. The browser only sends `{pin_id, qty}`.

1. `create_order(lines jsonb, method text) returns jsonb` — `security definer`
   - locks the pin rows (`select … for update`) and checks stock for each line
   - if any line is short, returns `{ problems: [{id, available}] }` (same shape as today's `checkInventory`, so `applyStockProblems` keeps working) and writes nothing
   - otherwise inserts an `orders` row (`pending`, server-made `KP-` ID, server total) plus its `order_lines`, and returns `{ order_id, total_cents }`
2. `mark_order_paid(order_id text, intent_id text) returns jsonb` — `security definer`
   - in one transaction: locks the pins, decrements stock, sets `status = 'paid'` and `paid_at`
   - if stock ran out between create and pay (a race), sets `needs_refund` instead and returns that, so the UI can say so
   - **not callable by anon** (`revoke execute … from anon`); only the verify step on the server calls it

**Why stock is taken at payment, not at order creation:** reserving at creation would need expiry and cleanup jobs for abandoned carts. For a small shop, taking stock on verified payment plus the `needs_refund` fallback is enough. Reserving stock is a later upgrade if races actually happen.

### Where payment verification runs

Today `DemoPay.verify` runs in the browser, so anyone could call "mark paid". Two options:

- **A (recommended for now):** one Supabase Edge Function, `checkout`, with routes `create` and `verify`. It still simulates the provider (keeping the demo outcome switch), but calls `mark_order_paid` with the service role. This gives the same shape as the real-provider phase, so phase 3 only swaps the provider inside it.
- **B (cheaper, demo only):** keep `DemoPay` in the browser and let anon call `mark_order_paid`. That is insecure: anyone could mark orders paid. Only acceptable while the site isn't live.

## Client changes

1. **Dependency and config**
   - `npm i @supabase/supabase-js`
   - `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   - commit an `.env.example`
   - add `.env*.local` to `.gitignore`
2. **Turn the scripts into real ES modules.** They're already loaded with `type="module"` but talk through `window.KP_*`. `supabase-js` needs `import`, and catalog loading becomes async, so:
   - `pins.js` exports `ART`, `pinSVG`, `iconSVG`, `face` and `MAX_PER_PIN`
   - `payment.js` exports its API
   - `app.js` imports them
   - the IIFE wrappers and the `window.KP_*` globals are removed
3. **New `js/db.js`**
   - creates the client
   - `loadCatalog()`: selects categories and active pins in `sort` order, keeps only pins that have an `ART` entry, attaches `bg`/`pat` from `pins.js`, derives `code` from position, and converts `price_cents` to pesos for the existing `money()`
   - Keeping the client in pesos means the UI code stays unchanged; only the order payloads use cents.
4. **`pins.js`**
   - `PINS` and `CATEGORIES` lose price and stock and keep only the visual fields (`bg`, `pat`) per id
   - the catalog itself comes from `loadCatalog()`
5. **`payment.js`**
   - `ShopAPI.checkInventory` is replaced by `create_order` (it checks stock and creates the order in one call)
   - `soldOutThisSession` goes away, because real stock now comes from the DB
   - `recordOrder` is deleted (the order already exists on the server)
   - `DemoPay.createIntent` and `verify` call the `checkout` edge function (option A)
   - `store` stays
6. **`app.js`**
   - `init()` becomes async: it shows a loading state on the LCD (`LOADING...`), awaits `loadCatalog()`, then builds the tabs and pages. If the load fails, it flashes an error and offers a retry; the machine still renders without pins.
   - `byId`, `PINS` and `CATEGORIES` become `let` and are filled after the load
   - restored carts are checked against the loaded catalog; the existing logic already drops unknown ids and clamps quantities to stock
   - `ensureOrderId()` stops generating IDs: the ID now comes back from `create_order` in `startPayment`
   - the receipt view shows `ORDER #-----` until then, which it already does when the ID is empty
   - `startPayment`: a single `create_order` call replaces `checkInventory` plus local order creation; `problems` → `applyStockProblems` as today
   - `onPaid`: drop `PAY.ShopAPI.recordOrder`; build the order for the receipt from the server response
   - after a successful payment, re-fetch the catalog so the stock badges update
7. **`CLAUDE.md`**: update the architecture section (ES modules, Supabase, env vars, `supabase/` folder).

## API contract (binding for implementation — backend and client are built in parallel against this)

**Catalog reads** (anon key, direct table access):
- `supabase.from('categories').select('id,name,icon,sort').order('sort')`
- `supabase.from('pins').select('id,category_id,name,price_cents,stock,sort').eq('active', true).order('sort')`

**Edge Function `checkout`** — called as `supabase.functions.invoke('checkout', { body })`, POST JSON, always `{ action, ... }`. Uses the service-role key internally. Errors: HTTP 503 `{ error: 'unavailable' }` for the demo "provider down" outcome; HTTP 400 `{ error: '<message>' }` for bad input; HTTP 404 `{ error: 'not_found' }` for an unknown order.

| action | request body | success response |
|---|---|---|
| `create` | `{ action, lines: [{ pin_id, qty }], method: 'qr'\|'card'\|'bank', outcome? }` | `{ problems: [{ id, available }] }` if stock short (nothing written), else `{ order_id, total_cents, intent_id, status: 'requires_action' }` |
| `complete` | `{ action, order_id, outcome? }` | `{ status }` — demo stand-in for the customer finishing on the provider's side |
| `cancel` | `{ action, order_id }` | `{ status }` |
| `verify` | `{ action, order_id }` | `{ status, order: { order_id, method, total_cents, currency, paid_at, lines: [{ pin_id, name, qty, unit_price_cents }] } }` |

- `status` values returned to the client (provider vocabulary): `requires_action` (DB `pending`), `succeeded` (DB `paid`), `failed`, `cancelled`, `needs_refund`.
- `outcome` is the demo switch (`success | decline | cancel | unavailable | soldout`, default `success`):
  - `create` + `unavailable` → 503
  - `create` + `soldout` → returns `{ problems: [{ id: <first line's pin_id>, available: 0 }] }` without touching the DB
  - `complete` + `decline` → order `failed`; + `cancel` → `cancelled`; + `success` → `mark_order_paid` (may yield `needs_refund`)
- `complete` only works when the function's env has `DEMO_PAYMENTS=true` (otherwise 403). It is removed in phase 3. Until then anyone can mark a demo order paid — acceptable only because no real money moves.
- `intent_id` is a server-generated `pi_demo_…` string stored in `orders.provider_intent_id`.
- `complete`, `cancel` only act on `pending` orders; on any other status they return the current status unchanged (idempotent).
- Each `create` makes a new pending order; abandoned pending orders are left as-is (shortcut: no cleanup job).

## Phases (each one ships on its own)

1. **Catalog from DB.** Schema, seed, RLS, `db.js`, ES-module conversion, async init. Orders still stay local. *Smallest useful step.*
2. **Orders and stock on the server.** The `create_order` / `mark_order_paid` functions, the `checkout` edge function (option A), and the payment.js/app.js changes. Remove localStorage orders.
3. **Real payment provider (later, separate plan; provider not chosen yet).** Phases 1–2 don't depend on the choice: the provider only lives inside the `checkout` edge function. Candidates include PayMongo or Xendit (PH-local, GCash/Maya QR) and Stripe.
   - The `checkout` edge function creates real intents with the chosen provider's secret key and verifies them through the provider API.
   - Add a provider webhook function that also calls `mark_order_paid`, so closing the tab doesn't lose a payment.
   - Hide the demo outcome dropdown in production builds (`import.meta.env.DEV`).

Optional, later: Realtime subscription on `pins.stock` so "only 2 left!" updates live.

## How to check each phase

- **Phase 1:**
  - with a seeded DB, the UI looks identical to today
  - changing a price or stock in the dashboard shows up after a reload
  - setting `active = false` hides a pin
  - with the network blocked, you get the error state and no crash
- **Phase 2:**
  - buy a pin and check that `orders` and `order_lines` rows appear and stock goes down
  - set a pin's stock to 1 and buy 2: you get the "a pin just sold out" path
  - refresh mid-payment: the resume flow still verifies
  - as anon, check in the browser console that `supabase.from('orders').select()` returns nothing and that the `mark_order_paid` RPC is denied

## Open questions for you

1. Do you already have a Supabase project, or should setup start with `supabase init` and the local CLI (`supabase start`)?
2. ~~Which payment provider?~~ **Not decided yet.** That's fine: it only blocks phase 3, so decide before starting it.
3. Do customers need accounts or an order history, or is anonymous checkout fine? The plan assumes anonymous.
4. Is the Supabase dashboard OK for editing the catalog, or do you want an admin page? The plan assumes the dashboard.
