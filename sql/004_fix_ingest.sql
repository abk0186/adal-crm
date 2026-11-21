-- ingest_lead: явные типы аргументов
create or replace function crm.ingest_lead(phone text, name text, source text, text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return crm._upsert_lead(phone, name, coalesce(nullif(source,''),'Другое')::crm.lead_source, text, null::uuid, 1::smallint, null::text);
end $$;
revoke all on function crm.ingest_lead(text,text,text,text) from public, anon, authenticated;
grant execute on function crm.ingest_lead(text,text,text,text) to service_role;
