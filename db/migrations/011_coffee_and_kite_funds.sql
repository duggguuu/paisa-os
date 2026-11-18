-- Paisa OS 011: a Coffee category of its own, and unused Kite funds in holdings.
--
-- Coffee: every book gets an expense category "Coffee" (right after Food) with subcategories.
-- Coffee is then taken out of everywhere else:
--   * past Food and Shopping entries at coffee places (Starbucks, Third Wave, Blue Tokai, "café"…)
--     move to Coffee › Orders (or › Beans / › Equipment when the text says so; Shopping → Beans);
--   * Food › "Snacks & coffee" becomes "Snacks" (merged into an existing "Snacks" if there is one);
--   * any other expense category or subcategory named for coffee/café is folded into Coffee
--     (its transactions, bills and budgets move; the emptied category is removed).
-- Safe to run more than once.

alter table holding_snapshot drop constraint if exists holding_snapshot_asset_type_check;
alter table holding_snapshot add constraint holding_snapshot_asset_type_check check (asset_type in ('equity', 'mf', 'cash'));

create or replace function pg_temp.fold_category(src uuid, tgt uuid) returns void language plpgsql as $f$
begin
  update posting set account_id = tgt where account_id = src;
  update recurring_rule set category_id = tgt where category_id = src;
  delete from budget where category_id = src and exists (select 1 from budget o where o.category_id = tgt and o.period = budget.period);
  update budget set category_id = tgt where category_id = src;
  delete from account where id = src;
end $f$;

do $$
declare
  b record; x record; c record;
  coffee uuid; tgt uuid; snacks uuid; food uuid; shop uuid; j int; s text;
  subs text[] := array['Beans', 'Equipment', 'Orders', 'Accessories & filters', 'Milk & syrups', 'Bean subscriptions', 'Servicing & descaling', 'Tastings & workshops'];
  place text := '(coffee|\mcaf(e|é)s?\M|starbucks|third wave|blue tokai|barista|\mccd\M|\mcosta\M|tim hortons|subko|araku|sleepy owl|roaster|espresso|cappuccino|\mlatte\M|cold brew|dunkin|\mmocha\M)';
begin
  for b in select id from book loop
    -- 1. The Coffee category (reuse one the owner already made) and its subcategories.
    select id into coffee from account where book_id = b.id and kind = 'category' and class = 'expense' and parent_id is null and lower(name) = 'coffee';
    if coffee is null then
      update account set sort = sort + 1 where book_id = b.id and kind = 'category' and class = 'expense' and parent_id is null and sort >= 1;
      insert into account (book_id, class, kind, name, icon, sort, meta) values (b.id, 'expense', 'category', 'Coffee', '☕', 1, '{}') returning id into coffee;
    else
      update account set icon = coalesce(icon, '☕'), is_archived = false where id = coffee;
    end if;
    j := 0;
    foreach s in array subs loop
      if not exists (select 1 from account where book_id = b.id and kind = 'category' and parent_id = coffee and lower(name) = lower(s)) then
        insert into account (book_id, class, kind, name, parent_id, sort, meta) values (b.id, 'expense', 'category', s, coffee, j, '{}');
      end if;
      j := j + 1;
    end loop;

    -- 2. Coffee entries filed under Food or Shopping move to Coffee.
    select id into food from account where book_id = b.id and kind = 'category' and class = 'expense' and parent_id is null and lower(name) = 'food';
    select id into shop from account where book_id = b.id and kind = 'category' and class = 'expense' and parent_id is null and lower(name) = 'shopping';
    for x in
      select p.id as posting_id, coalesce(a.parent_id, a.id) as top,
             coalesce(t.merchant, '') || ' ' || coalesce(t.description, '') || ' ' || coalesce(t.note, '') as txt
      from posting p join txn t on t.id = p.txn_id join account a on a.id = p.account_id
      where t.book_id = b.id and a.kind = 'category' and coalesce(a.parent_id, a.id) in (food, shop)
    loop
      continue when x.txt !~* place;
      s := case
        when x.txt ~* '(grinder|machine|kettle|dripper|aeropress|moka|french press|scale|portafilter|tamper)' then 'Equipment'
        when x.txt ~* '(bean|ground coffee|roast)' or x.top = shop then 'Beans'
        else 'Orders' end;
      select id into tgt from account where book_id = b.id and parent_id = coffee and name = s;
      update posting set account_id = tgt where id = x.posting_id;
    end loop;

    -- 3. Food › "Snacks & coffee" → "Snacks".
    for x in select id from account where book_id = b.id and kind = 'category' and parent_id = food and lower(name) = 'snacks & coffee' loop
      select id into snacks from account where book_id = b.id and kind = 'category' and parent_id = food and lower(name) = 'snacks';
      if snacks is null then update account set name = 'Snacks' where id = x.id;
      else perform pg_temp.fold_category(x.id, snacks);
      end if;
    end loop;

    -- 4. Any other coffee/café expense category folds into Coffee (top-level ones with their children).
    for x in
      select a.id, a.name, a.parent_id from account a
      where a.book_id = b.id and a.kind = 'category' and a.class = 'expense' and a.id <> coffee
        and a.parent_id is distinct from coffee and a.name ~* '(coffee|\mcaf(e|é)s?\M)'
      order by a.parent_id nulls first
    loop
      continue when not exists (select 1 from account where id = x.id);   -- already folded with its parent
      s := case when x.name ~* 'bean' then 'Beans' when x.name ~* '(equip|machine|grinder|gear)' then 'Equipment' else 'Orders' end;
      select id into tgt from account where book_id = b.id and parent_id = coffee and name = s;
      for c in select id from account where parent_id = x.id loop
        perform pg_temp.fold_category(c.id, tgt);
      end loop;
      perform pg_temp.fold_category(x.id, tgt);
    end loop;
  end loop;
end $$;
