begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(13);

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('11111111-1111-4111-8111-111111111101','legacy@example.com',now(),'{}'),
 ('11111111-1111-4111-8111-111111111102','new@challenger.gauntletai.com',null,'{}'),
 ('11111111-1111-4111-8111-111111111103','new@challenger.gauntletai.com.evil.test',now(),'{}'),
 ('11111111-1111-4111-8111-111111111104','new@sub.challenger.gauntletai.com',now(),'{}'),
 ('11111111-1111-4111-8111-111111111105','new@gauntletai.com',now(),'{}'),
 ('11111111-1111-4111-8111-111111111106','NEW@CHALLENGER.GAUNTLETAI.COM',now(),'{"publisher_name":"Challenger developer"}');
insert into public.publishers(id,handle,display_name) values
 ('11111111-1111-4111-8111-111111111101','domain-test-legacy','Existing developer');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111101')->>'display_name','Existing developer','Existing provisioned accounts retain access');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111102'),null::jsonb,'Unverified email cannot enroll');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111103'),null::jsonb,'Suffix spoof is denied');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111104'),null::jsonb,'Subdomain is denied');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111105'),null::jsonb,'Parent domain is denied');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111106')->>'display_name','Challenger developer','Verified exact domain enrolls case-insensitively');
select ok((select email_domain_access from public.publishers where id='11111111-1111-4111-8111-111111111106'),'Enrollment records domain-based access');
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111106')->>'handle','challenger-11111111111141118111111111111106','Repeated enrollment preserves identity');
update public.publishers set enabled=false where id='11111111-1111-4111-8111-111111111106';
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111106'),null::jsonb,'Disabled publisher is never re-enabled by sign-in');
update public.publishers set enabled=true where id='11111111-1111-4111-8111-111111111106';
update auth.users set email='changed@example.com' where id='11111111-1111-4111-8111-111111111106';
select is(public.publisher_for_user('11111111-1111-4111-8111-111111111106'),null::jsonb,'Domain eligibility is rechecked after an email change');
select ok(not has_function_privilege('anon','public.publisher_for_user(uuid)','execute'),'Anonymous callers cannot enroll another identity');
select ok(not has_function_privilege('authenticated','public.publisher_for_user(uuid)','execute'),'Authenticated clients cannot call the administrative RPC');
select ok(has_function_privilege('service_role','public.publisher_for_user(uuid)','execute'),'Server can resolve publisher eligibility');
select * from finish();
rollback;
