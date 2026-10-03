-- Kalibrierung (ARCHITECTURE.md 7.4): Christians Bauchgefühl-Bewertung je Firma. A = sofort ansprechen,
-- B = vielleicht, C = kein guter Lead, X = übersprungen (kann ich nicht beurteilen). Golden Set = alle A/B/C.
create table calibration_ratings (
  company_id uuid primary key references companies (id) on delete cascade,
  grade text not null check (grade in ('A', 'B', 'C', 'X')),
  note text,
  chat_id bigint,
  rated_at timestamptz not null default now()
);
alter table calibration_ratings enable row level security;
