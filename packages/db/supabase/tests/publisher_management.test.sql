begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select plan(18);
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111191'),('11111111-1111-4111-8111-111111111192');
insert into public.publishers(id,handle,display_name) values
 ('11111111-1111-4111-8111-111111111191','management-owner','Owner'),
 ('11111111-1111-4111-8111-111111111192','management-other','Other');
insert into public.games(id,publisher_id,slug) values
 ('22222222-2222-4222-8222-222222222291','11111111-1111-4111-8111-111111111191','managed-game'),
 ('22222222-2222-4222-8222-222222222292','11111111-1111-4111-8111-111111111192','other-game');
insert into public.releases(id,game_id,request_key,digest,listing,status,base_generation) values
 ('33333333-3333-4333-8333-333333333391','22222222-2222-4222-8222-222222222291','44444444-4444-4444-8444-444444444491',repeat('a',64),'{"title":"Game","slug":"managed-game","description":"Original","controls":"Arrows","coverPath":null}','ready',0),
 ('33333333-3333-4333-8333-333333333392','22222222-2222-4222-8222-222222222291','44444444-4444-4444-8444-444444444492',repeat('b',64),'{"title":"Game","slug":"managed-game","description":"Second","controls":"WASD","coverPath":null}','ready',0);
select public.promote_game('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291','33333333-3333-4333-8333-333333333391',0);
select is(public.catalog_games()->0->'listing'->>'description','Original','Existing games use the release listing');
select throws_ok($$select public.update_game_listing('11111111-1111-4111-8111-111111111192','22222222-2222-4222-8222-222222222291',1,'Wrong','',null)$$,'P0001','Publisher does not own this game','Another publisher cannot edit');
select throws_ok($$select public.update_game_listing('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291',0,'Stale','',null)$$,'P0001','Game changed; refresh before saving','Stale edits are rejected');
select public.update_game_listing('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291',1,'Edited','Space',repeat('c',64));
select is(public.catalog_games()->0->'listing'->>'description','Edited','Public description reflects the edit');
select is(public.catalog_games()->0->'listing'->>'controls','Space','Public controls reflect the edit');
select is(public.catalog_games()->0->>'cover_key',repeat('c',64),'Public artwork uses a separate cover key');
select is((select current_release_id::text from public.games where slug='managed-game'),'33333333-3333-4333-8333-333333333391','Metadata save preserves the playable release');
select is((select listing->>'description' from public.releases where id='33333333-3333-4333-8333-333333333391'),'Original','Saved release metadata remains immutable');
select is((select digest from public.releases where id='33333333-3333-4333-8333-333333333391'),repeat('a',64),'Artifact digest remains immutable');
select public.promote_game('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291','33333333-3333-4333-8333-333333333392',2);
select is(public.catalog_games()->0->'listing'->>'description','Edited','Overrides survive a newer release');
select public.promote_game('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291','33333333-3333-4333-8333-333333333391',3);
select is(public.catalog_games()->0->'listing'->>'controls','Space','Overrides survive rollback');
select public.update_game_listing('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291',4,'','',null);
select is(public.catalog_games()->0->'listing'->>'description','','Description can be cleared');
select is(public.catalog_games()->0->>'cover_key',repeat('c',64),'A text-only edit preserves the cover');
select public.promote_game('11111111-1111-4111-8111-111111111191','22222222-2222-4222-8222-222222222291',null,5);
select is(jsonb_array_length(public.catalog_games()),0,'Unpublished games disappear from public browsing');
select is(jsonb_array_length(public.publisher_studio('11111111-1111-4111-8111-111111111191')->'games'),1,'My games retains unpublished games and excludes other owners');
select is(jsonb_array_length(public.publisher_studio('11111111-1111-4111-8111-111111111191')->'releases'),2,'My games retains saved releases');
select ok(not has_function_privilege('anon','public.update_game_listing(uuid,uuid,integer,text,text,text)','execute'),'Anon cannot edit listings');
select ok(not has_function_privilege('authenticated','public.update_game_listing(uuid,uuid,integer,text,text,text)','execute'),'Clients cannot impersonate the server RPC');
select * from finish();
rollback;
