-- Kleine Schlüssel-Wert-Ablage für Betriebszustände (z. B. "Budget-Meldung heute schon verschickt",
-- Telegram-Verlauf). pg-boss legt seine Tabellen im eigenen Schema "pgboss" an.
create table app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table app_state enable row level security;
