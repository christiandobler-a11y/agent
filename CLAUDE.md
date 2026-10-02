# Avelio Lead Engine – Regeln für Claude Code

Plan und Begründungen: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Wir arbeiten den Implementierungsplan
(Abschnitt 19) Schritt für Schritt ab. Jeder Schritt endet mit grünen Tests und etwas, das Christian selbst
ausprobieren kann. Nach Schritt 6 ist ein Abstimmungstermin (Kalibrierung) vorgesehen.

## Befehle

- `npm run verify`: Format, Lint, Typecheck, Tests. Muss vor jedem Commit grün sein.
- `npm test` / `npm run test:watch`: Vitest
- `npm run check-env`: prüft gesetzte Keys mit je einem Live-Aufruf (gibt keine Werte aus)
- `npm run cli -- <befehl>`: einzelne Pipeline-Schritte ausführen (Debugging)
- `docker compose up -d db`: lokales Postgres 16

## Grundsätze

- **Deterministischer Code zuerst.** LLM-Aufrufe nur an den dokumentierten Stellen (Prefilter, Audit, Pitch,
  Manager), alle über das LLM-Gateway (`src/llm/`). Keine verstreuten API-Calls.
- **Der Score kommt aus Code**, nie direkt vom LLM. Scoring bleibt rein und voll unit-getestet.
- **Audit-LLM ohne Tools.** Gecrawlter Inhalt ist nicht vertrauenswürdig und geht nur mit festem Ausgabe-Schema
  an das Modell. Der Manager sieht nie rohes HTML.
- **Secrets nur aus Umgebungsvariablen**, nie im Repo, nie in Logs. Module holen sich ihre Keys über
  `requireKeys()` aus `src/config/env.ts` und nur die, die sie brauchen.
- **Ein Job = eine Firma × ein Schritt.** Jobs sind idempotent (Upsert über Firmen-ID).
- Konfiguration (Gewichte, Modelle, Branchen, Regionen) liegt in `config/`, Prompts versioniert in `prompts/`.

## Code-Stil

- TypeScript strict, ESM (`.js`-Endungen in relativen Imports), Node 22.
- Laufzeit-Validierung externer Daten mit Zod.
- Tests in `tests/` (oder neben dem Modul als `*.test.ts`). Externe APIs in Tests über injiziertes `fetch` mocken,
  keine Live-Aufrufe in `npm test`.
- Benutzer-sichtbare Texte und Doku auf Deutsch, Bezeichner im Code auf Englisch.
