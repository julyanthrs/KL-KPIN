# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

KL!KPIN — a single-page, front-end-only "button pin vending machine" shop. The whole UI is one illustrated machine that a CSS-transform "camera" zooms around. Vanilla JS, no framework, no tests, no linter. Vite is the bundler; the catalog, stock, settings, payment methods and orders live in Supabase (`@supabase/supabase-js`). Payments are manual: the customer pays the shop's QR/bank/cash and uploads a screenshot; the owner approves it in the separate admin app (`../KL-KPIN-Admin`).

## Commands

```bash
cp .env.example .env.local   # then fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (public values; .env.production holds the live pair and is committed)
npm run dev       # vite dev server on :5173 (also the "dev" entry in .claude/launch.json)
npm run build     # vite build -> dist/
npm run preview   # serve the built dist/
```

Hosted backend: the repo is linked to the Supabase project `klikpin` (ref `tdpsympwcmwhcedxstgn`). Deploy schema changes with `supabase db push`. `supabase db reset --linked` wipes all hosted data, including orders: never run it once real orders exist. `docs/legacy-supabase-schema/` is reference only and is not applied. The backend contract (tables, RPCs, error codes, storage) is in `docs/go-live-plan.md` §1.

Local backend: `supabase start` (needs Docker; applies `supabase/migrations` + `seed.sql`); put the local API URL and anon key into `.env.local`.

There is no test or lint setup. Verify changes in the browser (home → window → receipt → payment views — with no backend orders you can still check the select state — plus a phone-width and a `prefers-reduced-motion` pass).

## Architecture

Files: [index.html](index.html) (all markup, static), [css/styles.css](css/styles.css) (~2000 lines, one sheet), and four scripts in `js/`.

**Script wiring.** `index.html` loads only `app.js` and `ambient.js` (`type="module"`); `app.js` imports `pins.js`, `db.js` and `payment.js`. These are real ES modules, no globals.

**db.js** — creates the Supabase client from `import.meta.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; a missing var throws when first used, so the machine shows its load-error state) and exports `loadShop()` -> `{ categories, pins, settings, methods }`: active, non-removed pins (a pin is hidden if it has neither a picture nor built-in art), pay methods (`active`, by `sort`) and the one `settings` row. Pin visuals come from DB columns (`art`, `bg`, `pat`, `pat_color`, `image_url`) and fall back to `VISUALS`/`ART` in `pins.js`. `price_cents` becomes pesos (the UI works in pesos; only order payloads use cents). A failing `settings`/`pay_methods` read is logged and defaults apply (shop open, no methods = checkout blocked). Sizes are ordinary pin rows (`variant_of` -> the pin they were added to, `size_label`, name "Fox · Large"); `loadShop` keeps each size right after its base pin, nothing else treats them specially. When `settings.open` is false, `applyClosed()` (called from `lcdIdle`) puts a CLOSED sign over the window and disables the window/receipt buttons; an order already in progress still resumes.

**pins.js** — artwork only: `ART[id]`, `BG` patterns, `VISUALS[id]` (fallback `bg`, `pat`), `pinSVG` (draws `p.img` as an `<image>` when set, else `ART[p.art || p.id]`), `iconSVG`, `face`. A built-in pin needs an `ART` entry; a pin with a picture needs none. The per-pin limit is `settings.max_per_pin`, not a constant.

**payment.js** — thin client over Supabase RPCs: `createOrder` (takes the customer's name, phone and address, all required, also checked by the server as `bad_customer`), `submitPayment`, `orderStatus`, `cancelOrder`, plus `compressImage` (max 1280 px long side, JPEG 0.75; `ProviderError('bad_image')` when the browser can't decode it) and `uploadProof` (`payment-proofs/<order_id>/<uuid>.jpg`, insert only). RPC error messages are the contract's codes and become `ProviderError(code)`; no answer -> `'network'`. The browser never decides an order is paid, it only trusts `order_status`. `store` is the localStorage wrapper.

**supabase/** — migrations (schema, RLS, RPCs, storage policies) and `seed.sql`. The shop only reads catalog tables and calls the customer RPCs; owner edits happen in the admin app.

**app.js** (~1500 lines) — all UI logic, organised in banner-commented sections: cart → display window + paginated batches → pin close-up modal → camera → LCD/QR → receipt → payment → push door (pins drop after pay) → WebAudio sfx → UI helpers → events → init. Key ideas:
- **View state machine**: `S.view` ∈ `home | window | receipt | payment`, changed only via `setView()`, which sets `v-<view>` on `#machine`, toggles `inert` on inactive regions, retracts/prints the receipt, and calls `frameView()`.
- **Camera**: `frameView()`/`frame()` compute a `translate+scale` for `#camera` so a target rect fills the viewport. It has separate phone vs desktop framing, avoids overlapping HUD controls, and re-runs on resize/visualViewport/ResizeObserver/font load. Layout changes to the machine usually need a matching `frameView()` tweak.
- **Pagination**: grid size comes from CSS custom properties `--cols`/`--rows` on `#machine` (read in `currentPageSize()`), so breakpoints in the CSS change how many pins per page; `buildPages()` rebuilds the DOM.
- **Cart/checkout**: cart lives in `cart.items` (persisted as `klikpin_cart`); checkout state in `S.checkout` (`klikpin_checkout`); `PAY.store` is the localStorage wrapper. Stock/limits go through `availableStock()`/`maxFor()` (max 5 per pin). Only a server `order_status` of `paid`/`packed`/`collected` counts as paid (`applyStatus` → `onPaid`).
- **Payment flow** (states of `renderPay`): `select` (methods from the DB) → `createOrder` → `instructions` (order number, total, QR picture tappable to enlarge, account rows with Copy, note, screenshot picker + preview; cash kind has no upload) → `sendPayment` (compress, upload, `submitPayment`) → `waiting` (polls `order_status` every 5 s only while the tab is visible; the timer is cleared in `renderPay` for any other state) → `onPaid` (pins drop + receipt). `rejected` returns to `instructions` with the reason (same order, upload again); `needs_refund`/`cancelled`/`refunded` end the order. `S.checkout` = `{ orderId, token, status: 'instructions'|'waiting', amount, method, proofPath }`, persisted so a refresh resumes via the `resume` state (`syncStatus`). An order in `instructions` (same cart total) or `waiting` is always resumed (`resumableState()`), never duplicated; closing the pop-up keeps it, only the Cancel button calls `cancel_order`. After any network/unknown error once an order exists the UI goes to `resume` (check status), never to a new order. `settings.open === false` or no active methods blocks checkout (`checkoutBlock()`).
- Payment and the final receipt render into one modal via `renderPay(state, info)`; the downloadable receipt PNG is drawn on a canvas (`receiptCanvas`).
- `track()` pushes to `window.dataLayer` (analytics events named per PRD §10); code comments cite PRD requirement IDs (`FR-xx`, "PRD §12") — the PRD itself is not in the repo.
- Currency is a placeholder (`CUR`, PHP).

**ambient.js** — background only (sky sparkles, petals, hill parallax); must not touch the machine or UI.

**Reduced motion / accessibility**: `html.reduce` mirrors `prefers-reduced-motion`; JS timing goes through `later()`, and the CSS has a `.reduce` block at the end of styles.css. Modals use `inert` on background layers plus focus management and a `#sr` live region (`announce()`) — keep these when adding views or controls. Fonts (Fredoka, Luckiest Guy, Silkscreen, VT323, Space Mono) come from Google Fonts; the receipt canvas waits on them via `document.fonts.load`.
