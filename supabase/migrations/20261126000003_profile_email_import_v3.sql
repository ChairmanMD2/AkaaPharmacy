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
