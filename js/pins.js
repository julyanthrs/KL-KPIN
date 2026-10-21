/* KL!KPIN — pin catalog + hand-drawn SVG pin art */
(function () {
  'use strict';

  const INK = '#3b2a4a';
  const BLUSH = '#ff8fab';
  const S = `stroke="${INK}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"`;
  let uid = 0;

  /* ---------- little helpers ---------- */
  function face(cx, cy, s = 1, o = {}) {
    const ink = o.ink || INK;
    const eyes = o.sleepy
      ? `<path d="M-12 -1q3 3.4 6 0M6 -1q3 3.4 6 0" stroke="${ink}" stroke-width="1.9" fill="none" stroke-linecap="round"/>`
      : `<ellipse cx="-9" cy="0" rx="2.6" ry="3.1" fill="${ink}"/><ellipse cx="9" cy="0" rx="2.6" ry="3.1" fill="${ink}"/>` +
        `<circle cx="-8.1" cy="-1.2" r="1" fill="#fff"/><circle cx="9.9" cy="-1.2" r="1" fill="#fff"/>`;
    const mouth = o.open
      ? `<path d="M-3.2 3.4q3.2 5.4 6.4 0z" fill="${ink}"/>`
      : `<path d="M-3.4 3.6q1.7 2.4 3.4 0q1.7 2.4 3.4 0" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    const blush = o.noBlush ? '' :
      `<ellipse cx="-14.5" cy="4.5" rx="3.6" ry="2.2" fill="${BLUSH}" opacity=".75"/><ellipse cx="14.5" cy="4.5" rx="3.6" ry="2.2" fill="${BLUSH}" opacity=".75"/>`;
    return `<g transform="translate(${cx} ${cy}) scale(${s})">${blush}${eyes}${mouth}</g>`;
  }

  function starPath(cx, cy, R, r, n = 5) {
    const p = [];
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const rr = i % 2 ? r : R;
      p.push((cx + rr * Math.cos(a)).toFixed(1) + ' ' + (cy + rr * Math.sin(a)).toFixed(1));
    }
    return 'M' + p.join('L') + 'Z';
  }

  function sparkle(x, y, s, c = '#fff') {
    return `<path d="M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z" fill="${c}"/>`;
  }

  function cloud(cx, cy, s, fill = '#fff') {
    const shapes = '<circle cx="-14" cy="4" r="11"/><circle cx="0" cy="-4" r="14"/><circle cx="14" cy="4" r="11"/><rect x="-14" y="2" width="28" height="13" rx="2"/>';
    return `<g transform="translate(${cx} ${cy}) scale(${s})"><g fill="${INK}" stroke="${INK}" stroke-width="4.4">${shapes}</g><g fill="${fill}">${shapes}</g></g>`;
  }

  const dotsAt = (pts, r, c) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`).join('');

  /* ---------- background patterns ---------- */
  const BG = {
    dots(c) {
      let s = '';
      for (let y = 6, row = 0; y < 100; y += 13, row++)
        for (let x = row % 2 ? 12 : 5; x < 100; x += 13) s += `<circle cx="${x}" cy="${y}" r="2.3" fill="${c}"/>`;
      return s;
    },
    stripes(c) {
      let s = '';
      for (let i = -50; i < 140; i += 13) s += `<path d="M${i} -5L${i + 40} 105" stroke="${c}" stroke-width="5"/>`;
      return s;
    },
    checks(c) {
      let s = '';
      for (let y = 0, r = 0; y < 100; y += 12.5, r++)
        for (let x = 0, k = 0; x < 100; x += 12.5, k++) if ((r + k) % 2 === 0) s += `<rect x="${x}" y="${y}" width="12.5" height="12.5" fill="${c}"/>`;
      return s;
    },
    rays(c) {
      let s = '';
      for (let i = 0; i < 16; i += 2) {
        const a1 = (i * Math.PI) / 8, a2 = ((i + 1) * Math.PI) / 8;
        s += `<path d="M50 50L${(50 + 80 * Math.cos(a1)).toFixed(1)} ${(50 + 80 * Math.sin(a1)).toFixed(1)}L${(50 + 80 * Math.cos(a2)).toFixed(1)} ${(50 + 80 * Math.sin(a2)).toFixed(1)}z" fill="${c}"/>`;
      }
      return s;
    },
    night(c) {
      return dotsAt([[14, 30], [22, 78], [84, 50], [70, 14], [40, 12], [88, 80], [12, 56], [58, 90]], 1.4, c);
    },
  };

  /* ---------- pin artwork (viewBox 0 0 100 100) ---------- */
  const ART = {
    strawberry: () => `
      <path d="M50 31C31 28 21 45 29 61c6 12 16 19 21 21 5-2 15-9 21-21 8-16-2-33-21-30z" fill="#ff5f80" ${S}/>
      ${[[33, 47], [67, 47], [41, 40], [59, 40], [30, 60], [70, 60], [42, 73], [58, 73]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1.5" ry="2.2" fill="#ffe680"/>`).join('')}
      <path d="M50 34 38 25l9 1-2-9 5 7 5-7-2 9 9-1z" fill="#6fd393" ${S}/>
      ${face(50, 57, 0.85)}`,

    cherry: () => `
      <path d="M37 52Q40 36 57 22M63 54Q60 38 57 22" fill="none" stroke="#4e8a3e" stroke-width="3" stroke-linecap="round"/>
      <path d="M57 22q12-10 23-2-11 9-23 2z" fill="#6fd393" ${S}/>
      <circle cx="36" cy="62" r="14" fill="#ff4d6d" ${S}/><circle cx="64" cy="64" r="14" fill="#ff4d6d" ${S}/>
      <ellipse cx="30" cy="55" rx="3" ry="2" fill="#fff" opacity=".85"/><ellipse cx="58" cy="57" rx="3" ry="2" fill="#fff" opacity=".85"/>
      ${face(36, 64, 0.5)}${face(64, 66, 0.5)}`,

    boba: () => `
      <rect x="54" y="12" width="7" height="34" rx="3.5" fill="#ff9cc0" ${S} transform="rotate(16 57 29)"/>
      <path d="M30 38h40l-5 42q-15 5-30 0z" fill="#f5d8b8" ${S}/>
      <path d="M26 39q24-16 48 0z" fill="#fff" ${S}/>
      ${dotsAt([[40, 75], [48, 78], [56, 77], [62, 72], [44, 70], [54, 71], [37.5, 68]], 3.3, '#4a3047')}
      ${face(50, 54, 0.8)}`,

    peach: () => `
      <path d="M50 33C29 29 21 55 33 69c8 10 26 10 34 0 12-14 4-40-17-36z" fill="#ffb18e" ${S}/>
      <path d="M50 35q-5 6-3 13" fill="none" stroke="#f08667" stroke-width="2" stroke-linecap="round"/>
      <path d="M50 33q6-14 21-13-5 14-21 13z" fill="#7fd79c" ${S}/>
      ${face(50, 58, 0.85)}`,

    donut: (u, p) => `
      <circle cx="50" cy="51" r="29" fill="#e9b07a" ${S}/>
      <path d="M50 26c9 0 17 4 21 11 3 5 5 9 3 15-1 4 1 8-2 11-3 4-7 2-10 5-4 4-8 6-12 6s-8-2-11-6c-3-3-8-2-10-6-2-3-1-7-2-11-1-6 1-10 4-15 4-7 11-10 19-10z" fill="#ff9ec4" ${S}/>
      <circle cx="50" cy="49" r="8" fill="${p.bg}" ${S}/>
      ${[[37, 37, 20, '#fff'], [60, 34, -30, '#7cc8ff'], [68, 47, 60, '#ffe066'], [33, 51, -50, '#8ee08a'], [44, 30, 70, '#b79cff'], [64, 58, 15, '#fff']]
        .map(([x, y, a, c]) => `<rect x="-4" y="-1.3" width="8" height="2.6" rx="1.3" fill="${c}" transform="translate(${x} ${y}) rotate(${a})"/>`).join('')}
      ${face(50, 65, 0.55)}`,

    heart: () => `
      <path d="M50 79C21 61 17 40 30 31c10-6 17 0 20 6 3-6 10-12 20-6 13 9 9 30-20 48z" fill="#ff6f93" ${S}/>
      ${face(50, 52, 0.85)}${sparkle(23, 24, 6)}${sparkle(78, 72, 5)}${sparkle(80, 25, 4, '#ffd84d')}`,

    cat: () => `
      <path d="M27 44 29 18l18 15zM73 44 71 18 53 33z" fill="#ffc98f" ${S}/>
      <path d="M31 36 32 25l8 7zM69 36l-1-11-8 7z" fill="#ff9fb8"/>
      <ellipse cx="50" cy="53" rx="27" ry="22" fill="#ffc98f" ${S}/>
      <path d="M45 33v6M50 32v7M55 33v6" stroke="#f3a256" stroke-width="2.6" stroke-linecap="round"/>
      ${face(50, 55, 0.9, { sleepy: true })}
      <path d="M23 55h-9M23 59l-8 3M77 55h9M77 59l8 3" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
      <text x="70" y="27" font-family="Fredoka, sans-serif" font-weight="700" font-size="12" fill="#fff" stroke="${INK}" stroke-width=".8">z</text>
      <text x="79" y="18" font-family="Fredoka, sans-serif" font-weight="700" font-size="9" fill="#fff" stroke="${INK}" stroke-width=".7">z</text>`,

    bunny: () => `
      <ellipse cx="39" cy="27" rx="7.5" ry="18" fill="#fff" ${S} transform="rotate(-8 39 27)"/>
      <ellipse cx="61" cy="27" rx="7.5" ry="18" fill="#fff" ${S} transform="rotate(8 61 27)"/>
      <ellipse cx="39" cy="28" rx="3.4" ry="12" fill="#ffb3c8" transform="rotate(-8 39 27)"/>
      <ellipse cx="61" cy="28" rx="3.4" ry="12" fill="#ffb3c8" transform="rotate(8 61 27)"/>
      <ellipse cx="50" cy="59" rx="26" ry="21" fill="#fff" ${S}/>
      ${face(50, 59, 0.9)}`,

    bear: () => `
      <circle cx="29" cy="33" r="10" fill="#c98e5f" ${S}/><circle cx="71" cy="33" r="10" fill="#c98e5f" ${S}/>
      <circle cx="29" cy="33" r="5" fill="#f4c9a5"/><circle cx="71" cy="33" r="5" fill="#f4c9a5"/>
      <circle cx="50" cy="54" r="26" fill="#c98e5f" ${S}/>
      <ellipse cx="50" cy="63" rx="12" ry="9" fill="#f6dcc0" stroke="${INK}" stroke-width="1.6"/>
      <ellipse cx="50" cy="59.5" rx="3.8" ry="2.7" fill="${INK}"/>
      <path d="M46.5 64q1.75 2.4 3.5 0q1.75 2.4 3.5 0" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="40" cy="50" r="2.9" fill="${INK}"/><circle cx="60" cy="50" r="2.9" fill="${INK}"/>
      <circle cx="40.9" cy="49" r="1" fill="#fff"/><circle cx="60.9" cy="49" r="1" fill="#fff"/>
      <ellipse cx="32" cy="60" rx="4" ry="2.4" fill="${BLUSH}" opacity=".8"/><ellipse cx="68" cy="60" rx="4" ry="2.4" fill="${BLUSH}" opacity=".8"/>`,

    frog: () => `
      <circle cx="34" cy="37" r="11" fill="#8fe08c" ${S}/><circle cx="66" cy="37" r="11" fill="#8fe08c" ${S}/>
      <ellipse cx="50" cy="58" rx="31" ry="21" fill="#8fe08c" ${S}/>
      <circle cx="34" cy="37" r="6.5" fill="#fff"/><circle cx="66" cy="37" r="6.5" fill="#fff"/>
      <circle cx="35" cy="38" r="3.4" fill="${INK}"/><circle cx="67" cy="38" r="3.4" fill="${INK}"/>
      <circle cx="36" cy="36.8" r="1.1" fill="#fff"/><circle cx="68" cy="36.8" r="1.1" fill="#fff"/>
      <path d="M37 59q13 11 26 0" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
      <ellipse cx="29" cy="62" rx="4.5" ry="2.6" fill="${BLUSH}" opacity=".8"/><ellipse cx="71" cy="62" rx="4.5" ry="2.6" fill="${BLUSH}" opacity=".8"/>`,

    ghost: () => `
      <path d="M28 77V49c0-15 10-24 22-24s22 9 22 24v28q-5.5-6-11 0t-11 0t-11 0t-11 0z" fill="#fff" ${S}/>
      ${face(50, 50, 0.9, { open: true })}
      ${sparkle(20, 28, 5, '#fff')}${sparkle(80, 66, 4, '#fff')}`,

    duck: () => `
      <path d="M47 31q1-9 7-8-3 3-2 8" fill="#ffd84a" ${S}/>
      <circle cx="50" cy="55" r="25" fill="#ffe066" ${S}/>
      <circle cx="41" cy="50" r="2.9" fill="${INK}"/><circle cx="59" cy="50" r="2.9" fill="${INK}"/>
      <circle cx="41.9" cy="49" r="1" fill="#fff"/><circle cx="59.9" cy="49" r="1" fill="#fff"/>
      <path d="M41 59q9-7 18 0-9 8-18 0z" fill="#ff9d42" ${S}/>
      <ellipse cx="33" cy="58" rx="4" ry="2.4" fill="${BLUSH}" opacity=".8"/><ellipse cx="67" cy="58" rx="4" ry="2.4" fill="${BLUSH}" opacity=".8"/>`,

    star: () => `
      <path d="${starPath(50, 53, 31, 15)}" fill="#ffd84d" ${S} stroke-width="2.6"/>
      ${face(50, 56, 0.75)}${sparkle(20, 22, 4)}${sparkle(82, 78, 4)}`,

    cloud: () => `${cloud(50, 56, 1.15)}${face(50, 58, 0.75, { sleepy: true })}${sparkle(80, 24, 5)}${sparkle(20, 76, 4)}`,

    sun: () => {
      let rays = '';
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6, w = 0.2;
        const p = (r, ang) => `${(50 + r * Math.cos(ang)).toFixed(1)} ${(50 + r * Math.sin(ang)).toFixed(1)}`;
        rays += `<path d="M${p(24, a - w)}L${p(39, a)}L${p(24, a + w)}z" fill="#ffd25e" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`;
      }
      return `${rays}<circle cx="50" cy="50" r="23" fill="#ffb04a" ${S}/>${face(50, 52, 0.85)}`;
    },

    moon: (u) => `
      ${sparkle(73, 74, 5, '#ffe680')}${sparkle(77, 27, 4)}${sparkle(25, 23, 3)}
      <mask id="${u}m"><rect width="100" height="100" fill="#fff"/><circle cx="63" cy="42" r="21" fill="#000"/></mask>
      <clipPath id="${u}k"><circle cx="46" cy="54" r="27"/></clipPath>
      <g mask="url(#${u}m)"><circle cx="46" cy="54" r="27" fill="#ffe680" ${S}/></g>
      <circle cx="63" cy="42" r="21" fill="none" stroke="${INK}" stroke-width="2.2" clip-path="url(#${u}k)"/>
      ${face(37, 64, 0.6, { sleepy: true })}`,

    rainbow: () => {
      const cols = ['#ff7d9e', '#ffb36b', '#ffe066', '#8ee08a', '#7cc8ff', '#b79cff'];
      const arcs = cols.map((c, i) => {
        const R = 34 - i * 5;
        return `<path d="M${50 - R} 66A${R} ${R} 0 0 1 ${50 + R} 66" fill="none" stroke="${c}" stroke-width="5.4"/>`;
      }).join('');
      return `${arcs}${cloud(22, 68, 0.55)}${cloud(78, 68, 0.55)}${face(22, 70, 0.36)}${face(78, 70, 0.36)}`;
    },

    daisy: () => {
      let petals = '';
      for (let i = 0; i < 10; i++) petals += `<ellipse cx="50" cy="29" rx="7.5" ry="13" fill="#fff" stroke="${INK}" stroke-width="1.8" transform="rotate(${i * 36} 50 50)"/>`;
      return `${petals}<circle cx="50" cy="50" r="14" fill="#ffd84d" ${S}/>${face(50, 51, 0.62)}`;
    },

    puppy: () => `
      <ellipse cx="50" cy="53" rx="24" ry="22" fill="#fff3dc" ${S}/>
      <ellipse cx="60" cy="44" rx="8" ry="7" fill="#f2c08f"/>
      <ellipse cx="27" cy="49" rx="9" ry="15" fill="#c98e5f" ${S} transform="rotate(18 27 49)"/>
      <ellipse cx="73" cy="49" rx="9" ry="15" fill="#c98e5f" ${S} transform="rotate(-18 73 49)"/>
      <circle cx="41" cy="51" r="2.9" fill="${INK}"/><circle cx="59" cy="51" r="2.9" fill="${INK}"/>
      <circle cx="41.9" cy="50" r="1" fill="#fff"/><circle cx="59.9" cy="50" r="1" fill="#fff"/>
      <ellipse cx="50" cy="58" rx="3.6" ry="2.6" fill="${INK}"/>
      <path d="M48.6 62.4q1.4 4.4 2.8 0z" fill="#ff8fab"/>
      <path d="M46.5 61q1.75 2.4 3.5 0q1.75 2.4 3.5 0" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
      <ellipse cx="35" cy="59" rx="4" ry="2.4" fill="${BLUSH}" opacity=".8"/><ellipse cx="65" cy="59" rx="4" ry="2.4" fill="${BLUSH}" opacity=".8"/>`,

    ribbon: () => `
      <path d="M47 53 36 77l8-2 4 7 5-27zM53 53l11 24-8-2-4 7-5-27z" fill="#ff8fb8" ${S}/>
      <path d="M50 50C38 33 19 31 21 48c1 12 17 13 29 2zM50 50c12-17 31-19 29-2-1 12-17 13-29 2z" fill="#ff9cc4" ${S}/>
      <path d="M41 46q-8-6-14-3M59 46q8-6 14-3" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="50" cy="50" r="8" fill="#ff6f9c" ${S}/>
      ${sparkle(22, 26, 5)}${sparkle(80, 74, 5)}${sparkle(80, 24, 3.5, '#ffd84d')}`,
  };

  /* ---------- catalog ---------- */
  // Prices/stock are placeholders until the shop confirms its catalog (PRD §12 "not yet specified").
  const CATEGORIES = [
    { id: 'all', name: 'All', icon: 'star' },
    { id: 'animals', name: 'Animals', icon: 'cat' },
    { id: 'food', name: 'Food', icon: 'strawberry' },
    { id: 'nature', name: 'Nature', icon: 'daisy' },
    { id: 'cute', name: 'Cute Stuff', icon: 'ribbon' },
    { id: 'special', name: 'Special', icon: 'sparkle' },
  ];

  // Order here = order in the "All" tab.
  const PINS = [
    { id: 'puppy', cat: 'animals', name: 'Puppy', price: 60, stock: 20, bg: '#fff4d6', pat: ['dots', '#ffe6a8'] },
    { id: 'cat', cat: 'animals', name: 'Sleepy Cat', price: 60, stock: 14, bg: '#e3f2ff', pat: ['dots', '#c6e3ff'] },
    { id: 'strawberry', cat: 'food', name: 'Strawberry', price: 55, stock: 24, bg: '#ffe3ea', pat: ['dots', '#ffc6d5'] },
    { id: 'moon', cat: 'nature', name: 'Moonbeam', price: 55, stock: 11, bg: '#4c5ba8', pat: ['night', '#ffffff'] },
    { id: 'daisy', cat: 'nature', name: 'Daisy', price: 45, stock: 28, bg: '#dff7e8', pat: ['dots', '#c3edd3'] },
    { id: 'ribbon', cat: 'cute', name: 'Ribbon', price: 50, stock: 18, bg: '#ffe8f2', pat: ['checks', '#ffd3e6'] },
    { id: 'cloud', cat: 'nature', name: 'Cloud Nap', price: 50, stock: 17, bg: '#cfe9ff', pat: ['dots', '#b6dcff'] },
    { id: 'bear', cat: 'animals', name: 'Honey Bear', price: 60, stock: 10, bg: '#fff1d9', pat: ['stripes', '#ffe3b3'] },
    { id: 'star', cat: 'special', name: 'Lucky Star', price: 50, stock: 25, bg: '#ece6ff', pat: ['dots', '#d9ceff'] },
    { id: 'heart', cat: 'cute', name: 'Heart', price: 45, stock: 30, bg: '#fff6c9', pat: ['rays', '#ffeb98'] },
    { id: 'bunny', cat: 'animals', name: 'Bun Bun', price: 60, stock: 16, bg: '#ffe3f0', pat: ['checks', '#ffcde3'] },
    { id: 'cherry', cat: 'food', name: 'Cherry Duo', price: 50, stock: 18, bg: '#fff0d6', pat: ['checks', '#ffe2ad'] },
    { id: 'sun', cat: 'nature', name: 'Sunny', price: 55, stock: 13, bg: '#fff3c4', pat: ['rays', '#ffe68e'] },
    { id: 'ghost', cat: 'cute', name: 'Ghostie', price: 65, stock: 2, bg: '#e8e0ff', pat: ['stripes', '#d8ccff'] },
    { id: 'boba', cat: 'food', name: 'Boba', price: 60, stock: 20, bg: '#e3f6ea', pat: ['stripes', '#ccecd7'] },
    { id: 'frog', cat: 'animals', name: 'Froggy', price: 55, stock: 22, bg: '#fff7d6', pat: ['dots', '#ffeaa3'] },
    { id: 'peach', cat: 'food', name: 'Peachy', price: 50, stock: 15, bg: '#fff1e6', pat: ['dots', '#ffdcc4'] },
    { id: 'rainbow', cat: 'special', name: 'Rainbow', price: 70, stock: 0, bg: '#fff0f5', pat: ['dots', '#ffdbe8'] },
    { id: 'duck', cat: 'animals', name: 'Ducky', price: 55, stock: 19, bg: '#dff5ff', pat: ['rays', '#c8ecff'] },
    { id: 'donut', cat: 'food', name: 'Donut', price: 55, stock: 12, bg: '#e8e4ff', pat: ['dots', '#d5ccff'] },
  ];
  PINS.forEach((p, i) => { p.code = String.fromCharCode(65 + Math.floor(i / 5)) + ((i % 5) + 1); });

  // Small icon (tabs) — the pin art without the badge frame.
  function iconSVG(id) {
    if (id === 'sparkle') {
      return `<svg class="ico" viewBox="0 0 100 100" aria-hidden="true">${sparkle(50, 50, 38, '#ffd84d').replace('/>', ` stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`)}${sparkle(80, 22, 12, '#ff9cc4')}</svg>`;
    }
    return `<svg class="ico" viewBox="16 16 68 68" aria-hidden="true">${ART[id]('ic' + ++uid, { bg: '#fff' })}</svg>`;
  }

  function pinSVG(p) {
    const u = 'kp' + ++uid;
    return `<svg class="pin-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="${u}c"><circle cx="50" cy="50" r="42"/></clipPath>
        <radialGradient id="${u}g" cx="32%" cy="26%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".38" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
        <linearGradient id="${u}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e4d9f5"/></linearGradient>
      </defs>
      <circle cx="50" cy="50" r="47" fill="url(#${u}r)" stroke="${INK}" stroke-width="2.6"/>
      <g clip-path="url(#${u}c)"><rect width="100" height="100" fill="${p.bg}"/>${BG[p.pat[0]](p.pat[1])}${ART[p.id](u, p)}</g>
      <circle cx="50" cy="50" r="42" fill="none" stroke="${INK}" stroke-width="1.6"/>
      <circle cx="50" cy="50" r="42" fill="url(#${u}g)"/>
      <path d="M19 40A32 32 0 0 1 37 16" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" opacity=".85"/>
    </svg>`;
  }

  window.KP_PINS = { PINS, CATEGORIES, pinSVG, iconSVG, face, MAX_PER_PIN: 5 };
})();
