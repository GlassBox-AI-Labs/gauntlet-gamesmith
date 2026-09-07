-- Use neutral public identities for new publishers. Existing handles and access
-- remain unchanged so profile URLs and publication ownership stay stable.
create or replace function public.publisher_for_user(actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.publishers; u auth.users; eligible boolean;
begin
  select * into u from auth.users where id = actor;
  if not found then return null; end if;
  eligible := u.email_confirmed_at is not null
    and lower(coalesce(u.email, '')) ~ '^[^@[:space:]]+@challenger\.gauntletai\.com$';
  select * into p from public.publishers where id = actor;
  if not found then
    if not eligible then return null; end if;
    insert into public.publishers(id, handle, display_name, email_domain_access)
      values(actor, 'creator-' || replace(actor::text, '-', ''),
        coalesce(nullif(left(btrim(u.raw_user_meta_data->>'publisher_name'), 80), ''), 'Game creator'), true)
      on conflict(id) do nothing;
    select * into p from public.publishers where id = actor;
  end if;
  if not p.enabled or (p.email_domain_access and not eligible) then return null; end if;
  return jsonb_build_object('id',p.id,'handle',p.handle,'display_name',p.display_name);
end $$;
revoke all on function public.publisher_for_user(uuid) from public, anon, authenticated;
grant execute on function public.publisher_for_user(uuid) to service_role;
