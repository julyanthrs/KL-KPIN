-- The customer must leave a name, phone number and delivery address with every order. Additive: existing orders keep NULLs.
alter table orders
  add column cust_name    text,
  add column cust_phone   text,
  add column cust_address text;

drop function create_order(jsonb, text);

create function create_order(lines jsonb, method_id text, cust_name text, cust_phone text, cust_address text) returns jsonb
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

  cust_name := btrim(coalesce(cust_name, '')); cust_phone := btrim(coalesce(cust_phone, '')); cust_address := btrim(coalesce(cust_address, ''));
  if char_length(cust_name) not between 2 and 80
     or cust_phone !~ '^[0-9+ ()-]+$' or length(regexp_replace(cust_phone, '\D', '', 'g')) not between 7 and 15
     or char_length(cust_address) not between 8 and 300 then
    raise exception 'bad_customer';
  end if;

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

  insert into orders (id, method, method_id, method_name, total_cents, cust_name, cust_phone, cust_address)
  values (new_id, m.kind, m.id, m.name, total, cust_name, cust_phone, cust_address)
  returning claim_token into new_tok;

  insert into order_lines (order_id, pin_id, name, unit_price_cents, qty)
  select new_id, p2.id, p2.name, p2.price_cents, (e->>'qty')::int
  from jsonb_array_elements(lines) e join pins p2 on p2.id = e->>'pin_id';

  return jsonb_build_object('order_id', new_id, 'token', new_tok, 'total_cents', total,
    'method', jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name, 'note', m.note,
                                 'acc_name', m.acc_name, 'acc_no', m.acc_no, 'qr_url', m.qr_url));
end;
$$;

revoke execute on function create_order(jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function create_order(jsonb, text, text, text, text) to anon, authenticated, service_role;
