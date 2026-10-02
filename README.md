# Avelio Lead Engine

Internes System für Avelio: lokale Unternehmen finden, Websites auditieren, Leads mit dem
Avelio Lead Score bewerten und über Telegram berichten.

Plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Stand: Schritt 6 (Audit, Avelio Lead Score, Erklärung, Pitch) umgesetzt.

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
  und Knock-outs; alle Gewichte in `config/scoring.v1.yaml`. Ab 60 Punkten `QUALIFIED`, sonst `SKIPPED` mit Grund.
- **Pitch (Opus):** ab 80 Punkten Hauptchance, drei Argumente und ein Einstiegssatz für das Gespräch (ca. 3 Cent).
