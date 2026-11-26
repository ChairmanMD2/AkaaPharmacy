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
