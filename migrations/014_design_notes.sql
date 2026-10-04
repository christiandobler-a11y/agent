-- Vorbild-Notizen (04.10.2026, Christian): Beim Kalibrieren kann Christian eine Website als Vorbild merken und kurz
-- schreiben, was ihm daran gefällt. Die Notizen fließen in künftige Prototypen der Branche ein (src/prototype/run.ts)
-- und lassen sich mit /vorbilder abrufen, um daraus Vorlagen zu verbessern.
create table design_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete set null,
  branch_key text,
  url text,
  name text not null,
  note text not null,
  created_by text,
  created_at timestamptz not null default now()
);
create index design_notes_branch on design_notes (branch_key, created_at);
alter table design_notes enable row level security;
