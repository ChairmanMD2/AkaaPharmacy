-- Migration 7: shifts that can be opened/closed on a device while offline (idempotent, client time), and Realtime publication.

drop function if exists public.open_shift(numeric);
create function public.open_shift(p_float numeric, p_id uuid default null, p_opened_at timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v uuid; v_at timestamptz;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  if me.branch_id is null then raise exception 'Your account has no branch assigned'; end if;
  if p_float is null or p_float < 0 then raise exception 'Enter the opening cash float (0 if none)'; end if;
  if p_id is not null and exists (select 1 from public.shifts where id = p_id and cashier_id = me.id) then return p_id; end if;  -- already uploaded
  -- a device clock cannot start a shift in the future or more than 3 days back
  v_at := case when p_opened_at is null then now() else least(greatest(p_opened_at, now() - interval '3 days'), now()) end;
  insert into public.shifts (id, branch_id, cashier_id, opening_float, opened_at)
    values (coalesce(p_id, gen_random_uuid()), me.branch_id, me.id, p_float, v_at) returning id into v;
  return v;
exception when unique_violation then
  raise exception 'You already have an open shift. Close it first.';
end $$;

drop function if exists public.close_shift(uuid, numeric, text);
create function public.close_shift(p_shift uuid, p_counted numeric, p_note text default null, p_closed_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; s public.shifts; r jsonb; v_exp numeric; v_diff numeric; v_note text := nullif(trim(p_note), '');
begin
  me := public.assert_role('admin','pharmacist','cashier');
  select * into s from public.shifts where id = p_shift for update;
  if not found then raise exception 'Shift not found'; end if;
  if s.cashier_id <> me.id and not (me.role = 'admin' or (me.role = 'pharmacist' and me.branch_id = s.branch_id)) then
    raise exception 'Not your shift' using errcode = '42501';
  end if;
  if s.status <> 'open' then
    if s.status = 'closed' and p_closed_at is not null then return s.summary; end if;   -- an offline close that was already uploaded
    raise exception 'This shift is already closed';
  end if;
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash you counted'; end if;
  s.closed_at := case when p_closed_at is null then now() else least(greatest(p_closed_at, s.opened_at), now()) end;   -- count sales only up to the time it was really closed
  r := public.compute_shift(s);
  v_exp := (r->>'expected_cash')::numeric;
  v_diff := p_counted - v_exp;
  if v_diff <> 0 and v_note is null then
    if p_closed_at is null then raise exception 'The count is off by % . Please explain the difference in the note.', v_diff; end if;
    v_note := 'Closed offline; difference of ' || v_diff || ' was found when it uploaded.';
  end if;
  r := r || jsonb_build_object('counted_cash', p_counted, 'difference', v_diff);
  update public.shifts set status = 'closed', closed_at = s.closed_at, closed_by = me.id, expected_cash = v_exp,
    counted_cash = p_counted, difference = v_diff, summary = r, note = v_note where id = p_shift;
  return r;
end $$;

-- queued order payments must be safe to resend: a payment id makes the insert idempotent
alter table public.payments add column if not exists client_id uuid;
create unique index if not exists payments_client_id_uq on public.payments (client_id) where client_id is not null;

drop function if exists public.add_order_payment(uuid, text, numeric, text);
create function public.add_order_payment(p_order uuid, p_method text, p_amount numeric, p_reference text default null, p_client_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; v uuid; v_ref text := nullif(trim(p_reference),''); v_tx public.paystack_transactions%rowtype;
        v_status text; v_note text;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  if p_client_id is not null then
    select id into v from public.payments where client_id = p_client_id;
    if found then return v; end if;
  end if;
  o := public.get_order_for_update(p_order, me);
  if o.status in ('cancelled','returned') then raise exception 'Order is %', o.status; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Invalid amount'; end if;
  if p_method not in ('cash','card','transfer','pos_terminal','paystack','other') then raise exception 'Invalid method'; end if;
  if p_method in ('transfer','pos_terminal') and v_ref is null then
    raise exception 'A payment reference is required for %', p_method;
  end if;
  v_status := case when p_method = 'cash' then 'verified' else 'pending_verification' end;
  if p_method = 'paystack' then
    select * into v_tx from public.paystack_transactions where reference = v_ref for update;
    if v_ref is null or not found or v_tx.status <> 'success' or v_tx.claimed_sale is not null
       or v_tx.claimed_order is not null or v_tx.amount < p_amount then
      raise exception 'This Paystack payment has not been confirmed (or was already used). Complete the payment first.';
    end if;
    v_status := 'verified'; v_note := 'Confirmed with Paystack';
    update public.paystack_transactions set claimed_order = p_order where reference = v_ref;
  end if;
  insert into public.payments (order_id, branch_id, method, amount, status, reference, note, created_by, verified_by, verified_at, client_id)
    values (p_order, o.branch_id, p_method, p_amount, v_status, v_ref, v_note, me.id,
      case when v_status = 'verified' and p_method <> 'paystack' then me.id end,
      case when v_status = 'verified' then now() end, p_client_id)
    returning id into v;
  return v;
exception when unique_violation then
  raise exception 'This payment reference has already been used';
end $$;

revoke execute on function public.open_shift(numeric, uuid, timestamptz), public.close_shift(uuid, numeric, text, timestamptz),
  public.add_order_payment(uuid, text, numeric, text, uuid) from public, anon;
grant execute on function public.open_shift(numeric, uuid, timestamptz), public.close_shift(uuid, numeric, text, timestamptz),
  public.add_order_payment(uuid, text, numeric, text, uuid) to authenticated;

-- Realtime: other devices hear about stock, sales, order and list changes within seconds (row security still applies)
do $$
declare t text;
begin
  foreach t in array array['drugs','drug_batches','sales','payments','orders','delivery_jobs','wishlist_items','expenses','stock_receipts','suppliers','shifts'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
