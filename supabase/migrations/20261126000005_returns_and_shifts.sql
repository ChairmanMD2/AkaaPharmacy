-- Migration 5: customer returns/refunds and cashier shifts (cash-up).

-- ───────────── returns ─────────────
create sequence public.return_seq;

create table public.sale_returns (
  id uuid primary key default gen_random_uuid(),
  return_no text not null unique
    default ('RT' || to_char(now(), 'YYMM') || lpad(nextval('public.return_seq')::text, 5, '0')),
  sale_id uuid not null references public.sales(id),
  branch_id uuid not null references public.branches(id),
  reason text not null check (length(trim(reason)) > 0),
  refund_method text not null check (refund_method in ('cash','transfer','pos_terminal','store_credit','other')),
  refund_reference text,
  refund_amount numeric(12,2) not null default 0 check (refund_amount >= 0),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index sale_returns_sale on public.sale_returns (sale_id);
create index sale_returns_time on public.sale_returns (branch_id, created_at desc);

create table public.sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.sale_returns(id) on delete cascade,
  sale_item_id uuid not null references public.sale_items(id),
  drug_id uuid not null references public.drugs(id),
  batch_id uuid references public.drug_batches(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null,
  refund_amount numeric(12,2) not null,
  restocked boolean not null
);
create index sale_return_items_item on public.sale_return_items (sale_item_id);

alter table public.sale_returns enable row level security;
alter table public.sale_return_items enable row level security;
create policy returns_read on public.sale_returns for select to authenticated using ((select public.can_see_branch(branch_id)));
create policy return_items_read on public.sale_return_items for select to authenticated
  using (exists (select 1 from public.sale_returns r where r.id = return_id and (select public.can_see_branch(r.branch_id))));
create trigger audit_sale_returns after insert on public.sale_returns for each row execute function public.audit_row();

create function public.process_return(p_sale uuid, p_items jsonb, p_reason text, p_method text,
  p_reference text default null, p_restock boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles; s public.sales; it jsonb; si public.sale_items; b public.drug_batches;
  q int; already int; ratio numeric; line numeric(12,2); total numeric(12,2) := 0; rid uuid := gen_random_uuid();
  rn text; did_restock boolean;
begin
  me := public.assert_role('admin','pharmacist');
  select * into s from public.sales where id = p_sale for update;
  if not found then raise exception 'Sale not found'; end if;
  if me.role <> 'admin' and s.branch_id is distinct from me.branch_id then raise exception 'Wrong branch' using errcode = '42501'; end if;
  if s.status <> 'completed' then raise exception 'Only completed sales can have items returned (this one is %)', s.status; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if p_method not in ('cash','transfer','pos_terminal','store_credit','other') then raise exception 'Invalid refund method'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Choose at least one item to return'; end if;

  ratio := case when s.subtotal > 0 then s.total / s.subtotal else 1 end;   -- refund what was actually paid after any discount
  insert into public.sale_returns (id, sale_id, branch_id, reason, refund_method, refund_reference, created_by)
    values (rid, p_sale, s.branch_id, trim(p_reason), p_method, nullif(trim(p_reference), ''), me.id)
    returning return_no into rn;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into si from public.sale_items where id = (it->>'sale_item_id')::uuid and sale_id = p_sale for update;
    if not found then raise exception 'An item does not belong to this sale'; end if;
    q := (it->>'quantity')::int;
    if q is null or q < 1 then raise exception 'Invalid return quantity'; end if;
    select coalesce(sum(quantity), 0) into already from public.sale_return_items where sale_item_id = si.id;
    if q + already > si.quantity then
      raise exception 'Cannot return % (only % of % left to return)', q, si.quantity - already, si.quantity;
    end if;
    line := round(si.unit_price * q * ratio, 2);
    did_restock := false;
    if p_restock and si.batch_id is not null then
      select * into b from public.drug_batches where id = si.batch_id for update;
      if found and b.expiry_date >= current_date then          -- expired goods are never put back on the shelf
        update public.drug_batches set quantity_remaining = quantity_remaining + q where id = b.id;
        insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id, note)
          values (si.drug_id, b.id, s.branch_id, 'return', q, 'return', rid, 'Customer return ' || rn);
        did_restock := true;
      end if;
    end if;
    insert into public.sale_return_items (return_id, sale_item_id, drug_id, batch_id, quantity, unit_price, refund_amount, restocked)
      values (rid, si.id, si.drug_id, si.batch_id, q, si.unit_price, line, did_restock);
    total := total + line;
  end loop;

  update public.sale_returns set refund_amount = total where id = rid;
  return jsonb_build_object('id', rid, 'return_no', rn, 'refund_amount', total);
end $$;

-- profit now accounts for refunds (by the date the refund happened) and recovered cost of restocked goods
create or replace function public.profit_report(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rev numeric; v_cogs numeric; v_nocost int; v_top jsonb; v_ref numeric; v_rec numeric;
begin
  perform public.assert_role('admin');
  select coalesce(sum(si.line_total), 0), coalesce(sum(si.unit_cost * si.quantity), 0), count(*) filter (where si.unit_cost = 0)
    into v_rev, v_cogs, v_nocost
  from public.sale_items si join public.sales s on s.id = si.sale_id
  where s.status = 'completed' and s.sold_at between p_from and p_to;

  select coalesce(sum(sri.refund_amount), 0), coalesce(sum(si.unit_cost * sri.quantity) filter (where sri.restocked), 0)
    into v_ref, v_rec
  from public.sale_return_items sri
  join public.sale_returns sr on sr.id = sri.return_id
  join public.sale_items si on si.id = sri.sale_item_id
  where sr.created_at between p_from and p_to;

  select coalesce(jsonb_agg(x.t order by x.p desc), '[]'::jsonb) into v_top from (
    select sum(si.line_total - si.unit_cost * si.quantity) as p,
           jsonb_build_object('name', d.name, 'qty', sum(si.quantity), 'revenue', sum(si.line_total),
             'cost', sum(si.unit_cost * si.quantity), 'profit', sum(si.line_total - si.unit_cost * si.quantity)) as t
    from public.sale_items si join public.sales s on s.id = si.sale_id join public.drugs d on d.id = si.drug_id
    where s.status = 'completed' and s.sold_at between p_from and p_to
    group by d.id, d.name order by 1 desc limit 15
  ) x;

  return jsonb_build_object('revenue', v_rev, 'refunds', v_ref, 'cost_of_goods', v_cogs - v_rec,
    'gross_profit', v_rev - v_ref - (v_cogs - v_rec), 'lines_without_cost', v_nocost, 'top_products', v_top);
end $$;

-- ───────────── shifts (cash-up) ─────────────
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  cashier_id uuid not null references public.profiles(id),
  opened_at timestamptz not null default now(),
  opening_float numeric(12,2) not null default 0 check (opening_float >= 0),
  status text not null default 'open' check (status in ('open','closed')),
  closed_at timestamptz,
  closed_by uuid references public.profiles(id),
  expected_cash numeric(12,2), counted_cash numeric(12,2), difference numeric(12,2),
  summary jsonb,
  note text
);
create unique index shifts_one_open on public.shifts (cashier_id) where status = 'open';
create index shifts_branch_time on public.shifts (branch_id, opened_at desc);
alter table public.shifts enable row level security;
create policy shifts_read on public.shifts for select to authenticated
  using (cashier_id = (select auth.uid()) or ((select public.has_role('admin','pharmacist')) and (select public.can_see_branch(branch_id))));
create trigger audit_shifts after insert or update on public.shifts for each row execute function public.audit_row();

create function public.compute_shift(s public.shifts) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_to timestamptz := coalesce(s.closed_at, now()); v_cnt int; v_tot numeric; v_cash numeric; v_change numeric;
        v_refunds numeric; v_methods jsonb; v_pending numeric;
begin
  select count(*), coalesce(sum(total), 0), coalesce(sum(change_given), 0) into v_cnt, v_tot, v_change
  from public.sales where cashier_id = s.cashier_id and branch_id = s.branch_id and status = 'completed'
    and channel = 'pos' and sold_at between s.opened_at and v_to;

  select coalesce(jsonb_object_agg(method, amt), '{}'::jsonb) into v_methods from (
    select p.method, sum(p.amount) as amt from public.payments p join public.sales x on x.id = p.sale_id
    where x.cashier_id = s.cashier_id and x.branch_id = s.branch_id and x.status = 'completed' and x.channel = 'pos'
      and x.sold_at between s.opened_at and v_to and p.status <> 'rejected' group by p.method) m;
  v_cash := coalesce((v_methods->>'cash')::numeric, 0);

  select coalesce(sum(p.amount), 0) into v_pending from public.payments p join public.sales x on x.id = p.sale_id
  where x.cashier_id = s.cashier_id and x.branch_id = s.branch_id and x.status = 'completed' and x.channel = 'pos'
    and x.sold_at between s.opened_at and v_to and p.status = 'pending_verification' and p.method <> 'cash';

  select coalesce(sum(refund_amount), 0) into v_refunds from public.sale_returns
  where created_by = s.cashier_id and branch_id = s.branch_id and refund_method = 'cash' and created_at between s.opened_at and v_to;

  return jsonb_build_object('sales_count', v_cnt, 'sales_total', v_tot, 'by_method', v_methods,
    'cash_received', v_cash, 'change_given', v_change, 'cash_refunds', v_refunds, 'pending_verification', v_pending,
    'opening_float', s.opening_float,
    'expected_cash', s.opening_float + v_cash - v_change - v_refunds);
end $$;

create function public.open_shift(p_float numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; v uuid;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  if me.branch_id is null then raise exception 'Your account has no branch assigned'; end if;
  if p_float is null or p_float < 0 then raise exception 'Enter the opening cash float (0 if none)'; end if;
  insert into public.shifts (branch_id, cashier_id, opening_float) values (me.branch_id, me.id, p_float) returning id into v;
  return v;
exception when unique_violation then
  raise exception 'You already have an open shift. Close it first.';
end $$;

create function public.shift_summary(p_shift uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; s public.shifts;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  select * into s from public.shifts where id = p_shift;
  if not found then raise exception 'Shift not found'; end if;
  if s.cashier_id <> me.id and not (me.role = 'admin' or (me.role = 'pharmacist' and me.branch_id = s.branch_id)) then
    raise exception 'Not your shift' using errcode = '42501';
  end if;
  if s.status = 'closed' and s.summary is not null then return s.summary; end if;
  return public.compute_shift(s);
end $$;

create function public.close_shift(p_shift uuid, p_counted numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; s public.shifts; r jsonb; v_exp numeric; v_diff numeric;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  select * into s from public.shifts where id = p_shift for update;
  if not found then raise exception 'Shift not found'; end if;
  if s.cashier_id <> me.id and not (me.role = 'admin' or (me.role = 'pharmacist' and me.branch_id = s.branch_id)) then
    raise exception 'Not your shift' using errcode = '42501';
  end if;
  if s.status <> 'open' then raise exception 'This shift is already closed'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash you counted'; end if;
  r := public.compute_shift(s);
  v_exp := (r->>'expected_cash')::numeric;
  v_diff := p_counted - v_exp;
  if v_diff <> 0 and coalesce(trim(p_note), '') = '' then
    raise exception 'The count is off by % . Please explain the difference in the note.', v_diff;
  end if;
  r := r || jsonb_build_object('counted_cash', p_counted, 'difference', v_diff);
  update public.shifts set status = 'closed', closed_at = now(), closed_by = me.id, expected_cash = v_exp,
    counted_cash = p_counted, difference = v_diff, summary = r, note = nullif(trim(p_note), '') where id = p_shift;
  return r;
end $$;

-- ───────────── grants ─────────────
grant select on public.sale_returns, public.sale_return_items, public.shifts to authenticated;
revoke insert, update, delete on public.sale_returns, public.sale_return_items, public.shifts from authenticated;
revoke all on public.sale_returns, public.sale_return_items, public.shifts from anon;
grant usage on sequence public.return_seq to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.handle_new_user(), public.audit_row(), public.set_updated_at(), public.prevent_mutation(),
  public.stamp_updated_by(), public.log_order_event(uuid,text,text,text), public.get_order_for_update(uuid, public.profiles),
  public.issue_order_stock(uuid, uuid), public.sync_profile_email(), public.compute_shift(public.shifts) from authenticated;
grant execute on function public.record_paystack_payment(uuid,uuid,uuid,text,numeric) to service_role;
revoke execute on function public.record_paystack_payment(uuid,uuid,uuid,text,numeric) from authenticated;
