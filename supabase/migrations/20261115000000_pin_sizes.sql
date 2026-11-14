-- Optional size variants. A size is just another pin row (own price, stock and name, e.g. "Sleepy Fox · Large"),
-- so create_order, stock and refunds need no change. variant_of points at the pin the size was added to.
alter table pins
  add column size_label text,
  add column variant_of text references pins(id) on delete cascade;
create index pins_variant_of_idx on pins (variant_of);
