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
