-- Автозакрытие задач: при уходе с этапа «Новая заявка» закрывается авто-задача «Связаться»;
-- при «Успешно»/«Отказ» закрываются все открытые задачи сделки.
create or replace function crm.tg_deals_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into crm.tasks(deal_id, title, due_at, assignee, auto, created_by)
    values (new.id, 'Связаться', crm.end_of_today(), new.responsible, true, new.created_by);
  elsif new.stage is distinct from old.stage then
    insert into crm.touches(contact_id, deal_id, kind, body, created_by)
    values (new.contact_id, new.id, 'system',
            'Этап: ' || old.stage || ' → ' || new.stage ||
            case when new.stage = 'Отказ' then ' (причина: ' || new.lost_reason || ')' else '' end,
            auth.uid());
    if old.stage = 'Новая заявка' then
      update crm.tasks set done = true where deal_id = new.id and auto and title = 'Связаться' and not done;
    end if;
    if new.stage in ('Успешно','Отказ') then
      update crm.tasks set done = true where deal_id = new.id and not done;
    elsif new.stage = 'КП отправлено' then
      insert into crm.tasks(deal_id, title, due_at, assignee, auto, created_by)
      values (new.id, 'Переспросить по КП', now() + interval '2 days', new.responsible, true, auth.uid());
    elsif new.stage = 'Счёт/договор' then
      insert into crm.tasks(deal_id, title, due_at, assignee, auto, created_by)
      values (new.id, 'Проверить оплату', now() + interval '3 days', new.responsible, true, auth.uid());
    end if;
  end if;
  return null;
end $$;
revoke all on function crm.tg_deals_after() from public, anon, authenticated;
