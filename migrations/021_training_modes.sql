-- Sales-Trainer in drei Stufen (09.10.2026, Christian: "mehr Hilfe am Anfang, zwischen Modi wechseln, erst Sätze
-- einbrennen, dann selbst wiedergeben"): leicht = Lückentext, mittel = Satz aus dem Kopf, schwer = Rollenspiel.
-- Runden der Stufen leicht/mittel stehen ebenfalls in training_sessions (XP fürs Spiel), ihr Ablauf in `drill`.
alter table training_sessions add column mode text not null default 'schwer'
  check (mode in ('leicht', 'mittel', 'schwer'));
alter table training_sessions add column drill jsonb;

-- Lernstand je Satz aus config/saetze.yaml (Leitner-Fach 0 bis 4).
create table training_phrases (
  phrase text primary key,
  box int not null default 0,
  seen int not null default 0,
  correct int not null default 0,
  last_at timestamptz
);
alter table training_phrases enable row level security;
