create table categories (
  id    text primary key,
  name  text not null,
  icon  text not null,
  sort  int  not null default 0
);

create table pins (
  id           text primary key,
  category_id  text not null references categories(id),
  name         text not null,
  price_cents  int  not null check (price_cents >= 0),
  stock        int  not null check (stock >= 0),
  sort         int  not null default 0,
  active       boolean not null default true
);

create table orders (
  id                  text primary key,
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
  name              text not null,
  unit_price_cents  int  not null,
  qty               int  not null check (qty between 1 and 5),
  primary key (order_id, pin_id)
);

alter table categories  enable row level security;
alter table pins        enable row level security;
alter table orders      enable row level security;
alter table order_lines enable row level security;

create policy "public read categories" on categories
  for select to anon, authenticated using (true);
create policy "public read active pins" on pins
  for select to anon, authenticated using (active);
-- orders / order_lines: no policies, so only the service role can touch them.

-- create_order: validates, checks stock, writes a pending order. Stock is taken at payment.
create function create_order(lines jsonb, method text, intent_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  l        jsonb;
  ids      text[] := '{}';
  pid      text;
  q        int;
  p        pins%rowtype;
  problems jsonb := '[]';
  total    int := 0;
  new_id   text;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'lines must be a non-empty array';
  end if;

  for l in select * from jsonb_array_elements(lines) loop
    pid := l->>'pin_id';
    if pid is null then raise exception 'pin_id required'; end if;
    if jsonb_typeof(l->'qty') is distinct from 'number'
       or (l->>'qty')::numeric <> trunc((l->>'qty')::numeric)
       or (l->>'qty')::numeric not between 1 and 5 then
      raise exception 'qty must be an integer 1..5 for %', pid;
    end if;
    if pid = any(ids) then raise exception 'duplicate pin_id %', pid; end if;
    ids := ids || pid;
  end loop;

  -- lock in id order to avoid deadlocks between concurrent orders
  perform 1 from pins where id = any(ids) order by id for update;
  if (select count(*) from pins where id = any(ids) and active) <> array_length(ids, 1) then
    raise exception 'unknown or inactive pin';
  end if;

  for l in select * from jsonb_array_elements(lines) loop
    select * into p from pins where id = l->>'pin_id';
    q := (l->>'qty')::int;
    if p.stock < q then
      problems := problems || jsonb_build_object('id', p.id, 'available', p.stock);
    end if;
    total := total + p.price_cents * q;
  end loop;

  if jsonb_array_length(problems) > 0 then
    return jsonb_build_object('problems', problems);
  end if;

  loop
    new_id := 'KP-' || (select string_agg(substr(alphabet, 1 + floor(random() * 36)::int, 1), '')
                     from generate_series(1, 5));
    exit when not exists (select 1 from orders where id = new_id);
  end loop;

  insert into orders (id, method, total_cents, provider_intent_id)
  values (new_id, method, total, intent_id);

  insert into order_lines (order_id, pin_id, name, unit_price_cents, qty)
  select new_id, p2.id, p2.name, p2.price_cents, (e->>'qty')::int
  from jsonb_array_elements(lines) e join pins p2 on p2.id = e->>'pin_id';

  return jsonb_build_object('order_id', new_id, 'total_cents', total);
end;
$$;

-- mark_order_paid: takes stock and marks paid, or needs_refund if stock ran out. Pending orders only.
create function mark_order_paid(order_id text, intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o orders%rowtype;
begin
  select * into o from orders where id = order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if o.status <> 'pending' then
    return jsonb_build_object('status', o.status);
  end if;

  perform 1 from pins where id in (select pin_id from order_lines where order_lines.order_id = o.id)
    order by id for update;

  if exists (select 1 from order_lines ol join pins p on p.id = ol.pin_id
             where ol.order_id = o.id and p.stock < ol.qty) then
    update orders set status = 'needs_refund',
      provider_intent_id = coalesce(provider_intent_id, intent_id) where id = o.id;
    return jsonb_build_object('status', 'needs_refund');
  end if;

  update pins p set stock = p.stock - ol.qty
  from order_lines ol where ol.order_id = o.id and ol.pin_id = p.id;

  update orders set status = 'paid', paid_at = now(),
    provider_intent_id = coalesce(provider_intent_id, intent_id) where id = o.id;
  return jsonb_build_object('status', 'paid');
end;
$$;

revoke execute on function create_order(jsonb, text, text) from public, anon, authenticated;
revoke execute on function mark_order_paid(text, text) from public, anon, authenticated;
grant execute on function create_order(jsonb, text, text) to service_role;
grant execute on function mark_order_paid(text, text) to service_role;
