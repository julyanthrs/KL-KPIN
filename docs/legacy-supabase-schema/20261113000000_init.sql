-- KL!KPIN schema: catalog, orders (proof-of-payment flow), settings, admin owner

create extension if not exists pgcrypto;
-- ---------- admin ----------
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
create policy "admins read self" on public.admins for select using (user_id = auth.uid());
-- Single owner: the first signed-up user becomes admin only when claimed via claim_owner().
create or replace function public.claim_owner() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if exists (select 1 from public.admins) then return false; end if;
  insert into public.admins(user_id) values (auth.uid());
  return true;
end $$;
revoke all on function public.claim_owner() from public, anon;
grant execute on function public.claim_owner() to authenticated;
-- ---------- catalog ----------
create table public.categories (
  id text primary key,
  name text not null,
  icon text,                       -- pin art_key or 'sparkle' used as the tab icon
  sort int not null default 0
);
create table public.pins (
  id text primary key,
  category_id text not null references public.categories(id) on update cascade,
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  stock int not null default 0 check (stock >= 0),
  bg text not null default '#ffffff',
  pattern text not null default 'dots',
  pattern_color text not null default '#eeeeee',
  art_key text,                    -- built-in procedural art (existing pins)
  image_url text,                  -- admin-uploaded art (new pins)
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (art_key is not null or image_url is not null)
);
create table public.inventory_log (
  id bigserial primary key,
  pin_id text not null,
  delta int not null,
  reason text not null,
  order_id text,
  created_at timestamptz not null default now()
);
-- ---------- settings (payment instructions etc.) ----------
create table public.settings (
  key text primary key,
  value text not null default ''
);
-- ---------- orders ----------
create table public.orders (
  id text primary key,
  status text not null default 'pending_proof'
    check (status in ('pending_proof','pending_verification','paid','rejected','cancelled')),
  total numeric(10,2) not null,
  currency text not null default 'PHP',
  proof_path text,
  claim_token text not null default encode(gen_random_bytes(12), 'hex'),
  customer_note text,
  reject_reason text,
  created_at timestamptz not null default now(),
  proof_at timestamptz,
  decided_at timestamptz
);
create table public.order_items (
  id bigserial primary key,
  order_id text not null references public.orders(id) on delete cascade,
  pin_id text not null,
  name text not null,
  price numeric(10,2) not null,
  qty int not null check (qty > 0)
);
-- ---------- RLS ----------
alter table public.categories enable row level security;
alter table public.pins enable row level security;
alter table public.inventory_log enable row level security;
alter table public.settings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
create policy "public read categories" on public.categories for select using (true);
create policy "public read active pins" on public.pins for select using (active or public.is_admin());
create policy "public read settings" on public.settings for select using (true);
create policy "admin all categories" on public.categories for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all pins" on public.pins for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all settings" on public.settings for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all orders" on public.orders for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all order_items" on public.order_items for all using (public.is_admin()) with check (public.is_admin());
create policy "admin read inventory_log" on public.inventory_log for select using (public.is_admin());
-- ---------- storefront RPCs (anon-callable, no direct table writes) ----------
-- items: [{"id":"puppy","qty":2}, ...]
create or replace function public.submit_order(items jsonb, note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it jsonb; p public.pins; q int; oid text; tok text; tot numeric := 0; tries int := 0;
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'empty_order';
  end if;
  -- validate first
  for it in select * from jsonb_array_elements(items) loop
    q := (it->>'qty')::int;
    select * into p from public.pins where id = it->>'id' and active;
    if not found then raise exception 'unknown_pin:%', it->>'id'; end if;
    if q is null or q < 1 or q > 5 then raise exception 'bad_qty:%', p.id; end if;
    if q > p.stock then raise exception 'soldout:%:%', p.id, p.stock; end if;
    tot := tot + q * p.price;
  end loop;
  loop
    oid := 'KP-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 5));
    begin
      insert into public.orders(id, total, customer_note) values (oid, tot, left(note, 500))
        returning claim_token into tok;
      exit;
    exception when unique_violation then
      tries := tries + 1; if tries > 5 then raise; end if;
    end;
  end loop;
  insert into public.order_items(order_id, pin_id, name, price, qty)
    select oid, p2.id, p2.name, p2.price, (e->>'qty')::int
    from jsonb_array_elements(items) e join public.pins p2 on p2.id = e->>'id';
  return jsonb_build_object('order_id', oid, 'token', tok, 'total', tot);
end $$;
-- attach the uploaded screenshot (path = '<order_id>/<file>') and move to verification
create or replace function public.attach_proof(p_order text, p_token text, p_path text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.orders
     set proof_path = p_path, status = 'pending_verification', proof_at = now()
   where id = p_order and claim_token = p_token and status in ('pending_proof','rejected')
     and p_path like p_order || '/%';
  if not found then raise exception 'invalid_order'; end if;
end $$;
-- lets the customer check their own order's status (needs the token)
create or replace function public.order_status(p_order text, p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', status, 'reject_reason', reject_reason, 'total', total)
  from public.orders where id = p_order and claim_token = p_token;
$$;
grant execute on function public.submit_order(jsonb, text) to anon, authenticated;
grant execute on function public.attach_proof(text, text, text) to anon, authenticated;
grant execute on function public.order_status(text, text) to anon, authenticated;
-- ---------- admin RPCs ----------
create or replace function public.approve_order(p_order text)
returns void language plpgsql security definer set search_path = public as $$
declare r record; o public.orders;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found or o.status not in ('pending_verification') then raise exception 'not_pending'; end if;
  for r in select * from public.order_items where order_id = p_order loop
    update public.pins set stock = stock - r.qty where id = r.pin_id and stock >= r.qty;
    if not found then raise exception 'soldout:%', r.pin_id; end if;
    insert into public.inventory_log(pin_id, delta, reason, order_id) values (r.pin_id, -r.qty, 'order_paid', p_order);
  end loop;
  update public.orders set status = 'paid', decided_at = now() where id = p_order;
end $$;
create or replace function public.reject_order(p_order text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.orders set status = 'rejected', reject_reason = p_reason, decided_at = now()
   where id = p_order and status = 'pending_verification';
end $$;
grant execute on function public.approve_order(text) to authenticated;
grant execute on function public.reject_order(text, text) to authenticated;
-- ---------- storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('pin-images', 'pin-images', true, 3145728, array['image/png','image/jpeg','image/webp','image/svg+xml']),
  ('payment-proofs', 'payment-proofs', false, 5242880, array['image/png','image/jpeg','image/webp','image/heic'])
on conflict (id) do nothing;
create policy "admin manage pin images" on storage.objects for all
  using (bucket_id = 'pin-images' and public.is_admin())
  with check (bucket_id = 'pin-images' and public.is_admin());
create policy "anyone uploads proofs (insert only)" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs');
create policy "admin reads proofs" on storage.objects for select
  using (bucket_id = 'payment-proofs' and public.is_admin());
create policy "admin deletes proofs" on storage.objects for delete
  using (bucket_id = 'payment-proofs' and public.is_admin());
-- ---------- seed ----------
insert into public.settings(key, value) values
  ('payment_instructions', 'Send the exact total, then upload a screenshot of your payment.'),
  ('payment_qr_url', ''),
  ('payment_account', '')
on conflict do nothing;
insert into public.categories(id, name, icon, sort) values
  ('animals','Animals','cat',1),('food','Food','strawberry',2),('nature','Nature','daisy',3),
  ('cute','Cute Stuff','ribbon',4),('special','Special','sparkle',5);
insert into public.pins(id, category_id, name, price, stock, bg, pattern, pattern_color, art_key, sort) values
  ('puppy','animals','Puppy',60,20,'#fff4d6','dots','#ffe6a8','puppy',1),
  ('cat','animals','Sleepy Cat',60,14,'#e3f2ff','dots','#c6e3ff','cat',2),
  ('strawberry','food','Strawberry',55,24,'#ffe3ea','dots','#ffc6d5','strawberry',3),
  ('moon','nature','Moonbeam',55,11,'#4c5ba8','night','#ffffff','moon',4),
  ('daisy','nature','Daisy',45,28,'#dff7e8','dots','#c3edd3','daisy',5),
  ('ribbon','cute','Ribbon',50,18,'#ffe8f2','checks','#ffd3e6','ribbon',6),
  ('cloud','nature','Cloud Nap',50,17,'#cfe9ff','dots','#b6dcff','cloud',7),
  ('bear','animals','Honey Bear',60,10,'#fff1d9','stripes','#ffe3b3','bear',8),
  ('star','special','Lucky Star',50,25,'#ece6ff','dots','#d9ceff','star',9),
  ('heart','cute','Heart',45,30,'#fff6c9','rays','#ffeb98','heart',10),
  ('bunny','animals','Bun Bun',60,16,'#ffe3f0','checks','#ffcde3','bunny',11),
  ('cherry','food','Cherry Duo',50,18,'#fff0d6','checks','#ffe2ad','cherry',12),
  ('sun','nature','Sunny',55,13,'#fff3c4','rays','#ffe68e','sun',13),
  ('ghost','cute','Ghostie',65,2,'#e8e0ff','stripes','#d8ccff','ghost',14),
  ('boba','food','Boba',60,20,'#e3f6ea','stripes','#ccecd7','boba',15),
  ('frog','animals','Froggy',55,22,'#fff7d6','dots','#ffeaa3','frog',16),
  ('peach','food','Peachy',50,15,'#fff1e6','dots','#ffdcc4','peach',17),
  ('rainbow','special','Rainbow',70,0,'#fff0f5','dots','#ffdbe8','rainbow',18),
  ('duck','animals','Ducky',55,19,'#dff5ff','rays','#c8ecff','duck',19),
  ('donut','food','Donut',55,12,'#e8e4ff','dots','#d5ccff','donut',20);
