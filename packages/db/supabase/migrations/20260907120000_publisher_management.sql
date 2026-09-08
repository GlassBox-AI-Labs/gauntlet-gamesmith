-- Listing overrides belong to the game; playable releases remain immutable.
alter table public.games add column if not exists description_override text;
alter table public.games add column if not exists controls_override text;
alter table public.games add column if not exists cover_key text;

create or replace function public.update_game_listing(actor uuid, target_game uuid,
  expected_generation integer, description text, controls text, replacement_cover text default null)
returns public.games language plpgsql set search_path = public, pg_temp as $$
declare g public.games;
begin
  select * into g from public.games where id=target_game for update;
  if not found or g.publisher_id <> actor or not exists(select 1 from public.publishers where id=actor and enabled)
    then raise exception 'Publisher does not own this game'; end if;
  if g.generation <> expected_generation then raise exception 'Game changed; refresh before saving'; end if;
  if description is null or length(description)>2000 or controls is null or length(controls)>500
    then raise exception 'Invalid listing'; end if;
  if replacement_cover is not null and replacement_cover !~ '^[a-f0-9]{64}$' then raise exception 'Invalid cover'; end if;
  update public.games set description_override=description, controls_override=controls,
    cover_key=coalesce(replacement_cover,cover_key), generation=generation+1 where id=g.id returning * into g;
  return g;
end $$;
revoke all on function public.update_game_listing(uuid,uuid,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.update_game_listing(uuid,uuid,integer,text,text,text) to service_role;

create or replace function public.catalog_games() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(entry order by created_at desc),'[]'::jsonb) from (
    select g.created_at, jsonb_build_object('id',g.id,'slug',g.slug,'current_release_id',g.current_release_id,
      'cover_key',g.cover_key,
      'listing',r.listing || jsonb_strip_nulls(jsonb_build_object('description',g.description_override,'controls',g.controls_override)),
      'publisher',jsonb_build_object('handle',p.handle,'display_name',p.display_name)) entry
    from public.games g join public.releases r on r.id=g.current_release_id and r.game_id=g.id
    join public.publishers p on p.id=g.publisher_id where r.status='ready' and p.enabled order by g.created_at desc limit 100
  ) rows;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('game-covers','game-covers',false,3145728,array['image/png'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
