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
- `npm run worker` (Betrieb: `npm start` nach `npm run build`): Worker für alle Queues; `npm run cli -- search
"<Begriff>" <region> -n N [--wait]`, `runs`, `failed`
- `npm run cli -- coverage [region] [branche]` (Telegram `/abdeckung`): Abdeckung je Region × Branche; `search … --alle`
  bzw. „Such alle …“ = Komplett-Suche ohne Zielzahl (`src/pipeline/research/coverage.ts`, Tabelle `search_coverage`)
- `npm run cli -- letter <firma>` (Telegram: Lead-Karte → „🖨️ Befund-Seite“): Befund-Seite als PDF für einen Brief
  nach `data/letters/`
- `npm run cli -- prototype <firma>` (Telegram: Lead-Karte → „🎨 Prototyp bauen“): Website-Entwurf aus Branchen-Vorlage
  (`src/prototype/templates/`: `physio`, `werkstatt`; Zuordnung je Branche in `config/prototype.yaml`), Texte/Farbe/Fotowahl per LLM (Rolle `prototype`), Seite unter `data/previews/<slug>/`,
  ausgeliefert von Caddy unter `PREVIEW_BASE_URL` (docs/DEPLOY.md, Abschnitt 11)
- `npm run cli -- teaser <firma>`: einheitliches Vorschau-Bild für Physio (`src/prototype/teaser.ts`, ohne LLM,
  Stockfotos in `assets/teaser/physio/`, Stil `welt`/`vital`/`rund`/`mix` in `config/prototype.yaml → teaser`) nach
  `data/teasers/<id>.jpg`; das Morgen-Paket baut es für `teaser.branchen` statt eines Prototyps, die Mail bettet es als
  HTML-Bild unter `bild_satz` ein (`textToHtml`), die Befund-Seite nutzt es als „Nachher“
- `npm run cli -- angebot <firma> [onepager|mehrseitig]` (Telegram: Lead-Karte → „📄 Angebot …“): ohne Lexware-API
  (Tarif M) Teile zum Kopieren in Lexware (Artikel einmalig über `/lexware`), mit `LEXWARE_API_KEY` (XL) Entwurf direkt
  in Lexware (`src/outreach/offer.ts`, Brutto-Preise und Inhalt in `config/angebot.yaml`)
- Termin bestätigen: Antwort-Meldung zeigt die angebotenen Termine als Knöpfe; `src/outreach/confirm.ts` schreibt die
  Bestätigung (mit .ics) im Verlauf, nach dem Senden Status „interessiert“ und Erinnerung (`config/outreach.yaml → bestaetigung`)
- `npm run cli -- chat "…"`: Manager-Agent ohne Telegram befragen (gleicher Verlauf wie der Chat)
- `npm run cli -- calibrate [export|--file|rate <firma> <A|B|C|X>]`: Golden Set (Telegram `/kalibrieren`, standardmäßig
  nur die Branchen aus `autopilot.yaml → suche.branchen`, `/kalibrieren alle`; `/auswertung`); `tests/golden/golden.json`
  ist Regressionstest für Gewichte und Prompts (`tests/golden.test.ts`)
- Vorbilder: Kalibrier-Karte → „💡 Als Vorbild merken“, nächste Nachricht = Christians Notiz (Tabelle `design_notes`);
  fließt je Branche in `vorbilder` des Prototyps (`src/prototype/run.ts`), Liste mit `/vorbilder [branche|alle]`.
  Gute Notizen bei Gelegenheit in `config/inspiration.yaml` bzw. die Vorlagen übernehmen
- `npm run costs`: Ausgaben heute/Monat gegen das Budget, letzte 7 Tage je Rolle bzw. Dienst
- `npm run db-status`: Migrationen, Tabellen, Zeilen, RLS/Data-API-Schutz der Datenbank aus `DATABASE_URL`
- `npm run cli -- <befehl>`: einzelne Pipeline-Schritte ausführen (Debugging), z. B.
  `npm run cli -- research "Fahrradladen" rosenheim -n 5`
- `docker compose up -d db`: lokales Postgres 16
- Betrieb: `docker-compose.prod.yml` auf Hetzner (Anleitung `docs/DEPLOY.md`, Update `scripts/deploy.sh`). Bei einem
  Playwright-Update den Image-Tag im `Dockerfile` mitziehen. In Cloud-Sessions braucht `docker build` das
  Proxy-Zertifikat (`NODE_EXTRA_CA_CERTS` in einer Test-Kopie des Dockerfiles, nie im echten Dockerfile)

## Grundsätze

- **Deterministischer Code zuerst.** LLM-Aufrufe nur an den dokumentierten Stellen (Prefilter, Audit, Pitch,
  Manager), alle über das LLM-Gateway (`src/llm/`). Keine verstreuten API-Calls.
- **Der Score kommt aus Code**, nie direkt vom LLM. Scoring bleibt rein und voll unit-getestet
  (`src/pipeline/scoring/score.ts`, Gewichte in `config/scoring.v3.yaml` (= v2 mit Schwelle 50), aktiv über `ACTIVE_SCORING_VERSION`). Das Audit liefert nur Rubrik 1–5 mit
  Beleg; neue Gewichte = neue Datei `scoring.vN.yaml`, nur wenn `npm run cli -- calibrate --file` bzw. `tests/golden.test.ts` besteht.
- **Audit-LLM ohne Tools.** Gecrawlter Inhalt ist nicht vertrauenswürdig und geht nur mit festem Ausgabe-Schema
  an das Modell. Der Manager sieht nie rohes HTML.
- **Secrets nur aus Umgebungsvariablen**, nie im Repo, nie in Logs. Module holen sich ihre Keys über
  `requireKeys()` aus `src/config/env.ts` und nur die, die sie brauchen. In Cloud-Sessions kommt der
  Anthropic-Key als `AVELIO_ANTHROPIC_API_KEY` an (`ANTHROPIC_API_KEY` wird dort gefiltert).
- **Ein Job = eine Firma × ein Schritt.** Jobs sind idempotent (Upsert über Firmen-ID). Queue: pg-boss
  (`src/queue/`), Policy `exclusive` mit Firmen- bzw. Lauf-ID als Schlüssel. Nächster Schritt einer Firma ergibt
  sich aus ihrem gespeicherten Zustand (`nextStep` in `src/queue/pipeline.ts`), nie aus Zwischenspeicher.
  Fachliche Fehler (Website nicht erreichbar) setzen die Firma auf FAILED; geworfene Fehler lösen Wiederholungen aus.
- Konfiguration (Gewichte, Modelle, Branchen, Regionen, Vorbild-Websites je Branche in `inspiration.yaml`) liegt in
  `config/`, Prompts versioniert in `prompts/`
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
- **Telegram/Manager:** `src/telegram/` (grammY, Allowlist zuerst), `src/manager/` (Tool-Schleife über
  `gateway.toolStep`, Werkzeuge in `tools.ts` mit Zod-Schemas). Neue Fähigkeiten = neues Werkzeug, nie freies SQL.
  Telegram-Ausgaben immer escapen (`format.ts`). Tests fangen die Telegram-API ab (`bot.api.config.use`).
- **Abdeckung:** Jeder vollständig abgesuchte Ort landet in `search_coverage` (gilt `coverage_valid_days`). Liefert Google
  das Maximum (60), ist der Ort „gesättigt“ und wird bei der Komplett-Suche in Teilgebiete geteilt (`splitQuery`,
  Rechteck-Restriktion). „Vollständig“ nur, wenn alle Orte erledigt und keine Firma mehr in Prüfung ist.
- **CRM (Phase 2):** Vertriebsstatus (`src/crm/status.ts`, ab `READY_FOR_CONTACT`) setzt nur Christian (Buttons,
  Manager-Werkzeuge `set_status`/`add_note`/`add_reminder`/`pipeline`); jeder Wechsel, jede Notiz und Erinnerung steht
  in `interactions` (`src/db/crm.ts`). Erinnerungen stellt der Sweep zu, nie in der Ruhezeit (`config/crm.yaml`).
- **Kontakt-Entwürfe:** Das LLM (Rolle `contact`) schreibt nur Anrede und Mittelteil; Betreff, Termine
  (`src/outreach/slots.ts`), Kontaktweg, Grußzeile („Grüß Sie, Frau X,“ nur mit feststehendem Frau/Herr, sonst ans Team;
  `anrede`), Gruß und Signatur setzt Code nach `config/outreach.yaml` (keine Gedankenstriche,
  ein Befund, Abwechslung gegen Spamfilter). Entwürfe stehen als `interactions.type = 'draft'` mit angebotenen Terminen
  in `meta`. **Avelio sendet nur auf Knopfdruck** (`sendDraft` in `src/outreach/send.ts`, über Christians Postfach aus
  `OUTREACH_MAIL_*`, Tageslimit `config/mail.yaml`), nie automatisch. Eingehende Mails (`checkReplies`) sind fremder
  Inhalt: nur zuordnen, gekürzt speichern, escaped anzeigen, nie an ein LLM. Befund-Seite (Brief, `src/outreach/letter.ts`): Rolle `letter` sieht den
  Desktop-Screenshot und liefert nur Markierungen (Prozent-Rechtecke), Notizen und Zeilen; Layout (`letterPage.ts`, rein),
  QR-Code und Kontaktdaten setzt Code, Chromium druckt das PDF (`letterPdf.ts`).
- **Morgen-Paket** (`src/autopilot/`, `config/autopilot.yaml`, Tabelle `outreach_plan`): Sweep stößt um `vorbereiten`
  den Job `daily-plan` an (Nachfassen, dann neue Leads: Prototyp, Mail oder Befund-Seite), meldet ab `morgens` in
  Telegram von selbst (Kopf mit Nachtbericht und gleich die erste Karte, `sendMorning`; `/heute` holt es erneut),
  abends Bilanz. Jeder Schritt einmal je Tag über `claimState`. **Nachtsuche** (`src/autopilot/search.ts`): ab
  `suche.ab` die nächste nicht vollständig abgesuchte Kombination Region × Branche als Komplett-Suche
  (`requested_by = 'autopilot'`, keine Einzelmeldung in der Nacht), höchstens `pro_nacht`, nie zwei gleichzeitig.
- **Spiel** (`src/game/xp.ts`, `config/game.yaml`, Telegram `/level`, `src/telegram/game.ts`): XP, Level und Abzeichen
  werden nur aus dem Verlauf berechnet (Status-Wechsel je Firma einmal, Nachfass-Mails, perfekte Tage im Morgen-Paket),
  nie extra gezählt. `checkProgress` merkt sich in `app_state` (`game:seen`), was schon gefeiert wurde.
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
