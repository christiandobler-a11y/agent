-- Sales-Trainer (09.10.2026, Christian): Rollenspiele zur Einwandbehandlung in Telegram. Ein Gespräch je Zeile,
-- Verlauf als JSON, Bewertung des Coachs und die von Code berechneten XP (fließen ins Spiel, src/game/xp.ts).
create table training_sessions (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  scenario text not null,
  status text not null default 'offen' check (status in ('offen', 'fertig', 'abgebrochen')),
  turns jsonb not null default '[]',
  hints int not null default 0,
  decision text,
  feedback jsonb,
  score numeric(3, 2),
  xp int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index training_sessions_open on training_sessions (chat_id, status, updated_at desc);
create index training_sessions_scenario on training_sessions (scenario, finished_at desc);
alter table training_sessions enable row level security;
