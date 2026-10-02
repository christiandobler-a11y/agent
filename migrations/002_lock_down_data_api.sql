-- Supabase stellt Tabellen im Schema "public" automatisch über die REST-API (Data API) bereit.
-- Die App greift nur direkt per Postgres zu. Deshalb:
--   1. Row Level Security auf allen Tabellen einschalten, ohne Policies: anon/authenticated sehen nichts.
--      Die App verbindet sich als Tabellen-Eigentümer und ist davon nicht betroffen.
--   2. Rechte der Supabase-Rollen anon/authenticated auf unsere Tabellen entziehen, auch für künftige
--      Tabellen. Auf normalem Postgres (lokal, Tests) gibt es diese Rollen nicht; dann passiert nur Schritt 1.
-- Neue Tabellen in späteren Migrationen brauchen ebenfalls "enable row level security".

do $$
declare
  t record;
  r text;
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = current_schema()::regnamespace and c.relkind = 'r'
  loop
    execute format('alter table %I enable row level security', t.relname);
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema %I from %I', current_schema(), r);
      execute format('revoke all on all sequences in schema %I from %I', current_schema(), r);
      execute format('alter default privileges in schema %I revoke all on tables from %I', current_schema(), r);
      execute format('alter default privileges in schema %I revoke all on sequences from %I', current_schema(), r);
    end if;
  end loop;
end
$$;
