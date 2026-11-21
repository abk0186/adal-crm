-- 006: публичная форма заявки (zayavka.html) без входа.
-- anon вызывает ТОЛЬКО public.crm_public_lead(...). Чтения данных у anon по-прежнему нет.
-- Функция возвращает только {"ok":true} или ошибку; не сообщает, есть ли уже такой контакт.
-- Применяется двумя шагами: новые значения enum должны быть закоммичены до использования.

-- ---------- Шаг 1: источники Instagram / TikTok ----------
alter type crm.lead_source add value if not exists 'Instagram';
alter type crm.lead_source add value if not exists 'TikTok';

-- ---------- Шаг 2: журнал для лимитов + функция ----------
-- Журнал принятых заявок с формы (для лимитов). RLS включён, политик и грантов нет → доступ только у владельца.
create table if not exists crm.public_lead_log (
  id bigint generated always as identity primary key,
  phone text not null,
  src text,
  created_at timestamptz not null default now()
);
alter table crm.public_lead_log enable row level security;
revoke all on crm.public_lead_log from public, anon, authenticated;
create index if not exists public_lead_log_phone_idx on crm.public_lead_log(phone, created_at desc);
create index if not exists public_lead_log_created_idx on crm.public_lead_log(created_at);

create or replace function public.crm_public_lead(
  p_name text,
  p_phone text,
  p_comment text default null,
  p_src text default null,
  p_hp text default null,          -- поле-ловушка: у людей всегда пустое
  p_elapsed_ms integer default null -- сколько мс форма была открыта до отправки
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_min_ms constant integer := 3000;  -- быстрее 3 с — бот
  c_per_phone_day constant integer := 3;
  c_global_hour constant integer := 30;
  v_name text := btrim(regexp_replace(coalesce(p_name,''), '[[:cntrl:]]+', ' ', 'g'));
  v_comment text := btrim(regexp_replace(coalesce(p_comment,''), '[\x00-\x08\x0B-\x1F\x7F]+', ' ', 'g'));
  v_phone text := crm.normalize_phone(left(coalesce(p_phone,''), 40));
  v_src text := lower(btrim(coalesce(p_src,'')));
  v_source crm.lead_source;
  v_res jsonb;
begin
  -- антиспам: ловушка или слишком быстрое заполнение → тихо «ok», ничего не пишем
  if nullif(btrim(coalesce(p_hp,'')),'') is not null then return jsonb_build_object('ok', true); end if;
  if p_elapsed_ms is null or p_elapsed_ms < c_min_ms then return jsonb_build_object('ok', true); end if;

  -- валидация
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if v_phone is null or v_phone ~ '^\+7(\d)\1{9}$' or substr(v_phone,3,1) in ('0','1','2') then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if length(v_comment) > 1000 then
    raise exception 'invalid_comment' using errcode = '22023';
  end if;

  v_source := case
    when v_src in ('instagram','ig','insta') then 'Instagram'::crm.lead_source
    when v_src in ('tiktok','tt') then 'TikTok'::crm.lead_source
    else 'Сайт'::crm.lead_source end;

  -- глобальный лимит (защита от заливки): сообщаем, чтобы человек позвонил/написал
  perform pg_advisory_xact_lock(hashtext('crm_public_lead'));
  if (select count(*) from crm.public_lead_log where created_at > now() - interval '1 hour') >= c_global_hour then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  -- лимит на номер: тихо «ok», без записи (не раскрываем, что номер уже был)
  if (select count(*) from crm.public_lead_log where phone = v_phone and created_at > now() - interval '24 hours') >= c_per_phone_day then
    return jsonb_build_object('ok', true);
  end if;

  -- та же дедуп-логика, что у crm.ingest_lead: контакт по телефону, открытая сделка «Погрузчики» или новая
  v_res := crm._upsert_lead(v_phone, v_name, v_source,
             'Форма заявки на сайте' || coalesce('. Комментарий: ' || nullif(v_comment,''), ''),
             null::uuid, 1::smallint, null::text);

  -- новая сделка получает задачу «Связаться» на сегодня триггером deals_after;
  -- повтор в открытую сделку — задача на сегодня, если открытой задачи нет
  if not (v_res->>'new_deal')::boolean then
    if not exists (select 1 from crm.tasks t where t.deal_id = (v_res->>'deal_id')::uuid and not t.done) then
      insert into crm.tasks(deal_id, title, due_at, assignee, auto, created_by)
      select d.id, 'Перезвонить: повторная заявка с формы', crm.end_of_today(), d.responsible, true, null
        from crm.deals d where d.id = (v_res->>'deal_id')::uuid;
    end if;
  end if;

  insert into crm.public_lead_log(phone, src) values (v_phone, v_source::text);
  delete from crm.public_lead_log where created_at < now() - interval '30 days';

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.crm_public_lead(text,text,text,text,text,integer) from public;
grant execute on function public.crm_public_lead(text,text,text,text,text,integer) to anon, authenticated;
