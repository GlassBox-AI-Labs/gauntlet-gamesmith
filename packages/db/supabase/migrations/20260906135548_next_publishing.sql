-- Saved-round provenance is mandatory for every new desktop publication.
alter table public.releases add column if not exists source jsonb;
create table if not exists public.desktop_connections (
  code text primary key,
  challenge text not null check (challenge ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  sealed_session text,
  approved_by uuid references public.publishers(id)
);
alter table public.desktop_connections enable row level security;
revoke all on public.desktop_connections from public, anon, authenticated;
grant all on public.desktop_connections to service_role;

create or replace function public.begin_release(actor uuid, target_game uuid, retry_key uuid, artifact_digest text, metadata jsonb, provenance jsonb)
returns public.releases language plpgsql set search_path = 'public', 'pg_temp' as $$
declare g public.games; r public.releases;
begin
  if not exists(select 1 from public.publishers where id=actor and enabled) then raise exception 'Publisher account required'; end if;
  if provenance is null or provenance->>'loopId' is null or provenance->>'runId' is null
    or coalesce((provenance->>'round')::integer,0) < 1 or coalesce(provenance->>'revision','') !~ '^[a-f0-9]{40,64}$'
    then raise exception 'Saved round provenance required'; end if;
  perform (provenance->>'loopId')::uuid, (provenance->>'runId')::uuid;
  insert into public.games(id,publisher_id,slug) values(target_game,actor,metadata->>'slug') on conflict(id) do nothing;
  select * into g from public.games where id=target_game for update;
  if g.publisher_id <> actor or g.slug <> metadata->>'slug' then raise exception 'Game ownership or slug mismatch'; end if;
  select * into r from public.releases where game_id=g.id and request_key=retry_key;
  if found then
    if r.digest <> artifact_digest or r.listing <> metadata or r.source is distinct from provenance then raise exception 'Retry key belongs to another build'; end if;
    return r;
  end if;
  insert into public.releases(id,game_id,request_key,digest,listing,source,base_generation)
    values(gen_random_uuid(),g.id,retry_key,artifact_digest,metadata,provenance,g.generation) returning * into r;
  return r;
end $$;
revoke all on function public.begin_release(uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.begin_release(uuid,uuid,uuid,text,jsonb,jsonb) to service_role;

create or replace function public.catalog_games() returns jsonb language sql stable security definer set search_path = 'public', 'pg_temp' as $$
  select coalesce(jsonb_agg(entry order by created_at desc),'[]'::jsonb) from (
    select g.created_at, jsonb_build_object('id',g.id,'slug',g.slug,'current_release_id',g.current_release_id,
      'listing',r.listing,'publisher',jsonb_build_object('handle',p.handle,'display_name',p.display_name)) entry
    from public.games g join public.releases r on r.id=g.current_release_id and r.game_id=g.id
    join public.publishers p on p.id=g.publisher_id where r.status='ready' and p.enabled order by g.created_at desc limit 100
  ) rows;
$$;
revoke all on function public.catalog_games() from public;
grant execute on function public.catalog_games() to anon,authenticated,service_role;

create or replace function public.publisher_studio(actor uuid) returns jsonb language sql stable set search_path = 'public', 'pg_temp' as $$
  select jsonb_build_object('publisher',to_jsonb(p),
    'games',coalesce((select jsonb_agg(g order by g.created_at desc) from public.games g where g.publisher_id=p.id),'[]'::jsonb),
    'releases',coalesce((select jsonb_agg(r order by r.created_at desc) from public.releases r join public.games g on r.game_id=g.id where g.publisher_id=p.id),'[]'::jsonb))
    from public.publishers p where p.id=actor and p.enabled;
$$;
revoke all on function public.publisher_studio(uuid) from public,anon,authenticated;
grant execute on function public.publisher_studio(uuid) to service_role;

create or replace function public.start_desktop_connection(connection_code text, connection_challenge text) returns void language plpgsql set search_path = 'public', 'pg_temp' as $$
begin
  perform pg_advisory_xact_lock(73125001);
  delete from public.desktop_connections where expires_at < now();
  if (select count(*) from public.desktop_connections) >= 100 then raise exception 'Too many pending connections'; end if;
  insert into public.desktop_connections(code,challenge,expires_at) values(connection_code,connection_challenge,now()+interval '5 minutes');
end $$;
create or replace function public.consume_desktop_connection(connection_code text, connection_challenge text) returns text language plpgsql set search_path = 'public', 'pg_temp' as $$
declare c public.desktop_connections;
begin
  select * into c from public.desktop_connections where code=connection_code and challenge=connection_challenge and expires_at>now() for update;
  if not found then raise exception 'Connection expired'; end if;
  if c.sealed_session is null then return null; end if;
  delete from public.desktop_connections where code=c.code;
  return c.sealed_session;
end $$;
revoke all on function public.start_desktop_connection(text,text),public.consume_desktop_connection(text,text) from public,anon,authenticated;
grant execute on function public.start_desktop_connection(text,text),public.consume_desktop_connection(text,text) to service_role;
