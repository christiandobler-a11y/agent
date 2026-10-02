-- Kosten externer APIs ohne LLM (z. B. Google Places) und eine gemeinsame Kostenansicht (ARCHITECTURE.md 9, 11.1).
-- LLM-Aufrufe stehen weiter in agent_runs; der Budget-Wächter summiert beide Tabellen.

create table api_usage (
  id uuid primary key default gen_random_uuid(),
  service text not null,                    -- z. B. 'places'
  operation text not null,                  -- z. B. 'searchText'
  search_run_id uuid references search_runs (id) on delete set null,
  company_id uuid references companies (id) on delete set null,
  cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now()
);
create index api_usage_created on api_usage (created_at);
alter table api_usage enable row level security;

-- Kosten je Tag (deutsche Zeit), Quelle und Rolle bzw. Dienst. security_invoker: die Ansicht prüft die Rechte
-- des Aufrufers, damit sie über die Supabase-Data-API nicht mehr zeigt als die Tabellen selbst.
create view v_costs_daily with (security_invoker = true) as
select (started_at at time zone 'Europe/Berlin')::date as day,
       'llm'::text as source,
       role as name,
       count(*)::int as calls,
       count(*) filter (where status = 'ERROR')::int as errors,
       sum(cost_usd)::numeric(12, 5) as cost_usd
  from agent_runs
 group by 1, 3
union all
select (created_at at time zone 'Europe/Berlin')::date,
       'api',
       service,
       count(*)::int,
       0,
       sum(cost_usd)::numeric(12, 5)
  from api_usage
 group by 1, 3;
