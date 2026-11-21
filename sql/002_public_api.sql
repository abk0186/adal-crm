-- Тонкий API для браузера в public: view с security_invoker (RLS таблиц crm действует)
-- и RPC с security invoker. anon — без доступа.

create or replace view public.crm_contacts with (security_invoker = true) as select * from crm.contacts;
create or replace view public.crm_deals    with (security_invoker = true) as select * from crm.deals;
create or replace view public.crm_touches  with (security_invoker = true) as select * from crm.touches;
create or replace view public.crm_tasks    with (security_invoker = true) as select * from crm.tasks;
create or replace view public.crm_team     with (security_invoker = true) as
  select user_id, email, full_name, role, active from crm.team_members;
create or replace view public.crm_directions with (security_invoker = true) as select * from crm.directions;

-- Сделки с контактом и счётчиками — для канбана/списка
create or replace view public.crm_deals_full with (security_invoker = true) as
select d.*, c.phone, c.name as contact_name, c.city as contact_city,
       dir.name as direction_name, tm.full_name as responsible_name, tm.email as responsible_email,
       (select count(*) from crm.tasks t where t.deal_id = d.id and not t.done) as open_tasks,
       (select min(t.due_at) from crm.tasks t where t.deal_id = d.id and not t.done) as next_due,
       (select max(x.created_at) from crm.touches x where x.deal_id = d.id) as last_touch_at
from crm.deals d
join crm.contacts c on c.id = d.contact_id
join crm.directions dir on dir.id = d.direction_id
left join crm.team_members tm on tm.user_id = d.responsible;

create or replace view public.crm_tasks_full with (security_invoker = true) as
select t.*, d.stage, d.contact_id, c.phone, c.name as contact_name, d.direction_id,
       tm.full_name as assignee_name
from crm.tasks t
join crm.deals d on d.id = t.deal_id
join crm.contacts c on c.id = d.contact_id
left join crm.team_members tm on tm.user_id = t.assignee;

revoke all on public.crm_contacts, public.crm_deals, public.crm_touches, public.crm_tasks,
  public.crm_team, public.crm_directions, public.crm_deals_full, public.crm_tasks_full from public, anon;
grant select, insert, update, delete on public.crm_contacts, public.crm_deals, public.crm_touches, public.crm_tasks to authenticated;
grant select on public.crm_team, public.crm_directions, public.crm_deals_full, public.crm_tasks_full to authenticated;

-- «+ Лид» из приложения: та же дедуп-логика, что и у ingest_lead
create or replace function public.crm_create_lead(
  p_phone text, p_name text default null, p_source text default 'Другое', p_text text default null,
  p_direction smallint default 1, p_city text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not crm.is_member() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  return crm._upsert_lead(p_phone, p_name, coalesce(nullif(p_source,''),'Другое')::crm.lead_source,
                          p_text, auth.uid(), p_direction, p_city);
end $$;

-- Проверка номера перед созданием (подсказка «контакт уже есть»)
create or replace function public.crm_find_contact(p_phone text)
returns table(contact_id uuid, phone text, name text, city text, open_deal_id uuid, open_stage text)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.phone, c.name, c.city, d.id, d.stage::text
  from crm.contacts c
  left join lateral (select id, stage from crm.deals x where x.contact_id = c.id and x.stage not in ('Успешно','Отказ')
                     order by created_at desc limit 1) d on true
  where crm.is_member() and c.phone = crm.normalize_phone(p_phone);
$$;

revoke all on function public.crm_create_lead(text,text,text,text,smallint,text), public.crm_find_contact(text) from public, anon;
grant execute on function public.crm_create_lead(text,text,text,text,smallint,text), public.crm_find_contact(text) to authenticated;
-- invoker-функции вызывают внутренние crm-функции → authenticated нужен execute на них
grant execute on function crm._upsert_lead(text,text,crm.lead_source,text,uuid,smallint,text) to authenticated;
