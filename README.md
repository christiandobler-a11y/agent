# Avelio Lead Engine

Internes System für Avelio: lokale Unternehmen finden, Websites auditieren, Leads mit dem
Avelio Lead Score bewerten und über Telegram berichten.

Plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Stand: Schritte 1–9 umgesetzt (zuletzt Kalibrier-Werkzeug und Deploy auf Hetzner, Anleitung: [docs/DEPLOY.md](docs/DEPLOY.md)). Offen: Kalibrierung am Golden Set (Kriterium 10), 7 Tage stabiler Betrieb (Kriterium 12).

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

## Kosten und Budget (Schritt 4)

```sh
npm run costs
```

zeigt die Ausgaben heute und im Monat gegen das Budget sowie die letzten 7 Tage je Rolle (LLM) bzw. Dienst
(Places). Die Limits stehen in `config/models.yaml` unter `budget` (Start: 5 $ pro Tag, 50 $ pro Monat, Tag und
Monat nach deutscher Zeit). Sie gelten für LLM und Places zusammen. Ist ein Limit erreicht, startet kein neuer
kostenpflichtiger Aufruf mehr: Ein Recherche-Lauf hält mit „Budget erreicht“ an, noch ungeprüfte Firmen bleiben
`NEW` und werden beim nächsten Lauf fertig geprüft.

Unbrauchbare LLM-Antworten (Schema verletzt, abgeschnitten) werden einmal wiederholt; Netz- und Überlastungsfehler
wiederholt das Anthropic-SDK selbst (bis zu 3-mal). Jeder Versuch steht mit Kosten in `agent_runs`.

## Websites crawlen (Schritt 5)

Einmalig den Browser installieren:

```sh
npx playwright install chromium
```

Dann:

```sh
npm run cli -- crawl --pending -n 10     # 10 recherchierte Firmen, die noch nicht gecrawlt wurden
npm run cli -- crawl radlmeier.com       # eine Firma (ID, Place-ID oder Domain)
```

Pro Firma: Startseite in Chromium rendern, Screenshot desktop (1440 px) und mobil (390 px) bis drei
Bildschirmhöhen, Fakten (CMS/Baukasten, Copyright-Jahr, Viewport, `tel:`-Links, CTAs, Formulare, Bilder ohne
Alt-Text …), Impressum (Inhaber/Geschäftsführung, E-Mail, Telefon → Tabelle `contacts`), eine Leistungen-Seite
für den Text und PageSpeed mobil (kostenlos). Ergebnis in `website_snapshots`, Screenshots unter
`data/screenshots/<firma>/`. Die Konfiguration steht in `config/crawl.yaml`.

Fehler (nicht erreichbar, Timeout, HTTP-Fehler, Bot-Schutz, leere Seite, ungültiges Zertifikat) werden mit
Fehlerart gespeichert; die Firma steht dann auf `FAILED` und wird nach 7 Tagen erneut versucht. Ist die „Website“
nur ein Facebook- oder Instagram-Profil, gilt die Firma als „ohne Website“.

## Bewerten und erklären (Schritt 6)

```sh
npm run cli -- audit --pending -n 10    # gecrawlte Firmen auditieren, bewerten, Top-Leads mit Pitch
npm run cli -- audit radlmeier.com      # eine Firma
npm run cli -- explain radlmeier.com    # "Warum 72 Punkte?" (mit --full: jede Position)
npm run cli -- score --all              # alle neu bewerten nach Gewichtsänderung (ohne LLM, kostenlos)
```

- **Audit (Sonnet, ohne Tools):** drei Screenshot-Ausschnitte, gemessene Fakten und Seitentext → Befunde mit Belegen
  und eine Rubrik 1–5 für Design, Mobil, Handlungsaufforderung, Leistungen, Vertrauen und ersten Bildschirm. Ca.
  4 Cent je Firma. Unveränderte Websites werden nicht erneut auditiert (Inhalts-Hash).
- **Score (Code):** fünf Dimensionen (Business 25, Website-Chance 30, Potenzial 20, Lücke 15, Erreichbarkeit 10)
  und Knock-outs; alle Gewichte in `config/scoring.v2.yaml` (am Golden Set kalibriert, v1 = Startwerte). Ab 55 Punkten
  `QUALIFIED`, sonst `SKIPPED` mit Grund; Pitch ab 75.
- **Pitch (Opus):** ab 80 Punkten Hauptchance, drei Argumente und ein Einstiegssatz für das Gespräch (ca. 3 Cent).

## Automatischer Ablauf (Schritt 7)

Ab jetzt läuft alles über eine Job-Queue (pg-boss, Tabellen im Schema `pgboss`):

```sh
npm run worker                                        # Worker starten (läuft dauerhaft, Strg+C beendet)
npm run cli -- search "Fahrradladen" rosenheim -n 5   # in einem zweiten Terminal: Suche einreihen
npm run cli -- runs                                   # Stand der letzten Suchläufe mit Top-Leads und Kosten
npm run cli -- failed                                 # fehlgeschlagene Firmen der letzten 14 Tage
```

Mit `search … --wait` wartet der Befehl und zeigt den Fortschritt, bis der Lauf fertig ist.

Ablauf je Firma: Recherche → Crawl → Audit + Score → Pitch (ab 80 Punkten), jeder Schritt ein eigener Job.

- **Robust:** Stürzt der Worker ab (oder wird beendet), übernimmt der nächste Start die offenen Jobs, ohne dass
  etwas doppelt läuft. Jede Firma endet in `QUALIFIED`, `SKIPPED` (mit Grund) oder `FAILED` (mit Fehler).
- **Fehler:** Eine nicht erreichbare Website wird nach 5 Minuten und 1 Stunde erneut versucht, danach bleibt nur
  diese Firma `FAILED`; der Lauf geht weiter.
- **Budget:** Ist das Tages- oder Monatslimit erreicht, wartet die offene Arbeit bis zum nächsten Morgen (06:00)
  bzw. Monatsersten, und es gibt genau eine Meldung.
- **Abschluss:** Sind alle Jobs eines Laufs fertig, wird er abgeschlossen und gemeldet (bis Schritt 8 im Log des
  Workers, danach per Telegram).
- Wiederholungen, Timeouts und Parallelität stehen in `config/queue.yaml`.

## Telegram (Schritt 8)

```sh
npm run worker      # startet Worker + Telegram-Bot (braucht TELEGRAM_BOT_TOKEN und TELEGRAM_ALLOWED_CHAT_IDS)
```

Dann in Telegram an **@avelio_manager_bot** schreiben, z. B.:

- „Such mir 20 Fahrradläden im Landkreis Rosenheim“ → Bestätigung sofort, Ergebnis mit Top-Leads und Buttons
  `[Details] [Skip] [Kontakt] [Prototyp]`, sobald alle Firmen geprüft sind
- „Zeig mir die besten Leads“, „Warum hat Radl Sepp 72 Punkte?“, „Warum wurde Cycle aussortiert?“
- „Was hat das diese Woche gekostet?“
- Schnellbefehle ohne KI: `/status`, `/kosten`, `/fehler`, `/budget` (`/budget +5` gibt heute 5 $ mehr frei und
  setzt wartende Jobs sofort fort)

Der Bot antwortet nur auf die Chat-IDs in `TELEGRAM_ALLOWED_CHAT_IDS`; alle anderen werden ignoriert und
protokolliert. Ohne diese Variable startet er gar nicht. Der Manager (Sonnet) arbeitet nur über feste Werkzeuge
(Suche starten, Leads auflisten/zeigen/erklären/aussortieren, Status, Kosten, Fehler), ohne freien Datenbankzugriff;
eine Antwort kostet etwa 1–2 Cent. Ohne Telegram testen: `npm run cli -- chat "Zeig mir die besten Leads"`.

Wichtig: Der Bot darf nur in **einem** Prozess laufen (Telegram erlaubt nur einen Abrufer pro Bot). Läuft er später
auf dem Server, auf dem Mac nur `npm run cli -- …` verwenden, nicht `npm run worker`.

## Kalibrierung (Golden Set, ARCHITECTURE.md 7.4)

1. Firmen aus verschiedenen Branchen suchen lassen, z. B. je 8 Fahrradläden, Schreiner, Restaurants, Hotels,
   Physiotherapeuten, Friseure, Kosmetikstudios.
2. In Telegram `/kalibrieren`: Der Bot zeigt eine Firma nach der anderen (Name, Branche, Google-Bewertung, Website,
   **ohne** Score). Du tippst A (sofort ansprechen), B (vielleicht), C (eher nicht) oder „Weiß nicht“. Die Branche
   mit den wenigsten Bewertungen kommt zuerst dran. Ziel: mindestens 20, besser 30.
3. `/auswertung` (oder `npm run cli -- calibrate`) vergleicht deine Noten mit dem Score: Rangliste, Durchschnitt je
   Note und Abnahmekriterium 10 (deine Top-A-Firmen in den System-Top-8, keine C-Firma ab 80 Punkten).
4. `npm run cli -- calibrate export` schreibt `tests/golden/golden.json`. Ins Repo eingecheckt, prüft
   `tests/golden.test.ts` bei jeder Änderung von Gewichten oder Prompts, dass das Golden Set weiter besteht.
   Gewichte ausprobieren ohne Datenbank: `npm run cli -- calibrate --file`.

## Betrieb auf dem Server (Schritt 9)

Avelio läuft auf einem Hetzner-Server in Docker (`Dockerfile`, `docker-compose.prod.yml`). Einrichtung Schritt für
Schritt: [docs/DEPLOY.md](docs/DEPLOY.md). Neue Version einspielen: `ssh root@<IP> bash /opt/avelio/scripts/deploy.sh`.
Lebenszeichen jede Minute (Docker-Healthcheck, optional Ausfall-Alarm über `HEALTHCHECK_URL`), tägliche Sicherung
nach `/opt/avelio/backups/`.

## Abdeckung: Ist eine Region wirklich durch?

Eine normale Suche („Such mir 20 Hotels in Rosenheim“) hört beim Ziel auf und deckt die Region meist nur teilweise ab.
Für Vollständigkeit:

- **„Such alle Hotels in Rosenheim“** (CLI: `npm run cli -- search "Hotel" rosenheim --alle`): jeder Ort mit allen
  Ergebnisseiten. Bereits vollständig abgesuchte Orte werden übersprungen. Liefert Google in einem Ort das Maximum (60
  Treffer), wird der Ort automatisch in Teilgebiete geteilt. Bricht die Suche ab (Budget, Kostenbremse), setzt die
  nächste Komplett-Suche dort fort.
- **`/abdeckung`** bzw. „Ist Rosenheim durch?“ (CLI: `npm run cli -- coverage rosenheim`): je Branche ✔ vollständig,
  ◐ teilweise (x von y Orten) oder ○ noch nie gesucht, mit gefundenen Betrieben und offenen Prüfungen. Suchen von vor
  dieser Funktion zählen als „angesucht, aber nicht sicher vollständig“.
- Jede Ergebnismeldung nach einer Suche nennt die Abdeckung der Region für diese Branche.

## Mini-CRM (Phase 2)

- In der Ergebnismeldung auf **Kontakt** tippen: CRM-Karte mit Status-Buttons (📤 kontaktiert, 💬 Antwort,
  📅 Termin, 🛠 Prototyp, ✅ gewonnen, ❌ verloren), Verlauf und Erinnerung „in 3/7 Tagen“.
- Nach „kontaktiert“ legt Avelio automatisch eine Nachfass-Erinnerung an (`config/crm.yaml`, Standard 5 Tage).
  Fällige Erinnerungen kommen als Telegram-Nachricht mit „Erledigt“ / „+2 Tage“, nie nachts (21–8 Uhr).
- Freitext geht auch: „Hab Radl Sepp angerufen, will ein Angebot“, „Notiz zu Ariadne: …“, „Erinner mich Freitag an …“.
- `/pipeline`: alle Leads im Vertrieb je Status und offene Erinnerungen.

## Kontakt-Entwürfe (Phase 2)

Auf der CRM-Karte (**Kontakt**) gibt es **✍️ E-Mail-Entwurf**. Avelio schreibt eine kurze, persönliche Mail:
Einstieg („Ich heiße Christian und mache Online-Auftritte zeitgemäß …“), genau ein echter Befund aus dem Audit, ein
Kompliment mit Fakt (Google-Bewertung), Terminvorschlag mit Knappheit (2 Tage × 2 Uhrzeiten um den Hauptjob herum,
derselbe Termin höchstens an 2 Leads) und WhatsApp-Link mit vorausgefülltem Text. Sie/Du/Ihr je nach Branche und
Ansprechpartner, Betreff, Einstieg, Überleitung und Gruß wechseln gegen Spamfilter.

Gesendet wird von Christians eigenem Postfach (Stufe 2): Adresse, Betreff und Text in Telegram antippen zum Kopieren
(oder „In Mail-App öffnen“, wenn Telegram den Link zulässt), danach **📤 Gesendet, kontaktiert** → Nachfass-Erinnerung.
Avelio verschickt nichts selbst. Regeln, Texte und Zeitfenster: `config/outreach.yaml`; Prompt: `prompts/contact.v1.md`;
Nummern in der `.env` (`OUTREACH_WHATSAPP`, `OUTREACH_PHONE`). Ein Entwurf kostet etwa 0,3–0,6 Cent.
