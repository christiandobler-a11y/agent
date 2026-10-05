-- Berater-Runde (05.10.2026, Christian): Prozess-Optimierer und Wachstums-Berater schauen einmal die Woche (oder auf
-- /berater) auf die Zahlen, recherchieren im Netz und machen Vorschläge. Sie ändern nichts selbst: Christian
-- entscheidet per Knopf, umgesetzt wird im Code. Verworfene Vorschläge kommen nicht wieder, umgesetzte werden
-- in den Wochen danach nachgeprüft.
create table advisor_reports (
  id uuid primary key default gen_random_uuid(),
  trigger text not null,
  lage text not null,
  rueckblick text,
  research text,
  sources jsonb not null default '[]',
  cost_usd numeric(10, 5) not null default 0,
  dropped int not null default 0,
  created_at timestamptz not null default now()
);
alter table advisor_reports enable row level security;

create table advisor_suggestions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references advisor_reports (id) on delete cascade,
  area text not null check (area in ('prozess', 'wachstum')),
  title text not null,
  observation text not null,
  evidence text not null,
  proposal text not null,
  impact text not null,
  effort text not null check (effort in ('klein', 'mittel', 'gross')),
  risk text not null,
  confidence text not null check (confidence in ('niedrig', 'mittel', 'hoch')),
  critique text,
  sources jsonb not null default '[]',
  status text not null default 'offen' check (status in ('offen', 'umsetzen', 'verworfen', 'spaeter', 'erledigt')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index advisor_suggestions_status on advisor_suggestions (status, created_at);
alter table advisor_suggestions enable row level security;
