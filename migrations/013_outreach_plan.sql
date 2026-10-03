-- Morgen-Paket (Phase 2): Tagesplan mit fertig vorbereiteten Kontakten. Avelio bereitet nachts vor, Christian
-- sendet morgens per Knopf (Mail) bzw. druckt (Brief). Ein Eintrag je Firma und Tag.
create table outreach_plan (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null,
  company_id uuid not null references companies (id) on delete cascade,
  kind text not null check (kind in ('new', 'followup')),
  channel text not null check (channel in ('email', 'letter')),
  draft_id uuid references interactions (id) on delete set null,
  status text not null default 'ready' check (status in ('ready', 'done', 'later', 'dropped')),
  position integer not null,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  unique (plan_date, company_id)
);
create index outreach_plan_day on outreach_plan (plan_date, position);
alter table outreach_plan enable row level security;
