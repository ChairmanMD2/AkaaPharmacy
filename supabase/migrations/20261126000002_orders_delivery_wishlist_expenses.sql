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
