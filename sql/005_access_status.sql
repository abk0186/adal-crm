-- Самостоятельный первый вход / сброс пароля.
-- Для anon: по email отвечает, что делать клиенту: 'signup' | 'reset' | 'none'.
-- UI показывает одинаковое нейтральное сообщение во всех случаях.
create or replace function public.crm_access_status(p_email text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare e text := lower(btrim(coalesce(p_email,'')));
begin
  if e = '' or not exists (select 1 from crm.allowlist a where a.email = e) then return 'none'; end if;
  if exists (select 1 from auth.users u where lower(u.email) = e) then return 'reset'; end if;
  return 'signup';
end $$;
revoke all on function public.crm_access_status(text) from public;
grant execute on function public.crm_access_status(text) to anon, authenticated;

-- Если auth-пользователь уже был до добавления в allowlist — подхватить при добавлении в allowlist
create or replace function crm.on_allowlist_added() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into crm.team_members(user_id, email, full_name, role)
  select u.id, lower(u.email), new.full_name, new.role from auth.users u where lower(u.email) = new.email
  on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function crm.on_allowlist_added() from public, anon, authenticated;
drop trigger if exists allowlist_added on crm.allowlist;
create trigger allowlist_added after insert on crm.allowlist for each row execute function crm.on_allowlist_added();
