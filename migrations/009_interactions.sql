-- Mini-CRM (ARCHITECTURE.md 9, Phase 2): Statuswechsel, Notizen, Erinnerungen und später Kontakt-Entwürfe je Firma.
create table interactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  type text not null check (type in ('status', 'note', 'reminder', 'draft')),
  channel text check (channel in ('email', 'letter', 'phone', 'visit', 'other')),
  body text,
  from_status text,
  to_status text,
  due_at timestamptz,
  done_at timestamptz,
  notified_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index interactions_company on interactions (company_id, created_at desc);
create index interactions_open_reminders on interactions (due_at) where type = 'reminder' and done_at is null;
alter table interactions enable row level security;
