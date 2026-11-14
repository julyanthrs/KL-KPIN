-- gen_random_bytes lives in the extensions schema; use core gen_random_uuid() instead
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
    oid := 'KP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
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
