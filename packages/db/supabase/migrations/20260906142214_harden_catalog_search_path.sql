-- Apply the hardened path to existing installations as well as fresh databases.
alter function public.promote_game(uuid, uuid, uuid, integer) set search_path = public, pg_temp;
