-- Laden der Woche (06.10.2026, Christian): Avelio sucht je Woche einen Laden in der Nähe aus (Fahrrad & Sport,
-- Friseur & Kosmetik), liefert ein Design-Briefing mit drei klar verschiedenen Richtungen; Christian baut die Seite
-- gemeinsam mit Claude, besucht den Laden und filmt (mit Freigabe). Gewählte Richtungen werden gemerkt, damit keine
-- Seite wie die andere aussieht.
create table shop_picks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  week text not null,
  status text not null default 'vorgeschlagen'
    check (status in ('vorgeschlagen', 'genommen', 'abgelehnt', 'besucht')),
  briefing jsonb,
  chosen int,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index shop_picks_company on shop_picks (company_id);
create index shop_picks_week on shop_picks (week, created_at desc);
alter table shop_picks enable row level security;
