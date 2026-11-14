/* KL!KPIN — Supabase client + shop loader. Built-in art stays in pins.js; the DB can override it per pin. */
import { createClient } from '@supabase/supabase-js';
import { ART, VISUALS } from './pins.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
let client;
// Throws lazily (not at import) so a missing .env shows the machine's load-error state instead of a blank page.
export function supabase() {
  if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.');
  return client || (client = createClient(url, key));
}

const DEFAULT_SETTINGS = { open: true, closed_msg: 'Taking a little break. Back soon ♡', max_per_pin: 5 };

// -> { categories, pins, settings, methods }; money is converted to pesos here (the UI works in pesos, orders in cents)
export async function loadShop() {
  const [cats, pins, set, meth] = await Promise.all([
    supabase().from('categories').select('id,name,icon,sort').order('sort'),
    supabase().from('pins').select('*').eq('active', true).order('sort'), // * so older schemas without the art columns still load
    supabase().from('settings').select('*').eq('id', 1).maybeSingle(),
    supabase().from('pay_methods').select('id,kind,name,note,acc_name,acc_no,qr_url,sort').eq('active', true).order('sort'),
  ]);
  if (cats.error) throw cats.error;
  if (pins.error) throw pins.error;
  // settings/methods failing (e.g. migration not applied yet) must not hide the catalog: shop stays open, checkout is blocked by "no methods"
  if (set.error) console.warn('settings:', set.error.message);
  if (meth.error) console.warn('pay_methods:', meth.error.message);

  // A pin with neither a picture nor built-in art for its art key is hidden.
  const shown = pins.data.filter((p) => !p.removed && (p.image_url || ART[p.art || p.id]));
  // sizes are pins of their own: keep each one right after the pin it was added to
  const visible = shown.filter((p) => !p.variant_of || !shown.some((b) => b.id === p.variant_of))
    .flatMap((p) => [p, ...shown.filter((v) => v.variant_of === p.id)]);
  const PINS = visible.map((p, i) => {
    const v = VISUALS[p.id] || {};
    return {
      id: p.id,
      cat: p.category_id,
      name: p.name,
      price: p.price_cents / 100,
      stock: p.stock,
      art: p.art || p.id,
      img: p.image_url || null,
      bg: p.bg || v.bg || '#fff',
      pat: p.pat ? [p.pat, p.pat_color || '#eee'] : v.pat || ['dots', '#eee'],
      code: String.fromCharCode(65 + Math.floor(i / 5)) + ((i % 5) + 1),
    };
  });
  return {
    categories: [{ id: 'all', name: 'All', icon: 'star' }, ...cats.data],
    pins: PINS,
    settings: { ...DEFAULT_SETTINGS, ...(set.data || {}) },
    methods: meth.data || [],
  };
}
