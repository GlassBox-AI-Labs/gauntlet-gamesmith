


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."releases" (
    "id" "uuid" NOT NULL,
    "game_id" "uuid" NOT NULL,
    "request_key" "uuid" NOT NULL,
    "digest" "text" NOT NULL,
    "listing" "jsonb" NOT NULL,
    "base_generation" integer NOT NULL,
    "status" "text" DEFAULT 'uploading'::"text" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "jsonb",
    CONSTRAINT "releases_digest_check" CHECK (("digest" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "releases_status_check" CHECK (("status" = ANY (ARRAY['uploading'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."releases" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."begin_release"("actor" "uuid", "target_game" "uuid", "retry_key" "uuid", "artifact_digest" "text", "metadata" "jsonb", "provenance" "jsonb") RETURNS "public"."releases"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
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
end $_$;


ALTER FUNCTION "public"."begin_release"("actor" "uuid", "target_game" "uuid", "retry_key" "uuid", "artifact_digest" "text", "metadata" "jsonb", "provenance" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."catalog_games"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(jsonb_agg(entry order by created_at desc),'[]'::jsonb) from (
    select g.created_at, jsonb_build_object('id',g.id,'slug',g.slug,'current_release_id',g.current_release_id,
      'listing',r.listing,'publisher',jsonb_build_object('handle',p.handle,'display_name',p.display_name)) entry
    from public.games g join public.releases r on r.id=g.current_release_id and r.game_id=g.id
    join public.publishers p on p.id=g.publisher_id where r.status='ready' and p.enabled order by g.created_at desc limit 100
  ) rows;
$$;


ALTER FUNCTION "public"."catalog_games"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_desktop_connection"("connection_code" "text", "connection_challenge" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare c public.desktop_connections;
begin
  select * into c from public.desktop_connections where code=connection_code and challenge=connection_challenge and expires_at>now() for update;
  if not found then raise exception 'Connection expired'; end if;
  if c.sealed_session is null then return null; end if;
  delete from public.desktop_connections where code=c.code;
  return c.sealed_session;
end $$;


ALTER FUNCTION "public"."consume_desktop_connection"("connection_code" "text", "connection_challenge" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."games" (
    "id" "uuid" NOT NULL,
    "publisher_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "current_release_id" "uuid",
    "generation" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "games_slug_check" CHECK ((("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::"text") AND ("length"("slug") <= 64)))
);


ALTER TABLE "public"."games" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promote_game"("actor" "uuid", "target_game" "uuid", "target_release" "uuid", "expected_generation" integer) RETURNS "public"."games"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."promote_game"("actor" "uuid", "target_game" "uuid", "target_release" "uuid", "expected_generation" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publisher_studio"("actor" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select jsonb_build_object('publisher',to_jsonb(p),
    'games',coalesce((select jsonb_agg(g order by g.created_at desc) from public.games g where g.publisher_id=p.id),'[]'::jsonb),
    'releases',coalesce((select jsonb_agg(r order by r.created_at desc) from public.releases r join public.games g on r.game_id=g.id where g.publisher_id=p.id),'[]'::jsonb))
    from public.publishers p where p.id=actor and p.enabled;
$$;


ALTER FUNCTION "public"."publisher_studio"("actor" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_desktop_connection"("connection_code" "text", "connection_challenge" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform pg_advisory_xact_lock(73125001);
  delete from public.desktop_connections where expires_at < now();
  if (select count(*) from public.desktop_connections) >= 100 then raise exception 'Too many pending connections'; end if;
  insert into public.desktop_connections(code,challenge,expires_at) values(connection_code,connection_challenge,now()+interval '5 minutes');
end $$;


ALTER FUNCTION "public"."start_desktop_connection"("connection_code" "text", "connection_challenge" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."desktop_connections" (
    "code" "text" NOT NULL,
    "challenge" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "sealed_session" "text",
    "approved_by" "uuid",
    CONSTRAINT "desktop_connections_challenge_check" CHECK (("challenge" ~ '^[a-f0-9]{64}$'::"text"))
);


ALTER TABLE "public"."desktop_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."publication_events" (
    "id" bigint NOT NULL,
    "game_id" "uuid" NOT NULL,
    "release_id" "uuid",
    "kind" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."publication_events" OWNER TO "postgres";


ALTER TABLE "public"."publication_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."publication_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."publishers" (
    "id" "uuid" NOT NULL,
    "handle" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    CONSTRAINT "publishers_display_name_check" CHECK ((("length"("display_name") >= 1) AND ("length"("display_name") <= 80))),
    CONSTRAINT "publishers_handle_check" CHECK ((("handle" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::"text") AND ("length"("handle") <= 64)))
);


ALTER TABLE "public"."publishers" OWNER TO "postgres";


ALTER TABLE ONLY "public"."desktop_connections"
    ADD CONSTRAINT "desktop_connections_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."publication_events"
    ADD CONSTRAINT "publication_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."publishers"
    ADD CONSTRAINT "publishers_handle_key" UNIQUE ("handle");



ALTER TABLE ONLY "public"."publishers"
    ADD CONSTRAINT "publishers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."releases"
    ADD CONSTRAINT "releases_game_id_id_key" UNIQUE ("game_id", "id");



ALTER TABLE ONLY "public"."releases"
    ADD CONSTRAINT "releases_game_id_request_key_key" UNIQUE ("game_id", "request_key");



ALTER TABLE ONLY "public"."releases"
    ADD CONSTRAINT "releases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "current_release_belongs_to_game" FOREIGN KEY ("id", "current_release_id") REFERENCES "public"."releases"("game_id", "id");



ALTER TABLE ONLY "public"."desktop_connections"
    ADD CONSTRAINT "desktop_connections_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."publishers"("id");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id");



ALTER TABLE ONLY "public"."publication_events"
    ADD CONSTRAINT "publication_events_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id");



ALTER TABLE ONLY "public"."publication_events"
    ADD CONSTRAINT "publication_events_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id");



ALTER TABLE ONLY "public"."publishers"
    ADD CONSTRAINT "publishers_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."releases"
    ADD CONSTRAINT "releases_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id");



ALTER TABLE "public"."desktop_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."games" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."publication_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."publishers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."releases" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";































































































































































GRANT ALL ON TABLE "public"."releases" TO "service_role";



REVOKE ALL ON FUNCTION "public"."begin_release"("actor" "uuid", "target_game" "uuid", "retry_key" "uuid", "artifact_digest" "text", "metadata" "jsonb", "provenance" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."begin_release"("actor" "uuid", "target_game" "uuid", "retry_key" "uuid", "artifact_digest" "text", "metadata" "jsonb", "provenance" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."catalog_games"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."catalog_games"() TO "anon";
GRANT ALL ON FUNCTION "public"."catalog_games"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."catalog_games"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_desktop_connection"("connection_code" "text", "connection_challenge" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_desktop_connection"("connection_code" "text", "connection_challenge" "text") TO "service_role";



GRANT ALL ON TABLE "public"."games" TO "service_role";



REVOKE ALL ON FUNCTION "public"."promote_game"("actor" "uuid", "target_game" "uuid", "target_release" "uuid", "expected_generation" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promote_game"("actor" "uuid", "target_game" "uuid", "target_release" "uuid", "expected_generation" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."publisher_studio"("actor" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publisher_studio"("actor" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_desktop_connection"("connection_code" "text", "connection_challenge" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_desktop_connection"("connection_code" "text", "connection_challenge" "text") TO "service_role";


















GRANT ALL ON TABLE "public"."desktop_connections" TO "service_role";



GRANT ALL ON TABLE "public"."publication_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."publication_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."publication_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."publication_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."publishers" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
