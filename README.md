# Avelio Lead Engine

Internes System für Avelio: lokale Unternehmen finden, Websites auditieren, Leads mit dem
Avelio Lead Score bewerten und über Telegram berichten.

Plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Stand: Schritt 3 (Recherche: Places-Suche mit Orts-Kachelung, Gate, Prefilter) umgesetzt.

Datenbank im Betrieb: Supabase, Einrichtung in [docs/SUPABASE.md](docs/SUPABASE.md).

## Lokal starten

```sh
nvm use               # Node 22
npm install
cp .env.example .env  # Keys eintragen
docker compose up -d db
npm run migrate       # Schema anlegen bzw. aktualisieren
npm run db-status     # Tabellen und Zugriffsschutz prüfen
npm run check-env     # prüft Keys und Datenbank live
npm run verify        # Format, Lint, Typecheck, Tests (DB-Tests brauchen TEST_DATABASE_URL)
```

## Recherche ausprobieren (Schritt 3)

```sh
npm run cli -- research "Fahrradladen" rosenheim -n 5
```

Sucht Ort für Ort im Landkreis Rosenheim (`config/regions/rosenheim.yaml`), gleicht mit dem Bestand ab, sortiert
per Gate (`config/gate.yaml`: geöffnet, ≥ 4,0★, ≥ 15 Bewertungen, keine bekannte Kette) und Prefilter (Haiku:
passende Branche, keine Filiale) aus. Gesucht wird, bis `Ziel × 3` neue Firmen bestanden haben
(`config/research.yaml`). Ergebnis: Firmen mit Status `RESEARCHED` bzw. `SKIPPED` + Grund in `companies`, der Lauf in
`search_runs`, jeder LLM-Aufruf mit Kosten in `agent_runs`.

Ein zweiter Lauf mit denselben Parametern legt keine Dubletten an: Bekannte Firmen bekommen nur eine neue
Places-Momentaufnahme und werden erst nach `recheck_after` erneut geprüft.

Kosten je Lauf mit `-n 5` (gemessen): ca. 5–13 Places-Anfragen (~0,18–0,46 $) und 0,03–0,07 $ für Haiku.

Nützliche Abfragen (Supabase SQL-Editor):

```sql
select name, city, status, skip_reason, skip_detail from companies order by last_seen_at desc;
select id, status, stats from search_runs order by created_at desc limit 5;
select role, count(*), sum(cost_usd) from agent_runs group by role;
```
