// Background ambience: fills the sky with tiny sparkles, glowing dots and a few drifting
// petals, and gives the two back hill layers a gentle pointer parallax. Background only:
// nothing here touches the machine or any UI.
const root = document.documentElement;
const reduced = () => root.classList.contains('reduce');

// --- particles (fixed seed, so the sky looks the same on every visit)
let seed = 7;
const rnd = (a, b) => {
  seed = (seed * 16807) % 2147483647;
  return a + ((seed - 1) / 2147483646) * (b - a);
};
const fx = document.querySelector('.sky-fx');
if (fx) {
  const sparkle = '<svg viewBox="-10 -10 20 20"><path d="M0-10q1.6 8.4 10 10q-8.4 1.6-10 10q-1.6-8.4-10-10q8.4-1.6 10-10z" fill="#fff4c4" stroke="#f6d77a" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const add = (cls, style, html = '') => {
    const el = document.createElement('span');
    el.className = cls;
    el.setAttribute('style', style);
    el.innerHTML = html;
    fx.appendChild(el);
  };
  for (let i = 0; i < 14; i++) {
    add('fx-star',
      `left:${rnd(2, 97).toFixed(1)}%;top:${rnd(3, 48).toFixed(1)}%;--s:${rnd(9, 18).toFixed(0)}px;` +
      `--t:${rnd(3.2, 6).toFixed(1)}s;--d:-${rnd(0, 6).toFixed(1)}s`, sparkle);
  }
  for (let i = 0; i < 9; i++) {
    add('fx-dot',
      `left:${rnd(3, 96).toFixed(1)}%;top:${rnd(18, 62).toFixed(1)}%;--s:${rnd(6, 11).toFixed(0)}px;` +
      `--dx:${rnd(-24, 24).toFixed(0)}px;--t:${rnd(9, 15).toFixed(1)}s;--d:-${rnd(0, 15).toFixed(1)}s`);
  }
  for (let i = 0; i < 5; i++) {
    add('fx-petal',
      `left:${rnd(-5, 70).toFixed(1)}%;top:-4%;--dx:${rnd(22, 40).toFixed(0)}vw;--dy:${rnd(70, 95).toFixed(0)}vh;` +
      `--t:${rnd(20, 30).toFixed(1)}s;--d:-${rnd(0, 30).toFixed(1)}s`, '<i></i>');
  }
}

// --- pointer parallax for the back hills (mouse / trackpad only; touch keeps the idle drift)
const far = document.querySelector('.land.l-far');
const mid = document.querySelector('.land.l-mid');
if (far && mid && matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let x = 0, y = 0, raf = 0;
  const apply = () => {
    raf = 0;
    if (reduced()) { far.style.transform = mid.style.transform = ''; return; }
    far.style.transform = `translate(${(-x * 26).toFixed(1)}px, ${(-y * 9).toFixed(1)}px)`;
    mid.style.transform = `translate(${(-x * 11).toFixed(1)}px, ${(-y * 4).toFixed(1)}px)`;
  };
  addEventListener('pointermove', (e) => {
    x = (e.clientX / innerWidth) * 2 - 1;
    y = (e.clientY / innerHeight) * 2 - 1;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
}
