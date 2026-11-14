/* KL!KPIN — interactive vending machine shop */
import { pinSVG, iconSVG, face } from './pins.js';
import { loadShop } from './db.js';
import * as PAY from './payment.js';

  const store = PAY.store;

  // Currency is a placeholder until the shop confirms it (PRD §12).
  const CUR = { code: 'PHP', symbol: '₱' };
  const money = (n) => CUR.symbol + Number(n).toLocaleString('en-PH');
  // filled by loadShop() in init(); empty until then (and if the load fails)
  let PINS = [], CATEGORIES = [], byId = {}, METHODS = [];
  let SETTINGS = { open: true, closed_msg: 'Taking a little break. Back soon ♡', max_per_pin: 5 };
  // why checkout can't start right now ('' = it can)
  const checkoutBlock = () => (!SETTINGS.open ? SETTINGS.closed_msg : !METHODS.length ? 'Payments aren’t set up yet ♡' : '');
  const $ = (s, r = document) => r.querySelector(s);

  const root = document.documentElement;
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  let reduce = mqReduce.matches;
  const applyReduce = () => root.classList.toggle('reduce', reduce);
  applyReduce();
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', (e) => { reduce = e.matches; applyReduce(); });
  const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const later = (fn, ms) => setTimeout(fn, reduce ? Math.min(ms, 60) : ms);

  /* ---------- analytics (PRD §10) ---------- */
  window.dataLayer = window.dataLayer || [];
  function track(event, data = {}) {
    window.dataLayer.push({ event, at: new Date().toISOString(), ...data });
    console.debug('%c[klikpin]', 'color:#ff6f9c;font-weight:700', event, data);
  }

  /* ---------- elements ---------- */
  const el = {
    camera: $('#camera'), machine: $('#machine'), viewport: $('#viewport'),
    win: $('#window'), winInner: $('#windowInner'), winHit: $('#windowHit'), tabs: $('#tabs'),
    bv: $('#batchViewport'), track: $('#batchTrack'), dots: $('#dots'), batchLabel: $('#batchLabel'),
    prev: $('#prevBatch'), next: $('#nextBatch'),
    panel: $('#panel'), lcd: $('#lcd'), lcdText: $('#lcdText'), lcdTotal: $('#lcdTotal'), lcdQty: $('#lcdQty'), keys: $('#keys'),
    receiptKey: $('#receiptKey'), rkCount: $('#rkCount'), qr: $('#qrScreen'),
    rWrap: $('#receiptWrap'), receipt: $('#receipt'), payModal: $('#payModal'), payCard: $('#payCard'), payBody: $('#payBody'),
    push: $('#pushDoor'), tray: $('#tray'), flap: $('#flap'), stripes: $('#stripes'), topper: document.querySelector('.topper'),
    chipHome: $('#chipHome'), chipReceipt: $('#chipReceipt'), chipCount: $('#chipCount'),
    hint: $('#hint'), mute: $('#muteBtn'), toast: $('#toast'), sr: $('#sr'), confetti: $('#confetti'),
  };

  const S = {
    view: 'home',
    category: 'all',
    pages: [],
    pageSize: 0,
    batch: 0,
    hoverZoom: false,
    muted: store.get('klikpin_muted', false),
    checkout: store.get('klikpin_checkout', {}),
    paying: false,
    payState: null,
    method: '',
    proof: null, // { blob, url } the compressed screenshot picked for the current order
    lastOrder: null,
    camScale: 1,
    loading: false,
    loadError: false,
  };

  /* =========================================================
     CART (FR-06)
     ========================================================= */
  const availableStock = (id) => byId[id].stock;
  const maxFor = (id) => Math.max(0, Math.min(SETTINGS.max_per_pin, availableStock(id)));

  const cart = { items: {}, flagged: {} };
  // runs after the catalog loads: drops unknown pins and clamps quantities to stock
  function restoreCart() {
    const saved = store.get('klikpin_cart', null);
    if (saved && saved.items) {
      for (const [id, q] of Object.entries(saved.items)) {
        if (byId[id] && q > 0) { const m = maxFor(id); if (m > 0) cart.items[id] = Math.min(q, m); }
      }
    }
  }
  const saveCart = () => store.set('klikpin_cart', { items: cart.items });
  const saveCheckout = () => store.set('klikpin_checkout', S.checkout);

  const qty = (id) => cart.items[id] || 0;
  const lines = () => Object.entries(cart.items).filter(([, q]) => q > 0)
    .map(([id, q]) => ({ id, qty: q, name: byId[id].name, price: byId[id].price, stock: availableStock(id) }));
  const payableLines = () => lines().filter((l) => cart.flagged[l.id] !== 'soldout');
  function totals() {
    const ls = payableLines();
    return { count: ls.reduce((a, l) => a + l.qty, 0), subtotal: ls.reduce((a, l) => a + l.qty * l.price, 0) };
  }

  function setQty(id, q, source) {
    const prev = qty(id);
    q = Math.max(0, Math.min(q, cart.flagged[id] === 'soldout' ? 0 : maxFor(id)));
    if (q === prev) return false;
    if (q === 0) { delete cart.items[id]; delete cart.flagged[id]; }
    else { cart.items[id] = q; if (cart.flagged[id] === 'reduced') delete cart.flagged[id]; }
    saveCart();
    track(q > prev ? 'pin_added' : 'pin_removed', { id, qty: q, source });
    if (source === 'receipt') track('order_edited', { id, qty: q });
    refreshCartUI(id);
    return true;
  }

  function addPin(id, source = 'window') {
    const p = byId[id];
    if (availableStock(id) <= 0) { toast(`${p.name} is sold out ♡`); sfx.err(); return; }
    if (qty(id) >= maxFor(id)) {
      const msg = qty(id) >= SETTINGS.max_per_pin ? `Max ${SETTINGS.max_per_pin} per design ♡` : `Only ${maxFor(id)} ${p.name} left!`;
      toast(msg); sfx.err(); lcdFlash('MAX!');
      return;
    }
    setQty(id, qty(id) + 1, source);
    sfx.add();
    lcdFlash('+1 ' + p.name.toUpperCase());
    announce(`${p.name} added. ${qty(id)} in your order.`);
    feedback(id);
  }

  function removePin(id, source = 'window') {
    if (!qty(id)) return;
    const p = byId[id];
    setQty(id, qty(id) - 1, source);
    sfx.remove();
    announce(qty(id) ? `One ${p.name} removed. ${qty(id)} left in your order.` : `${p.name} removed from your order.`);
  }

  function refreshCartUI(id) {
    if (id) updateSlot(id); else PINS.forEach((p) => updateSlot(p.id));
    lcdIdle();
    updateHUD();
    if (pz.id) renderPinZoom();
    if (S.view === 'receipt') afterReceiptEdit();
  }

  /* =========================================================
     DISPLAY WINDOW + BATCHES (FR-04, FR-05)
     ========================================================= */
  const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  const catName = () => (CATEGORIES.find((c) => c.id === S.category) || { name: '' }).name;

  function slotHTML(p) {
    return `<div class="slot-item" data-id="${p.id}">
      <div class="pin-zone">
        <div class="pin-wrap">
          <button class="pin-art" data-act="zoom" aria-label="Look closer at ${p.name}">${pinSVG(p)}</button>
          <span class="holder" aria-hidden="true"></span>
          <span class="ribbon" aria-hidden="true">SOLD OUT</span>
          ${p.stock > 0 && p.stock <= 3 ? `<span class="low">only ${p.stock} left!</span>` : ''}
        </div>
        <span class="qty-badge" aria-hidden="true"></span>
        <button class="minus-bubble" data-act="dec" aria-label="Remove one ${p.name}">−</button>
      </div>
      <div class="label">
        <div class="label-info">
          <p class="pin-name">${p.name}</p>
          <p class="pin-price"><span class="code" aria-hidden="true">${p.code}</span>${money(p.price)}</p>
        </div>
        <button class="add" data-act="inc" aria-label="Add ${p.name}, ${money(p.price)}">${PLUS_SVG}</button>
      </div>
    </div>`;
  }

  function buildTabs() {
    el.tabs.innerHTML = CATEGORIES.map((c) =>
      `<button class="tab" data-cat="${c.id}" aria-pressed="${c.id === S.category}">${iconSVG(c.icon)}<span>${c.name}</span></button>`).join('');
  }

  function currentPageSize() {
    const cs = getComputedStyle(el.machine);
    return (parseInt(cs.getPropertyValue('--cols'), 10) || 5) * (parseInt(cs.getPropertyValue('--rows'), 10) || 2);
  }

  // Splits the active category into pages that slide left/right (FR-04).
  function buildPages(keepId) {
    S.pageSize = currentPageSize();
    const ids = PINS.filter((p) => S.category === 'all' || p.cat === S.category).map((p) => p.id);
    S.pages = [];
    for (let i = 0; i < ids.length; i += S.pageSize) S.pages.push(ids.slice(i, i + S.pageSize));
    if (keepId) { const at = S.pages.findIndex((pg) => pg.includes(keepId)); S.batch = at < 0 ? 0 : at; }
    S.batch = Math.max(0, Math.min(S.batch, S.pages.length - 1));
    el.track.innerHTML = S.pages.map((pg, bi) =>
      `<div class="page" data-batch="${bi}" role="group" aria-label="${catName()}, page ${bi + 1} of ${S.pages.length}">
        ${pg.map((id) => slotHTML(byId[id])).join('')}
      </div>`).join('');
    el.dots.innerHTML = S.pages.map((_, i) => `<button class="dot" data-i="${i}" aria-label="Show page ${i + 1}"></button>`).join('');
    el.win.classList.toggle('single-page', S.pages.length < 2);
    PINS.forEach((p) => updateSlot(p.id));
    el.track.classList.add('dragging');
    applyBatch();
    void el.track.offsetWidth;
    el.track.classList.remove('dragging');
  }

  function setCategory(id) {
    if (id === S.category) return;
    S.category = id;
    S.batch = 0;
    el.tabs.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.cat === id)));
    buildPages();
    sfx.slide();
    track('category_selected', { category: id });
    announce(`${catName()}: ${S.pages.flat().length} pins`);
  }

  function updateSlot(id) {
    const node = el.track.querySelector(`.slot-item[data-id="${id}"]`);
    if (!node) return;
    const q = qty(id), max = maxFor(id);
    node.classList.toggle('in-cart', q > 0);
    node.classList.toggle('is-soldout', availableStock(id) <= 0);
    node.querySelector('.qty-badge').textContent = q ? '×' + q : '';
    const minus = node.querySelector('[data-act="dec"]');
    minus.disabled = q === 0;
    minus.tabIndex = q === 0 ? -1 : 0;
    const plus = node.querySelector('[data-act="inc"]');
    plus.disabled = availableStock(id) <= 0;
    plus.classList.toggle('at-max', q >= max && max > 0);
  }

  function feedback(id) {
    const node = el.track.querySelector(`.slot-item[data-id="${id}"]`);
    if (node) {
      const art = node.querySelector('.pin-art');
      art.classList.remove('boing'); void art.offsetWidth; art.classList.add('boing');
      const pop = document.createElement('span');
      pop.className = 'pop'; pop.textContent = '+1 ♡';
      node.querySelector('.pin-wrap').appendChild(pop);
      setTimeout(() => pop.remove(), 900);
    }
    el.chipReceipt.classList.remove('bump'); void el.chipReceipt.offsetWidth; el.chipReceipt.classList.add('bump');
  }

  function applyBatch() {
    el.track.style.transform = `translateX(${-S.batch * 100}%)`;
    el.track.querySelectorAll('.page').forEach((pg, j) => { pg.inert = j !== S.batch; });
    el.dots.querySelectorAll('.dot').forEach((d, j) => {
      d.classList.toggle('on', j === S.batch);
      if (j === S.batch) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current');
    });
    el.batchLabel.textContent = S.pages.length ? `page ${S.batch + 1}/${S.pages.length}` : '';
    el.prev.disabled = S.batch === 0;
    el.next.disabled = S.batch >= S.pages.length - 1;
  }

  function setBatch(i, source = 'button') {
    if (i < 0 || i >= S.pages.length) { applyBatch(); sfx.err(); return; }
    if (i === S.batch) { applyBatch(); return; }
    S.batch = i;
    applyBatch();
    sfx.slide();
    track('product_batch_changed', { batch: i + 1, category: S.category, source });
    announce(`${catName()}, page ${i + 1} of ${S.pages.length}`);
  }

  /* =========================================================
     PIN CLOSE-UP — tap a pin in the open window: it lifts off its holder and
     flies to the middle of the screen, big, over frosted glass
     ========================================================= */
  const pz = { id: null, src: null, slot: null, closing: false, anim: null };
  const pzEl = {
    modal: $('#pinModal'), art: $('#pzArt'), wrap: $('#pinModal .pz-art-wrap'),
    name: $('#pzName'), code: $('#pzCode'), price: $('#pzPrice'), stock: $('#pzStock'), qty: $('#pzQty'),
    dec: $('#pinModal [data-act="dec"]'), inc: $('#pinModal [data-act="inc"]'),
  };
  const pageLayers = () => [el.viewport, document.querySelector('.hud-top'), document.querySelector('.hud-bottom'), el.mute];

  // the transform that puts the big pin exactly over the small one in the window
  // (measured on the wrapper, which never animates, so it works mid-flight too)
  function pzFrom() {
    const a = pz.src && pz.src.isConnected ? pz.src.getBoundingClientRect() : null;
    const b = pzEl.wrap.getBoundingClientRect();
    if (!a || !a.width || !b.width) return 'scale(.25)';
    const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
    return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(a.width / b.width).toFixed(4)})`;
  }

  function renderPinZoom() {
    const id = pz.id;
    if (!id) return;
    const p = byId[id], q = qty(id), left = availableStock(id), max = maxFor(id);
    pzEl.name.textContent = p.name;
    pzEl.code.textContent = p.code;
    pzEl.price.textContent = money(p.price);
    pzEl.stock.textContent = left <= 0 ? 'sold out' : left <= 3 ? `only ${left} left!` : `${left} in stock`;
    pzEl.stock.classList.toggle('is-low', left <= 3);
    pzEl.modal.classList.toggle('is-soldout', left <= 0);
    pzEl.qty.textContent = q;
    pzEl.qty.setAttribute('aria-label', `${q} in your order`);
    pzEl.dec.textContent = '−';
    pzEl.dec.disabled = q === 0;
    pzEl.dec.setAttribute('aria-label', `Remove one ${p.name}`);
    pzEl.inc.disabled = left <= 0;
    pzEl.inc.classList.toggle('at-max', q >= max && max > 0);
    pzEl.inc.innerHTML = left <= 0 ? 'Sold out' : `${PLUS_SVG}${q ? 'One more' : 'Add to order'} ♡`;
    pzEl.inc.setAttribute('aria-label', left <= 0 ? `${p.name} is sold out` : `Add ${p.name}, ${money(p.price)}`);
  }

  function pzPlay(cls) {
    const svg = pzEl.art.querySelector('.pin-svg');
    if (!svg) return;
    svg.classList.remove('boing', 'spin'); void svg.getBoundingClientRect(); svg.classList.add(cls);
  }

  function openPinZoom(id, srcBtn) {
    if (pz.id || S.view !== 'window') return;
    pz.id = id; pz.src = srcBtn; pz.closing = false;
    pz.slot = srcBtn.closest('.slot-item');
    S.hoverZoom = false; // stay zoomed in on the window while looking closer
    pzEl.art.innerHTML = pinSVG(byId[id]);
    renderPinZoom();
    pzEl.modal.classList.remove('closing');
    pzEl.modal.hidden = false;
    pageLayers().forEach((n) => { if (n) n.inert = true; });
    if (pz.slot) pz.slot.classList.add('lifted'); // the pin leaves its holder
    if (!reduce) {
      pz.anim = pzEl.art.animate(
        [{ transform: pzFrom() + ' rotate(-24deg)' }, { transform: 'none' }],
        { duration: 640, easing: 'cubic-bezier(.3, 1.3, .5, 1)' });
    }
    sfx.lift();
    track('pin_zoomed', { id });
    requestAnimationFrame(() => pzEl.name.focus({ preventScroll: true }));
  }

  function closePinZoom() {
    if (!pz.id || pz.closing) return;
    pz.closing = true;
    pageLayers().forEach((n) => { if (n) n.inert = false; });
    pzEl.modal.classList.add('closing');
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (pz.anim) pz.anim.cancel(); // drop the held fly-back pose before the next open
      if (pz.slot) pz.slot.classList.remove('lifted');
      pzEl.modal.hidden = true;
      pzEl.modal.classList.remove('closing', 'is-soldout');
      pzEl.art.innerHTML = '';
      const back = pz.src;
      Object.assign(pz, { id: null, src: null, slot: null, closing: false, anim: null });
      if (back && back.isConnected && S.view === 'window') back.focus({ preventScroll: true });
    };
    const from = pz.anim ? getComputedStyle(pzEl.art).transform : 'none';
    if (pz.anim) pz.anim.cancel();
    sfx.slide();
    if (reduce || !pz.src || !pz.src.isConnected) { setTimeout(done, reduce ? 0 : 220); return; }
    // fly back down into its holder in the window
    pz.anim = pzEl.art.animate(
      [{ transform: from === 'none' ? 'none' : from }, { transform: pzFrom() }],
      { duration: 420, easing: 'cubic-bezier(.5, 0, .3, 1)', fill: 'forwards' });
    pz.anim.onfinish = done;
    setTimeout(done, 500); // in case frames are paused (tab in the background)
  }

  pzEl.modal.addEventListener('click', (e) => {
    if (!pz.id || pz.closing) return;
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled) {
      const a = b.dataset.act;
      if (a === 'close') closePinZoom();
      else if (a === 'inc') { const before = qty(pz.id); addPin(pz.id, 'closeup'); if (qty(pz.id) > before) pzPlay('boing'); }
      else if (a === 'dec') removePin(pz.id, 'closeup');
      return;
    }
    // tap the big pin: it flips around like a coin
    if (e.target.closest('.pz-art-wrap')) { pzPlay('spin'); sfx.key(); }
  });
  // back to the gentle float once a flip or boing ends
  pzEl.art.addEventListener('animationend', (e) => { if (e.target.classList) e.target.classList.remove('boing', 'spin'); });

  /* =========================================================
     CAMERA (FR-01, FR-02, FR-11, FR-16)
     ========================================================= */
  const mqPortrait = matchMedia('(max-aspect-ratio: 1/1)');
  const isPortrait = () => mqPortrait.matches;

  function rectOf(node) {
    let x = 0, y = 0, n = node;
    while (n && n !== el.machine) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: node.offsetWidth, h: node.offsetHeight };
  }

  function frame(r, o = {}) {
    const vw = el.viewport.clientWidth, vh = el.viewport.clientHeight;
    const pad = o.pad != null ? o.pad : Math.max(10, Math.min(28, vw * 0.03));
    const top = pad + (o.top || 0), bottom = pad + (o.bottom || 0);
    const s = Math.min((vw - pad * 2) / r.w, (vh - top - bottom) / r.h, o.max || 1.5);
    const tx = vw / 2 - (r.x + r.w / 2) * s;
    const ty = top + (vh - top - bottom) / 2 - (r.y + r.h / 2) * s;
    el.camera.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
    S.camScale = s;
  }

  function frameView() {
    const v = S.view;
    const small = window.innerHeight < 460;
    const hudB = v === 'payment' ? 0 : small ? 44 : 64;
    if (v === 'home') {
      // the logo sign (+ the cat peeking over it) sits above the cabinet on phones
      const lift = el.topper && el.topper.offsetHeight ? el.topper.offsetHeight - 8 + 64 : 0;
      if (isPortrait() || matchMedia('(max-width: 760px), (pointer: coarse)').matches) {
        // Phones: as big as the screen allows, edge to edge. The Receipt chip always
        // stays below the cabinet; the top controls (hint, sound) only push it down
        // when they would actually sit on the logo sign.
        const r = { x: -4, y: -6 - lift, w: el.machine.offsetWidth + 8, h: el.machine.offsetHeight + 20 + lift };
        const vw = el.viewport.clientWidth, vh = el.viewport.clientHeight;
        const muteR = el.mute.getBoundingClientRect();
        const ups = [el.hint, el.mute].filter((n) => !n.hidden).map((n) => n.getBoundingClientRect()).filter((q) => q.height);
        const sign = el.topper ? { x0: el.topper.offsetLeft, x1: el.topper.offsetLeft + el.topper.offsetWidth } : { x0: 0, x1: r.w };
        const bottom = vh - el.chipReceipt.getBoundingClientRect().top + 2;
        let top = Math.max(6, muteR.top - 6); // notch / safe area
        for (let i = 0; i < 2; i++) {
          const s = Math.min((vw - 4) / r.w, (vh - top - bottom - 4) / r.h, 1.25);
          const cx = vw / 2 - (r.x + r.w / 2) * s;
          const x0 = cx + sign.x0 * s - 4, x1 = cx + sign.x1 * s + 4;
          ups.forEach((q) => { if (q.right > x0 && q.left < x1) top = Math.max(top, q.bottom + 2); });
        }
        frame(r, { max: 1.25, pad: 2, top, bottom });
      } else {
        // Desktop: the hint and chips sit beside the machine, so it can use the full
        // height. A control only limits the framing if it would overlap the cabinet.
        const r = { x: -6, y: -6 - lift, w: el.machine.offsetWidth + 12, h: el.machine.offsetHeight + 22 + lift };
        const vw = el.viewport.clientWidth, vh = el.viewport.clientHeight;
        const ups = [el.hint, el.mute].filter((n) => !n.hidden).map((n) => n.getBoundingClientRect());
        const downs = [el.chipReceipt, el.chipHome].filter((n) => n && !n.hidden).map((n) => n.getBoundingClientRect());
        let t = 8, b = 22; // a strip of the path stays visible under the machine
        for (let i = 0; i < 2; i++) {
          const s = Math.min((vw - 8) / r.w, (vh - t - b - 8) / r.h, 1.25);
          const x0 = vw / 2 - (r.w * s) / 2 - 6, x1 = vw / 2 + (r.w * s) / 2 + 6;
          const hits = (q) => q.right > x0 && q.left < x1;
          ups.forEach((q) => { if (hits(q)) t = Math.max(t, q.bottom + 2); });
          downs.forEach((q) => { if (hits(q)) b = Math.max(b, vh - q.top + 2); });
        }
        frame(r, { max: 1.25, pad: 4, top: t, bottom: b });
      }
    } else if (v === 'window') {
      // phones: zoom right up to the window frame (the arrows only stick out a little)
      const r = rectOf(el.win), px = isPortrait() ? 16 : 50;
      frame({ x: r.x - px, y: r.y - 18, w: r.w + px * 2, h: r.h + 36 }, { max: 1.45, bottom: hudB, pad: isPortrait() ? 4 : undefined });
    } else if (v === 'receipt' || v === 'payment') {
      // the payment pop-up floats over the printed receipt (blurred behind the glass)
      const r = rectOf(el.rWrap), h = el.receipt.offsetHeight;
      frame({ x: r.x - 20, y: r.y - 58, w: r.w + 40, h: h + 58 + 28 }, { max: 2.4, bottom: v === 'payment' ? 0 : hudB });
    }
  }

  function setView(v, opts = {}) {
    const prev = S.view;
    S.view = v;
    el.machine.classList.remove('v-' + prev);
    el.machine.classList.add('v-' + v);
    document.body.dataset.view = v;
    el.winInner.inert = v !== 'window';
    el.receipt.inert = v !== 'receipt';
    if (v !== 'window') S.hoverZoom = false;
    const paperOut = (x) => x === 'receipt' || x === 'payment';
    if (paperOut(prev) && !paperOut(v)) retractReceipt();
    if (v === 'receipt' && (!paperOut(prev) || !el.rWrap.offsetHeight)) printReceipt();
    toggleModal(v === 'payment');
    updateHUD();
    frameView();
    if (prev !== v) sfx.zoom();
    if (v === 'window' && prev !== 'window') track('product_window_opened', { via: opts.via || 'tap' });
    if (v === 'home' && prev !== 'home') track('machine_home_viewed', { from: prev });

    requestAnimationFrame(() => {
      if (opts.focus) {
        let t = null;
        if (v === 'window') t = el.track.querySelector(`.page[data-batch="${S.batch}"] button[data-act="inc"]:not(:disabled)`);
        else if (v === 'receipt') t = $('#rTitle');
        else if (v === 'payment') t = $('#payTitle');
        else if (v === 'home') t = el.winHit;
        if (t) t.focus({ preventScroll: true });
      } else {
        const a = document.activeElement;
        if (a && a !== document.body && a.closest('[inert]')) el.winHit.focus({ preventScroll: true });
      }
    });
  }

  // Payment + final receipt live in one pop-up over a frosted-glass backdrop.
  let modalT;
  function toggleModal(open) {
    const m = el.payModal;
    clearTimeout(modalT);
    const hidePage = [el.viewport, document.querySelector('.hud-top'), document.querySelector('.hud-bottom'), el.mute];
    if (open) {
      m.classList.remove('closing');
      m.hidden = false;
      hidePage.forEach((n) => { if (n) n.inert = true; });
    } else if (!m.hidden) {
      m.classList.add('closing');
      hidePage.forEach((n) => { if (n) n.inert = false; });
      modalT = setTimeout(() => { m.hidden = true; m.classList.remove('closing'); }, reduce ? 0 : 220);
    }
  }

  function updateHUD() {
    const v = S.view, t = totals();
    el.chipHome.hidden = !(v === 'window' || v === 'receipt');
    el.chipReceipt.hidden = !(v === 'home' || v === 'window');
    el.hint.hidden = v !== 'home';
    el.chipCount.textContent = t.count;
    el.chipReceipt.setAttribute('aria-label', `Open receipt, ${t.count} pin${t.count === 1 ? '' : 's'} in your order`);
    el.rkCount.textContent = t.count ? `(${t.count})` : '';
  }

  /* =========================================================
     LCD + QR SCREEN
     ========================================================= */
  // TOTAL display: small label line (shows quick messages) + big running total.
  let lcdTimer;
  function lcdIdle() {
    const t = totals();
    const amt = t.subtotal.toFixed(2);
    el.lcdTotal.textContent = amt;
    el.lcdTotal.dataset.ghost = amt.replace(/\d/g, '8'); // unlit "8" segments behind the digits
    el.lcdQty.textContent = 'QTY ' + String(t.count).padStart(2, '0');
    if (lcdTimer) return; // a flash message is showing
    el.lcd.classList.remove('flash');
    el.lcdText.textContent = S.loading ? 'LOADING...' : S.loadError ? 'LOAD FAILED' : !SETTINGS.open ? 'SHOP CLOSED' : t.count ? 'SUBTOTAL' : 'READY';
  }
  function lcdFlash(msg, ms = 1400) {
    clearTimeout(lcdTimer);
    el.lcd.classList.add('flash');
    el.lcdText.textContent = msg;
    lcdTimer = setTimeout(() => { lcdTimer = null; lcdIdle(); }, ms);
  }

  function qrIdle() {
    el.qr.innerHTML = '<span class="qr-title">QR CODE</span><span class="qr-ph" aria-hidden="true">♡</span><span class="qr-sub">scan at checkout</span>';
  }
  function qrShow(url, amount) {
    el.qr.innerHTML = `<span class="qr-title">SCAN TO PAY</span><img class="qr" src="${url}" alt="">
      <span class="qr-amt">${money(amount)}</span>`;
  }
  function qrThanks() {
    el.qr.innerHTML = '<span class="qr-title">QR CODE</span><div class="qr-thanks">THANK<br>YOU &lt;3</div>';
  }

  /* =========================================================
     RECEIPT (FR-07 → FR-10)
     ========================================================= */
  // The order id comes from the server's `create_order`; until then (or once that order is dead or no longer matches the cart) show dashes.
  const liveOrderId = () => (['instructions', 'waiting'].includes(S.checkout.status) && S.checkout.amount === totals().subtotal && S.checkout.orderId) || '';

  function openReceipt(source) {
    if (!lines().length) {
      sfx.err();
      lcdFlash('ADD A PIN FIRST!', 2200);
      toast('Add at least one pin first ♡');
      el.panel.classList.remove('shake'); void el.panel.offsetWidth; el.panel.classList.add('shake');
      return;
    }
    track('receipt_opened', { source, count: totals().count, total: totals().subtotal });
    setView('receipt', { focus: true });
  }

  function renderReceipt() {
    const ls = lines(), t = totals(), now = new Date();
    const date = now.toLocaleDateString('en-PH', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const items = ls.map((l) => {
      const p = byId[l.id], flag = cart.flagged[l.id], so = flag === 'soldout';
      const amt = money(l.qty * p.price);
      return `<li class="r-line${so ? ' is-flagged' : ''}">
        <div class="r-info">
          <b class="r-name">${esc(p.name)}</b>
          <span class="r-calc">${l.qty} × ${money(p.price)}</span>
          ${so ? '<em class="r-flag">sold out · not charged</em>' : flag === 'reduced' ? `<em class="r-flag">only ${l.qty} left · qty updated</em>` : ''}
        </div>
        <span class="r-amt">${so ? `<s>${amt}</s>` : amt}</span>
        <div class="r-edit-row">
          <span class="r-ctrls" role="group" aria-label="${p.name} quantity">
            <button data-act="dec" data-id="${l.id}" aria-label="One less ${p.name}" ${so ? 'disabled' : ''}>−</button>
            <span class="r-qty" aria-label="Quantity ${l.qty}">${l.qty}</span>
            <button data-act="inc" data-id="${l.id}" aria-label="One more ${p.name}" ${so || l.qty >= maxFor(l.id) ? 'disabled' : ''}>+</button>
          </span>
          <button class="r-remove" data-act="del" data-id="${l.id}" aria-label="Remove ${p.name} from order">remove</button>
        </div>
      </li>`;
    }).join('');
    el.receipt.innerHTML = `
      <div class="r-head"><p class="r-brand">KL!KPIN</p><p class="r-sub">BUTTON PIN MACHINE</p></div>
      <p class="r-meta"><span>ORDER #${liveOrderId() || '-----'}</span><span>${date} · ${time}</span></p>
      <h2 class="r-title" id="rTitle" tabindex="-1">ORDER RECEIPT</h2>
      <p class="r-columns"><span>ITEM / QTY</span><span>AMOUNT</span></p>
      ${ls.length ? `<ul class="r-lines">${items}</ul>` : '<p class="r-empty">no pins yet ♡<br>go back and add one!</p>'}
      <div class="r-tot">
        <p class="r-count"><span>ITEMS</span><span>${t.count}</span></p>
        <p class="r-grand"><b>TOTAL DUE</b><strong>${money(t.subtotal)}</strong></p>
      </div>
      <div class="r-barcode" aria-hidden="true"></div>
      <p class="r-thanks">a little pin, a little joy ♡<br>THANK YOU FOR STOPPING BY!</p>
      ${checkoutBlock() ? `<p class="r-closed" role="status">${checkoutBlock()}</p>` : ''}
      <div class="r-actions">
        <button class="r-btn primary" data-act="confirm" ${t.count && !checkoutBlock() ? '' : 'disabled'}>Confirm order ♡</button>
        <button class="r-btn" data-act="edit">← edit order</button>
      </div>`;
  }

  function printReceipt() {
    renderReceipt();
    el.rWrap.classList.remove('printing', 'unrolling', 'adjust', 'retract');
    el.receipt.inert = true;
    el.rWrap.style.setProperty('--receipt-height', el.receipt.offsetHeight + 'px');
    el.rWrap.style.height = '0px';
    void el.rWrap.offsetWidth;
    el.rWrap.classList.add('printing');
    el.rWrap.style.height = el.receipt.offsetHeight + 'px';
    sfx.print();
    lcdFlash('PRINTING...', 2300);
  }
  function retractReceipt() {
    el.rWrap.classList.remove('printing', 'unrolling', 'adjust');
    el.rWrap.style.height = '0px';
  }
  function afterReceiptEdit() {
    const a = document.activeElement;
    const keep = a && el.receipt.contains(a) && a.dataset ? { act: a.dataset.act, id: a.dataset.id } : null;
    renderReceipt();
    el.rWrap.classList.remove('printing', 'unrolling');
    el.receipt.inert = false;
    el.rWrap.classList.add('adjust');
    el.rWrap.style.height = el.receipt.offsetHeight + 'px';
    frameView();
    if (keep) {
      const back = (keep.id && el.receipt.querySelector(`[data-act="${keep.act}"][data-id="${keep.id}"]:not(:disabled)`)) || $('#rTitle');
      back.focus({ preventScroll: true });
    }
  }

  el.receipt.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || S.view !== 'receipt') return;
    const { act, id } = b.dataset;
    if (act === 'inc') addPin(id, 'receipt');
    else if (act === 'dec') removePin(id, 'receipt');
    else if (act === 'del') { setQty(id, 0, 'receipt'); sfx.remove(); announce(`${byId[id].name} removed from your order.`); }
    else if (act === 'confirm') confirmOrder();
    else if (act === 'edit') { track('order_edited', { action: 'back_to_pins' }); setView('window', { focus: true, via: 'edit' }); }
  });

  /* =========================================================
     PAYMENT (FR-11 → FR-15)
     ========================================================= */
  const ICON = {
    qr: '<svg viewBox="0 0 24 24"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6 6h1v1H6zM17 6h1v1h-1zM6 17h1v1H6zM14 14h3v3h-3zM18 18h3v3h-3zM18 14h3v2h-3zM14 18h2v3h-2z" fill="currentColor" stroke="currentColor"/></svg>',
    card: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 10h20" stroke="currentColor" stroke-width="2.6"/><path d="M6 15h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    bank: '<svg viewBox="0 0 24 24"><path d="M3 9l9-5 9 5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 11v6M9.5 11v6M14.5 11v6M19 11v6M3 20h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    cash: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    other: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.6 6.7 19.4l1.2-6L3.4 9.3l6-.7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#ffd6e2" stroke="#2c2554" stroke-width="2" stroke-linejoin="round"/><path d="M16 9q2 3 0 6M18.5 6.5q4 5.5 0 11" fill="none" stroke="#2c2554" stroke-width="2" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#eee" stroke="#2c2554" stroke-width="2" stroke-linejoin="round"/><path d="M16 9l5 6M21 9l-5 6" stroke="#2c2554" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const DL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';
  const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
  const stamp = (iso) => {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleDateString('en-PH', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' +
      d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  };

  // text from the shop (method names, notes, messages) goes through esc() before it reaches innerHTML
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ERR_TEXT = {
    bad_image: 'We couldn’t read that picture. Please send a PNG or JPG screenshot.',
    proof_required: 'Please upload your payment screenshot first.',
    bad_proof: 'That upload didn’t arrive properly. Please choose your screenshot again.',
  };
  let payPoll = null, polling = false;
  const stopPoll = () => { clearInterval(payPoll); payPoll = null; };
  function setProof(blob) {
    if (S.proof) URL.revokeObjectURL(S.proof.url);
    S.proof = blob ? { blob, url: URL.createObjectURL(blob) } : null;
  }

  function renderPay(state, info = {}) {
    S.payState = state;
    if (state !== 'waiting') stopPoll();
    const t = totals();
    const order = info.order || null;
    const items = order ? order.lines : payableLines();
    const amount = order ? order.total : t.subtotal;
    const orderId = (order && order.orderId) || liveOrderId() || '-----';
    const paid = state === 'success';
    const c = S.checkout, cm = c.method || {};

    const head = `<header class="pm-head">
        <h2 class="pm-title" id="payTitle" tabindex="-1">${paid ? 'RECEIPT' : 'PAYMENT'}</h2>
        <p class="pm-meta">ORDER #${esc(orderId)}<br>${stamp(order && order.paidAt)}</p>
        ${paid ? '<span class="pm-paid" aria-hidden="true">PAID ✓</span>' : ''}
        ${paid
          ? `<button class="pm-icon dl" data-act="download" aria-label="Download receipt">${DL_SVG}</button>`
          : `<button class="pm-icon" data-act="back" aria-label="Close payment and go back to the receipt" ${state === 'busy' ? 'disabled' : ''}>${X_SVG}</button>`}
      </header>`;
    const receipt = `<div class="pm-receipt">
        <ul class="pm-lines" aria-label="Your pins">
          ${items.map((l) => `<li class="pm-line">
            <span class="pm-pin" aria-hidden="true">${pinSVG(byId[l.id])}</span>
            <span class="pm-q">${l.qty}x</span>
            <span class="pm-name">${esc(l.name)}</span>
            <span class="pm-amt">${money(l.qty * l.price)}</span>
          </li>`).join('')}
        </ul>
        <p class="pm-total"><span>${paid ? 'TOTAL PAID' : 'TOTAL'}</span><strong>${money(amount)}</strong></p>
      </div>`;

    let body = '';
    const copyRow = (label, v) => v ? `<div class="pm-acc-row"><span class="pm-acc-l">${label}</span><b class="pm-acc-v">${esc(v)}</b><button class="pm-copy" data-act="copy" data-v="${esc(v)}" aria-label="Copy ${label.toLowerCase()}">Copy</button></div>` : '';
    if (state === 'select') {
      body = `<fieldset class="methods"><legend class="sr-only">Choose how you’ll pay</legend>
          ${METHODS.map((x) => `<label class="method"><input type="radio" name="pm" value="${esc(x.id)}" ${x.id === S.method ? 'checked' : ''}><span class="m-card"><span class="m-ico">${ICON[x.kind] || ICON.other}</span>${esc(x.name)}</span></label>`).join('')}
        </fieldset>
        <button class="pay-btn" data-act="pay">Continue ♡</button>
        <button class="pay-link" data-act="back">← back to receipt</button>`;
    } else if (state === 'busy') {
      body = `<div class="pay-status" role="status"><span class="pay-spin" aria-hidden="true"></span><p class="ps-big">${info.msg}</p><p class="ps-small">please keep this page open ♡</p></div>`;
    } else if (state === 'instructions') {
      const cash = cm.kind === 'cash';
      body = `${c.rejectReason ? `<div class="pay-status is-bad" role="alert"><p class="ps-big">Payment not accepted</p><p class="ps-small">${esc(c.rejectReason)}</p><p class="ps-small">Please upload a new screenshot below.</p></div>` : ''}
        <div class="pay-status">
          <p class="ps-big">${cash ? 'Reserve your pins' : `Pay ${money(c.amount)} to ${esc(cm.name)}`}</p>
          <p class="ps-small">${cash ? 'We’ll hold them for you. Pay at the stall.' : 'Send the exact amount, then upload a screenshot of the payment.'}</p>
        </div>
        ${cm.qr_url ? `<button class="pm-qr pm-qr-btn" data-act="zoomqr" aria-label="Enlarge the payment QR code"><img class="pm-qr-img" src="${esc(cm.qr_url)}" alt="Payment QR code for ${esc(cm.name)}"></button>` : ''}
        ${cm.acc_name || cm.acc_no ? `<div class="pm-acc">${copyRow('Account name', cm.acc_name)}${copyRow('Account no.', cm.acc_no)}</div>` : ''}
        ${cm.note ? `<p class="ps-small pm-note">${esc(cm.note)}</p>` : ''}
        ${cash ? '' : `<div class="pm-upload">
          ${info.err ? `<p class="pm-err" role="alert">${esc(info.err)}</p>` : ''}
          ${S.proof ? `<img class="pm-proof" src="${S.proof.url}" alt="Your payment screenshot">` : ''}
          <label class="pay-btn ghost pm-pick">${S.proof ? 'Change screenshot' : 'Upload your payment screenshot'}<input type="file" id="proofFile" accept="image/*" class="sr-only"></label>
        </div>`}
        <div class="pay-row"><button class="pay-btn" data-act="send" ${cash || S.proof ? '' : 'disabled'}>${cash ? 'Reserve, I’ll pay at the stall' : 'Send payment ♡'}</button><button class="pay-btn ghost" data-act="cancel">Cancel</button></div>
        ${cash && info.err ? `<p class="pm-err" role="alert">${esc(info.err)}</p>` : ''}`;
    } else if (state === 'waiting') {
      body = `<div class="pay-status" role="status"><span class="pay-spin" aria-hidden="true"></span><p class="ps-big">Payment sent!</p><p class="ps-small">${cm.kind === 'cash' ? 'Your pins are reserved. The shop will confirm once you’ve paid at the stall.' : 'The shop is checking it. This page updates by itself, and you can come back to it later on this device.'}</p><p class="ps-small">Order #${esc(c.orderId)}</p></div>
        <button class="pay-btn ghost" data-act="back">Close for now</button>`;
    } else if (state === 'resume') {
      body = `<div class="pay-status" role="status"><p class="ps-big">You have an unfinished order</p><p class="ps-small">Let’s check on it with the shop before anything else, so nothing gets ordered twice.</p></div>
        <div class="pay-row"><button class="pay-btn" data-act="resume">Check status</button><button class="pay-btn ghost" data-act="back">Back to receipt</button></div>`;
    } else if (paid) {
      body = `<div class="pay-status" role="status"><span class="ok-badge" aria-hidden="true">✓</span><p class="ps-big">Payment confirmed!</p><p class="ps-small">Paid with ${esc(order.methodName || 'the shop')}. Your pins drop into the PUSH door when you close this ♡</p></div>
        <button class="pay-btn dl-btn" data-act="download">${DL_SVG} Download receipt</button>
        <button class="pay-btn ghost" data-act="home">Back to the machine ♡</button>`;
    } else {
      const T = {
        cancelled: ['Order cancelled', 'No worries! Your pins are still in your order.'],
        refund: ['Paid, but a pin sold out', 'A pin sold out while you were paying. The shop will refund you.'],
        refunded: ['Order refunded', 'The shop refunded this order. Your pins are still in your cart if you’d like to try again.'],
        stock: ['A pin just sold out', 'We updated your receipt and total. Please check it before paying.'],
        closed: ['The shop is closed', SETTINGS.closed_msg],
        nomethods: ['Payments aren’t set up yet', 'Please check back soon ♡'],
        error: ['Something went wrong', info.msg || 'Please try again.'],
      }[state];
      const back = ['stock', 'refund', 'refunded', 'closed', 'nomethods'].includes(state);
      body = `<div class="pay-status is-bad" role="alert"><p class="ps-big">${T[0]}</p><p class="ps-small">${esc(T[1])}</p></div>
        <div class="pay-row">${back
          ? `<button class="pay-btn" data-act="back">${state === 'stock' ? 'Review receipt' : 'Back to receipt'}</button>`
          : '<button class="pay-btn" data-act="retry">Try again</button><button class="pay-btn ghost" data-act="back">Back to receipt</button>'}</div>`;
    }
    const foot = paid ? '' : '<div class="pay-foot"><span>🔒 You pay the shop directly. The shop checks every payment by hand ♡</span></div>';
    el.payBody.innerHTML = head + receipt + `<div class="pay-main">${body}${foot}</div>`;

    // the machine's own QR screen mirrors the pop-up
    if (state === 'instructions' && cm.qr_url) qrShow(cm.qr_url, c.amount);
    else if (paid) qrThanks();
    else if (state !== 'busy') qrIdle();
    if (state === 'waiting') startPoll();
  }

  // Waiting for the owner's approval: ask the server every 5 s, but only while the tab is visible.
  function startPoll() {
    stopPoll();
    payPoll = setInterval(pollTick, 5000);
  }
  async function pollTick() {
    if (document.visibilityState !== 'visible' || polling || S.paying || S.payState !== 'waiting' || S.view !== 'payment') return;
    polling = true;
    try { await syncStatus(); } catch (err) { /* offline for a moment: the next tick tries again */ } finally { polling = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollTick(); });

  /* ---------- downloadable receipt (PNG drawn on a canvas) ---------- */
  function svgImage(svg) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" '));
    });
  }

  function receiptCanvas(order, imgs) {
    const W = 720, PAD = 70, PW = W - PAD * 2, ROW = 78;
    const H = 380 + order.lines.length * ROW + 340;
    const cv = document.createElement('canvas');
    const k = 2;
    cv.width = W * k; cv.height = H * k;
    const g = cv.getContext('2d');
    g.scale(k, k);
    const INK = '#2c2554', MAROON = '#8e1d39', HOT = '#ff7fa7', GREY = '#68615c';

    // background: lilac → pink with polka dots
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#ece0ff'); bg.addColorStop(1, '#ffe4ef');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.8)';
    for (let yy = 0, r = 0; yy < H + 36; yy += 18, r++) for (let xx = r % 2 ? 18 : 0; xx < W + 36; xx += 36) { g.beginPath(); g.arc(xx, yy, 3, 0, 7); g.fill(); }

    // paper with a zig-zag bottom edge
    const top = 40, bottom = H - 54, zig = 14;
    const paper = () => {
      g.beginPath();
      g.moveTo(PAD + 22, top); g.lineTo(PAD + PW - 22, top); g.quadraticCurveTo(PAD + PW, top, PAD + PW, top + 22);
      g.lineTo(PAD + PW, bottom);
      for (let xx = PAD + PW; xx > PAD; xx -= zig * 2) { g.lineTo(xx - zig, bottom + zig); g.lineTo(Math.max(PAD, xx - zig * 2), bottom); }
      g.lineTo(PAD, top + 22); g.quadraticCurveTo(PAD, top, PAD + 22, top); g.closePath();
    };
    g.save(); g.translate(10, 12); paper(); g.fillStyle = 'rgba(44,37,84,.15)'; g.fill(); g.restore();
    paper(); g.fillStyle = '#fffdf6'; g.fill(); g.lineWidth = 6; g.strokeStyle = INK; g.lineJoin = 'round'; g.stroke();

    const cx = W / 2;
    const text = (s, x, y, font, color = INK, align = 'center') => { g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y); };
    const dash = (y) => { g.save(); g.setLineDash([8, 7]); g.lineWidth = 2; g.strokeStyle = '#a69e93'; g.beginPath(); g.moveTo(PAD + 30, y); g.lineTo(PAD + PW - 30, y); g.stroke(); g.restore(); };

    // brand: KL!KPIN with the pink bang
    g.font = '400 64px "Luckiest Guy", Fredoka, sans-serif';
    const parts = [['KL', MAROON], ['!', HOT], ['KPIN', MAROON]];
    const tw = parts.reduce((a, [s]) => a + g.measureText(s).width, 0);
    let x = cx - tw / 2;
    g.textAlign = 'left';
    parts.forEach(([s, c]) => { g.fillStyle = '#fff'; g.fillText(s, x + 4, 128); g.fillStyle = c; g.fillText(s, x, 124); x += g.measureText(s).width; });
    text('BUTTON PIN MACHINE', cx, 160, '400 17px Silkscreen, monospace', '#2a3a92');
    text(`ORDER #${order.orderId}`, cx, 206, '700 18px "Space Mono", monospace');
    text(stamp(order.paidAt), cx, 232, '400 16px "Space Mono", monospace', GREY);

    // PAID stamp
    g.save(); g.translate(PAD + PW - 92, 96); g.rotate(-0.16);
    g.lineWidth = 4; g.strokeStyle = '#2f8a66'; g.beginPath();
    if (g.roundRect) g.roundRect(-58, -26, 116, 48, 10); else g.rect(-58, -26, 116, 48);
    g.stroke();
    text('PAID', 0, 11, '400 26px Silkscreen, monospace', '#2f8a66');
    g.restore();

    dash(262);
    text('YOUR PINS', cx, 296, '700 17px "Space Mono", monospace', GREY);
    let y = 318;
    order.lines.forEach((l, i) => {
      if (imgs[i]) g.drawImage(imgs[i], PAD + 34, y + 8, 56, 56);
      text(`${l.qty}x`, PAD + 106, y + 45, '700 22px "Space Mono", monospace', HOT, 'left');
      text(l.name, PAD + 158, y + 45, '600 25px Fredoka, sans-serif', INK, 'left');
      text(money(l.qty * l.price), PAD + PW - 36, y + 45, '700 22px "Space Mono", monospace', INK, 'right');
      y += ROW;
    });
    y += 8; dash(y); y += 40;
    text(`ITEMS  ${order.count}`, PAD + 36, y, '400 17px "Space Mono", monospace', GREY, 'left');
    y += 50;
    text('TOTAL PAID', PAD + 36, y, '700 22px "Space Mono", monospace', INK, 'left');
    text(money(order.total), PAD + PW - 36, y + 4, '400 46px "Luckiest Guy", sans-serif', MAROON, 'right');
    y += 28; dash(y);
    text(`paid with ${order.methodName || 'the shop'} · ${order.currency}`, cx, y + 40, '400 16px "Space Mono", monospace', GREY);
    // barcode
    let bx = cx - 120; const by = y + 64;
    g.fillStyle = INK;
    for (let i = 0; bx < cx + 120; i++) { const w = [2, 4, 1, 3, 2, 1][i % 6]; g.fillRect(bx, by, w, 40); bx += w + [2, 3, 2, 4][i % 4]; }
    text('a little pin, a little joy ♡', cx, by + 80, '600 21px Fredoka, sans-serif', MAROON);
    return cv;
  }

  async function downloadReceipt(order) {
    if (!order) return;
    try {
      if (document.fonts && document.fonts.load) {
        await Promise.all(['40px "Luckiest Guy"', '600 20px Fredoka', '400 20px "Space Mono"', '700 20px "Space Mono"', '20px Silkscreen']
          .map((f) => document.fonts.load(f).catch(() => {})));
      }
      const imgs = await Promise.all(order.lines.map((l) => svgImage(pinSVG(byId[l.id]))));
      const cv = receiptCanvas(order, imgs);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
      if (!blob) throw new Error('no image');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `klikpin-receipt-${order.orderId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      track('receipt_downloaded', { orderId: order.orderId });
      toast('Receipt saved ♡');
      sfx.ding();
    } catch (err) {
      console.error(err);
      toast('Couldn’t save the receipt — please try again');
    }
  }

  // An order we must pick up again instead of creating a second one: waiting for approval (always), or
  // pending with the same cart total (a changed cart needs a fresh order).
  function resumableState() {
    const c = S.checkout;
    if (!c.token) return null;
    if (c.status === 'waiting') return 'waiting';
    if (c.status === 'instructions' && c.amount === totals().subtotal) return 'instructions';
    return null;
  }

  function confirmOrder() {
    const t = totals();
    if (!t.count) { toast('Add at least one pin first ♡'); return; }
    if (checkoutBlock()) { toast(checkoutBlock()); sfx.err(); lcdFlash(SETTINGS.open ? 'NO PAYMENTS' : 'SHOP CLOSED', 2200); return; }
    track('order_confirmed', { count: t.count, total: t.subtotal, orderId: S.checkout.orderId });
    if (!METHODS.some((m) => m.id === S.method)) S.method = METHODS[0].id;
    renderPay(resumableState() || 'select');
    setView('payment', { focus: true });
  }

  // Closing the pop-up keeps the order: confirming again picks it up. Only the Cancel button cancels it.
  function backToReceipt() {
    if (S.paying) return;
    stopPoll();
    qrIdle();
    setView('receipt', { focus: true });
  }

  function applyStockProblems(problems) {
    problems.forEach(({ id, available }) => {
      if (byId[id]) byId[id].stock = available; // the server knows better than our cached catalog
      if (available <= 0) cart.flagged[id] = 'soldout';
      else { cart.items[id] = available; cart.flagged[id] = 'reduced'; }
      updateSlot(id);
    });
    saveCart();
    updateHUD();
    lcdIdle();
    afterReceiptEdit(); // the receipt behind the pop-up must show the corrected lines and total
  }

  function stockBlocked(problems) {
    applyStockProblems(problems);
    renderPay('stock');
    sfx.err();
    track('checkout_blocked', { reason: 'stock', items: problems.map((p) => p.id) });
  }

  // Forget the current order (best effort cancel; a no-op on the server unless it is still pending).
  function dropCheckout() {
    if (S.checkout.token) PAY.cancelOrder(S.checkout.orderId, S.checkout.token).catch(() => {});
    S.checkout = {}; saveCheckout();
    setProof(null);
  }

  async function startPayment() {
    if (S.paying) return;
    const t = totals();
    if (!t.count) { toast('Add at least one pin first ♡'); return; }
    if (checkoutBlock()) { renderPay(SETTINGS.open ? 'nomethods' : 'closed'); return; }
    const again = resumableState();
    if (again) { renderPay(again); return; } // never a second order for the same cart
    dropCheckout();
    S.paying = true;
    const method = METHODS.find((m) => m.id === S.method) || METHODS[0];
    track('payment_started', { method: method.id, amount: t.subtotal });
    try {
      renderPay('busy', { msg: 'Setting up your order…' });
      const res = await PAY.createOrder(payableLines(), method.id);
      if (res.problems && res.problems.length) { stockBlocked(res.problems); return; }
      S.checkout = { orderId: res.order_id, token: res.token, status: 'instructions', amount: res.total_cents / 100, method: res.method };
      saveCheckout();
      renderPay('instructions');
      sfx.key();
    } catch (err) {
      handlePayError(err);
    } finally {
      S.paying = false;
    }
  }

  // The customer picked a screenshot: shrink it now so an undecodable file (HEIC…) is caught right away.
  async function pickProof(file) {
    if (!file || S.paying) return;
    try {
      setProof(await PAY.compressImage(file));
      S.checkout.proofPath = null; saveCheckout(); // a new picture means a new upload
      renderPay('instructions');
    } catch (err) {
      renderPay('instructions', { err: ERR_TEXT[err.code] || ERR_TEXT.bad_image });
    }
    const f = $('[data-act="send"]', el.payBody);
    if (f && !f.disabled) f.focus({ preventScroll: true });
  }

  // Upload the screenshot, then tell the shop. A failure after the order exists leads to "check status", never a new order.
  async function sendPayment() {
    const c = S.checkout;
    if (S.paying || !c.token) return;
    const cash = c.method && c.method.kind === 'cash';
    if (!cash && !S.proof) { renderPay('instructions', { err: ERR_TEXT.proof_required }); return; }
    S.paying = true;
    try {
      renderPay('busy', { msg: cash ? 'Reserving your pins…' : 'Sending your payment…' });
      let path = null;
      if (!cash) {
        path = c.proofPath || await PAY.uploadProof(c.orderId, S.proof.blob);
        c.proofPath = path; saveCheckout(); // if the next call fails, retrying reuses the upload
      }
      const res = await PAY.submitPayment(c.orderId, c.token, path);
      if (res.problems && res.problems.length) { // cash only: the pending order has stale lines, so start over from the corrected receipt
        dropCheckout();
        stockBlocked(res.problems);
        return;
      }
      if (res.status === 'needs_refund') return applyStatus({ status: 'needs_refund' });
      track('payment_submitted', { orderId: c.orderId, method: c.method.id });
      c.status = 'waiting'; c.rejectReason = ''; saveCheckout();
      setProof(null);
      renderPay('waiting');
      sfx.key();
    } catch (err) {
      handlePayError(err);
    } finally {
      S.paying = false;
    }
  }

  async function resumePayment() {
    if (S.paying) return;
    S.paying = true;
    try { renderPay('busy', { msg: 'Checking your order…' }); await syncStatus(); } catch (err) { handlePayError(err); } finally { S.paying = false; }
  }

  // Ask the server where the order stands (only its answer counts as paid, FR-12) and show the matching screen.
  async function syncStatus() {
    const c = S.checkout;
    const res = await PAY.orderStatus(c.orderId, c.token);
    applyStatus(res);
  }

  function applyStatus({ status, reject_reason: reason, order }) {
    const c = S.checkout;
    if (status === 'paid' || status === 'packed' || status === 'collected') return onPaid(order);
    if (status === 'submitted') {
      if (S.payState !== 'waiting' || c.status !== 'waiting') { c.status = 'waiting'; saveCheckout(); renderPay('waiting'); }
      return;
    }
    if (status === 'pending' || status === 'rejected') {
      c.status = 'instructions'; c.rejectReason = status === 'rejected' ? (reason || 'The shop couldn’t confirm your payment.') : ''; saveCheckout();
      if (status === 'rejected') { sfx.err(); track('payment_failed', { reason: 'rejected', orderId: c.orderId }); }
      renderPay('instructions');
      return;
    }
    // cancelled / needs_refund / refunded: this order is over
    track(status === 'cancelled' ? 'payment_cancelled' : 'payment_failed', { by: 'shop', reason: status, orderId: c.orderId });
    S.checkout = {}; saveCheckout(); setProof(null);
    if (status !== 'cancelled') reloadShop();
    sfx.err();
    renderPay(status === 'needs_refund' ? 'refund' : status);
  }

  async function cancelPayment() {
    if (S.paying) return;
    S.paying = true;
    try {
      renderPay('busy', { msg: 'Cancelling…' });
      const { status } = await PAY.cancelOrder(S.checkout.orderId, S.checkout.token);
      if (status === 'cancelled') { track('payment_cancelled', { by: 'customer', orderId: S.checkout.orderId }); S.checkout = {}; saveCheckout(); setProof(null); renderPay('cancelled'); }
      else await syncStatus(); // it moved on (e.g. already submitted): show where it really is
    } catch (err) {
      handlePayError(err);
    } finally {
      S.paying = false;
    }
  }

  function handlePayError(err) {
    sfx.err();
    const code = err && err.code;
    if (code === 'shop_closed') { SETTINGS.open = false; lcdIdle(); afterReceiptEdit(); renderPay('closed'); return; }
    if (code === 'bad_method') { reloadShop().then(() => { if (!METHODS.some((m) => m.id === S.method)) S.method = (METHODS[0] || {}).id; renderPay(METHODS.length ? 'select' : 'nomethods'); toast('That payment method isn’t available any more ♡'); }); return; }
    if (code === 'bad_lines' || code === 'unknown_pin') { reloadShop().then(() => { if (S.view === 'receipt' || S.view === 'payment') afterReceiptEdit(); }); renderPay('stock'); return; }
    if (S.checkout.token) {
      if (code === 'not_found') { S.checkout = {}; saveCheckout(); renderPay('error', { msg: 'We couldn’t find that order any more. Please start again.' }); return; }
      if (code === 'bad_state') { resumePayment(); return; } // the order moved on without us
      if (code === 'bad_proof') { S.checkout.proofPath = null; saveCheckout(); renderPay('instructions', { err: ERR_TEXT.bad_proof }); return; }
      if (code === 'proof_required') { renderPay('instructions', { err: ERR_TEXT.proof_required }); return; }
      if (code === 'upload_failed') { renderPay('instructions', { err: err.message }); return; }
      renderPay('resume'); // network or unknown: the order may have gone through, so re-check, don't re-order
      return;
    }
    track('payment_failed', { reason: 'error', message: err && err.message });
    renderPay('error', { msg: err && err.message });
  }

  function onPaid(o) {
    const order = {
      orderId: o.order_id, methodName: o.method_name,
      lines: o.lines.map((l) => ({ id: l.pin_id, name: l.name, qty: l.qty, price: l.unit_price_cents / 100 })),
      count: o.lines.reduce((a, l) => a + l.qty, 0), total: o.total_cents / 100, currency: o.currency || CUR.code, paidAt: o.paid_at,
    };
    track('payment_succeeded', { orderId: order.orderId, amount: order.total, method: order.methodName });
    cart.items = {}; cart.flagged = {}; saveCart(); // the order now lives on the server; clear the cart
    S.checkout = {}; saveCheckout(); setProof(null);
    S.lastOrder = order;
    refreshCartUI();
    renderPay('success', { order });
    sfx.success();
    lcdFlash('PAID! THANK YOU <3', 3200);
    reloadShop(); // stock badges
    announce(`Payment confirmed. Order ${order.orderId}. You can download your receipt. Close it to collect your pins from the pickup door.`);
  }

  function finishToHome() {
    if (S.view !== 'payment' || S.payState !== 'success') return;
    const order = S.lastOrder;
    setView('home', { focus: true });
    later(() => { qrIdle(); dropPins(order); }, 750);
  }

  // the QR picture, big: a plain overlay so it is easy to scan from another phone
  function zoomQr() {
    const url = (S.checkout.method || {}).qr_url;
    if (!url) return;
    const z = document.createElement('div');
    z.className = 'qr-zoom';
    z.setAttribute('role', 'dialog'); z.setAttribute('aria-label', 'Payment QR code');
    z.innerHTML = `<img src="${esc(url)}" alt="Payment QR code"><button class="pay-btn" data-act="qrclose">Close</button>`;
    z.addEventListener('click', () => { z.remove(); const b = $('[data-act="zoomqr"]', el.payBody); if (b) b.focus({ preventScroll: true }); });
    el.payModal.appendChild(z);
    $('button', z).focus({ preventScroll: true });
  }

  el.payBody.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const a = b.dataset.act;
    if (a === 'pay' || a === 'retry') startPayment();
    else if (a === 'send') sendPayment();
    else if (a === 'cancel') cancelPayment();
    else if (a === 'back') backToReceipt();
    else if (a === 'resume') resumePayment();
    else if (a === 'home') finishToHome();
    else if (a === 'download') downloadReceipt(S.lastOrder);
    else if (a === 'zoomqr') zoomQr();
    else if (a === 'copy') {
      const done = () => { toast('Copied ♡'); sfx.key(); };
      (navigator.clipboard ? navigator.clipboard.writeText(b.dataset.v) : Promise.reject()).then(done, () => toast('Couldn’t copy. Select the text instead ♡'));
    }
  });
  // tapping the frosted glass closes the pop-up (when nothing is in flight)
  el.payModal.addEventListener('click', (e) => {
    if (e.target.dataset.act !== 'dismiss' || S.paying) return;
    if (S.payState === 'success') finishToHome();
    else if (S.payState !== 'busy') backToReceipt();
  });
  el.payBody.addEventListener('change', (e) => {
    if (e.target.name === 'pm') { S.method = e.target.value; sfx.key(); }
    if (e.target.id === 'proofFile') pickProof(e.target.files[0]);
  });

  /* =========================================================
     PUSH DOOR — pins drop after payment
     ========================================================= */
  function dropPins(order) {
    if (!order) return;
    const ids = [];
    order.lines.forEach((l) => { for (let i = 0; i < l.qty; i++) ids.push(l.id); });
    el.tray.innerHTML = '';
    const W = el.tray.clientWidth, H = el.tray.clientHeight;
    const size = Math.min(84, H * 0.8);
    const shown = ids.slice(0, 16);
    const step = shown.length > 1 ? Math.min(size * 0.9, (W - size - 24) / (shown.length - 1)) : 0;
    const startX = (W - (step * (shown.length - 1) + size)) / 2;
    shown.forEach((id, i) => {
      const d = document.createElement('div');
      d.className = 'drop-pin';
      d.innerHTML = pinSVG(byId[id]);
      d.style.cssText = `left:${startX + i * step}px;width:${size}px;height:${size}px;--rot:${Math.round(Math.random() * 50 - 25)}deg;animation-delay:${reduce ? 0 : i * 130}ms`;
      el.tray.appendChild(d);
      if (!reduce || i === 0) later(() => {
        if (el.tray.contains(d)) sfx.thunk();
      }, i * 130 + 437);
    });
    el.push.classList.add('has-pins');
    const firstPin = el.tray.firstElementChild;
    later(() => {
      if (!firstPin || !el.tray.contains(firstPin)) return;
      const r = el.flap.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height * .65, [], { small: true });
    }, 437);
    later(() => {
      if (firstPin && el.tray.contains(firstPin)) sfx.ding();
    }, Math.max(0, shown.length - 1) * 130 + 1150);
    el.flap.setAttribute('aria-label', `Push the flap to collect your ${ids.length} pin${ids.length === 1 ? '' : 's'}`);
    toast('Your pins dropped! Push the flap to collect ♡', 3600);
  }

  function collect() {
    if (el.flap.classList.contains('open')) return;
    const duration = reduce ? 60 : 1050;
    el.flap.style.setProperty('--flap-duration', `${duration}ms`);
    el.flap.classList.add('open');
    setTimeout(() => el.flap.classList.remove('open'), duration);
    if (!el.push.classList.contains('has-pins')) {
      toast('Nothing here yet — pick some pins first ♡');
      sfx.key();
      return;
    }
    const ids = [...el.tray.querySelectorAll('.drop-pin')].map((_, i) => S.lastOrder.lines.flatMap((l) => Array(l.qty).fill(l.id))[i]);
    setTimeout(() => {
      sfx.collect();
      const r = el.flap.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, ids);
    }, duration * .55);
    setTimeout(() => {
      el.tray.innerHTML = '';
      el.push.classList.remove('has-pins');
      el.flap.setAttribute('aria-label', 'Push the flap to collect your pins');
    }, duration * .72);
    toast(`Enjoy your pins! ♡ Order #${S.lastOrder.orderId}`, 3200);
    track('pins_collected', { orderId: S.lastOrder.orderId });
  }

  function burst(x, y, ids, { small = false } = {}) {
    if (reduce) return;
    const colors = ['#ff7fa7', '#ffe066', '#7ed8b1', '#b9a7ff', '#7cc8ff'];
    for (let i = 0; i < (small ? 14 : 30); i++) {
      const d = document.createElement('span');
      d.className = 'confetti-bit';
      if (small) { d.textContent = i % 2 ? '✦' : '♡'; d.style.color = colors[i % 5]; }
      else if (i < Math.min(ids.length, 10)) { d.classList.add('is-pin'); d.innerHTML = pinSVG(byId[ids[i]]); }
      else if (i % 3 === 0) { d.textContent = '♡'; d.style.color = colors[i % 5]; }
      else d.style.background = colors[i % 5];
      d.style.left = x + 'px'; d.style.top = y + 'px';
      el.confetti.appendChild(d);
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
      const dist = small ? 50 + Math.random() * 70 : 140 + Math.random() * 280;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
      const anim = d.animate([
        { transform: 'translate(-50%,-50%) scale(.3) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${Math.random() * 360 - 180}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + (small ? 90 : 260)}px)) scale(.9) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 },
      ], { duration: small ? 850 + Math.random() * 250 : 1400 + Math.random() * 700, easing: 'cubic-bezier(.2,.7,.3,1)' });
      anim.onfinish = () => d.remove();
    }
  }

  /* =========================================================
     SOUND (tiny WebAudio blips, can be muted)
     ========================================================= */
  const sfx = (() => {
    let ctx;
    function ac() {
      if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(f, d = 0.12, type = 'sine', vol = 0.08, when = 0, slideTo) {
      if (S.muted) return;
      const c = ac(); if (!c) return;
      const t = c.currentTime + when;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + d + 0.03);
    }
    return {
      add() { tone(880, 0.09, 'triangle', 0.09); tone(1320, 0.13, 'triangle', 0.07, 0.07); },
      remove() { tone(660, 0.12, 'triangle', 0.07, 0, 420); },
      slide() { tone(480, 0.16, 'sine', 0.05, 0, 820); },
      key() { tone(1000 + Math.random() * 400, 0.05, 'square', 0.025); },
      zoom() { tone(380, 0.28, 'sine', 0.03, 0, 720); },
      lift() { tone(520, 0.2, 'triangle', 0.05, 0, 1180); tone(1568, 0.14, 'sine', 0.035, 0.16); },
      print() { // soft continuous paper-feed whirr
        if (S.muted) return;
        const c = ac(); if (!c) return;
        const t = c.currentTime, d = 2.3;
        const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), g = c.createGain(), f = c.createBiquadFilter();
        o.type = 'sawtooth'; o.frequency.value = 120;
        lfo.frequency.value = 9; lg.gain.value = 14;
        lfo.connect(lg).connect(o.frequency);
        f.type = 'lowpass'; f.frequency.value = 700;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.03, t + 0.25);
        g.gain.setValueAtTime(0.03, t + d - 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(f).connect(g).connect(c.destination);
        o.start(t); lfo.start(t); o.stop(t + d + 0.05); lfo.stop(t + d + 0.05);
      },
      ding() { tone(1568, 0.12, 'sine', 0.05); tone(2093, 0.25, 'sine', 0.04, 0.08); },
      err() { tone(240, 0.16, 'square', 0.035); tone(190, 0.2, 'square', 0.035, 0.12); },
      success() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.2, 'triangle', 0.08, i * 0.1)); },
      thunk() { tone(150, 0.13, 'sine', 0.1, 0, 70); },
      collect() { [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.14, 'sine', 0.06, i * 0.06)); },
      coin() { tone(1568, 0.08, 'square', 0.03); tone(2093, 0.2, 'square', 0.03, 0.08); },
    };
  })();

  function applyMute() {
    el.mute.setAttribute('aria-pressed', String(S.muted));
    el.mute.setAttribute('aria-label', S.muted ? 'Sound is off. Turn sound on' : 'Sound is on. Turn sound off');
    el.mute.innerHTML = S.muted ? ICON.muted : ICON.sound;
  }

  /* =========================================================
     UI helpers
     ========================================================= */
  let toastTimer;
  function toast(msg, ms = 2600) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }
  function announce(msg) {
    el.sr.textContent = '';
    setTimeout(() => { el.sr.textContent = msg; }, 40);
  }

  function drawStripes() {
    const cs = getComputedStyle(el.machine);
    const w = parseFloat(cs.getPropertyValue('--face-w'));
    const h = el.machine.offsetHeight;
    const k = parseFloat(cs.getPropertyValue('--stripe-k')) || 1;
    const m = 0.86;
    // navy bands, measured as distance up from the bottom-left corner (white gaps between them)
    const bands = [[612, 562], [514, 462], [418, 366], [326, 0]].map(([a, b]) => [a * k, b * k]);
    el.stripes.setAttribute('viewBox', `0 0 ${w} ${h}`);
    el.stripes.setAttribute('width', w);
    el.stripes.setAttribute('height', h);
    el.stripes.innerHTML = bands.map(([d1, d2]) => {
      const pts = d2 === 0
        ? `0,${h - d1} ${d1 / m},${h} 0,${h}`
        : `0,${h - d1} ${d1 / m},${h} ${d2 / m},${h} 0,${h - d2}`;
      return `<polygon points="${pts}"/>`;
    }).join('');
  }

  const STAR5 = (() => {
    const p = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 11 : 24;
      p.push((30 + r * Math.cos(a)).toFixed(1) + ' ' + (31 + r * Math.sin(a)).toFixed(1));
    }
    return 'M' + p.join('L') + 'Z';
  })();
  const FLOWER = (() => {
    let d = '';
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const x = 30 + 13 * Math.cos(a), y = 30 + 13 * Math.sin(a);
      d += `M${(x + 10).toFixed(1)} ${y.toFixed(1)}a10 10 0 1 0 -20 0a10 10 0 1 0 20 0z`;
    }
    return d;
  })();
  const STICKERS = {
    heart: { d: 'M30 52C10 40 6 26 14 18c6-6 13-3 16 2 3-5 10-8 16-2 8 8 4 22-16 34z', fill: '#ff8fb1', face: [30, 31, 0.5], shine: 'M15 24q2-5 7-6' },
    star: { d: STAR5, fill: '#ffe27a', shine: 'M24 22l3-6' },
    sparkle: { d: 'M30 4Q33 27 56 30Q33 33 30 56Q27 33 4 30Q27 27 30 4Z', fill: '#bfe3ff', shine: 'M28 16v6' },
    rect: { d: 'M10 18h40a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z', fill: '#bfe3ff', shine: 'M12 24h8' },
    rectY: { d: 'M10 18h40a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z', fill: '#ffe98f', shine: 'M12 24h8' },
    flower: { d: FLOWER, fill: '#fff', center: true, shine: 'M22 14q3-3 6-3' },
  };
  function buildStickers() {
    document.querySelectorAll('.sticker').forEach((node) => {
      const s = STICKERS[node.dataset.shape];
      node.innerHTML = `<svg viewBox="0 0 60 60">
        <path d="${s.d}" fill="#2c2554" stroke="#2c2554" stroke-width="11" stroke-linejoin="round"/>
        <path d="${s.d}" fill="#fff" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>
        <path d="${s.d}" fill="${s.fill}" ${s.center ? 'stroke="#2c2554" stroke-width="1.5"' : ''}/>
        ${s.center ? '<circle cx="30" cy="30" r="9" fill="#ffd84d" stroke="#2c2554" stroke-width="2.5"/>' : ''}
        ${s.face ? face(...s.face) : ''}
        <path d="${s.shine}" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".85"/>
      </svg>`;
    });
    // little cat peeking over the barcode on the side panel
    const catSVG = `<svg viewBox="0 0 60 60">
      <g stroke-linejoin="round">
        <path d="M12 26 14 8l14 10zM48 26 46 8 32 18z" fill="#2c2554" stroke="#2c2554" stroke-width="10"/>
        <ellipse cx="30" cy="34" rx="22" ry="18" fill="#2c2554" stroke="#2c2554" stroke-width="10"/>
        <path d="M12 26 14 8l14 10zM48 26 46 8 32 18z" fill="#fff" stroke="#fff" stroke-width="6"/>
        <ellipse cx="30" cy="34" rx="22" ry="18" fill="#fff" stroke="#fff" stroke-width="6"/>
        <path d="M12 26 14 8l14 10zM48 26 46 8 32 18z" fill="#fff" stroke="#3b2a4a" stroke-width="2"/>
        <ellipse cx="30" cy="34" rx="22" ry="18" fill="#fff" stroke="#3b2a4a" stroke-width="2"/>
        <path d="M40 18q8-6 7 8q-6-2-7-8z" fill="#ffb36b"/>
        <path d="M16 13 17 21l6-4z" fill="#ffb3c8"/>
      </g>
      ${face(30, 35, 0.75)}
    </svg>`;
    document.querySelectorAll('.cat-sticker').forEach((n) => { n.innerHTML = catSVG; });
  }

  function buildKeys() {
    el.keys.innerHTML = Array.from({ length: 9 }, (_, i) => `<button class="key" tabindex="-1" data-k="${i + 1}">${i + 1}</button>`).join('');
  }

  /* =========================================================
     EVENTS
     ========================================================= */
  // hover zoom (pointer devices) — FR-02
  let hoverInT, hoverOutT, hoverCool = false;
  el.win.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || !canHover) return;
    clearTimeout(hoverOutT);
    if (S.view === 'home' && !hoverCool) {
      hoverInT = setTimeout(() => {
        if (S.view === 'home') { setView('window', { via: 'hover' }); S.hoverZoom = true; }
      }, 220);
    }
  });
  el.win.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(hoverInT);
    if (S.view !== 'window' || !S.hoverZoom) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('.hud')) return;
    hoverOutT = setTimeout(() => {
      if (S.view === 'window' && S.hoverZoom) {
        setView('home');
        hoverCool = true;
        setTimeout(() => { hoverCool = false; }, 1000);
      }
    }, 550);
  });

  // tap / click / keyboard entry — FR-03
  el.winHit.addEventListener('click', (e) => {
    if (S.loadError) loadAndBuild(); // retry a failed catalog load
    clearTimeout(hoverInT);
    setView('window', { via: e.detail === 0 ? 'keyboard' : 'tap', focus: true });
    S.hoverZoom = false;
  });

  el.track.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b && S.view === 'window') {
      const id = b.closest('.slot-item').dataset.id;
      const act = b.dataset.act;
      if (act === 'zoom') openPinZoom(id, b);
      else if (act === 'inc') addPin(id, 'window');
      else removePin(id, 'window');
    }
  });
  el.prev.addEventListener('click', () => setBatch(S.batch - 1, 'arrow'));
  el.next.addEventListener('click', () => setBatch(S.batch + 1, 'arrow'));
  el.dots.addEventListener('click', (e) => { const d = e.target.closest('.dot'); if (d) setBatch(+d.dataset.i, 'dot'); });

  // swipe / drag batches
  const drag = { id: null, x0: 0, y0: 0, dx: 0, active: false, suppress: false };
  el.bv.addEventListener('pointerdown', (e) => {
    if (S.view !== 'window' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    Object.assign(drag, { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, active: false });
  });
  el.bv.addEventListener('pointermove', (e) => {
    if (drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        drag.active = true;
        try { el.bv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        el.track.classList.add('dragging');
      } else return;
    }
    drag.dx = dx / S.camScale;
    let off = drag.dx;
    if ((S.batch === 0 && off > 0) || (S.batch === S.pages.length - 1 && off < 0)) off *= 0.35;
    el.track.style.transform = `translateX(calc(${-S.batch * 100}% + ${off}px))`;
  });
  function endDrag(e) {
    if (drag.id !== e.pointerId) return;
    drag.id = null;
    if (!drag.active) return;
    drag.active = false;
    drag.suppress = true;
    setTimeout(() => { drag.suppress = false; }, 0);
    el.track.classList.remove('dragging');
    const W = el.bv.offsetWidth;
    if (drag.dx < -W * 0.16) setBatch(S.batch + 1, 'swipe');
    else if (drag.dx > W * 0.16) setBatch(S.batch - 1, 'swipe');
    else applyBatch();
  }
  el.bv.addEventListener('pointerup', endDrag);
  el.bv.addEventListener('pointercancel', endDrag);
  el.bv.addEventListener('click', (e) => { if (drag.suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
  el.bv.addEventListener('scroll', () => { el.bv.scrollLeft = 0; });

  let wheelLock = 0;
  el.bv.addEventListener('wheel', (e) => {
    if (S.view !== 'window') return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (Math.abs(d) < 12) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock) return;
    wheelLock = now + 650;
    setBatch(S.batch + (d > 0 ? 1 : -1), 'wheel');
  }, { passive: false });

  // keypad
  el.keys.addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (!k) return;
    sfx.key();
    lcdFlash('* ' + k.dataset.k + ' *', 700);
  });
  el.receiptKey.addEventListener('click', () => openReceipt('keypad'));
  el.chipReceipt.addEventListener('click', () => openReceipt('chip'));
  el.chipHome.addEventListener('click', () => setView('home', { focus: true }));
  el.flap.addEventListener('click', collect);
  el.tabs.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setCategory(t.dataset.cat); });
  el.rWrap.addEventListener('animationend', (e) => {
    if (e.target !== el.rWrap || e.animationName !== 'receipt-processing' || S.view !== 'receipt') return;
    el.rWrap.classList.remove('printing');
    el.rWrap.classList.add('unrolling');
    lcdFlash('UNROLLING...', 850);
  });
  el.receipt.addEventListener('animationend', (e) => {
    if (e.target !== el.receipt || e.animationName !== 'receipt-unroll' || S.view !== 'receipt') return;
    el.rWrap.classList.remove('unrolling');
    el.receipt.inert = false;
    sfx.ding();
    $('#rTitle').focus({ preventScroll: true });
    if (el.rWrap.offsetHeight !== el.receipt.offsetHeight) {
      el.rWrap.classList.add('adjust');
      el.rWrap.style.height = el.receipt.offsetHeight + 'px';
    }
  });
  // keep the receipt fully visible if fonts nudge its height after printing
  el.rWrap.addEventListener('transitionend', (e) => {
    if (e.target !== el.rWrap || e.propertyName !== 'height' || S.view !== 'receipt') return;
    if (el.rWrap.offsetHeight !== el.receipt.offsetHeight) {
      el.rWrap.classList.add('adjust');
      el.rWrap.style.height = el.receipt.offsetHeight + 'px';
    }
  });
  el.mute.addEventListener('click', () => { S.muted = !S.muted; store.set('klikpin_muted', S.muted); applyMute(); sfx.key(); });

  // click away from the window to step back
  el.viewport.addEventListener('click', (e) => {
    if (S.view === 'window' && !S.hoverZoom && !el.win.contains(e.target) && !el.panel.contains(e.target)) setView('home', { focus: true });
    else if (S.view === 'receipt' && (e.target === el.viewport || e.target === el.camera)) setView('home', { focus: true });
  });

  document.addEventListener('keydown', (e) => {
    if (pz.id) { // the pin close-up is on top of everything: Esc closes it, nothing else moves
      if (e.key === 'Escape') { e.preventDefault(); closePinZoom(); }
      return;
    }
    if (e.key !== 'Escape' && e.target.matches && e.target.matches('select, input, textarea')) return;
    if (e.key === 'Escape') {
      if (S.view === 'window') setView('home', { focus: true });
      else if (S.view === 'receipt') setView('window', { focus: true, via: 'escape' });
      else if (S.view === 'payment' && !S.paying && ['select', 'cancelled', 'stock', 'refund', 'refunded', 'closed', 'nomethods', 'error', 'instructions', 'waiting', 'resume'].includes(S.payState)) backToReceipt();
      else if (S.view === 'payment' && S.payState === 'success') finishToHome();
    }
    if (S.view === 'window' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const hadFocus = el.winInner.contains(document.activeElement);
      setBatch(S.batch + (e.key === 'ArrowRight' ? 1 : -1), 'keyboard');
      if (hadFocus) {
        requestAnimationFrame(() => {
          const f = el.track.querySelector(`.page[data-batch="${S.batch}"] button[data-act="inc"]:not(:disabled)`);
          if (f) f.focus({ preventScroll: true });
        });
      }
    }
  });

  // never let focus scroll the stage
  el.viewport.addEventListener('scroll', () => { el.viewport.scrollTop = 0; el.viewport.scrollLeft = 0; });

  let rzT;
  const onResize = () => {
    clearTimeout(rzT);
    rzT = setTimeout(() => {
      root.classList.add('no-anim');
      drawStripes();
      if (currentPageSize() !== S.pageSize) {
        const first = S.pages[S.batch] && S.pages[S.batch][0];
        buildPages(first);
      }
      if (S.view === 'receipt') {
        el.rWrap.style.height = el.receipt.offsetHeight + 'px';
        el.rWrap.style.setProperty('--receipt-height', el.receipt.offsetHeight + 'px');
      }
      frameView();
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
    }, 60);
  };
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(el.viewport);

  window.addEventListener('pagehide', () => {
    if ((S.view === 'receipt' || S.view === 'payment') && lines().length) track('checkout_abandoned', { view: S.view, orderId: S.checkout.orderId });
  });

  /* =========================================================
     INIT
     ========================================================= */
  async function applyShop() {
    const c = await loadShop();
    PINS = c.pins; CATEGORIES = c.categories; SETTINGS = c.settings; METHODS = c.methods;
    byId = Object.fromEntries(PINS.map((p) => [p.id, p]));
  }

  // After a payment (or a server-side change): re-fetch so stock, prices and settings are current. Keeps the current category; failure is non-fatal.
  async function reloadShop() {
    try {
      await applyShop();
      Object.keys(cart.items).forEach((id) => { if (!byId[id]) { delete cart.items[id]; delete cart.flagged[id]; } }); // a pin the shop removed
      saveCart();
      buildPages(); updateHUD(); lcdIdle();
    } catch (err) { console.error(err); }
  }

  async function loadAndBuild() {
    if (S.loading) return;
    S.loading = true; S.loadError = false;
    lcdIdle();
    try {
      await applyShop();
      restoreCart();
      buildTabs();
      buildPages();
    } catch (err) {
      console.error(err);
      S.loadError = true;
      toast('Couldn’t load the pins. Tap the window to try again ♡', 5000);
      announce('Couldn’t load the pins. Activate the window to try again.');
    }
    S.loading = false;
    lcdIdle();
    updateHUD();
    if (S.loadError) return;

    // came back mid-checkout (refresh / back button): ask the shop where the order stands before anything else
    if (S.checkout.token && ['instructions', 'waiting'].includes(S.checkout.status) && lines().length) {
      setTimeout(() => {
        renderPay('resume');
        setView('payment', { focus: true });
      }, 700);
    }
  }

  async function init() {
    buildStickers();
    buildKeys();
    qrIdle();
    lcdIdle();
    drawStripes();
    applyMute();
    el.hint.textContent = canHover ? '✿ hover over the window to peek inside ✿' : '✿ tap the window to peek inside ✿';
    el.winInner.inert = true;
    el.receipt.inert = true;
    root.classList.add('no-anim');
    updateHUD();
    frameView();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
    track('machine_home_viewed', { from: 'load' });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { root.classList.add('no-anim'); frameView(); requestAnimationFrame(() => root.classList.remove('no-anim')); });

    await loadAndBuild();
  }

  init();
