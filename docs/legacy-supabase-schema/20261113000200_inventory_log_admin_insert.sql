-- admin stock edits write to inventory_log
create policy "admin insert inventory_log" on public.inventory_log for insert with check (public.is_admin());
