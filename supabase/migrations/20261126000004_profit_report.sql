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
