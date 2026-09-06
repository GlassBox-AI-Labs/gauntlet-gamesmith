-- The HTTP publishing module is the only mutation surface. Supabase Auth owns identity.
create table public.publishers (
  id uuid primary key references auth.users(id),
  handle text not null unique check (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(handle) <= 64),
  display_name text not null check (length(display_name) between 1 and 80),
  enabled boolean not null default true
);
create table public.games (
  id uuid primary key,
  publisher_id uuid not null references public.publishers(id),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 64),
  current_release_id uuid,
  generation integer not null default 0,
  created_at timestamptz not null default now()
);
create table public.releases (
  id uuid primary key,
  game_id uuid not null references public.games(id),
  request_key uuid not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  listing jsonb not null,
  base_generation integer not null,
  status text not null default 'uploading' check (status in ('uploading','ready','failed')),
  error text,
  created_at timestamptz not null default now(),
  unique(game_id, request_key),
  unique(game_id, id)
);
alter table public.games add constraint current_release_belongs_to_game
  foreign key (id, current_release_id) references public.releases(game_id, id);
create table public.publication_events (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id),
  release_id uuid references public.releases(id),
  kind text not null,
  created_at timestamptz not null default now()
);
alter table public.publishers enable row level security;
alter table public.games enable row level security;
alter table public.releases enable row level security;
alter table public.publication_events enable row level security;
revoke all on public.publishers, public.games, public.releases, public.publication_events from anon, authenticated;
grant all on public.publishers, public.games, public.releases, public.publication_events to service_role;

create function public.promote_game(actor uuid, target_game uuid, target_release uuid, expected_generation integer)
returns public.games language plpgsql set search_path = public as $$
declare g public.games;
begin
  select * into g from public.games where id = target_game for update;
  if not found or g.publisher_id <> actor or not exists(select 1 from public.publishers where id=actor and enabled)
    then raise exception 'Publisher does not own this game'; end if;
  if g.generation <> expected_generation then raise exception 'Game changed; refresh before publishing'; end if;
  if target_release is not null and not exists(select 1 from public.releases where id=target_release and game_id=g.id and status='ready')
    then raise exception 'Release is not ready'; end if;
  update public.games set current_release_id=target_release, generation=generation+1 where id=g.id returning * into g;
  insert into public.publication_events(game_id,release_id,kind) values(g.id,target_release,case when target_release is null then 'unpublished' else 'published' end);
  return g;
end $$;
revoke execute on function public.promote_game(uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.promote_game(uuid,uuid,uuid,integer) to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('game-artifacts','game-artifacts',false,36700160,array['application/json']) on conflict(id) do nothing;
