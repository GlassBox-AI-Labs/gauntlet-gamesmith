-- Round 0 identifies a live-workspace publication snapshot. Positive rounds
-- remain saved implement revisions. UUID and revision checks are unchanged.
create or replace function public.begin_release(actor uuid, target_game uuid, retry_key uuid, artifact_digest text, metadata jsonb, provenance jsonb)
returns public.releases language plpgsql set search_path = 'public', 'pg_temp' as $$
declare g public.games; r public.releases;
begin
  if not exists(select 1 from public.publishers where id=actor and enabled) then raise exception 'Publisher account required'; end if;
  if provenance is null or provenance->>'loopId' is null or provenance->>'runId' is null
    or provenance->>'round' is null or coalesce((provenance->>'round')::integer, -1) < 0
    or coalesce(provenance->>'revision','') !~ '^[a-f0-9]{40,64}$'
    then raise exception 'Publication provenance required'; end if;
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
