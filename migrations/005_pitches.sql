-- Pitch für Top-Leads (ARCHITECTURE.md 5.2 Schritt 10): Hauptchance und drei Argumente, erzeugt von der Rolle "pitch".
create table pitches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  lead_score_id uuid references lead_scores (id) on delete set null,
  agent_run_id uuid references agent_runs (id) on delete set null,
  prompt_version text not null,
  model text not null,
  main_opportunity text not null,
  arguments jsonb not null,
  opening_line text,
  created_at timestamptz not null default now()
);
create index pitches_company on pitches (company_id, created_at desc);
alter table pitches enable row level security;

create index lead_scores_latest on lead_scores (company_id, created_at desc) where knocked_out = false;
