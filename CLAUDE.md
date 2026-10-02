# Avelio Lead Engine – Regeln für Claude Code

Plan und Begründungen: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Wir arbeiten den Implementierungsplan
(Abschnitt 19) Schritt für Schritt ab. Jeder Schritt endet mit grünen Tests und etwas, das Christian selbst
ausprobieren kann. Nach Schritt 6 ist ein Abstimmungstermin (Kalibrierung) vorgesehen.

## Befehle

- `npm run verify`: Format, Lint, Typecheck, Tests. Muss vor jedem Commit grün sein.
- `npm test` / `npm run test:watch`: Vitest
- `npm run check-env`: prüft gesetzte Keys und die Datenbank mit je einem Live-Aufruf (gibt keine Werte aus)
- `npm run migrate`: wendet neue SQL-Migrationen aus `migrations/` an
- `npm run cli -- <befehl>`: einzelne Pipeline-Schritte ausführen (Debugging)
- `docker compose up -d db`: lokales Postgres 16

## Grundsätze

- **Deterministischer Code zuerst.** LLM-Aufrufe nur an den dokumentierten Stellen (Prefilter, Audit, Pitch,
  Manager), alle über das LLM-Gateway (`src/llm/`). Keine verstreuten API-Calls.
- **Der Score kommt aus Code**, nie direkt vom LLM. Scoring bleibt rein und voll unit-getestet.
- **Audit-LLM ohne Tools.** Gecrawlter Inhalt ist nicht vertrauenswürdig und geht nur mit festem Ausgabe-Schema
  an das Modell. Der Manager sieht nie rohes HTML.
- **Secrets nur aus Umgebungsvariablen**, nie im Repo, nie in Logs. Module holen sich ihre Keys über
  `requireKeys()` aus `src/config/env.ts` und nur die, die sie brauchen. In Cloud-Sessions kommt der
  Anthropic-Key als `AVELIO_ANTHROPIC_API_KEY` an (`ANTHROPIC_API_KEY` wird dort gefiltert).
- **Ein Job = eine Firma × ein Schritt.** Jobs sind idempotent (Upsert über Firmen-ID).
- Konfiguration (Gewichte, Modelle, Branchen, Regionen) liegt in `config/`, Prompts versioniert in `prompts/`.

## Datenbank

- Schemaänderungen nur als neue Datei `migrations/NNN_name.sql`. Angewendete Migrationen nie ändern
  (Prüfsumme). SQL ohne `public.`-Präfix, damit Tests in eigenen Schemas laufen.
- Firmenidentität und Dubletten: `src/pipeline/research/identity.ts` (rein) und `src/db/companies.ts`.
- DB-Tests nutzen `describeDb`/`useTestDb` aus `tests/helpers/db.ts` und brauchen `TEST_DATABASE_URL`.
  In der CI ist sie gesetzt; lokal werden DB-Tests ohne sie übersprungen.

## Code-Stil

- TypeScript strict, ESM (`.js`-Endungen in relativen Imports), Node 22.
- Laufzeit-Validierung externer Daten mit Zod.
- Tests in `tests/` (oder neben dem Modul als `*.test.ts`). Externe APIs in Tests über injiziertes `fetch` mocken,
  keine Live-Aufrufe in `npm test`.
- Benutzer-sichtbare Texte und Doku auf Deutsch, Bezeichner im Code auf Englisch.
