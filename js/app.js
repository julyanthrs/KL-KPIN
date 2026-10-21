/* KL!KPIN — interactive vending machine shop */
(function () {
  'use strict';

  const { PINS, CATEGORIES, pinSVG, iconSVG, face, MAX_PER_PIN } = window.KP_PINS;
  const PAY = window.KP_PAY;
  const store = PAY.store;

  // Currency is a placeholder until the shop confirms it (PRD §12).
  const CUR = { code: 'PHP', symbol: '₱' };
  const money = (n) => CUR.symbol + Number(n).toLocaleString('en-PH');
  const byId = Object.fromEntries(PINS.map((p) => [p.id, p]));
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
    rWrap: $('#receiptWrap'), receipt: $('#receipt'), drawer: $('#drawer'), payBody: $('#payBody'),
    push: $('#pushDoor'), tray: $('#tray'), flap: $('#flap'), stripes: $('#stripes'), catSticker: $('#catSticker'),
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
    method: 'qr',
    lastOrder: null,
    camScale: 1,
  };

  /* =========================================================
     CART (FR-06)
     ========================================================= */
  const availableStock = (id) => (PAY.ShopAPI.soldOutThisSession.has(id) ? 0 : byId[id].stock);
  const maxFor = (id) => Math.max(0, Math.min(MAX_PER_PIN, availableStock(id)));

  const cart = (() => {
    const saved = store.get('klikpin_cart', null);
    const items = {};
    if (saved && saved.items) {
      for (const [id, q] of Object.entries(saved.items)) {
        if (byId[id] && q > 0) { const m = maxFor(id); if (m > 0) items[id] = Math.min(q, m); }
      }
    }
    return { items, flagged: {} };
  })();
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
      const msg = qty(id) >= MAX_PER_PIN ? `Max ${MAX_PER_PIN} per design ♡` : `Only ${maxFor(id)} ${p.name} left!`;
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
    if (S.view === 'receipt') afterReceiptEdit();
  }

  /* =========================================================
     DISPLAY WINDOW + BATCHES (FR-04, FR-05)
     ========================================================= */
  const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  const catName = () => CATEGORIES.find((c) => c.id === S.category).name;

  function slotHTML(p) {
    return `<div class="slot-item" data-id="${p.id}">
      <div class="pin-zone">
        <div class="pin-wrap">
          <div class="pin-art">${pinSVG(p)}</div>
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
    S.batch = Math.min(S.batch, S.pages.length - 1);
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
    el.batchLabel.textContent = `page ${S.batch + 1}/${S.pages.length}`;
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
     CAMERA (FR-01, FR-02, FR-11, FR-16)
     ========================================================= */
  const isPortrait = () => getComputedStyle(el.machine).getPropertyValue('--cols').trim() === '2';

  function rectOf(node) {
    let x = 0, y = 0, n = node;
    while (n && n !== el.machine) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: node.offsetWidth, h: node.offsetHeight };
  }

  function frame(r, o = {}) {
    const vw = window.innerWidth, vh = window.innerHeight;
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
      frame({ x: -6, y: -6, w: el.machine.offsetWidth + 12, h: el.machine.offsetHeight + 22 }, { max: 1.1, pad: Math.max(8, Math.min(16, window.innerWidth * 0.02)), top: small ? 30 : 48, bottom: hudB - 4 });
    } else if (v === 'window') {
      const r = rectOf(el.win), px = isPortrait() ? 26 : 50;
      frame({ x: r.x - px, y: r.y - 18, w: r.w + px * 2, h: r.h + 36 }, { max: 1.45, bottom: hudB });
    } else if (v === 'receipt') {
      const r = rectOf(el.rWrap), h = el.receipt.offsetHeight;
      frame({ x: r.x - 20, y: r.y - 58, w: r.w + 40, h: h + 58 + 28 }, { max: 2.4, bottom: hudB });
    } else if (v === 'payment') {
      const p = rectOf(el.panel), d = rectOf(el.drawer);
      frame({ x: p.x - 14, y: p.y - 14, w: p.w + 28, h: d.y + el.drawer.offsetHeight - p.y + 28 }, { max: 1.7, pad: 10 });
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
    el.drawer.inert = v !== 'payment';
    if (v !== 'window') S.hoverZoom = false;
    if (prev === 'receipt' && v !== 'receipt') retractReceipt();
    if (v !== 'payment') el.panel.classList.remove('drawer-open');
    if (v === 'receipt' && prev !== 'receipt') printReceipt();
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
    el.lcdText.textContent = t.count ? 'SUBTOTAL' : 'READY';
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
  function qrShow(seed, amount) {
    el.qr.innerHTML = `<span class="qr-title">SCAN TO PAY</span>${qrSVG(seed)}<span class="qr-amt">${money(amount)}</span>`;
  }
  function qrThanks() {
    el.qr.innerHTML = '<span class="qr-title">QR CODE</span><div class="qr-thanks">THANK<br>YOU &lt;3</div>';
  }
  function qrSVG(seed) {
    const N = 25;
    let h = 2166136261;
    for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    const corners = [[0, 0], [N - 7, 0], [0, N - 7]];
    let rects = '';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const f = corners.find(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
        let dark;
        if (f) {
          const dx = x - f[0], dy = y - f[1];
          dark = dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        } else if (corners.some(([fx, fy]) => x >= fx - 1 && x < fx + 8 && y >= fy - 1 && y < fy + 8)) {
          dark = false;
        } else if (Math.abs(x - N / 2 + .5) < 4 && Math.abs(y - N / 2 + .5) < 4) {
          dark = false; // room for the heart
        } else {
          dark = rnd() < 0.5;
        }
        if (dark) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    }
    return `<svg class="qr" viewBox="-2 -2 ${N + 4} ${N + 4}" role="img" aria-label="Payment QR code (demo)">
      <rect x="-2" y="-2" width="${N + 4}" height="${N + 4}" fill="#fff"/>
      <g fill="#2c2554" shape-rendering="crispEdges">${rects}</g>
      <path transform="translate(${N / 2} ${N / 2 - .6}) scale(.3)" d="M0 9C-9 3-11-3-7-7c3-3 6-1 7 1 1-2 4-4 7-1 4 4 2 10-7 16z" fill="#ff6f9c" stroke="#2c2554" stroke-width="1.6"/>
    </svg>`;
  }

  /* =========================================================
     RECEIPT (FR-07 → FR-10)
     ========================================================= */
  function ensureOrderId() {
    if (!S.checkout.orderId) {
      S.checkout = { orderId: 'KP-' + Math.random().toString(36).slice(2, 7).toUpperCase(), status: 'open' };
      saveCheckout();
    }
  }

  function openReceipt(source) {
    if (!lines().length) {
      sfx.err();
      lcdFlash('ADD A PIN FIRST!', 2200);
      toast('Add at least one pin first ♡');
      el.panel.classList.remove('shake'); void el.panel.offsetWidth; el.panel.classList.add('shake');
      return;
    }
    ensureOrderId();
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
        <span class="r-thumb">${pinSVG(p)}</span>
        <div class="r-info">
          <b class="r-name">${p.name}</b>
          <span class="r-calc">${l.qty} × ${money(p.price)}</span>
          ${so ? '<em class="r-flag">sold out · not charged</em>' : flag === 'reduced' ? `<em class="r-flag">only ${l.qty} left · qty updated</em>` : ''}
          <span class="r-ctrls">
            <button data-act="dec" data-id="${l.id}" aria-label="One less ${p.name}" ${so ? 'disabled' : ''}>−</button>
            <button data-act="inc" data-id="${l.id}" aria-label="One more ${p.name}" ${so || l.qty >= maxFor(l.id) ? 'disabled' : ''}>+</button>
            <button data-act="del" data-id="${l.id}" aria-label="Remove ${p.name} from order">✕</button>
          </span>
        </div>
        <span class="r-amt">${so ? `<s>${amt}</s>` : amt}</span>
      </li>`;
    }).join('');
    el.receipt.innerHTML = `
      <div class="r-head"><p class="r-brand">KL!KPIN</p><p class="r-sub">button pin machine ✿</p></div>
      <p class="r-meta"><span>ORDER #${S.checkout.orderId || '-----'}</span><span>${date} · ${time}</span></p>
      <h2 class="r-title" id="rTitle" tabindex="-1">~ your receipt ~</h2>
      ${ls.length ? `<ul class="r-lines">${items}</ul>` : '<p class="r-empty">no pins yet ♡<br>go back and add one!</p>'}
      <div class="r-tot">
        <p><span>subtotal · ${t.count} pin${t.count === 1 ? '' : 's'}</span><span>${money(t.subtotal)}</span></p>
        <p class="r-grand"><span>TOTAL</span><span>${money(t.subtotal)}</span></p>
      </div>
      <div class="r-actions">
        <button class="r-btn primary" data-act="confirm" ${t.count ? '' : 'disabled'}>Confirm order ♡</button>
        <button class="r-btn" data-act="edit">← edit order</button>
      </div>
      <div class="r-barcode" aria-hidden="true"></div>
      <p class="r-thanks">thank you, come again ♡</p>`;
  }

  function printReceipt() {
    renderReceipt();
    el.rWrap.classList.remove('adjust', 'retract');
    el.rWrap.style.height = '0px';
    void el.rWrap.offsetWidth;
    el.rWrap.classList.add('printing');
    el.rWrap.style.height = el.receipt.offsetHeight + 'px';
    sfx.print();
    lcdFlash('PRINTING...', 2300);
  }
  function retractReceipt() {
    el.rWrap.classList.remove('printing', 'adjust');
    el.rWrap.style.height = '0px';
  }
  function afterReceiptEdit() {
    const a = document.activeElement;
    const keep = a && el.receipt.contains(a) && a.dataset ? { act: a.dataset.act, id: a.dataset.id } : null;
    renderReceipt();
    el.rWrap.classList.remove('printing');
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
    sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#ffd6e2" stroke="#2c2554" stroke-width="2" stroke-linejoin="round"/><path d="M16 9q2 3 0 6M18.5 6.5q4 5.5 0 11" fill="none" stroke="#2c2554" stroke-width="2" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#eee" stroke="#2c2554" stroke-width="2" stroke-linejoin="round"/><path d="M16 9l5 6M21 9l-5 6" stroke="#2c2554" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const OUTCOMES = [
    ['success', '✓ payment succeeds'],
    ['decline', '✕ payment declined'],
    ['cancel', '↩ customer cancels'],
    ['unavailable', '⚠ provider is down'],
    ['soldout', '✿ a pin sells out'],
  ];

  function renderPay(state, info = {}) {
    S.payState = state;
    const t = totals();
    const amount = info.order ? info.order.total : t.subtotal;
    const count = info.order ? info.order.count : t.count;
    const m = S.method;
    const head = `<div class="pay-head">
        <div><p class="pay-eyebrow" id="payTitle" tabindex="-1">${state === 'success' ? 'paid' : 'total to pay'}</p><p class="pay-total">${money(amount)}</p></div>
        <p class="pay-meta">${count} pin${count === 1 ? '' : 's'}<br><span>#${(info.order && info.order.orderId) || S.checkout.orderId || ''}</span></p>
      </div>`;
    let body = '';
    if (state === 'select') {
      body = `<fieldset class="methods"><legend class="sr-only">Choose a payment method</legend>
          ${PAY.provider.methods.map((x) => `<label class="method"><input type="radio" name="pm" value="${x.id}" ${x.id === m ? 'checked' : ''}><span class="m-card"><span class="m-ico">${ICON[x.id]}</span>${x.short}</span></label>`).join('')}
        </fieldset>
        <button class="pay-btn" data-act="pay">Pay ${money(t.subtotal)} ♡</button>
        <button class="pay-link" data-act="back">← back to receipt</button>`;
    } else if (state === 'busy') {
      body = `<div class="pay-status" role="status"><span class="pay-spin" aria-hidden="true"></span><p class="ps-big">${info.msg}</p><p class="ps-small">please keep this page open ♡</p></div>`;
    } else if (state === 'awaiting') {
      const qr = m === 'qr';
      body = `<div class="pay-status" role="status">
          <p class="ps-big">${qr ? 'Scan the QR on the screen ↑' : m === 'card' ? 'Finish on the secure card page' : 'Finish in your bank app'}</p>
          <p class="ps-small">${qr ? 'Open your e-wallet or banking app, scan, then tap “I’ve paid”.' : 'In the live shop the provider’s secure page opens here — the shop never sees your card or bank login.'}</p>
        </div>
        <div class="pay-row"><button class="pay-btn" data-act="done">I’ve paid ♡</button><button class="pay-btn ghost" data-act="cancel">Cancel</button></div>`;
    } else if (state === 'resume') {
      body = `<div class="pay-status" role="status"><p class="ps-big">You have an unfinished payment</p><p class="ps-small">Let’s check it with the provider before anything else — no double charges.</p></div>
        <div class="pay-row"><button class="pay-btn" data-act="resume">Check status</button><button class="pay-btn ghost" data-act="back">Back to receipt</button></div>`;
    } else if (state === 'success') {
      body = `<div class="pay-status" role="status"><span class="ok-badge" aria-hidden="true">✓</span><p class="ps-big">Payment confirmed!</p><p class="ps-small">Your pins are dropping into the PUSH door ↓</p></div>
        <button class="pay-btn" data-act="home">Back to the machine ♡</button>`;
    } else {
      const T = {
        failed: ['Payment didn’t go through', 'Nothing was charged and your order is safe. Try again or pick another method.'],
        cancelled: ['Payment cancelled', 'No worries! Your pins are still in your order.'],
        unavailable: ['Payment provider is napping', 'We couldn’t reach the payment provider. Your order is saved — try again in a moment.'],
        stock: ['A pin just sold out', 'We updated your receipt and total. Please check it before paying.'],
        error: ['Something went wrong', info.msg || 'Please try again.'],
      }[state];
      body = `<div class="pay-status is-bad" role="alert"><p class="ps-big">${T[0]}</p><p class="ps-small">${T[1]}</p></div>
        <div class="pay-row">${state === 'stock'
          ? '<button class="pay-btn" data-act="back">Review receipt</button>'
          : '<button class="pay-btn" data-act="retry">Try again</button><button class="pay-btn ghost" data-act="back">Back to receipt</button>'}</div>`;
    }
    const foot = state === 'success' ? '' : `<div class="pay-foot">
        <span>🔒 ${PAY.provider.label}</span>
        <label class="pf-demo">demo: <select id="demoOutcome">${OUTCOMES.map(([v, l]) => `<option value="${v}" ${PAY.getOutcome() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>`;
    el.payBody.innerHTML = head + `<div class="pay-main">${body}</div>` + foot;

    if (state === 'awaiting' && m === 'qr') qrShow(S.checkout.intentId || S.checkout.orderId, t.subtotal);
    else if (state === 'success') qrThanks();
    else if (state !== 'busy') qrIdle();
  }

  function confirmOrder() {
    const t = totals();
    if (!t.count) { toast('Add at least one pin first ♡'); return; }
    ensureOrderId();
    track('order_confirmed', { count: t.count, total: t.subtotal, orderId: S.checkout.orderId });
    const resume = S.checkout.intentId && S.checkout.status === 'awaiting' && S.checkout.amount === t.subtotal;
    renderPay(resume ? 'awaiting' : 'select');
    setView('payment', { focus: true });
    later(() => el.panel.classList.add('drawer-open'), 420);
  }

  function backToReceipt() {
    if (S.paying) return;
    if (S.checkout.intentId && S.checkout.status === 'awaiting') {
      PAY.provider.cancel(S.checkout.intentId).catch(() => {});
      S.checkout.status = 'cancelled';
      saveCheckout();
    }
    qrIdle();
    el.panel.classList.remove('drawer-open');
    later(() => setView('receipt', { focus: true }), 300);
  }

  function applyStockProblems(problems) {
    problems.forEach(({ id, available }) => {
      if (available <= 0) cart.flagged[id] = 'soldout';
      else { cart.items[id] = available; cart.flagged[id] = 'reduced'; }
      updateSlot(id);
    });
    saveCart();
    updateHUD();
    lcdIdle();
  }

  async function startPayment() {
    if (S.paying) return;
    const t = totals();
    if (!t.count) { toast('Add at least one pin first ♡'); return; }
    S.paying = true;
    const method = S.method;
    track('payment_started', { method, amount: t.subtotal, orderId: S.checkout.orderId });
    try {
      renderPay('busy', { msg: 'Checking your pins are still in stock…' });
      const problems = await PAY.ShopAPI.checkInventory(payableLines(), byId);
      if (problems.length) {
        applyStockProblems(problems);
        renderPay('stock');
        sfx.err();
        track('checkout_blocked', { reason: 'stock', items: problems.map((p) => p.id) });
        return;
      }
      renderPay('busy', { msg: 'Connecting to the payment provider…' });
      const intent = await PAY.provider.createIntent({ orderId: S.checkout.orderId, amount: t.subtotal, currency: CUR.code, method });
      Object.assign(S.checkout, { intentId: intent.id, status: 'awaiting', amount: t.subtotal, method });
      saveCheckout();
      renderPay('awaiting');
      sfx.key();
    } catch (err) {
      handlePayError(err);
    } finally {
      S.paying = false;
    }
  }

  async function customerDone() {
    if (S.paying || !S.checkout.intentId) return;
    S.paying = true;
    try {
      renderPay('busy', { msg: 'Waiting for the provider…' });
      await PAY.provider.customerCompletes(S.checkout.intentId);
      await verifyAndFinish();
    } catch (err) {
      handlePayError(err);
    } finally {
      S.paying = false;
    }
  }

  async function resumePayment() {
    if (S.paying) return;
    S.paying = true;
    try { await verifyAndFinish(); } catch (err) { handlePayError(err); } finally { S.paying = false; }
  }

  // Only the provider's verified status counts as paid (FR-12, FR-13).
  async function verifyAndFinish() {
    S.checkout.status = 'verifying';
    saveCheckout();
    renderPay('busy', { msg: 'Confirming your payment…' });
    const status = await PAY.provider.verify(S.checkout.intentId);
    if (status === 'succeeded') return onPaid();
    if (status === 'requires_action') { S.checkout.status = 'awaiting'; saveCheckout(); renderPay('awaiting'); return; }
    S.checkout.status = status === 'cancelled' ? 'cancelled' : 'failed';
    saveCheckout();
    sfx.err();
    if (status === 'cancelled') { track('payment_cancelled', { by: 'provider', orderId: S.checkout.orderId }); renderPay('cancelled'); }
    else { track('payment_failed', { reason: status, orderId: S.checkout.orderId }); renderPay('failed'); }
  }

  async function cancelPayment() {
    if (S.paying) return;
    S.paying = true;
    try {
      renderPay('busy', { msg: 'Cancelling…' });
      await PAY.provider.cancel(S.checkout.intentId);
      S.checkout.status = 'cancelled';
      saveCheckout();
      track('payment_cancelled', { by: 'customer', orderId: S.checkout.orderId });
      renderPay('cancelled');
    } catch (err) {
      handlePayError(err);
    } finally {
      S.paying = false;
    }
  }

  function handlePayError(err) {
    sfx.err();
    if (err && err.code === 'unavailable') { track('payment_failed', { reason: 'provider_unavailable' }); renderPay('unavailable'); }
    else { track('payment_failed', { reason: 'error', message: err && err.message }); renderPay('error', { msg: err && err.message }); }
  }

  let successTimer;
  function onPaid() {
    const ls = payableLines(), t = totals();
    const order = {
      orderId: S.checkout.orderId, intentId: S.checkout.intentId, method: S.checkout.method,
      lines: ls.map((l) => ({ id: l.id, name: l.name, qty: l.qty, price: l.price })),
      count: t.count, total: t.subtotal, currency: CUR.code, paidAt: new Date().toISOString(),
    };
    PAY.ShopAPI.recordOrder(order); // keep the order record…
    track('payment_succeeded', { orderId: order.orderId, amount: order.total, method: order.method });
    cart.items = {}; cart.flagged = {}; saveCart(); // …then clear the completed cart
    S.checkout = {}; saveCheckout();
    S.lastOrder = order;
    refreshCartUI();
    renderPay('success', { order });
    sfx.success();
    lcdFlash('PAID! THANK YOU <3', 3200);
    announce(`Payment confirmed. Order ${order.orderId}. Your pins are dropping into the pickup door.`);
    successTimer = later(finishToHome, 2800);
  }

  function finishToHome() {
    clearTimeout(successTimer);
    if (S.view !== 'payment' || S.payState !== 'success') return;
    const order = S.lastOrder;
    setView('home', { focus: true });
    later(() => { qrIdle(); dropPins(order); }, 750);
  }

  el.payBody.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const a = b.dataset.act;
    if (a === 'pay' || a === 'retry') startPayment();
    else if (a === 'done') customerDone();
    else if (a === 'cancel') cancelPayment();
    else if (a === 'back') backToReceipt();
    else if (a === 'resume') resumePayment();
    else if (a === 'home') finishToHome();
  });
  el.payBody.addEventListener('change', (e) => {
    if (e.target.name === 'pm') { S.method = e.target.value; sfx.key(); }
    if (e.target.id === 'demoOutcome') PAY.setOutcome(e.target.value);
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
      later(() => sfx.thunk(), i * 130 + 500);
    });
    el.push.classList.add('has-pins');
    el.flap.setAttribute('aria-label', `Push the flap to collect your ${ids.length} pin${ids.length === 1 ? '' : 's'}`);
    toast('Your pins dropped! Push the flap to collect ♡', 3600);
  }

  function collect() {
    if (!el.push.classList.contains('has-pins')) {
      el.flap.classList.add('open');
      setTimeout(() => el.flap.classList.remove('open'), 380);
      toast('Nothing here yet — pick some pins first ♡');
      sfx.key();
      return;
    }
    const ids = [...el.tray.querySelectorAll('.drop-pin')].map((_, i) => S.lastOrder.lines.flatMap((l) => Array(l.qty).fill(l.id))[i]);
    el.flap.classList.add('open');
    sfx.collect();
    const r = el.flap.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, ids);
    setTimeout(() => {
      el.tray.innerHTML = '';
      el.push.classList.remove('has-pins');
      el.flap.classList.remove('open');
      el.flap.setAttribute('aria-label', 'Push the flap to collect your pins');
    }, 700);
    toast(`Enjoy your pins! ♡ Order #${S.lastOrder.orderId}`, 3200);
    track('pins_collected', { orderId: S.lastOrder.orderId });
  }

  function burst(x, y, ids) {
    if (reduce) return;
    const colors = ['#ff7fa7', '#ffe066', '#7ed8b1', '#b9a7ff', '#7cc8ff'];
    for (let i = 0; i < 30; i++) {
      const d = document.createElement('span');
      d.className = 'confetti-bit';
      if (i < Math.min(ids.length, 10)) { d.classList.add('is-pin'); d.innerHTML = pinSVG(byId[ids[i]]); }
      else if (i % 3 === 0) { d.textContent = '♡'; d.style.color = colors[i % 5]; }
      else d.style.background = colors[i % 5];
      d.style.left = x + 'px'; d.style.top = y + 'px';
      el.confetti.appendChild(d);
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
      const dist = 140 + Math.random() * 280;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
      const anim = d.animate([
        { transform: 'translate(-50%,-50%) scale(.3) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${Math.random() * 360 - 180}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 260}px)) scale(.9) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 },
      ], { duration: 1400 + Math.random() * 700, easing: 'cubic-bezier(.2,.7,.3,1)' });
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
    el.catSticker.innerHTML = `<svg viewBox="0 0 60 60">
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
    clearTimeout(hoverInT);
    setView('window', { via: e.detail === 0 ? 'keyboard' : 'tap', focus: true });
    S.hoverZoom = false;
  });

  el.track.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b && S.view === 'window') {
      const id = b.closest('.slot-item').dataset.id;
      if (b.dataset.act === 'inc') addPin(id, 'window'); else removePin(id, 'window');
      return;
    }
    const art = e.target.closest('.pin-art');
    if (art) { art.classList.remove('boing'); void art.offsetWidth; art.classList.add('boing'); sfx.key(); }
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
  // keep the receipt fully visible if fonts nudge its height after printing
  el.rWrap.addEventListener('transitionend', (e) => {
    if (e.target !== el.rWrap || e.propertyName !== 'height' || S.view !== 'receipt') return;
    if (el.rWrap.classList.contains('printing')) {
      el.rWrap.classList.remove('printing'); // curl unrolls flat
      sfx.ding();
    }
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
    if (e.target.matches && e.target.matches('select, input, textarea')) return;
    if (e.key === 'Escape') {
      if (S.view === 'window') setView('home', { focus: true });
      else if (S.view === 'receipt') setView('window', { focus: true, via: 'escape' });
      else if (S.view === 'payment' && !S.paying && ['select', 'failed', 'cancelled', 'unavailable', 'stock', 'error', 'awaiting', 'resume'].includes(S.payState)) backToReceipt();
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
      if (S.view === 'receipt') el.rWrap.style.height = el.receipt.offsetHeight + 'px';
      frameView();
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
    }, 60);
  };
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(el.viewport);

  window.addEventListener('pagehide', () => {
    if ((S.view === 'receipt' || S.view === 'payment') && lines().length) track('checkout_abandoned', { view: S.view, orderId: S.checkout.orderId });
  });

  /* =========================================================
     INIT
     ========================================================= */
  function init() {
    buildStickers();
    buildKeys();
    buildTabs();
    buildPages();
    qrIdle();
    lcdIdle();
    drawStripes();
    applyMute();
    el.hint.textContent = canHover ? '✿ hover over the window to peek inside ✿' : '✿ tap the window to peek inside ✿';
    el.winInner.inert = true;
    el.receipt.inert = true;
    el.drawer.inert = true;
    root.classList.add('no-anim');
    updateHUD();
    frameView();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
    track('machine_home_viewed', { from: 'load' });

    // came back mid-checkout (refresh / back button): verify before anything else
    if (S.checkout.intentId && ['awaiting', 'verifying'].includes(S.checkout.status) && lines().length) {
      setTimeout(() => {
        renderPay('resume');
        setView('payment', { focus: true });
        later(() => el.panel.classList.add('drawer-open'), 420);
      }, 700);
    }

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { root.classList.add('no-anim'); frameView(); requestAnimationFrame(() => root.classList.remove('no-anim')); });
  }

  init();
})();
