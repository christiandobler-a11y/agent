-- Abdeckung: welche Suchgebiete (Orte bzw. Teilgebiete) für welche Branche wann vollständig abgesucht wurden.
-- "subject" = Branchenschlüssel aus config/branches.yaml, sonst "term:<suchbegriff>".
-- saturated = Google hat das Maximum (60 Treffer) geliefert, es gibt dort vermutlich mehr → Gebiet wird geteilt.
create table search_coverage (
  region_key text not null,
  subject text not null,
  tile_key text not null,
  search_run_id uuid references search_runs (id) on delete set null,
  results int not null,
  pages int not null,
  saturated boolean not null,
  searched_at timestamptz not null default now(),
  primary key (region_key, subject, tile_key)
);
alter table search_coverage enable row level security;
