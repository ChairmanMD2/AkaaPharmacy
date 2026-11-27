-- AkaaPharmacy: complete database schema (all migrations in order).
-- This file is a convenience copy for reference and for rebuilding a fresh project.
-- The authoritative history is in supabase/migrations/. Apply them in filename order.
--
-- Also deployed separately (Supabase Edge Functions, see supabase/functions/):
--   admin-users        admin-only: create staff accounts, issue temporary passwords
--   paystack-init      start a Paystack payment (needs the PAYSTACK_SECRET_KEY secret)
--   paystack-verify    confirm a Paystack payment directly with Paystack
--   paystack-webhook   backup confirmation path (re-verifies with Paystack)
--
-- Roles: admin manages every branch; pharmacist, cashier and inventory_officer only see their own branch
-- (row-level security); rider/courier see only their delivery jobs.


-- ====================================================================
-- 20261126000001_core_inventory_pos.sql
-- ====================================================================

-- AkaaPharmacy migration 1: core, inventory, POS
-- Principles: RLS everywhere; stock/sales/payments are written ONLY through
-- SECURITY DEFINER functions so the ledger can never be bypassed; cost columns
-- are hidden from direct SELECT (read through role-checked RPCs).

create extension if not exists pg_trgm with schema extensions;

create type public.app_role as enum
  ('admin','pharmacist','cashier','inventory_officer','courier','rider','customer');

-- ───────────── lockdown defaults ─────────────
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from public, anon;

-- ───────────── generic helpers ─────────────
create function public.set_updated_at() returns trigger language plpgsql
set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create function public.prevent_mutation() returns trigger language plpgsql
set search_path = '' as $$
begin raise exception '% is append-only', tg_table_name; end $$;

-- ───────────── branches & profiles ─────────────
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  address text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role public.app_role not null default 'cashier',
  branch_id uuid references public.branches(id),
  is_active boolean not null default false,   -- an admin must activate every new user
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create function public.handle_new_user() returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- role helpers (SECURITY DEFINER avoids RLS recursion on profiles)
create function public.auth_role() returns public.app_role
language sql stable security definer set search_path = '' as
$$ select role from public.profiles where id = auth.uid() and is_active $$;

create function public.auth_branch() returns uuid
language sql stable security definer set search_path = '' as
$$ select branch_id from public.profiles where id = auth.uid() and is_active $$;

create function public.has_role(variadic p_roles public.app_role[]) returns boolean
language sql stable security definer set search_path = '' as
$$ select coalesce(public.auth_role() = any(p_roles), false) $$;

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as
$$ select public.has_role('admin','pharmacist','cashier','inventory_officer') $$;

create function public.can_see_branch(p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as
$$ select public.has_role('admin')
      or (public.is_staff() and p_branch is not distinct from public.auth_branch()) $$;

create function public.assert_role(variadic p_roles public.app_role[])
returns public.profiles language plpgsql stable security definer
set search_path = '' as $$
declare v public.profiles;
begin
  select * into v from public.profiles where id = auth.uid() and is_active;
  if v.id is null or not (v.role = any(p_roles)) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return v;
end $$;

-- ───────────── catalogue ─────────────
create table public.drugs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  generic_name text,
  category text,
  nafdac_number text,
  barcode text,
  unit_type text not null default 'Pack',
  cost_price numeric(12,2) not null default 0 check (cost_price >= 0),     -- hidden column
  selling_price numeric(12,2) not null default 0 check (selling_price >= 0),
  wholesale_price numeric(12,2) check (wholesale_price >= 0),
  requires_prescription boolean not null default false,
  reorder_level integer not null default 10 check (reorder_level >= 0),
  is_active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index drugs_barcode_uq on public.drugs (barcode) where barcode is not null and barcode <> '';
create unique index drugs_name_uq on public.drugs (lower(name));
create index drugs_name_trgm on public.drugs using gin (name extensions.gin_trgm_ops);
create index drugs_generic_trgm on public.drugs using gin (generic_name extensions.gin_trgm_ops);
create trigger drugs_updated before update on public.drugs
  for each row execute function public.set_updated_at();

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_person text, phone text, email text, address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.drug_batches (
  id uuid primary key default gen_random_uuid(),
  drug_id uuid not null references public.drugs(id),
  branch_id uuid not null references public.branches(id),
  batch_number text not null,
  expiry_date date not null,
  quantity_remaining integer not null default 0 check (quantity_remaining >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  cost_price numeric(12,2) check (cost_price >= 0),                        -- hidden column
  supplier_id uuid references public.suppliers(id),
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (drug_id, branch_id, batch_number),
  check (quantity_reserved <= quantity_remaining)
);
create index batches_fefo on public.drug_batches (drug_id, branch_id, expiry_date);
create trigger batches_updated before update on public.drug_batches
  for each row execute function public.set_updated_at();

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,
  email text,
  address text,
  notes text,
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index customers_phone on public.customers (phone);

-- ───────────── sales ─────────────
create sequence public.receipt_seq;

create table public.sales (
  id uuid primary key,                          -- generated on the device => idempotent sync
  receipt_no text not null unique
    default ('R' || to_char(now(), 'YYMM') || lpad(nextval('public.receipt_seq')::text, 6, '0')),
  local_ref text,                               -- number printed on an offline receipt
  branch_id uuid not null references public.branches(id),
  cashier_id uuid not null references public.profiles(id),
  customer_id uuid references public.customers(id),
  channel text not null default 'pos' check (channel in ('pos','online')),
  order_id uuid,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  total numeric(12,2) not null check (total >= 0),
  amount_paid numeric(12,2) not null default 0,
  change_given numeric(12,2) not null default 0,
  status text not null default 'completed' check (status in ('completed','voided')),
  needs_review boolean not null default false,
  review_note text,
  notes text,
  sold_at timestamptz not null default now(),   -- device time
  synced_at timestamptz not null default now(),
  voided_by uuid references public.profiles(id),
  voided_at timestamptz,
  void_reason text
);
create index sales_branch_time on public.sales (branch_id, sold_at desc);
create index sales_review on public.sales (needs_review) where needs_review;

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  drug_id uuid not null references public.drugs(id),
  batch_id uuid references public.drug_batches(id),   -- null => stock shortfall flagged for review
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  unit_cost numeric(12,2) not null default 0,         -- hidden column
  line_total numeric(12,2) not null
);
create index sale_items_sale on public.sale_items (sale_id);
create index sale_items_drug on public.sale_items (drug_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.sales(id) on delete cascade,
  order_id uuid,
  branch_id uuid not null references public.branches(id),
  method text not null check (method in ('cash','card','transfer','pos_terminal','paystack','other')),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending_verification'
    check (status in ('verified','pending_verification','rejected')),
  reference text,                  -- transfer ID / POS approval code / Paystack ref
  note text,
  created_by uuid default auth.uid(),
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (sale_id is not null or order_id is not null)
);
create unique index payments_ref_uq on public.payments (method, lower(reference))
  where reference is not null and method in ('transfer','pos_terminal','paystack') and status <> 'rejected';
create index payments_pending on public.payments (status) where status = 'pending_verification';
create index payments_sale on public.payments (sale_id);

-- append-only stock ledger
create table public.stock_movements (
  id bigint generated always as identity primary key,
  drug_id uuid not null references public.drugs(id),
  batch_id uuid references public.drug_batches(id),
  branch_id uuid not null references public.branches(id),
  movement_type text not null check (movement_type in
    ('opening','receipt','import','sale','sale_void','reserve','release','issue',
     'adjustment','expired_writeoff','return')),
  quantity integer not null,            -- signed change
  ref_type text, ref_id uuid, note text,
  actor uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index movements_drug on public.stock_movements (drug_id, created_at desc);
create trigger movements_immutable before update or delete on public.stock_movements
  for each row execute function public.prevent_mutation();

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid default auth.uid(),
  action text not null,
  table_name text not null,
  record_id text,
  old_data jsonb, new_data jsonb,
  created_at timestamptz not null default now()
);
create trigger audit_immutable before update or delete on public.audit_log
  for each row execute function public.prevent_mutation();

create function public.audit_row() returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), tg_op, tg_table_name,
          coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id'),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
create trigger audit_drugs after insert or update or delete on public.drugs for each row execute function public.audit_row();
create trigger audit_profiles after insert or update or delete on public.profiles for each row execute function public.audit_row();
create trigger audit_branches after insert or update or delete on public.branches for each row execute function public.audit_row();
create trigger audit_suppliers after insert or update or delete on public.suppliers for each row execute function public.audit_row();
create trigger audit_sales after update on public.sales for each row execute function public.audit_row();
create trigger audit_payments after update on public.payments for each row execute function public.audit_row();

-- ───────────── RLS ─────────────
alter table public.branches        enable row level security;
alter table public.profiles        enable row level security;
alter table public.drugs           enable row level security;
alter table public.suppliers       enable row level security;
alter table public.drug_batches    enable row level security;
alter table public.customers       enable row level security;
alter table public.sales           enable row level security;
alter table public.sale_items      enable row level security;
alter table public.payments        enable row level security;
alter table public.stock_movements enable row level security;
alter table public.audit_log       enable row level security;

create policy branches_read  on public.branches for select to authenticated using ((select public.is_staff()));
create policy branches_admin on public.branches for all to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));
create policy profiles_admin on public.profiles for all to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

create policy drugs_read on public.drugs for select to authenticated using ((select public.is_staff()));
create policy drugs_write on public.drugs for insert to authenticated
  with check ((select public.has_role('admin','pharmacist','inventory_officer')));
create policy drugs_update on public.drugs for update to authenticated
  using ((select public.has_role('admin','pharmacist','inventory_officer')))
  with check ((select public.has_role('admin','pharmacist','inventory_officer')));
create policy drugs_delete on public.drugs for delete to authenticated using ((select public.has_role('admin')));

create policy suppliers_read on public.suppliers for select to authenticated using ((select public.is_staff()));
create policy suppliers_write on public.suppliers for all to authenticated
  using ((select public.has_role('admin','pharmacist','inventory_officer')))
  with check ((select public.has_role('admin','pharmacist','inventory_officer')));

-- batches, sales, items, payments, movements: read-only to clients; writes via RPC only
create policy batches_read on public.drug_batches for select to authenticated using ((select public.can_see_branch(branch_id)));
create policy sales_read on public.sales for select to authenticated using ((select public.can_see_branch(branch_id)));
create policy sale_items_read on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id and (select public.can_see_branch(s.branch_id))));
create policy payments_read on public.payments for select to authenticated using ((select public.can_see_branch(branch_id)));
create policy movements_read on public.stock_movements for select to authenticated
  using ((select public.has_role('admin','pharmacist','inventory_officer')) and (select public.can_see_branch(branch_id)));
create policy audit_read on public.audit_log for select to authenticated using ((select public.has_role('admin')));

create policy customers_read on public.customers for select to authenticated using ((select public.is_staff()));
create policy customers_write on public.customers for insert to authenticated with check ((select public.is_staff()));
create policy customers_update on public.customers for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy customers_delete on public.customers for delete to authenticated using ((select public.has_role('admin')));

-- ───────────── table privileges ─────────────
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- clients never write the ledger-backed tables directly
revoke insert, update, delete on public.drug_batches, public.sales, public.sale_items,
  public.payments, public.stock_movements, public.audit_log from authenticated;
-- hide cost columns from direct reads (use get_drug_costs / report RPCs)
revoke select on public.drugs from authenticated;
grant select (id,name,generic_name,category,nafdac_number,barcode,unit_type,selling_price,
  wholesale_price,requires_prescription,reorder_level,is_active,created_by,created_at,updated_at)
  on public.drugs to authenticated;
revoke select on public.drug_batches from authenticated;
grant select (id,drug_id,branch_id,batch_number,expiry_date,quantity_remaining,quantity_reserved,
  supplier_id,received_at,updated_at) on public.drug_batches to authenticated;
revoke select on public.sale_items from authenticated;
grant select (id,sale_id,drug_id,batch_id,quantity,unit_price,line_total) on public.sale_items to authenticated;
grant usage on sequence public.receipt_seq to authenticated;

-- ═════════════ RPCs ═════════════

-- Atomic, idempotent sale. Safe to retry. Never rejects a real-world (already
-- handed-over) sale: problems are flagged with needs_review instead.
create function public.process_offline_sale(p_sale jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles; v_id uuid; v_ex public.sales%rowtype; v_branch uuid;
  v_item jsonb; v_pay jsonb; v_drug public.drugs%rowtype;
  v_qty int; v_price numeric(12,2); v_need int; v_take int; b record;
  v_sub numeric(12,2) := 0; v_disc numeric(12,2); v_total numeric(12,2);
  v_paid numeric(12,2) := 0; v_review boolean := false; v_note text := '';
  v_method text; v_ref text; v_amt numeric(12,2); v_status text; v_receipt text;
begin
  v_me := public.assert_role('admin','pharmacist','cashier');
  v_id := (p_sale->>'id')::uuid;
  if v_id is null then raise exception 'Sale id is required'; end if;

  select * into v_ex from public.sales where id = v_id;
  if found then
    return jsonb_build_object('id', v_id, 'receipt_no', v_ex.receipt_no,
      'needs_review', v_ex.needs_review, 'duplicate', true);
  end if;

  v_branch := coalesce(nullif(p_sale->>'branch_id','')::uuid, v_me.branch_id);
  if v_branch is null then raise exception 'Branch is required'; end if;
  if v_me.role <> 'admin' and v_branch is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_sale->'items') is distinct from 'array' or jsonb_array_length(p_sale->'items') = 0 then
    raise exception 'Sale has no items';
  end if;

  for v_item in select * from jsonb_array_elements(p_sale->'items') loop
    select * into v_drug from public.drugs where id = (v_item->>'drug_id')::uuid;
    if not found then raise exception 'Unknown drug %', v_item->>'drug_id'; end if;
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 then raise exception 'Invalid quantity for %', v_drug.name; end if;
    v_price := coalesce(nullif(v_item->>'unit_price','')::numeric, v_drug.selling_price);
    if v_price < 0 then raise exception 'Invalid price for %', v_drug.name; end if;
    v_sub := v_sub + v_qty * v_price;
    if v_price < v_drug.selling_price then
      v_review := true; v_note := v_note || format('Below list price: %s. ', v_drug.name);
    end if;
    if v_drug.requires_prescription and v_me.role = 'cashier' then
      v_review := true; v_note := v_note || format('Prescription item sold by cashier: %s. ', v_drug.name);
    end if;
  end loop;

  v_disc := least(greatest(coalesce((p_sale->>'discount')::numeric, 0), 0), v_sub);
  if v_me.role = 'cashier' and v_disc > v_sub * 0.10 then
    v_review := true; v_note := v_note || 'Discount above 10%. ';
  end if;
  v_total := v_sub - v_disc;

  for v_pay in select * from jsonb_array_elements(coalesce(p_sale->'payments','[]'::jsonb)) loop
    v_paid := v_paid + coalesce((v_pay->>'amount')::numeric, 0);
  end loop;
  if v_paid < v_total then
    v_review := true; v_note := v_note || format('Underpaid by %s. ', v_total - v_paid);
  end if;

  insert into public.sales (id, local_ref, branch_id, cashier_id, customer_id, subtotal, discount,
      total, amount_paid, change_given, notes, sold_at)
  values (v_id, p_sale->>'local_ref', v_branch, v_me.id, nullif(p_sale->>'customer_id','')::uuid,
      v_sub, v_disc, v_total, v_paid, greatest(v_paid - v_total, 0), p_sale->>'notes',
      coalesce(nullif(p_sale->>'sold_at','')::timestamptz, now()))
  returning receipt_no into v_receipt;

  -- FEFO allocation
  for v_item in select * from jsonb_array_elements(p_sale->'items') loop
    select * into v_drug from public.drugs where id = (v_item->>'drug_id')::uuid;
    v_qty := (v_item->>'quantity')::int;
    v_price := coalesce(nullif(v_item->>'unit_price','')::numeric, v_drug.selling_price);
    v_need := v_qty;
    for b in
      select id, quantity_remaining, quantity_reserved, cost_price from public.drug_batches
      where drug_id = v_drug.id and branch_id = v_branch and expiry_date >= current_date
        and quantity_remaining - quantity_reserved > 0
      order by expiry_date, received_at for update
    loop
      exit when v_need = 0;
      v_take := least(v_need, b.quantity_remaining - b.quantity_reserved);
      update public.drug_batches set quantity_remaining = quantity_remaining - v_take where id = b.id;
      insert into public.sale_items (sale_id, drug_id, batch_id, quantity, unit_price, unit_cost, line_total)
        values (v_id, v_drug.id, b.id, v_take, v_price, coalesce(b.cost_price, v_drug.cost_price), v_take * v_price);
      insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id)
        values (v_drug.id, b.id, v_branch, 'sale', -v_take, 'sale', v_id);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      insert into public.sale_items (sale_id, drug_id, batch_id, quantity, unit_price, unit_cost, line_total)
        values (v_id, v_drug.id, null, v_need, v_price, v_drug.cost_price, v_need * v_price);
      v_review := true;
      v_note := v_note || format('Stock shortfall: %s x%s. ', v_drug.name, v_need);
    end if;
  end loop;

  for v_pay in select * from jsonb_array_elements(coalesce(p_sale->'payments','[]'::jsonb)) loop
    v_method := coalesce(v_pay->>'method','cash');
    v_amt := (v_pay->>'amount')::numeric;
    v_ref := nullif(trim(v_pay->>'reference'), '');
    continue when v_amt is null or v_amt <= 0;
    if v_method not in ('cash','card','transfer','pos_terminal','paystack','other') then
      raise exception 'Invalid payment method %', v_method;
    end if;
    v_status := case when v_method = 'cash' then 'verified' else 'pending_verification' end;
    if v_method in ('transfer','pos_terminal') and v_ref is null then
      v_review := true; v_note := v_note || format('%s payment without reference. ', v_method);
    end if;
    begin
      insert into public.payments (sale_id, branch_id, method, amount, status, reference, created_by,
          verified_by, verified_at)
        values (v_id, v_branch, v_method, v_amt, v_status, v_ref, v_me.id,
          case when v_status = 'verified' then v_me.id end,
          case when v_status = 'verified' then now() end);
    exception when unique_violation then
      insert into public.payments (sale_id, branch_id, method, amount, status, reference, note, created_by)
        values (v_id, v_branch, v_method, v_amt, 'pending_verification', null,
          'DUPLICATE REFERENCE ' || v_ref, v_me.id);
      v_review := true; v_note := v_note || format('Duplicate payment reference %s. ', v_ref);
    end;
  end loop;

  update public.sales set needs_review = v_review, review_note = nullif(trim(v_note), '') where id = v_id;
  return jsonb_build_object('id', v_id, 'receipt_no', v_receipt, 'needs_review', v_review,
    'duplicate', false, 'total', v_total);
end $$;

create function public.verify_payment(p_payment uuid, p_accept boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_p public.payments;
begin
  v_me := public.assert_role('admin','pharmacist','cashier');
  select * into v_p from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_me.role <> 'admin' and v_p.branch_id is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if v_p.status <> 'pending_verification' then raise exception 'Payment already %', v_p.status; end if;
  update public.payments set status = case when p_accept then 'verified' else 'rejected' end,
    verified_by = v_me.id, verified_at = now(), note = coalesce(p_note, note) where id = p_payment;
  if not p_accept and v_p.sale_id is not null then
    update public.sales set needs_review = true,
      review_note = trim(coalesce(review_note,'') || ' Payment rejected: ' || coalesce(v_p.reference,'(no ref)') || '.')
      where id = v_p.sale_id;
  end if;
end $$;

create function public.void_sale(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_s public.sales; i record;
begin
  v_me := public.assert_role('admin','pharmacist');
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  select * into v_s from public.sales where id = p_sale for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_me.role <> 'admin' and v_s.branch_id is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if v_s.status = 'voided' then raise exception 'Sale already voided'; end if;
  for i in select * from public.sale_items where sale_id = p_sale and batch_id is not null loop
    update public.drug_batches set quantity_remaining = quantity_remaining + i.quantity where id = i.batch_id;
    insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id, note)
      values (i.drug_id, i.batch_id, v_s.branch_id, 'sale_void', i.quantity, 'sale', p_sale, p_reason);
  end loop;
  update public.sales set status = 'voided', voided_by = v_me.id, voided_at = now(), void_reason = p_reason
    where id = p_sale;
end $$;

create function public.receive_stock(p_branch uuid, p_drug uuid, p_batch text, p_expiry date,
  p_qty int, p_cost numeric default null, p_supplier uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_b uuid;
begin
  v_me := public.assert_role('admin','pharmacist','inventory_officer');
  if v_me.role <> 'admin' and p_branch is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be positive'; end if;
  if coalesce(trim(p_batch),'') = '' then raise exception 'Batch number is required'; end if;
  if p_expiry is null then raise exception 'Expiry date is required'; end if;
  insert into public.drug_batches (drug_id, branch_id, batch_number, expiry_date, quantity_remaining, cost_price, supplier_id)
    values (p_drug, p_branch, trim(p_batch), p_expiry, p_qty, p_cost, p_supplier)
  on conflict (drug_id, branch_id, batch_number) do update
    set quantity_remaining = public.drug_batches.quantity_remaining + excluded.quantity_remaining,
        expiry_date = excluded.expiry_date,
        cost_price = coalesce(excluded.cost_price, public.drug_batches.cost_price),
        supplier_id = coalesce(excluded.supplier_id, public.drug_batches.supplier_id)
  returning id into v_b;
  if p_cost is not null then update public.drugs set cost_price = p_cost where id = p_drug; end if;
  insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, note)
    values (p_drug, v_b, p_branch, 'receipt', p_qty, 'receipt', p_note);
  return v_b;
end $$;

create function public.adjust_stock(p_batch uuid, p_delta int, p_type text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; b public.drug_batches;
begin
  v_me := public.assert_role('admin','pharmacist','inventory_officer');
  if p_type not in ('adjustment','expired_writeoff','return') then raise exception 'Invalid type'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  select * into b from public.drug_batches where id = p_batch for update;
  if not found then raise exception 'Batch not found'; end if;
  if v_me.role <> 'admin' and b.branch_id is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if b.quantity_remaining + p_delta < b.quantity_reserved then
    raise exception 'Result would fall below reserved stock';
  end if;
  update public.drug_batches set quantity_remaining = quantity_remaining + p_delta where id = p_batch;
  insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, note)
    values (b.drug_id, p_batch, b.branch_id, p_type, p_delta, 'adjustment', p_reason);
end $$;

-- Bulk import. Row quantity is the PHYSICAL COUNT for that batch (idempotent re-imports).
create function public.import_inventory(p_branch uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles; r jsonb; i int := 0; v_errs jsonb := '[]'::jsonb;
  v_new int := 0; v_upd int := 0; v_bat int := 0;
  v_name text; v_bc text; v_id uuid; v_bn text; v_exp date; v_qty int; v_old int; v_b public.drug_batches;
  v_cost numeric; v_price numeric; f_new int; f_upd int; f_bat int;
begin
  v_me := public.assert_role('admin','pharmacist','inventory_officer');
  if v_me.role <> 'admin' and p_branch is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_id := null; f_new := 0; f_upd := 0; f_bat := 0;
      v_name := nullif(trim(r->>'name'), '');
      if v_name is null then raise exception 'name is required'; end if;
      v_bc := nullif(trim(r->>'barcode'), '');
      v_cost := nullif(trim(r->>'cost_price'), '')::numeric;
      v_price := nullif(trim(r->>'selling_price'), '')::numeric;
      select id into v_id from public.drugs
        where (v_bc is not null and barcode = v_bc) or lower(name) = lower(v_name)
        order by (barcode = v_bc) desc nulls last limit 1;
      if v_id is null then
        if v_price is null then raise exception 'selling_price is required for a new product'; end if;
        insert into public.drugs (name, generic_name, category, nafdac_number, barcode, unit_type,
            cost_price, selling_price, requires_prescription)
          values (v_name, nullif(trim(r->>'generic_name'),''), nullif(trim(r->>'category'),''),
            nullif(trim(r->>'nafdac_number'),''), v_bc, coalesce(nullif(trim(r->>'unit_type'),''),'Pack'),
            coalesce(v_cost,0), v_price, coalesce((r->>'requires_prescription')::boolean, false))
          returning id into v_id;
        f_new := 1;
      else
        update public.drugs set
          generic_name = coalesce(nullif(trim(r->>'generic_name'),''), generic_name),
          category = coalesce(nullif(trim(r->>'category'),''), category),
          nafdac_number = coalesce(nullif(trim(r->>'nafdac_number'),''), nafdac_number),
          barcode = coalesce(v_bc, barcode),
          unit_type = coalesce(nullif(trim(r->>'unit_type'),''), unit_type),
          cost_price = coalesce(v_cost, cost_price),
          selling_price = coalesce(v_price, selling_price)
        where id = v_id;
        f_upd := 1;
      end if;
      v_bn := nullif(trim(r->>'batch_number'), '');
      if v_bn is not null then
        v_exp := (r->>'expiry_date')::date;
        v_qty := (r->>'quantity')::int;
        if v_exp is null then raise exception 'expiry_date is required with a batch'; end if;
        if v_qty is null or v_qty < 0 then raise exception 'quantity must be 0 or more'; end if;
        select * into v_b from public.drug_batches
          where drug_id = v_id and branch_id = p_branch and batch_number = v_bn for update;
        if found then
          if v_qty < v_b.quantity_reserved then raise exception 'quantity is below reserved stock (%)', v_b.quantity_reserved; end if;
          v_old := v_b.quantity_remaining;
          update public.drug_batches set quantity_remaining = v_qty, expiry_date = v_exp,
            cost_price = coalesce(v_cost, cost_price) where id = v_b.id;
        else
          v_old := 0;
          insert into public.drug_batches (drug_id, branch_id, batch_number, expiry_date, quantity_remaining, cost_price)
            values (v_id, p_branch, v_bn, v_exp, v_qty, v_cost) returning * into v_b;
        end if;
        if v_qty <> v_old then
          insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, note)
            values (v_id, v_b.id, p_branch, 'import', v_qty - v_old, 'import', 'Bulk import');
        end if;
        f_bat := 1;
      end if;
      v_new := v_new + f_new; v_upd := v_upd + f_upd; v_bat := v_bat + f_bat;
    exception when others then
      v_errs := v_errs || jsonb_build_object('row', coalesce((r->>'_row')::int, i), 'message', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('created', v_new, 'updated', v_upd, 'batches', v_bat, 'errors', v_errs);
end $$;

create function public.get_drug_costs() returns table (drug_id uuid, cost_price numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_role('admin','pharmacist','inventory_officer');
  return query select d.id, d.cost_price from public.drugs d;
end $$;

-- ───────────── function grants ─────────────
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.handle_new_user(), public.audit_row(),
  public.set_updated_at(), public.prevent_mutation() from authenticated;

insert into public.branches (code, name) values ('MAIN', 'Main Branch');


-- ====================================================================
-- 20261126000002_orders_delivery_wishlist_expenses.sql
-- ====================================================================

-- AkaaPharmacy migration 2: online/phone orders, prescriptions, delivery jobs
-- (courier/rider boundary), Wish List, Expenses, settings.
-- Ledger note: 'reserve'/'release' movements change quantity_reserved only;
-- every other movement changes quantity_remaining.

create sequence public.order_seq;

-- ───────────── settings ─────────────
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values
  ('business_name', '"AkaaPharmacy"'),
  ('currency_symbol', '"₦"'),
  ('default_delivery_fee', '500'),
  ('receipt_footer', '"Thank you for your patronage."'),
  ('expiry_warning_days', '90');

-- ───────────── orders ─────────────
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique
    default ('O' || to_char(now(), 'YYMM') || lpad(nextval('public.order_seq')::text, 6, '0')),
  branch_id uuid not null references public.branches(id),
  customer_id uuid references public.customers(id),
  channel text not null default 'phone' check (channel in ('online','phone','walk_in')),
  fulfilment text not null default 'delivery' check (fulfilment in ('delivery','pickup')),
  payment_mode text not null default 'prepaid' check (payment_mode in ('prepaid','cod')),
  customer_name text not null,
  customer_phone text,
  delivery_address text,
  delivery_notes text,
  requires_prescription boolean not null default false,
  subtotal numeric(12,2) not null default 0,
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  total numeric(12,2) not null default 0,
  status text not null default 'placed' check (status in
    ('placed','payment_confirmed','pharmacist_approved','allocated','packed',
     'dispatched','delivered','failed_delivery','cancelled','returned')),
  refund_due boolean not null default false,
  cancel_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_branch_status on public.orders (branch_id, status, created_at desc);
create trigger orders_updated before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  drug_id uuid not null references public.drugs(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null
);
create index order_items_order on public.order_items (order_id);

create table public.order_allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  batch_id uuid not null references public.drug_batches(id),
  quantity integer not null check (quantity > 0),
  state text not null default 'reserved' check (state in ('reserved','issued','released','returned'))
);
create index order_alloc_order on public.order_allocations (order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status text, to_status text not null, note text,
  actor uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index order_events_order on public.order_events (order_id, created_at);
create trigger order_events_immutable before update or delete on public.order_events
  for each row execute function public.prevent_mutation();

create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  file_path text,                     -- object path in the private 'prescriptions' bucket
  prescriber text, note text,
  status text not null default 'submitted' check (status in ('submitted','verified','rejected')),
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- one row per courier/rider hand-off. Snapshot columns mean a courier never
-- needs access to orders, customers or stock.
create table public.delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  branch_id uuid not null references public.branches(id),
  assigned_to uuid references public.profiles(id),
  provider text not null default 'own_rider' check (provider in ('own_rider','third_party')),
  courier_name text,
  status text not null default 'assigned' check (status in
    ('assigned','picked_up','in_transit','delivered','failed','returned','cancelled')),
  recipient_name text not null, recipient_phone text, address text, notes text,
  items_summary text,
  cod_amount numeric(12,2) not null default 0,
  collected_amount numeric(12,2),
  delivery_code text not null,        -- hidden column; verified server-side
  proof_name text, proof_photo_path text, failure_reason text,
  assigned_at timestamptz not null default now(),
  picked_up_at timestamptz, delivered_at timestamptz,
  created_by uuid default auth.uid()
);
create unique index delivery_one_active on public.delivery_jobs (order_id)
  where status in ('assigned','picked_up','in_transit');
create index delivery_assignee on public.delivery_jobs (assigned_to, status);

-- ───────────── wish list ─────────────
create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  product_name text not null check (length(trim(product_name)) > 0),
  drug_id uuid references public.drugs(id),
  quantity integer not null default 1 check (quantity > 0),
  customer_name text, customer_phone text,
  reason text not null default 'out_of_stock' check (reason in ('out_of_stock','not_stocked','other')),
  status text not null default 'open' check (status in ('open','sourcing','fulfilled','declined')),
  notes text,
  requested_on date not null default current_date,
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_by uuid, deleted_at timestamptz
);
create index wishlist_name on public.wishlist_items (lower(trim(product_name)));
create index wishlist_date on public.wishlist_items (requested_on desc);
create trigger wishlist_updated before update on public.wishlist_items
  for each row execute function public.set_updated_at();
create function public.stamp_updated_by() returns trigger language plpgsql
security definer set search_path = '' as $$
begin new.updated_by := auth.uid(); return new; end $$;
create trigger wishlist_stamp before update on public.wishlist_items
  for each row execute function public.stamp_updated_by();

-- ───────────── expenses ─────────────
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  expense_date date not null default current_date,
  description text not null check (length(trim(description)) > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  quantity numeric(12,2) not null check (quantity > 0),
  total_cost numeric(14,2) generated always as (round(unit_cost * quantity, 2)) stored,
  category text, notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_by uuid, deleted_at timestamptz
);
create index expenses_date on public.expenses (branch_id, expense_date desc);
create trigger expenses_updated before update on public.expenses
  for each row execute function public.set_updated_at();

create trigger audit_wishlist after insert or update on public.wishlist_items for each row execute function public.audit_row();
create trigger audit_expenses after insert or update on public.expenses for each row execute function public.audit_row();
create trigger audit_orders after update on public.orders for each row execute function public.audit_row();
create trigger audit_settings after insert or update on public.app_settings for each row execute function public.audit_row();

-- ───────────── RLS ─────────────
alter table public.app_settings      enable row level security;
alter table public.orders            enable row level security;
alter table public.order_items       enable row level security;
alter table public.order_allocations enable row level security;
alter table public.order_events      enable row level security;
alter table public.prescriptions     enable row level security;
alter table public.delivery_jobs     enable row level security;
alter table public.wishlist_items    enable row level security;
alter table public.expenses          enable row level security;

create policy settings_read on public.app_settings for select to authenticated using ((select public.is_staff()));
create policy settings_write on public.app_settings for all to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

create policy orders_read on public.orders for select to authenticated using ((select public.can_see_branch(branch_id)));
create policy order_items_read on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (select public.can_see_branch(o.branch_id))));
create policy order_alloc_read on public.order_allocations for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (select public.can_see_branch(o.branch_id))));
create policy order_events_read on public.order_events for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (select public.can_see_branch(o.branch_id))));
create policy rx_read on public.prescriptions for select to authenticated using ((select public.can_see_branch(branch_id)));

create policy delivery_read on public.delivery_jobs for select to authenticated
  using ((select public.can_see_branch(branch_id)) or assigned_to = (select auth.uid()));

-- wish list: any staff can add; pharmacist/admin/inventory edit anything; creators edit their own while open
create policy wishlist_read on public.wishlist_items for select to authenticated
  using (not is_deleted and (select public.can_see_branch(branch_id)));
create policy wishlist_insert on public.wishlist_items for insert to authenticated
  with check ((select public.is_staff()) and (select public.can_see_branch(branch_id)));
create policy wishlist_update on public.wishlist_items for update to authenticated
  using (not is_deleted and (select public.can_see_branch(branch_id)) and
    ((select public.has_role('admin','pharmacist','inventory_officer'))
     or (created_by = (select auth.uid()) and status = 'open')))
  with check ((select public.can_see_branch(branch_id)) and
    ((select public.has_role('admin','pharmacist','inventory_officer')) or status = 'open'));

-- expenses: staff can record; admin/pharmacist review everything; others see only their own entries
create policy expenses_read on public.expenses for select to authenticated
  using (not is_deleted and (select public.can_see_branch(branch_id)) and
    ((select public.has_role('admin','pharmacist')) or created_by = (select auth.uid())));
create policy expenses_insert on public.expenses for insert to authenticated
  with check ((select public.is_staff()) and (select public.can_see_branch(branch_id)));
create policy expenses_update on public.expenses for update to authenticated
  using (not is_deleted and (select public.can_see_branch(branch_id)) and
    ((select public.has_role('admin','pharmacist'))
     or (created_by = (select auth.uid()) and expense_date = current_date)))
  with check ((select public.can_see_branch(branch_id)));

-- ───────────── privileges ─────────────
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.orders, public.order_items, public.order_allocations,
  public.order_events, public.prescriptions, public.delivery_jobs from authenticated;
revoke delete on public.wishlist_items, public.expenses from authenticated;
-- soft-delete flags are RPC-only
revoke update on public.wishlist_items, public.expenses from authenticated;
grant update (product_name, drug_id, quantity, customer_name, customer_phone, reason, status, notes, requested_on)
  on public.wishlist_items to authenticated;
grant update (expense_date, description, unit_cost, quantity, category, notes) on public.expenses to authenticated;
-- the delivery code never leaves the server except via get_delivery_code()
revoke select on public.delivery_jobs from authenticated;
grant select (id, order_id, branch_id, assigned_to, provider, courier_name, status, recipient_name,
  recipient_phone, address, notes, items_summary, cod_amount, collected_amount, proof_name,
  proof_photo_path, failure_reason, assigned_at, picked_up_at, delivered_at, created_by)
  on public.delivery_jobs to authenticated;
grant usage on sequence public.order_seq to authenticated;

-- ═════════════ views (respect RLS of the caller) ═════════════
create view public.wishlist_demand with (security_invoker = true) as
select coalesce(drug_id::text, lower(trim(product_name))) as demand_key,
       min(product_name) as product_name,
       max(drug_id::text)::uuid as drug_id,
       count(*) as request_count,
       sum(quantity) as total_quantity,
       count(distinct coalesce(nullif(customer_phone,''), customer_name)) as distinct_customers,
       count(*) filter (where status = 'open') as open_requests,
       count(*) filter (where reason = 'not_stocked') as not_stocked_requests,
       min(requested_on) as first_requested,
       max(requested_on) as last_requested
from public.wishlist_items where not is_deleted
group by 1;

create view public.wishlist_monthly with (security_invoker = true) as
select date_trunc('month', requested_on)::date as month,
       count(*) as requests, sum(quantity) as total_quantity
from public.wishlist_items where not is_deleted group by 1;

-- Expense report: S/No. is numbered per report so it never has gaps. Optional month OR range.
create function public.expense_report(p_from date, p_to date, p_branch uuid default null)
returns table (s_no bigint, id uuid, expense_date date, description text, unit_cost numeric,
               quantity numeric, total_cost numeric, category text)
language sql stable security invoker set search_path = '' as $$
  select row_number() over (order by e.expense_date, e.created_at), e.id, e.expense_date,
         e.description, e.unit_cost, e.quantity, e.total_cost, e.category
  from public.expenses e
  where not e.is_deleted and e.expense_date between p_from and p_to
    and (p_branch is null or e.branch_id = p_branch)
  order by e.expense_date, e.created_at
$$;

-- ═════════════ soft delete RPCs ═════════════
create function public.delete_wishlist_item(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := public.assert_role('admin','pharmacist');
  update public.wishlist_items set is_deleted = true, deleted_by = me.id, deleted_at = now()
   where id = p_id and not is_deleted and (me.role = 'admin' or branch_id = me.branch_id);
  if not found then raise exception 'Not found'; end if;
end $$;

create function public.delete_expense(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles;
begin
  me := public.assert_role('admin','pharmacist');
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  update public.expenses set is_deleted = true, deleted_by = me.id, deleted_at = now(),
         notes = trim(coalesce(notes,'') || ' [Deleted: ' || p_reason || ']')
   where id = p_id and not is_deleted and (me.role = 'admin' or branch_id = me.branch_id);
  if not found then raise exception 'Not found'; end if;
end $$;

-- ═════════════ order pipeline ═════════════
create function public.log_order_event(p_order uuid, p_from text, p_to text, p_note text) returns void
language sql security definer set search_path = '' as $$
  insert into public.order_events (order_id, from_status, to_status, note) values (p_order, p_from, p_to, p_note)
$$;

create function public.get_order_for_update(p_order uuid, p_me public.profiles) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if p_me.role <> 'admin' and o.branch_id is distinct from p_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  return o;
end $$;

create function public.create_order(p_order jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles; v_id uuid := gen_random_uuid(); v_branch uuid; it jsonb; d public.drugs;
  q int; sub numeric(12,2) := 0; rx boolean := false; fee numeric(12,2); mode text; ful text;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  v_branch := coalesce(nullif(p_order->>'branch_id','')::uuid, me.branch_id);
  if me.role <> 'admin' and v_branch is distinct from me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  ful := coalesce(p_order->>'fulfilment', 'delivery');
  mode := coalesce(p_order->>'payment_mode', 'prepaid');
  if ful not in ('delivery','pickup') then raise exception 'Invalid fulfilment'; end if;
  if mode not in ('prepaid','cod') then raise exception 'Invalid payment mode'; end if;
  if coalesce(trim(p_order->>'customer_name'),'') = '' then raise exception 'Customer name is required'; end if;
  if ful = 'delivery' and (coalesce(trim(p_order->>'delivery_address'),'') = ''
      or coalesce(trim(p_order->>'customer_phone'),'') = '') then
    raise exception 'Delivery needs a phone number and address';
  end if;
  fee := case when ful = 'delivery' then coalesce((p_order->>'delivery_fee')::numeric, 0) else 0 end;
  if fee < 0 then raise exception 'Invalid delivery fee'; end if;
  if jsonb_typeof(p_order->'items') is distinct from 'array' or jsonb_array_length(p_order->'items') = 0 then
    raise exception 'Order has no items';
  end if;

  insert into public.orders (id, branch_id, customer_id, channel, fulfilment, payment_mode, customer_name,
      customer_phone, delivery_address, delivery_notes, delivery_fee)
    values (v_id, v_branch, nullif(p_order->>'customer_id','')::uuid, coalesce(p_order->>'channel','phone'),
      ful, mode, trim(p_order->>'customer_name'), nullif(trim(p_order->>'customer_phone'),''),
      nullif(trim(p_order->>'delivery_address'),''), nullif(trim(p_order->>'delivery_notes'),''), fee);

  for it in select * from jsonb_array_elements(p_order->'items') loop
    select * into d from public.drugs where id = (it->>'drug_id')::uuid and is_active;
    if not found then raise exception 'Unknown or inactive drug'; end if;
    q := (it->>'quantity')::int;
    if q is null or q < 1 then raise exception 'Invalid quantity for %', d.name; end if;
    insert into public.order_items (order_id, drug_id, quantity, unit_price, line_total)
      values (v_id, d.id, q, d.selling_price, q * d.selling_price);   -- server price, never client price
    sub := sub + q * d.selling_price;
    rx := rx or d.requires_prescription;
  end loop;

  update public.orders set subtotal = sub, total = sub + fee, requires_prescription = rx where id = v_id;
  perform public.log_order_event(v_id, null, 'placed', 'Order created');
  return v_id;
end $$;

create function public.add_prescription(p_order uuid, p_file_path text, p_prescriber text default null,
  p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; v uuid;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  o := public.get_order_for_update(p_order, me);
  insert into public.prescriptions (order_id, branch_id, file_path, prescriber, note)
    values (p_order, o.branch_id, p_file_path, p_prescriber, p_note) returning id into v;
  return v;
end $$;

create function public.add_order_payment(p_order uuid, p_method text, p_amount numeric, p_reference text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; v uuid; v_ref text := nullif(trim(p_reference),'');
begin
  me := public.assert_role('admin','pharmacist','cashier');
  o := public.get_order_for_update(p_order, me);
  if o.status in ('cancelled','returned') then raise exception 'Order is %', o.status; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Invalid amount'; end if;
  if p_method not in ('cash','card','transfer','pos_terminal','paystack','other') then raise exception 'Invalid method'; end if;
  if p_method in ('transfer','pos_terminal') and v_ref is null then
    raise exception 'A payment reference is required for %', p_method;
  end if;
  insert into public.payments (order_id, branch_id, method, amount, status, reference, created_by, verified_by, verified_at)
    values (p_order, o.branch_id, p_method, p_amount,
      case when p_method = 'cash' then 'verified' else 'pending_verification' end, v_ref, me.id,
      case when p_method = 'cash' then me.id end, case when p_method = 'cash' then now() end)
    returning id into v;
  return v;
exception when unique_violation then
  raise exception 'This payment reference has already been used';
end $$;

create function public.order_confirm_payment(p_order uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; v_paid numeric;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  o := public.get_order_for_update(p_order, me);
  if o.status <> 'placed' then raise exception 'Order is %, expected placed', o.status; end if;
  select coalesce(sum(amount),0) into v_paid from public.payments where order_id = p_order and status = 'verified';
  if o.payment_mode = 'prepaid' and v_paid < o.total then
    raise exception 'Verified payments (%) are below the order total (%)', v_paid, o.total;
  end if;
  update public.orders set status = 'payment_confirmed' where id = p_order;
  perform public.log_order_event(p_order, 'placed', 'payment_confirmed',
    coalesce(p_note, case when o.payment_mode = 'cod' then 'Cash on delivery accepted' else 'Payment verified' end));
end $$;

create function public.order_pharmacist_review(p_order uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders;
begin
  me := public.assert_role('admin','pharmacist');
  o := public.get_order_for_update(p_order, me);
  if o.status <> 'payment_confirmed' or not o.requires_prescription then
    raise exception 'Order is not awaiting pharmacist review';
  end if;
  if p_approve and not exists (select 1 from public.prescriptions where order_id = p_order and status <> 'rejected') then
    raise exception 'Attach a prescription before approving';
  end if;
  update public.prescriptions set status = case when p_approve then 'verified' else 'rejected' end,
         verified_by = me.id, verified_at = now() where order_id = p_order and status = 'submitted';
  if p_approve then
    update public.orders set status = 'pharmacist_approved' where id = p_order;
    perform public.log_order_event(p_order, 'payment_confirmed', 'pharmacist_approved', p_note);
  else
    update public.orders set status = 'cancelled', cancel_reason = coalesce(p_note,'Prescription rejected'),
      refund_due = exists (select 1 from public.payments where order_id = p_order and status = 'verified')
      where id = p_order;
    perform public.log_order_event(p_order, 'payment_confirmed', 'cancelled', coalesce(p_note,'Prescription rejected'));
  end if;
end $$;

create function public.order_allocate(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; it record; b record; v_need int; v_take int;
begin
  me := public.assert_role('admin','pharmacist','inventory_officer');
  o := public.get_order_for_update(p_order, me);
  if not ((o.status = 'payment_confirmed' and not o.requires_prescription) or o.status = 'pharmacist_approved') then
    raise exception 'Order is % and cannot be allocated yet', o.status;
  end if;
  for it in select oi.id, oi.drug_id, oi.quantity, d.name from public.order_items oi
            join public.drugs d on d.id = oi.drug_id where oi.order_id = p_order loop
    v_need := it.quantity;
    for b in select id, quantity_remaining, quantity_reserved from public.drug_batches
             where drug_id = it.drug_id and branch_id = o.branch_id and expiry_date >= current_date
               and quantity_remaining - quantity_reserved > 0
             order by expiry_date, received_at for update loop
      exit when v_need = 0;
      v_take := least(v_need, b.quantity_remaining - b.quantity_reserved);
      update public.drug_batches set quantity_reserved = quantity_reserved + v_take where id = b.id;
      insert into public.order_allocations (order_id, order_item_id, batch_id, quantity)
        values (p_order, it.id, b.id, v_take);
      insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id)
        values (it.drug_id, b.id, o.branch_id, 'reserve', v_take, 'order', p_order);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      raise exception 'Insufficient in-date stock for % (short by %)', it.name, v_need;
    end if;
  end loop;
  update public.orders set status = 'allocated' where id = p_order;
  perform public.log_order_event(p_order, o.status, 'allocated', 'Stock reserved (earliest expiry first)');
end $$;

create function public.order_pack(p_order uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders;
begin
  me := public.assert_role('admin','pharmacist','inventory_officer');
  o := public.get_order_for_update(p_order, me);
  if o.status <> 'allocated' then raise exception 'Order is %, expected allocated', o.status; end if;
  update public.orders set status = 'packed' where id = p_order;
  perform public.log_order_event(p_order, 'allocated', 'packed', p_note);
end $$;

-- internal: reservation -> issued stock, plus the online sale record
create function public.issue_order_stock(p_order uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; a record; v_sale uuid := gen_random_uuid(); oi record; v_cost numeric;
begin
  select * into o from public.orders where id = p_order;
  insert into public.sales (id, branch_id, cashier_id, customer_id, channel, order_id, subtotal, discount,
      total, amount_paid, notes)
    values (v_sale, o.branch_id, p_actor, o.customer_id, 'online', p_order, o.subtotal, 0, o.total,
      coalesce((select sum(amount) from public.payments where order_id = p_order and status = 'verified'), 0),
      'Order ' || o.order_no || case when o.delivery_fee > 0 then ' (total includes delivery fee ' || o.delivery_fee || ')' else '' end);
  for a in select oa.*, oi.drug_id, oi.unit_price from public.order_allocations oa
           join public.order_items oi on oi.id = oa.order_item_id
           where oa.order_id = p_order and oa.state = 'reserved' loop
    update public.drug_batches set quantity_remaining = quantity_remaining - a.quantity,
           quantity_reserved = quantity_reserved - a.quantity where id = a.batch_id
    returning coalesce(cost_price, 0) into v_cost;
    update public.order_allocations set state = 'issued' where id = a.id;
    insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id)
      values (a.drug_id, a.batch_id, o.branch_id, 'release', -a.quantity, 'order', p_order),
             (a.drug_id, a.batch_id, o.branch_id, 'issue', -a.quantity, 'order', p_order);
    insert into public.sale_items (sale_id, drug_id, batch_id, quantity, unit_price, unit_cost, line_total)
      values (v_sale, a.drug_id, a.batch_id, a.quantity, a.unit_price, v_cost, a.quantity * a.unit_price);
  end loop;
end $$;

create function public.order_dispatch(p_order uuid, p_assignee uuid, p_provider text default 'own_rider',
  p_courier_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; v_job uuid := gen_random_uuid(); v_paid numeric;
        v_code text := lpad((floor(random() * 1000000))::int::text, 6, '0'); v_items text; a public.profiles;
begin
  me := public.assert_role('admin','pharmacist','inventory_officer');
  o := public.get_order_for_update(p_order, me);
  if o.fulfilment <> 'delivery' then raise exception 'Not a delivery order'; end if;
  if o.status <> 'packed' then raise exception 'Order is %, expected packed', o.status; end if;
  if p_provider not in ('own_rider','third_party') then raise exception 'Invalid provider'; end if;
  select * into a from public.profiles where id = p_assignee and is_active and role in ('rider','courier');
  if not found then raise exception 'Assignee must be an active rider or courier'; end if;
  perform public.issue_order_stock(p_order, me.id);
  select coalesce(sum(amount),0) into v_paid from public.payments where order_id = p_order and status = 'verified';
  select string_agg(oi.quantity || ' x ' || d.name, ', ') into v_items
    from public.order_items oi join public.drugs d on d.id = oi.drug_id where oi.order_id = p_order;
  insert into public.delivery_jobs (id, order_id, branch_id, assigned_to, provider, courier_name, recipient_name,
      recipient_phone, address, notes, items_summary, cod_amount, delivery_code, created_by)
    values (v_job, p_order, o.branch_id, p_assignee, p_provider, coalesce(p_courier_name, a.full_name),
      o.customer_name, o.customer_phone, o.delivery_address, o.delivery_notes, v_items,
      greatest(o.total - v_paid, 0), v_code, me.id);
  update public.orders set status = 'dispatched' where id = p_order;
  perform public.log_order_event(p_order, 'packed', 'dispatched', 'Assigned to ' || coalesce(p_courier_name, a.full_name));
  return v_job;
end $$;

create function public.order_complete_pickup(p_order uuid, p_collected_by text) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders;
begin
  me := public.assert_role('admin','pharmacist','cashier','inventory_officer');
  o := public.get_order_for_update(p_order, me);
  if o.fulfilment <> 'pickup' or o.status <> 'packed' then raise exception 'Order is not ready for pickup'; end if;
  if coalesce(trim(p_collected_by),'') = '' then raise exception 'Enter who collected the order'; end if;
  perform public.issue_order_stock(p_order, me.id);
  update public.orders set status = 'delivered' where id = p_order;
  perform public.log_order_event(p_order, 'packed', 'delivered', 'Collected by ' || p_collected_by);
end $$;

create function public.get_delivery_code(p_job uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles; j public.delivery_jobs;
begin
  me := public.assert_role('admin','pharmacist','cashier','inventory_officer');
  select * into j from public.delivery_jobs where id = p_job;
  if not found or (me.role <> 'admin' and j.branch_id is distinct from me.branch_id) then
    raise exception 'Not found';
  end if;
  return j.delivery_code;
end $$;

create function public.courier_update_job(p_job uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; j public.delivery_jobs;
begin
  me := public.assert_role('admin','pharmacist','courier','rider');
  select * into j from public.delivery_jobs where id = p_job for update;
  if not found then raise exception 'Job not found'; end if;
  if me.role in ('courier','rider') and j.assigned_to is distinct from me.id then
    raise exception 'Not your job' using errcode = '42501';
  end if;
  if me.role = 'pharmacist' and j.branch_id is distinct from me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if p_status not in ('picked_up','in_transit','failed') then raise exception 'Invalid status'; end if;
  if j.status not in ('assigned','picked_up','in_transit') then raise exception 'Job is already %', j.status; end if;
  if p_status = 'failed' and coalesce(trim(p_note),'') = '' then raise exception 'A reason is required'; end if;
  update public.delivery_jobs set status = p_status,
      picked_up_at = case when p_status = 'picked_up' then now() else picked_up_at end,
      failure_reason = case when p_status = 'failed' then p_note else failure_reason end
    where id = p_job;
  if p_status = 'failed' then
    update public.orders set status = 'failed_delivery' where id = j.order_id;
    perform public.log_order_event(j.order_id, 'dispatched', 'failed_delivery', p_note);
  else
    perform public.log_order_event(j.order_id, 'dispatched', 'dispatched', 'Courier: ' || p_status);
  end if;
end $$;

create function public.confirm_delivery(p_job uuid, p_code text, p_recipient text,
  p_collected numeric default null, p_photo text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; j public.delivery_jobs; v_col numeric; v_note text := 'Delivered to ' || coalesce(p_recipient,'?');
begin
  me := public.assert_role('admin','pharmacist','courier','rider');
  select * into j from public.delivery_jobs where id = p_job for update;
  if not found then raise exception 'Job not found'; end if;
  if me.role in ('courier','rider') and j.assigned_to is distinct from me.id then
    raise exception 'Not your job' using errcode = '42501';
  end if;
  if me.role = 'pharmacist' and j.branch_id is distinct from me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if j.status not in ('assigned','picked_up','in_transit') then raise exception 'Job is already %', j.status; end if;
  if coalesce(trim(p_recipient),'') = '' then raise exception 'Recipient name is required'; end if;
  if me.role in ('courier','rider') then
    if p_code is distinct from j.delivery_code then raise exception 'Incorrect delivery code'; end if;
  elsif p_code is distinct from j.delivery_code then
    v_note := v_note || ' (confirmed by ' || me.role || ' without customer code)';
  end if;
  v_col := case when j.cod_amount > 0 then coalesce(p_collected, j.cod_amount) else null end;
  update public.delivery_jobs set status = 'delivered', delivered_at = now(), proof_name = trim(p_recipient),
      proof_photo_path = p_photo, collected_amount = v_col where id = p_job;
  update public.orders set status = 'delivered' where id = j.order_id;
  if v_col is not null and v_col > 0 then
    insert into public.payments (order_id, branch_id, method, amount, status, reference, note, created_by)
      values (j.order_id, j.branch_id, 'cash', v_col, 'pending_verification', null,
        'COD collected by courier; verify on remittance' ||
        case when v_col <> j.cod_amount then ' (EXPECTED ' || j.cod_amount || ')' else '' end, me.id);
  end if;
  perform public.log_order_event(j.order_id, 'dispatched', 'delivered', v_note);
end $$;

create function public.order_cancel(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; a record;
begin
  me := public.assert_role('admin','pharmacist','cashier');
  o := public.get_order_for_update(p_order, me);
  if o.status not in ('placed','payment_confirmed','pharmacist_approved','allocated','packed') then
    raise exception 'Order is % and can no longer be cancelled', o.status;
  end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  for a in select oa.*, oi.drug_id from public.order_allocations oa join public.order_items oi on oi.id = oa.order_item_id
           where oa.order_id = p_order and oa.state = 'reserved' loop
    update public.drug_batches set quantity_reserved = quantity_reserved - a.quantity where id = a.batch_id;
    update public.order_allocations set state = 'released' where id = a.id;
    insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id, note)
      values (a.drug_id, a.batch_id, o.branch_id, 'release', -a.quantity, 'order', p_order, p_reason);
  end loop;
  update public.orders set status = 'cancelled', cancel_reason = p_reason,
    refund_due = exists (select 1 from public.payments where order_id = p_order and status = 'verified')
    where id = p_order;
  perform public.log_order_event(p_order, o.status, 'cancelled', p_reason);
end $$;

create function public.order_return(p_order uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; a record;
begin
  me := public.assert_role('admin','pharmacist','inventory_officer');
  o := public.get_order_for_update(p_order, me);
  if o.status <> 'failed_delivery' then raise exception 'Order is %, expected failed_delivery', o.status; end if;
  for a in select oa.*, oi.drug_id from public.order_allocations oa join public.order_items oi on oi.id = oa.order_item_id
           where oa.order_id = p_order and oa.state = 'issued' loop
    update public.drug_batches set quantity_remaining = quantity_remaining + a.quantity where id = a.batch_id;
    update public.order_allocations set state = 'returned' where id = a.id;
    insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id, note)
      values (a.drug_id, a.batch_id, o.branch_id, 'return', a.quantity, 'order', p_order, p_note);
  end loop;
  update public.sales set status = 'voided', voided_by = me.id, voided_at = now(), void_reason = 'Delivery failed; goods returned'
    where order_id = p_order and status = 'completed';
  update public.delivery_jobs set status = 'returned' where order_id = p_order and status = 'failed';
  update public.orders set status = 'returned',
    refund_due = exists (select 1 from public.payments where order_id = p_order and status = 'verified')
    where id = p_order;
  perform public.log_order_event(p_order, 'failed_delivery', 'returned', p_note);
end $$;

-- Paystack: called ONLY by the server-side edge function (service role) after it has verified
-- the transaction with Paystack. Idempotent on the reference.
create function public.record_paystack_payment(p_order uuid, p_sale uuid, p_branch uuid,
  p_reference text, p_amount numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  insert into public.payments (order_id, sale_id, branch_id, method, amount, status, reference, verified_at, note)
    values (p_order, p_sale, p_branch, 'paystack', p_amount, 'verified', p_reference, now(), 'Verified with Paystack')
  on conflict (method, lower(reference)) where reference is not null and method in ('transfer','pos_terminal','paystack') and status <> 'rejected'
  do nothing returning id into v;
  return v;
end $$;

-- storage for prescriptions / proof of delivery (private)
insert into storage.buckets (id, name, public) values ('prescriptions', 'prescriptions', false),
  ('delivery-proof', 'delivery-proof', false) on conflict (id) do nothing;
create policy storage_staff_rx_read on storage.objects for select to authenticated
  using (bucket_id in ('prescriptions','delivery-proof') and (select public.is_staff()));
create policy storage_staff_rx_write on storage.objects for insert to authenticated
  with check (bucket_id = 'prescriptions' and (select public.is_staff()));
create policy storage_courier_proof_write on storage.objects for insert to authenticated
  with check (bucket_id = 'delivery-proof' and (select public.has_role('admin','pharmacist','courier','rider')));

-- ───────────── function grants ─────────────
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.handle_new_user(), public.audit_row(), public.set_updated_at(),
  public.prevent_mutation(), public.stamp_updated_by(), public.log_order_event(uuid,text,text,text),
  public.get_order_for_update(uuid, public.profiles), public.issue_order_stock(uuid, uuid),
  public.record_paystack_payment(uuid,uuid,uuid,text,numeric) from authenticated;
grant execute on function public.record_paystack_payment(uuid,uuid,uuid,text,numeric) to service_role;


-- ====================================================================
-- 20261126000003_profile_email_import_v3.sql
-- ====================================================================

-- Migration 3: show emails in the staff list; import supports reorder level, wholesale price, Rx flag.

alter table public.profiles add column email text;
update public.profiles p set email = u.email from auth.users u where u.id = p.id;

create or replace function public.handle_new_user() returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create function public.sync_profile_email() returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email) execute function public.sync_profile_email();
revoke execute on function public.sync_profile_email() from public, anon, authenticated;

create or replace function public.import_inventory(p_branch uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles; r jsonb; i int := 0; v_errs jsonb := '[]'::jsonb;
  v_new int := 0; v_upd int := 0; v_bat int := 0;
  v_name text; v_bc text; v_id uuid; v_bn text; v_exp date; v_qty int; v_old int; v_b public.drug_batches;
  v_cost numeric; v_price numeric; v_whole numeric; v_reorder int; v_rx boolean; f_new int; f_upd int; f_bat int;
begin
  v_me := public.assert_role('admin','pharmacist','inventory_officer');
  if v_me.role <> 'admin' and p_branch is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_id := null; f_new := 0; f_upd := 0; f_bat := 0;
      v_name := nullif(trim(r->>'name'), '');
      if v_name is null then raise exception 'name is required'; end if;
      v_bc := nullif(trim(r->>'barcode'), '');
      v_cost := nullif(trim(r->>'cost_price'), '')::numeric;
      v_price := nullif(trim(r->>'selling_price'), '')::numeric;
      v_whole := nullif(trim(r->>'wholesale_price'), '')::numeric;
      v_reorder := nullif(trim(r->>'reorder_level'), '')::int;
      v_rx := nullif(trim(r->>'requires_prescription'), '')::boolean;
      select id into v_id from public.drugs
        where (v_bc is not null and barcode = v_bc) or lower(name) = lower(v_name)
        order by (barcode = v_bc) desc nulls last limit 1;
      if v_id is null then
        if v_price is null then raise exception 'selling_price is required for a new product'; end if;
        insert into public.drugs (name, generic_name, category, nafdac_number, barcode, unit_type,
            cost_price, selling_price, wholesale_price, reorder_level, requires_prescription)
          values (v_name, nullif(trim(r->>'generic_name'),''), nullif(trim(r->>'category'),''),
            nullif(trim(r->>'nafdac_number'),''), v_bc, coalesce(nullif(trim(r->>'unit_type'),''),'Pack'),
            coalesce(v_cost,0), v_price, v_whole, coalesce(v_reorder, 10), coalesce(v_rx, false))
          returning id into v_id;
        f_new := 1;
      else
        update public.drugs set
          generic_name = coalesce(nullif(trim(r->>'generic_name'),''), generic_name),
          category = coalesce(nullif(trim(r->>'category'),''), category),
          nafdac_number = coalesce(nullif(trim(r->>'nafdac_number'),''), nafdac_number),
          barcode = coalesce(v_bc, barcode),
          unit_type = coalesce(nullif(trim(r->>'unit_type'),''), unit_type),
          cost_price = coalesce(v_cost, cost_price),
          selling_price = coalesce(v_price, selling_price),
          wholesale_price = coalesce(v_whole, wholesale_price),
          reorder_level = coalesce(v_reorder, reorder_level),
          requires_prescription = coalesce(v_rx, requires_prescription)
        where id = v_id;
        f_upd := 1;
      end if;
      v_bn := nullif(trim(r->>'batch_number'), '');
      if v_bn is not null then
        v_exp := (r->>'expiry_date')::date;
        v_qty := (r->>'quantity')::int;
        if v_exp is null then raise exception 'expiry_date is required with a batch'; end if;
        if v_qty is null or v_qty < 0 then raise exception 'quantity must be 0 or more'; end if;
        select * into v_b from public.drug_batches
          where drug_id = v_id and branch_id = p_branch and batch_number = v_bn for update;
        if found then
          if v_qty < v_b.quantity_reserved then raise exception 'quantity is below reserved stock (%)', v_b.quantity_reserved; end if;
          v_old := v_b.quantity_remaining;
          update public.drug_batches set quantity_remaining = v_qty, expiry_date = v_exp,
            cost_price = coalesce(v_cost, cost_price) where id = v_b.id;
        else
          v_old := 0;
          insert into public.drug_batches (drug_id, branch_id, batch_number, expiry_date, quantity_remaining, cost_price)
            values (v_id, p_branch, v_bn, v_exp, v_qty, v_cost) returning * into v_b;
        end if;
        if v_qty <> v_old then
          insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, note)
            values (v_id, v_b.id, p_branch, 'import', v_qty - v_old, 'import', 'Bulk import');
        end if;
        f_bat := 1;
      end if;
      v_new := v_new + f_new; v_upd := v_upd + f_upd; v_bat := v_bat + f_bat;
    exception when others then
      v_errs := v_errs || jsonb_build_object('row', coalesce((r->>'_row')::int, i), 'message', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('created', v_new, 'updated', v_upd, 'batches', v_bat, 'errors', v_errs);
end $$;


-- ====================================================================
-- 20261126000004_profit_report.sql
-- ====================================================================

-- Migration 4: administrator-only profit report (uses hidden purchase costs).
create function public.profit_report(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rev numeric; v_cogs numeric; v_nocost int; v_top jsonb;
begin
  perform public.assert_role('admin');
  select coalesce(sum(si.line_total), 0), coalesce(sum(si.unit_cost * si.quantity), 0), count(*) filter (where si.unit_cost = 0)
    into v_rev, v_cogs, v_nocost
  from public.sale_items si join public.sales s on s.id = si.sale_id
  where s.status = 'completed' and s.sold_at between p_from and p_to;

  select coalesce(jsonb_agg(x.t order by x.p desc), '[]'::jsonb) into v_top from (
    select sum(si.line_total - si.unit_cost * si.quantity) as p,
           jsonb_build_object('name', d.name, 'qty', sum(si.quantity), 'revenue', sum(si.line_total),
             'cost', sum(si.unit_cost * si.quantity), 'profit', sum(si.line_total - si.unit_cost * si.quantity)) as t
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.drugs d on d.id = si.drug_id
    where s.status = 'completed' and s.sold_at between p_from and p_to
    group by d.id, d.name
    order by 1 desc limit 15
  ) x;

  return jsonb_build_object('revenue', v_rev, 'cost_of_goods', v_cogs, 'gross_profit', v_rev - v_cogs,
    'lines_without_cost', v_nocost, 'top_products', v_top);
end $$;
revoke execute on function public.profit_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.profit_report(timestamptz, timestamptz) to authenticated;


-- ====================================================================
-- 20261126000005_returns_and_shifts.sql
-- ====================================================================

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


-- ====================================================================
-- 20261127000006_receiving_and_paystack.sql
-- ====================================================================

-- Migration 6: stock receiving with supplier / invoice details, and Paystack payment confirmation.

-- ───────────── stock receipts (goods received notes) ─────────────
create sequence public.grn_seq;

create table public.stock_receipts (
  id uuid primary key,                                   -- generated on the device, so uploads are idempotent
  grn_no text not null unique
    default ('GRN' || to_char(now(), 'YYMM') || lpad(nextval('public.grn_seq')::text, 5, '0')),
  branch_id uuid not null references public.branches(id),
  supplier_id uuid references public.suppliers(id),
  supplier_name text not null,                           -- name as it was when received
  invoice_no text,                                       -- the supplier's invoice / receipt number
  supply_date date not null,                             -- date on the supplier's invoice (date supplied)
  received_date date not null default current_date,      -- date received into the system
  note text,
  total_cost numeric(14,2) not null default 0,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  check (supply_date <= received_date)
);
create unique index stock_receipts_supplier_invoice_uq on public.stock_receipts (supplier_id, lower(invoice_no))
  where invoice_no is not null and supplier_id is not null;
create index stock_receipts_dates on public.stock_receipts (branch_id, received_date desc);
create index stock_receipts_supplier on public.stock_receipts (supplier_id);

create table public.stock_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.stock_receipts(id) on delete cascade,
  drug_id uuid not null references public.drugs(id),
  batch_id uuid references public.drug_batches(id),
  batch_number text not null,
  expiry_date date not null,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12,2) check (unit_cost >= 0),
  line_total numeric(14,2) not null default 0
);
create index stock_receipt_items_receipt on public.stock_receipt_items (receipt_id);
create index stock_receipt_items_drug on public.stock_receipt_items (drug_id);

alter table public.stock_receipts enable row level security;
alter table public.stock_receipt_items enable row level security;
create policy receipts_read on public.stock_receipts for select to authenticated
  using ((select public.has_role('admin','pharmacist','inventory_officer')) and (select public.can_see_branch(branch_id)));
create policy receipt_items_read on public.stock_receipt_items for select to authenticated
  using (exists (select 1 from public.stock_receipts r where r.id = receipt_id
    and (select public.has_role('admin','pharmacist','inventory_officer')) and (select public.can_see_branch(r.branch_id))));
create trigger audit_stock_receipts after insert on public.stock_receipts for each row execute function public.audit_row();

create function public.receive_stock_invoice(p_receipt jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles; v_id uuid; v_branch uuid; v_sup uuid; v_sup_name text; v_inv text;
  v_supply date; v_recv date; v_exist public.stock_receipts; it jsonb; v_drug uuid; v_dname text;
  v_bn text; v_exp date; v_q int; v_cost numeric; v_b uuid; v_total numeric(14,2) := 0; v_grn text;
begin
  me := public.assert_role('admin','pharmacist','inventory_officer');
  v_id := (p_receipt->>'id')::uuid;
  if v_id is null then raise exception 'Receipt id is required'; end if;

  select * into v_exist from public.stock_receipts where id = v_id;
  if found then
    return jsonb_build_object('id', v_id, 'grn_no', v_exist.grn_no, 'total_cost', v_exist.total_cost, 'duplicate', true);
  end if;

  v_branch := coalesce(nullif(p_receipt->>'branch_id','')::uuid, me.branch_id);
  if v_branch is null then raise exception 'Branch is required'; end if;
  if me.role <> 'admin' and v_branch is distinct from me.branch_id then raise exception 'Wrong branch' using errcode = '42501'; end if;

  v_inv := nullif(trim(p_receipt->>'invoice_no'), '');
  v_supply := nullif(p_receipt->>'supply_date', '')::date;
  v_recv := coalesce(nullif(p_receipt->>'received_date', '')::date, current_date);
  if v_supply is null then raise exception 'The date of supply is required'; end if;
  if v_supply > v_recv then raise exception 'The date of supply cannot be after the date received'; end if;
  if v_recv > current_date + 1 then raise exception 'The date received cannot be in the future'; end if;
  if jsonb_typeof(p_receipt->'items') is distinct from 'array' or jsonb_array_length(p_receipt->'items') = 0 then
    raise exception 'Add at least one product to receive';
  end if;

  v_sup := nullif(p_receipt->>'supplier_id', '')::uuid;
  v_sup_name := nullif(trim(p_receipt->>'supplier_name'), '');
  if v_sup is not null then
    select name into v_sup_name from public.suppliers where id = v_sup;
    if not found then raise exception 'Supplier not found'; end if;
  elsif v_sup_name is not null then
    select id into v_sup from public.suppliers where lower(name) = lower(v_sup_name);
    if v_sup is null then insert into public.suppliers (name) values (v_sup_name) returning id into v_sup; end if;
  else
    raise exception 'Choose the supplier or type their name';
  end if;

  if v_inv is not null and exists (select 1 from public.stock_receipts where supplier_id = v_sup and lower(invoice_no) = lower(v_inv)) then
    raise exception 'Invoice % from % has already been received', v_inv, v_sup_name;
  end if;

  insert into public.stock_receipts (id, branch_id, supplier_id, supplier_name, invoice_no, supply_date, received_date, note, created_by)
    values (v_id, v_branch, v_sup, v_sup_name, v_inv, v_supply, v_recv, nullif(trim(p_receipt->>'note'), ''), me.id)
    returning grn_no into v_grn;

  for it in select * from jsonb_array_elements(p_receipt->'items') loop
    v_drug := (it->>'drug_id')::uuid;
    select name into v_dname from public.drugs where id = v_drug;
    if not found then raise exception 'Unknown product'; end if;
    v_bn := nullif(trim(it->>'batch_number'), '');
    v_exp := nullif(it->>'expiry_date', '')::date;
    v_q := (it->>'quantity')::int;
    v_cost := nullif(it->>'unit_cost', '')::numeric;
    if v_bn is null then raise exception 'Batch number is required for %', v_dname; end if;
    if v_exp is null then raise exception 'Expiry date is required for %', v_dname; end if;
    if v_exp < current_date then raise exception 'Batch % of % has already expired', v_bn, v_dname; end if;
    if v_q is null or v_q < 1 then raise exception 'Quantity must be at least 1 for %', v_dname; end if;
    if v_cost is not null and v_cost < 0 then raise exception 'Invalid cost for %', v_dname; end if;

    insert into public.drug_batches (drug_id, branch_id, batch_number, expiry_date, quantity_remaining, cost_price, supplier_id)
      values (v_drug, v_branch, v_bn, v_exp, v_q, v_cost, v_sup)
    on conflict (drug_id, branch_id, batch_number) do update
      set quantity_remaining = public.drug_batches.quantity_remaining + excluded.quantity_remaining,
          expiry_date = excluded.expiry_date,
          cost_price = coalesce(excluded.cost_price, public.drug_batches.cost_price),
          supplier_id = coalesce(excluded.supplier_id, public.drug_batches.supplier_id)
    returning id into v_b;
    if v_cost is not null then update public.drugs set cost_price = v_cost where id = v_drug; end if;

    insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id, note)
      values (v_drug, v_b, v_branch, 'receipt', v_q, 'receipt', v_id,
              'GRN ' || v_grn || coalesce(' / invoice ' || v_inv, '') || ' / ' || v_sup_name);
    insert into public.stock_receipt_items (receipt_id, drug_id, batch_id, batch_number, expiry_date, quantity, unit_cost, line_total)
      values (v_id, v_drug, v_b, v_bn, v_exp, v_q, v_cost, v_q * coalesce(v_cost, 0));
    v_total := v_total + v_q * coalesce(v_cost, 0);
  end loop;

  update public.stock_receipts set total_cost = v_total where id = v_id;
  return jsonb_build_object('id', v_id, 'grn_no', v_grn, 'total_cost', v_total, 'duplicate', false);
end $$;

-- ───────────── Paystack ─────────────
create table public.paystack_transactions (
  reference text primary key,
  branch_id uuid references public.branches(id),
  purpose text not null default 'pos' check (purpose in ('pos','order')),
  amount numeric(12,2) not null check (amount > 0),        -- naira
  currency text not null default 'NGN',
  customer_email text,
  status text not null default 'initiated' check (status in ('initiated','success','failed','abandoned')),
  gateway_response text,
  channel text,
  paid_at timestamptz,
  verified_at timestamptz,
  claimed_sale uuid references public.sales(id),
  claimed_order uuid references public.orders(id),
  initiated_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index paystack_status on public.paystack_transactions (status, created_at desc);
create index paystack_claimed_sale on public.paystack_transactions (claimed_sale);
create index paystack_claimed_order on public.paystack_transactions (claimed_order);
alter table public.paystack_transactions enable row level security;
create policy paystack_read on public.paystack_transactions for select to authenticated
  using ((select public.has_role('admin','pharmacist','cashier')) and (select public.can_see_branch(branch_id)));
-- rows are written only by the server-side functions (service role), never by the browser

insert into public.app_settings (key, value) values ('paystack_enabled', 'false') on conflict (key) do nothing;

-- A Paystack payment is only marked "verified" when the server has already confirmed it with Paystack AND it has not been used before.
create or replace function public.process_offline_sale(p_sale jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles; v_id uuid; v_ex public.sales%rowtype; v_branch uuid;
  v_item jsonb; v_pay jsonb; v_drug public.drugs%rowtype; v_tx public.paystack_transactions%rowtype;
  v_qty int; v_price numeric(12,2); v_need int; v_take int; b record;
  v_sub numeric(12,2) := 0; v_disc numeric(12,2); v_total numeric(12,2);
  v_paid numeric(12,2) := 0; v_review boolean := false; v_note text := '';
  v_method text; v_ref text; v_amt numeric(12,2); v_status text; v_receipt text; v_pnote text;
begin
  v_me := public.assert_role('admin','pharmacist','cashier');
  v_id := (p_sale->>'id')::uuid;
  if v_id is null then raise exception 'Sale id is required'; end if;

  select * into v_ex from public.sales where id = v_id;
  if found then
    return jsonb_build_object('id', v_id, 'receipt_no', v_ex.receipt_no,
      'needs_review', v_ex.needs_review, 'duplicate', true);
  end if;

  v_branch := coalesce(nullif(p_sale->>'branch_id','')::uuid, v_me.branch_id);
  if v_branch is null then raise exception 'Branch is required'; end if;
  if v_me.role <> 'admin' and v_branch is distinct from v_me.branch_id then
    raise exception 'Wrong branch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_sale->'items') is distinct from 'array' or jsonb_array_length(p_sale->'items') = 0 then
    raise exception 'Sale has no items';
  end if;

  for v_item in select * from jsonb_array_elements(p_sale->'items') loop
    select * into v_drug from public.drugs where id = (v_item->>'drug_id')::uuid;
    if not found then raise exception 'Unknown drug %', v_item->>'drug_id'; end if;
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 then raise exception 'Invalid quantity for %', v_drug.name; end if;
    v_price := coalesce(nullif(v_item->>'unit_price','')::numeric, v_drug.selling_price);
    if v_price < 0 then raise exception 'Invalid price for %', v_drug.name; end if;
    v_sub := v_sub + v_qty * v_price;
    if v_price < v_drug.selling_price then
      v_review := true; v_note := v_note || format('Below list price: %s. ', v_drug.name);
    end if;
    if v_drug.requires_prescription and v_me.role = 'cashier' then
      v_review := true; v_note := v_note || format('Prescription item sold by cashier: %s. ', v_drug.name);
    end if;
  end loop;

  v_disc := least(greatest(coalesce((p_sale->>'discount')::numeric, 0), 0), v_sub);
  if v_me.role = 'cashier' and v_disc > v_sub * 0.10 then
    v_review := true; v_note := v_note || 'Discount above 10%. ';
  end if;
  v_total := v_sub - v_disc;

  for v_pay in select * from jsonb_array_elements(coalesce(p_sale->'payments','[]'::jsonb)) loop
    v_paid := v_paid + coalesce((v_pay->>'amount')::numeric, 0);
  end loop;
  if v_paid < v_total then
    v_review := true; v_note := v_note || format('Underpaid by %s. ', v_total - v_paid);
  end if;

  insert into public.sales (id, local_ref, branch_id, cashier_id, customer_id, subtotal, discount,
      total, amount_paid, change_given, notes, sold_at)
  values (v_id, p_sale->>'local_ref', v_branch, v_me.id, nullif(p_sale->>'customer_id','')::uuid,
      v_sub, v_disc, v_total, v_paid, greatest(v_paid - v_total, 0), p_sale->>'notes',
      coalesce(nullif(p_sale->>'sold_at','')::timestamptz, now()))
  returning receipt_no into v_receipt;

  for v_item in select * from jsonb_array_elements(p_sale->'items') loop
    select * into v_drug from public.drugs where id = (v_item->>'drug_id')::uuid;
    v_qty := (v_item->>'quantity')::int;
    v_price := coalesce(nullif(v_item->>'unit_price','')::numeric, v_drug.selling_price);
    v_need := v_qty;
    for b in
      select id, quantity_remaining, quantity_reserved, cost_price from public.drug_batches
      where drug_id = v_drug.id and branch_id = v_branch and expiry_date >= current_date
        and quantity_remaining - quantity_reserved > 0
      order by expiry_date, received_at for update
    loop
      exit when v_need = 0;
      v_take := least(v_need, b.quantity_remaining - b.quantity_reserved);
      update public.drug_batches set quantity_remaining = quantity_remaining - v_take where id = b.id;
      insert into public.sale_items (sale_id, drug_id, batch_id, quantity, unit_price, unit_cost, line_total)
        values (v_id, v_drug.id, b.id, v_take, v_price, coalesce(b.cost_price, v_drug.cost_price), v_take * v_price);
      insert into public.stock_movements (drug_id, batch_id, branch_id, movement_type, quantity, ref_type, ref_id)
        values (v_drug.id, b.id, v_branch, 'sale', -v_take, 'sale', v_id);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      insert into public.sale_items (sale_id, drug_id, batch_id, quantity, unit_price, unit_cost, line_total)
        values (v_id, v_drug.id, null, v_need, v_price, v_drug.cost_price, v_need * v_price);
      v_review := true;
      v_note := v_note || format('Stock shortfall: %s x%s. ', v_drug.name, v_need);
    end if;
  end loop;

  for v_pay in select * from jsonb_array_elements(coalesce(p_sale->'payments','[]'::jsonb)) loop
    v_method := coalesce(v_pay->>'method','cash');
    v_amt := (v_pay->>'amount')::numeric;
    v_ref := nullif(trim(v_pay->>'reference'), '');
    continue when v_amt is null or v_amt <= 0;
    if v_method not in ('cash','card','transfer','pos_terminal','paystack','other') then
      raise exception 'Invalid payment method %', v_method;
    end if;
    v_status := case when v_method = 'cash' then 'verified' else 'pending_verification' end;
    v_pnote := null;
    if v_method in ('transfer','pos_terminal') and v_ref is null then
      v_review := true; v_note := v_note || format('%s payment without reference. ', v_method);
    end if;
    if v_method = 'paystack' then
      select * into v_tx from public.paystack_transactions where reference = v_ref for update;
      if v_ref is not null and found and v_tx.status = 'success' and v_tx.claimed_sale is null
         and v_tx.claimed_order is null and v_tx.amount >= v_amt then
        v_status := 'verified'; v_pnote := 'Confirmed with Paystack';
        update public.paystack_transactions set claimed_sale = v_id where reference = v_ref;
      else
        v_review := true; v_note := v_note || format('Paystack payment %s could not be confirmed. ', coalesce(v_ref, '(no reference)'));
      end if;
    end if;
    begin
      insert into public.payments (sale_id, branch_id, method, amount, status, reference, note, created_by, verified_by, verified_at)
        values (v_id, v_branch, v_method, v_amt, v_status, v_ref, v_pnote, v_me.id,
          case when v_status = 'verified' and v_method <> 'paystack' then v_me.id end,
          case when v_status = 'verified' then now() end);
    exception when unique_violation then
      insert into public.payments (sale_id, branch_id, method, amount, status, reference, note, created_by)
        values (v_id, v_branch, v_method, v_amt, 'pending_verification', null,
          'DUPLICATE REFERENCE ' || coalesce(v_ref, ''), v_me.id);
      v_review := true; v_note := v_note || format('Duplicate payment reference %s. ', coalesce(v_ref, ''));
    end;
  end loop;

  update public.sales set needs_review = v_review, review_note = nullif(trim(v_note), '') where id = v_id;
  return jsonb_build_object('id', v_id, 'receipt_no', v_receipt, 'needs_review', v_review,
    'duplicate', false, 'total', v_total);
end $$;

-- online orders: a Paystack payment must already be confirmed, and can only be used once
create or replace function public.add_order_payment(p_order uuid, p_method text, p_amount numeric, p_reference text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me public.profiles; o public.orders; v uuid; v_ref text := nullif(trim(p_reference),''); v_tx public.paystack_transactions%rowtype;
        v_status text; v_note text;
begin
  me := public.assert_role('admin','pharmacist','cashier');
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
  insert into public.payments (order_id, branch_id, method, amount, status, reference, note, created_by, verified_by, verified_at)
    values (p_order, o.branch_id, p_method, p_amount, v_status, v_ref, v_note, me.id,
      case when v_status = 'verified' and p_method <> 'paystack' then me.id end,
      case when v_status = 'verified' then now() end)
    returning id into v;
  return v;
exception when unique_violation then
  raise exception 'This payment reference has already been used';
end $$;

-- ───────────── grants ─────────────
grant select on public.stock_receipts, public.stock_receipt_items, public.paystack_transactions to authenticated;
revoke insert, update, delete on public.stock_receipts, public.stock_receipt_items, public.paystack_transactions from authenticated;
revoke all on public.stock_receipts, public.stock_receipt_items, public.paystack_transactions from anon;
grant usage on sequence public.grn_seq to authenticated;
revoke execute on function public.receive_stock_invoice(jsonb) from public, anon;
grant execute on function public.receive_stock_invoice(jsonb) to authenticated;

-- ===== 20261128000007_offline_shifts_realtime.sql =====
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
