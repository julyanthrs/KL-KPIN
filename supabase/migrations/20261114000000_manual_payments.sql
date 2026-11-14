-- Manual payments go-live: admins, pin visuals, settings, pay_methods, new order flow, storage.
-- Additive on init.sql; existing orders survive. Never `db reset` the hosted project.

-- ===== Admins =====
create table admins (
  user_id uuid primary key references auth.users on delete cascade
);
alter table admins enable row level security;
create policy "admin reads own row" on admins
  for select to authenticated using (user_id = auth.uid());

create function is_admin() returns boolean
language sql security definer stable set search_path = public
as $$ select exists (select 1 from admins where user_id = auth.uid()) $$;
revoke execute on function is_admin() from public, anon, authenticated;
grant execute on function is_admin() to anon, authenticated, service_role;

-- ===== Pins =====
alter table pins
  add column art       text,
  add column bg        text,
  add column pat       text,
  add column pat_color text,
  add column image_url text,
  add column removed   boolean not null default false,
  add column created_at timestamptz not null default now();

update pins p set bg = v.bg, pat = v.pat, pat_color = v.pat_color
from (values
    ('puppy', '#fff4d6', 'dots', '#ffe6a8'),
    ('cat', '#e3f2ff', 'dots', '#c6e3ff'),
    ('strawberry', '#ffe3ea', 'dots', '#ffc6d5'),
    ('moon', '#4c5ba8', 'night', '#ffffff'),
    ('daisy', '#dff7e8', 'dots', '#c3edd3'),
    ('ribbon', '#ffe8f2', 'checks', '#ffd3e6'),
    ('cloud', '#cfe9ff', 'dots', '#b6dcff'),
    ('bear', '#fff1d9', 'stripes', '#ffe3b3'),
    ('star', '#ece6ff', 'dots', '#d9ceff'),
    ('heart', '#fff6c9', 'rays', '#ffeb98'),
    ('bunny', '#ffe3f0', 'checks', '#ffcde3'),
    ('cherry', '#fff0d6', 'checks', '#ffe2ad'),
    ('sun', '#fff3c4', 'rays', '#ffe68e'),
    ('ghost', '#e8e0ff', 'stripes', '#d8ccff'),
    ('boba', '#e3f6ea', 'stripes', '#ccecd7'),
    ('frog', '#fff7d6', 'dots', '#ffeaa3'),
    ('peach', '#fff1e6', 'dots', '#ffdcc4'),
    ('rainbow', '#fff0f5', 'dots', '#ffdbe8'),
    ('duck', '#dff5ff', 'rays', '#c8ecff'),
    ('donut', '#e8e4ff', 'dots', '#d5ccff')
) as v(id, bg, pat, pat_color)
where p.id = v.id;

drop policy "public read active pins" on pins;
create policy "public read shown pins" on pins
  for select to anon, authenticated using (active and not removed);
create policy "admin all pins" on pins
  for all to authenticated using (is_admin()) with check (is_admin());

-- the admin edits categories too (not spelled out in the plan)
create policy "admin all categories" on categories
  for all to authenticated using (is_admin()) with check (is_admin());

-- ===== Settings =====
create table settings (
  id         int primary key default 1 check (id = 1),
  open       boolean not null default true,
  closed_msg text not null default 'Taking a little break. Back soon ♡',
  order_prefix text not null default 'KP-' check (order_prefix ~ '^[A-Z0-9]{1,6}-$'),
  max_per_pin int not null default 5 check (max_per_pin between 1 and 50),
  low_at      int not null default 3 check (low_at between 0 and 50),
  restock_by  int not null default 10 check (restock_by between 1 and 100),
  receipt     jsonb not null default '{"name":"KL!KPIN","place":"","contact":"","note":"Thanks for popping by the machine!"}'
);
insert into settings (id) values (1);
alter table settings enable row level security;
create policy "public read settings" on settings
  for select to anon, authenticated using (true);
create policy "admin update settings" on settings
  for update to authenticated using (is_admin()) with check (is_admin());

-- ===== Payment methods =====
create table pay_methods (
  id        text primary key,
  kind      text not null check (kind in ('qr','bank','card','cash','other')),
  name      text not null,
  note      text not null default '',
  acc_name  text not null default '',
  acc_no    text not null default '',
  qr_url    text,
  active    boolean not null default false,
  sort      int not null default 0,
  created_at timestamptz not null default now()
);
alter table pay_methods enable row level security;
create policy "public read active methods" on pay_methods
  for select to anon, authenticated using (active);
create policy "admin all methods" on pay_methods
  for all to authenticated using (is_admin()) with check (is_admin());

-- ===== Orders =====
alter table orders
  add column method_id    text,
  add column method_name  text,
  add column claim_token  text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  add column proof_path   text,
  add column proof_at     timestamptz,
  add column reject_reason text,
  add column decided_at   timestamptz,
  add column packed_at    timestamptz,
  add column collected_at timestamptz,
  add column refunded_at  timestamptz;

update orders set status = 'cancelled' where status = 'failed';
alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check check (status in
  ('pending','submitted','paid','packed','collected','rejected','cancelled','refunded','needs_refund'));

alter table order_lines drop constraint order_lines_qty_check;
alter table order_lines add constraint order_lines_qty_check check (qty >= 1);

create policy "admin read orders" on orders
  for select to authenticated using (is_admin());
create policy "admin update orders" on orders
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin read order lines" on order_lines
  for select to authenticated using (is_admin());

-- ===== Drop the demo-payment functions =====
drop function create_order(jsonb, text, text);
drop function mark_order_paid(text, text);

-- ===== Storage helper (also used by submit_payment) =====
create function proof_upload_ok(name text) returns boolean
language sql security definer stable set search_path = public
as $$
  select position('/' in name) > 1 and exists (
    select 1 from orders where id = split_part(name, '/', 1) and status in ('pending','rejected'))
$$;
revoke execute on function proof_upload_ok(text) from public, anon, authenticated;
grant execute on function proof_upload_ok(text) to anon, authenticated, service_role;

-- ===== Customer RPCs =====
create function create_order(lines jsonb, method_id text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  s        settings%rowtype;
  m        pay_methods%rowtype;
  l        jsonb;
  ids      text[] := '{}';
  pid      text;
  p        pins%rowtype;
  problems jsonb := '[]';
  total    int := 0;
  new_id   text;
  new_tok  text;
begin
  select * into s from settings where id = 1;
  if not s.open then raise exception 'shop_closed'; end if;

  select * into m from pay_methods pm where pm.id = create_order.method_id and pm.active;
  if not found then raise exception 'bad_method'; end if;

  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'bad_lines';
  end if;
  for l in select * from jsonb_array_elements(lines) loop
    pid := l->>'pin_id';
    if jsonb_typeof(l) is distinct from 'object' or pid is null
       or jsonb_typeof(l->'qty') is distinct from 'number'
       or (case when jsonb_typeof(l->'qty') = 'number'
               then (l->>'qty')::numeric <> trunc((l->>'qty')::numeric)
                    or (l->>'qty')::numeric not between 1 and s.max_per_pin
               else true end)
       or pid = any(ids) then
      raise exception 'bad_lines';
    end if;
    ids := ids || pid;
  end loop;

  perform 1 from pins where id = any(ids) order by id for update;
  if (select count(*) from pins where id = any(ids) and active and not removed) <> array_length(ids, 1) then
    raise exception 'unknown_pin';
  end if;

  for l in select * from jsonb_array_elements(lines) loop
    select * into p from pins where id = l->>'pin_id';
    if p.stock < (l->>'qty')::int then
      problems := problems || jsonb_build_object('id', p.id, 'available', p.stock);
    end if;
    total := total + p.price_cents * (l->>'qty')::int;
  end loop;
  if jsonb_array_length(problems) > 0 then
    return jsonb_build_object('problems', problems);
  end if;

  loop
    new_id := s.order_prefix || (select string_agg(substr(alphabet, 1 + floor(random() * 36)::int, 1), '')
                                 from generate_series(1, 5));
    exit when not exists (select 1 from orders where id = new_id);
  end loop;

  insert into orders (id, method, method_id, method_name, total_cents)
  values (new_id, m.kind, m.id, m.name, total)
  returning claim_token into new_tok;

  insert into order_lines (order_id, pin_id, name, unit_price_cents, qty)
  select new_id, p2.id, p2.name, p2.price_cents, (e->>'qty')::int
  from jsonb_array_elements(lines) e join pins p2 on p2.id = e->>'pin_id';

  return jsonb_build_object('order_id', new_id, 'token', new_tok, 'total_cents', total,
    'method', jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name, 'note', m.note,
                                 'acc_name', m.acc_name, 'acc_no', m.acc_no, 'qr_url', m.qr_url));
end;
$$;

create function submit_payment(order_id text, token text, proof_path text default null) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  o        orders%rowtype;
  problems jsonb;
begin
  select * into o from orders x
   where x.id = submit_payment.order_id and x.claim_token = submit_payment.token for update;
  if not found then raise exception 'not_found'; end if;
  if o.status not in ('pending','rejected') then raise exception 'bad_state'; end if;

  if submit_payment.proof_path is null then
    if o.method <> 'cash' then raise exception 'proof_required'; end if;
  elsif left(submit_payment.proof_path, length(o.id) + 1) <> o.id || '/'
     or not exists (select 1 from storage.objects so
                    where so.bucket_id = 'payment-proofs' and so.name = submit_payment.proof_path) then
    raise exception 'bad_proof';
  end if;

  perform 1 from pins where id in (select ol.pin_id from order_lines ol where ol.order_id = o.id)
    order by id for update;

  select jsonb_agg(jsonb_build_object('id', p.id, 'available', p.stock))
    into problems
    from order_lines ol join pins p on p.id = ol.pin_id
   where ol.order_id = o.id and p.stock < ol.qty;

  if problems is not null then
    if o.method = 'cash' then
      return jsonb_build_object('problems', problems);
    end if;
    update orders set status = 'needs_refund', proof_path = submit_payment.proof_path, proof_at = now()
     where id = o.id;
    return jsonb_build_object('status', 'needs_refund');
  end if;

  update pins p set stock = p.stock - ol.qty
    from order_lines ol where ol.order_id = o.id and ol.pin_id = p.id;
  update orders set status = 'submitted', proof_path = submit_payment.proof_path,
         proof_at = now(), reject_reason = null
   where id = o.id;
  return jsonb_build_object('status', 'submitted');
end;
$$;

create function order_status(order_id text, token text) returns jsonb
language plpgsql security definer stable set search_path = public
as $$
declare o orders%rowtype;
begin
  select * into o from orders x
   where x.id = order_status.order_id and x.claim_token = order_status.token;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('status', o.status, 'reject_reason', o.reject_reason,
    'order', jsonb_build_object(
      'order_id', o.id, 'method_name', o.method_name, 'method', o.method,
      'total_cents', o.total_cents, 'currency', o.currency,
      'created_at', o.created_at, 'paid_at', o.paid_at,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('pin_id', ol.pin_id, 'name', ol.name,
                  'qty', ol.qty, 'unit_price_cents', ol.unit_price_cents) order by ol.pin_id)
                from order_lines ol where ol.order_id = o.id), '[]'::jsonb)));
end;
$$;

create function cancel_order(order_id text, token text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare o orders%rowtype;
begin
  select * into o from orders x
   where x.id = cancel_order.order_id and x.claim_token = cancel_order.token for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'pending' then return jsonb_build_object('status', o.status); end if;
  update orders set status = 'cancelled' where id = o.id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- ===== Admin RPCs =====
create function approve_order(order_id text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare o orders%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into o from orders x where x.id = approve_order.order_id for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'submitted' then raise exception 'bad_state'; end if;
  update orders set status = 'paid', paid_at = now(), decided_at = now() where id = o.id;
  return jsonb_build_object('status', 'paid');
end;
$$;

create function reject_order(order_id text, reason text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare o orders%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into o from orders x where x.id = reject_order.order_id for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'submitted' then raise exception 'bad_state'; end if;
  perform 1 from pins where id in (select ol.pin_id from order_lines ol where ol.order_id = o.id)
    order by id for update;
  update pins p set stock = p.stock + ol.qty
    from order_lines ol where ol.order_id = o.id and ol.pin_id = p.id;
  update orders set status = 'rejected', reject_reason = reject_order.reason, decided_at = now()
   where id = o.id;
  return jsonb_build_object('status', 'rejected');
end;
$$;

create function set_order_status(order_id text, status text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  o   orders%rowtype;
  ns  text := set_order_status.status;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into o from orders x where x.id = set_order_status.order_id for update;
  if not found then raise exception 'not_found'; end if;

  if (o.status, ns) in (('paid','packed'),('packed','paid'),('packed','collected'),('collected','packed')) then
    update orders set status = ns,
      packed_at    = case when ns = 'packed' then now() when ns = 'paid' then null else packed_at end,
      collected_at = case when ns = 'collected' then now() when ns = 'packed' then null else collected_at end
     where id = o.id;
  elsif ns = 'refunded' and o.status in ('submitted','paid','packed','collected','needs_refund') then
    if o.status in ('submitted','paid','packed') then
      perform 1 from pins where id in (select ol.pin_id from order_lines ol where ol.order_id = o.id)
        order by id for update;
      update pins p set stock = p.stock + ol.qty
        from order_lines ol where ol.order_id = o.id and ol.pin_id = p.id;
    end if;
    update orders set status = 'refunded', refunded_at = now() where id = o.id;
  else
    raise exception 'bad_state';
  end if;
  return jsonb_build_object('status', ns);
end;
$$;

create function adjust_stock(pin_id text, delta int) returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update pins set stock = greatest(0, stock + adjust_stock.delta)
   where id = adjust_stock.pin_id returning stock into n;
  if not found then raise exception 'unknown_pin'; end if;
  return n;
end;
$$;

-- default privileges on Supabase grant execute to anon/authenticated, so revoke those explicitly
revoke execute on function create_order(jsonb, text), submit_payment(text, text, text),
  order_status(text, text), cancel_order(text, text), approve_order(text), reject_order(text, text),
  set_order_status(text, text), adjust_stock(text, int) from public, anon, authenticated;
grant execute on function create_order(jsonb, text), submit_payment(text, text, text),
  order_status(text, text), cancel_order(text, text) to anon, authenticated, service_role;
grant execute on function approve_order(text), reject_order(text, text),
  set_order_status(text, text), adjust_stock(text, int) to authenticated, service_role;

-- ===== Storage =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('pin-images', 'pin-images', true, 3145728, array['image/png','image/jpeg','image/webp','image/gif']),
  ('payment-proofs', 'payment-proofs', false, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- legacy screenshot-schema policies (anyone could upload any proof) may still be on the hosted project
drop policy if exists "admin manage pin images" on storage.objects;
drop policy if exists "anyone uploads proofs (insert only)" on storage.objects;
drop policy if exists "admin reads proofs" on storage.objects;
drop policy if exists "admin deletes proofs" on storage.objects;

drop policy if exists "admin insert pin images" on storage.objects;
drop policy if exists "admin update pin images" on storage.objects;
drop policy if exists "admin delete pin images" on storage.objects;
drop policy if exists "customer upload proofs" on storage.objects;
drop policy if exists "admin read proofs" on storage.objects;
drop policy if exists "admin insert proofs" on storage.objects;
drop policy if exists "admin delete proofs" on storage.objects;

create policy "admin insert pin images" on storage.objects for insert to authenticated
  with check (bucket_id = 'pin-images' and is_admin());
create policy "admin update pin images" on storage.objects for update to authenticated
  using (bucket_id = 'pin-images' and is_admin()) with check (bucket_id = 'pin-images' and is_admin());
create policy "admin delete pin images" on storage.objects for delete to authenticated
  using (bucket_id = 'pin-images' and is_admin());

create policy "customer upload proofs" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs' and proof_upload_ok(name));
create policy "admin read proofs" on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs' and is_admin());
create policy "admin insert proofs" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-proofs' and is_admin());
create policy "admin delete proofs" on storage.objects for delete to authenticated
  using (bucket_id = 'payment-proofs' and is_admin());
