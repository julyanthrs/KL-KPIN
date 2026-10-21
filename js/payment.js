/* KL!KPIN — payment + shop backend adapters
 *
 * The PRD leaves the payment provider open (§12), so this file ships a DEMO
 * provider that behaves like a real one: create a payment intent, wait for the
 * customer, then VERIFY the result before the shop treats the order as paid
 * (FR-12: a client-side redirect alone is never proof of payment).
 *
 * To go live, replace `DemoPay` with an adapter that calls YOUR server:
 *   createIntent -> POST /api/checkout       (server creates the intent with the provider's secret key)
 *   verify       -> GET  /api/checkout/:id   (server confirms status via provider API / webhook)
 * and `ShopAPI.checkInventory` / `recordOrder` with your inventory + orders backend.
 * Card details must only ever be entered on the provider's hosted page/SDK.
 */
(function () {
  'use strict';

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable: keep going in memory */ } },
  };

  class ProviderError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }

  let outcome = 'success'; // demo switch: success | decline | cancel | unavailable | soldout

  /* ---------- simulated shop backend ---------- */
  const ShopAPI = {
    soldOutThisSession: new Set(),

    // Re-check availability right before payment (FR-15).
    async checkInventory(lines, catalog) {
      await wait(600);
      if (outcome === 'soldout' && lines.length) this.soldOutThisSession.add(lines[0].id);
      const problems = [];
      for (const l of lines) {
        const avail = this.soldOutThisSession.has(l.id) ? 0 : catalog[l.id].stock;
        if (l.qty > avail) problems.push({ id: l.id, available: avail });
      }
      return problems;
    },

    recordOrder(order) {
      const orders = store.get('klikpin_orders', []);
      orders.push(order);
      store.set('klikpin_orders', orders);
    },
  };

  /* ---------- demo payment provider ---------- */
  const KEY = 'klikpin_demo_provider';
  const db = () => store.get(KEY, { intents: {} });

  const DemoPay = {
    label: 'Demo Pay · sandbox, no real money',
    methods: [
      { id: 'qr', short: 'QR / e-wallet' },
      { id: 'card', short: 'Card' },
      { id: 'bank', short: 'Bank' },
    ],

    // Idempotent per order + amount + method, so a retry or refresh never makes a second charge.
    async createIntent({ orderId, amount, currency, method }) {
      await wait(750);
      if (outcome === 'unavailable') throw new ProviderError('unavailable', 'The payment provider is not responding.');
      const d = db();
      let it = Object.values(d.intents).find((i) => i.orderId === orderId && i.amount === amount && i.method === method && i.status === 'requires_action');
      if (!it) {
        it = { id: 'pi_' + Math.random().toString(36).slice(2, 10), orderId, amount, currency, method, status: 'requires_action', created: Date.now() };
        d.intents[it.id] = it;
        store.set(KEY, d);
      }
      return { ...it };
    },

    // Stands in for the customer finishing on the provider's side (scan + approve, 3-D Secure, bank login…).
    async customerCompletes(intentId) {
      await wait(900);
      const d = db();
      const it = d.intents[intentId];
      if (!it) throw new ProviderError('not_found', 'We could not find that payment.');
      if (it.status === 'requires_action') {
        it.status = outcome === 'decline' ? 'failed' : outcome === 'cancel' ? 'cancelled' : 'succeeded';
        store.set(KEY, d);
      }
    },

    async cancel(intentId) {
      await wait(300);
      const d = db();
      const it = d.intents[intentId];
      if (it && it.status === 'requires_action') { it.status = 'cancelled'; store.set(KEY, d); }
    },

    // In production this must ask your server, which asks the provider.
    async verify(intentId) {
      await wait(850);
      const it = db().intents[intentId];
      return it ? it.status : 'not_found';
    },
  };

  window.KP_PAY = {
    ShopAPI,
    provider: DemoPay,
    ProviderError,
    store,
    setOutcome(o) { outcome = o; },
    getOutcome() { return outcome; },
  };
})();
