# Avelio Lead Engine – Regeln für Claude Code

Plan und Begründungen: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Wir arbeiten den Implementierungsplan
(Abschnitt 19) Schritt für Schritt ab. Jeder Schritt endet mit grünen Tests und etwas, das Christian selbst
ausprobieren kann. Nach Schritt 6 ist ein Abstimmungstermin (Kalibrierung) vorgesehen.

## Befehle

- `npm run verify`: Format, Lint, Typecheck, Tests. Muss vor jedem Commit grün sein.
- `npm test` / `npm run test:watch`: Vitest
- `npm run check-env`: prüft gesetzte Keys und die Datenbank mit je einem Live-Aufruf (gibt keine Werte aus)
- `npm run migrate`: wendet neue SQL-Migrationen aus `migrations/` an
- `npm run cli -- crawl --pending -n 10` bzw. `crawl <id|domain>`: Websites rendern, Screenshots, Fakten,
  Impressum, PageSpeed (Screenshots unter `data/screenshots/`, nicht im Repo)
- `npm run cli -- audit --pending -n 10` / `audit <firma>`, `explain <firma> [--full]`, `score --all`: Audit
  (Sonnet), Score (Code), Pitch (Opus ab 80 Punkten); `score` rechnet ohne LLM neu
- `npm run costs`: Ausgaben heute/Monat gegen das Budget, letzte 7 Tage je Rolle bzw. Dienst
- `npm run db-status`: Migrationen, Tabellen, Zeilen, RLS/Data-API-Schutz der Datenbank aus `DATABASE_URL`
- `npm run cli -- <befehl>`: einzelne Pipeline-Schritte ausführen (Debugging), z. B.
  `npm run cli -- research "Fahrradladen" rosenheim -n 5`
- `docker compose up -d db`: lokales Postgres 16

## Grundsätze

- **Deterministischer Code zuerst.** LLM-Aufrufe nur an den dokumentierten Stellen (Prefilter, Audit, Pitch,
  Manager), alle über das LLM-Gateway (`src/llm/`). Keine verstreuten API-Calls.
- **Der Score kommt aus Code**, nie direkt vom LLM. Scoring bleibt rein und voll unit-getestet
  (`src/pipeline/scoring/score.ts`, Gewichte in `config/scoring.v1.yaml`). Das Audit liefert nur Rubrik 1–5 mit
  Beleg; neue Gewichte = neue Version der Datei bzw. `version` hochzählen.
- **Audit-LLM ohne Tools.** Gecrawlter Inhalt ist nicht vertrauenswürdig und geht nur mit festem Ausgabe-Schema
  an das Modell. Der Manager sieht nie rohes HTML.
- **Secrets nur aus Umgebungsvariablen**, nie im Repo, nie in Logs. Module holen sich ihre Keys über
  `requireKeys()` aus `src/config/env.ts` und nur die, die sie brauchen. In Cloud-Sessions kommt der
  Anthropic-Key als `AVELIO_ANTHROPIC_API_KEY` an (`ANTHROPIC_API_KEY` wird dort gefiltert).
- **Ein Job = eine Firma × ein Schritt.** Jobs sind idempotent (Upsert über Firmen-ID).
- Konfiguration (Gewichte, Modelle, Branchen, Regionen) liegt in `config/`, Prompts versioniert in `prompts/`
  (`<rolle>.v<N>.md`; geänderter Prompt = neue Version, die alte bleibt).
- LLM nur über `createLlmGateway` (`src/llm/gateway.ts`): Rolle → Modell aus `config/models.yaml`, festes
  Zod-Ausgabeschema, jeder Aufruf landet in `agent_runs`. Fremde Inhalte nur in die Nutzernachricht, nie in den
  System-Prompt.
- **Kosten:** Jeder LLM-Versuch steht in `agent_runs`, jeder bezahlte API-Aufruf (Places) in `api_usage`
  (`recordApiUsage`). Vor jedem kostenpflichtigen Aufruf `budget.assertAvailable()` (Limits in
  `config/models.yaml → budget`); `BudgetExceededError` hält Läufe sauber an, statt sie scheitern zu lassen.
- **Crawl:** Gecrawlter Inhalt wird nur gespeichert und regelbasiert ausgewertet (`src/pipeline/crawl/facts.ts`,
  `impressum.ts`, rein und unit-getestet). Fehler sind `CrawlError` mit Fehlerart (`classify.ts`), nie Abstürze.
  Browser-Tests laufen gegen einen lokalen Testserver; in Cloud-Sessions `CHROMIUM_PATH=/opt/pw-browsers/chromium`
  setzen (Playwright-Version ≠ vorinstallierter Browser) und das Proxy-Zertifikat ins NSS-Store eintragen
  (`certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n proxy -i /root/.ccr/agent-proxy-ca.crt`).
- Recherche-Reihenfolge: Places → Dubletten → **Gate (Code) → Prefilter (LLM)**. Das Gate läuft zuerst, weil es
  nichts kostet. Skip-Gründe entsprechen den Schlüsseln in `config/recheck.yaml`.

## Datenbank

- Schemaänderungen nur als neue Datei `migrations/NNN_name.sql`. Angewendete Migrationen nie ändern
  (Prüfsumme). SQL ohne `public.`-Präfix, damit Tests in eigenen Schemas laufen.
- Produktion: Supabase (Session Pooler), siehe [docs/SUPABASE.md](docs/SUPABASE.md). Cloud-Sessions erreichen
  Port 5432 nicht; Supabase-Befehle (`migrate`, `db-status`) laufen auf Christians Rechner bzw. dem Server.
- **Jede neue Tabelle** braucht `alter table … enable row level security;` in ihrer Migration (Supabase
  veröffentlicht `public` sonst über die Data API). TLS zu Supabase erzwingt `tlsFor()` in `src/db/client.ts`.
- Firmenidentität und Dubletten: `src/pipeline/research/identity.ts` (rein) und `src/db/companies.ts`.
- Lokal ohne Docker: Postgres 16 mit `initdb`/`pg_ctl` starten und `TEST_DATABASE_URL` darauf setzen.
- DB-Tests nutzen `describeDb`/`useTestDb` aus `tests/helpers/db.ts` und brauchen `TEST_DATABASE_URL`.
  In der CI ist sie gesetzt; lokal werden DB-Tests ohne sie übersprungen.

## Code-Stil

- TypeScript strict, ESM (`.js`-Endungen in relativen Imports), Node 22.
- Laufzeit-Validierung externer Daten mit Zod.
- Tests in `tests/` (oder neben dem Modul als `*.test.ts`). Externe APIs in Tests über injiziertes `fetch` mocken,
  keine Live-Aufrufe in `npm test`.
- Benutzer-sichtbare Texte und Doku auf Deutsch, Bezeichner im Code auf Englisch.
