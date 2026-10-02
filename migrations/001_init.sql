-- Avelio Lead Engine: Grundschema (ARCHITECTURE.md Abschnitt 9)
-- Schema-neutral geschrieben (keine "public."-Präfixe), damit Tests in eigenen Schemas laufen können.

create extension if not exists pg_trgm;

-- Betrieb ------------------------------------------------------------------

create table search_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  query jsonb not null,
  target_count int not null check (target_count > 0),
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  stats jsonb not null default '{}',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Kern ---------------------------------------------------------------------

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_normalized text not null,
  place_id text unique,
  domain text unique,                       -- Identitätsschlüssel, siehe identity.ts
  street text,
  postal_code text,
  city text,
  region text,
  lat numeric(9, 6),
  lng numeric(9, 6),
  category text,
  branch_key text,
  phone text,
  website_url text,
  segment text check (segment in ('WEBSITE', 'NO_WEBSITE')),
  status text not null default 'NEW' check (status in (
    'NEW', 'RESEARCHED', 'AUDITED', 'QUALIFIED', 'SKIPPED', 'FAILED',
    'READY_FOR_CONTACT', 'CONTACTED', 'REPLIED', 'INTERESTED', 'PROTOTYPE', 'WON', 'LOST'
  )),
  skip_reason text,
  skip_detail text,
  current_score int check (current_score between 0 and 100),
  current_score_id uuid,
  recheck_after timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_search_run_id uuid references search_runs (id) on delete set null,
  check (status <> 'SKIPPED' or skip_reason is not null)
);

-- Dubletten-Stufe 3 (Name + PLZ): unscharf per Trigram-Index. Exakt eindeutig nur für Firmen ohne
-- Place-ID; zwei Google-Orte mit gleichem Namen in einer PLZ (z. B. Filialen) bleiben getrennte Firmen.
create unique index companies_name_postal_key on companies (name_normalized, postal_code)
  where place_id is null;
create index companies_name_trgm on companies using gin (name_normalized gin_trgm_ops);
create index companies_status on companies (status);
create index companies_score on companies (current_score desc) where current_score is not null;

create table places_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  fetched_at timestamptz not null default now(),
  rating numeric(2, 1),
  review_count int,
  business_status text,
  latest_review_at timestamptz,
  photo_count int,
  raw jsonb not null
);
create index places_snapshots_company on places_snapshots (company_id, fetched_at desc);

create table website_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  fetched_at timestamptz not null default now(),
  url text not null,
  final_url text,
  http_status int,
  https boolean,
  facts jsonb,
  psi jsonb,
  screenshot_desktop text,
  screenshot_mobile text,
  content_hash text,
  error text
);
create index website_snapshots_company on website_snapshots (company_id, fetched_at desc);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  company_id uuid references companies (id) on delete set null,
  search_run_id uuid references search_runs (id) on delete set null,
  job_id text,
  model text not null,
  prompt_version text,
  input_summary text,
  output_summary text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  status text not null check (status in ('RUNNING', 'OK', 'ERROR')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_runs_started on agent_runs (started_at);

create table audits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  website_snapshot_id uuid references website_snapshots (id) on delete set null,
  agent_run_id uuid references agent_runs (id) on delete set null,
  prompt_version text not null,
  model text not null,
  findings jsonb not null,
  rubric jsonb not null,
  commercial jsonb,
  summary text,
  created_at timestamptz not null default now()
);
create index audits_company on audits (company_id, created_at desc);

create table lead_scores (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  audit_id uuid references audits (id) on delete set null,
  scoring_version text not null,
  total int not null check (total between 0 and 100),
  breakdown jsonb not null,
  knocked_out boolean not null default false,
  knockout_reason text,
  created_at timestamptz not null default now()
);
create index lead_scores_company on lead_scores (company_id, created_at desc);

alter table companies
  add constraint companies_current_score_fk
  foreign key (current_score_id) references lead_scores (id) on delete set null;

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name text,
  role text,
  email text,
  phone text,
  source text not null check (source in ('impressum', 'places', 'manual')),
  created_at timestamptz not null default now()
);
create index contacts_company on contacts (company_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  direction text not null check (direction in ('IN', 'OUT')),
  text text,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);
create index messages_chat on messages (chat_id, created_at desc);
