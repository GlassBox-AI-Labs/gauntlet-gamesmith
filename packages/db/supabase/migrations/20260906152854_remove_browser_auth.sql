-- Retire only the obsolete, short-lived browser handoff state.
drop function if exists public.start_desktop_connection(text, text);
drop function if exists public.consume_desktop_connection(text, text);
drop table if exists public.desktop_connections;
