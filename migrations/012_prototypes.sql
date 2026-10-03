-- Prototypen (Phase 3): automatisch gebaute Website-Entwürfe je Lead, statisch unter vorschau.<domain>/<slug>/.
create table prototypes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  -- Pfad unter der Vorschau-Domain, mit Zufallsteil (nicht erratbar), bleibt beim Neubau gleich.
  slug text not null,
  template text not null,
  content jsonb not null,
  prompt_version text not null,
  cost_usd numeric(10, 5) not null default 0,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index prototypes_company on prototypes (company_id, created_at desc);
create index prototypes_slug on prototypes (slug);
alter table prototypes enable row level security;
