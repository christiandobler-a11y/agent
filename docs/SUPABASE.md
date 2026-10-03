# Supabase einrichten

Supabase ist nur die Postgres-Datenbank (plus Tabellen-Ansicht im Dashboard). Die App spricht direkt Postgres,
nicht die Supabase-REST-API. Dauer: ca. 15 Minuten.

## 1. Projekt und Verbindungs-URL

- Region **Frankfurt (eu-central-1)**.
- Dashboard → **Connect** → **Session pooler** (Port 5432, IPv4). Nicht den Transaction-Pooler (Port 6543):
  Die Job-Queue (pg-boss, Schritt 7) braucht Session-Features.
- Die URL sieht so aus:
  `postgresql://postgres.<projekt-ref>:<passwort>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`
- Sonderzeichen im Passwort (`@`, `:`, `/`, `#`, `%` …) müssen URL-kodiert sein, z. B. `@` → `%40`.
  Am einfachsten: ein langes Passwort nur aus Buchstaben und Ziffern (Dashboard → Database → Reset password).
- **Kein** `?sslmode=…` anhängen. Die App erkennt Supabase-Hosts und erzwingt TLS mit Prüfung gegen das
  Supabase-Root-Zertifikat (`config/certs/supabase-prod-ca-2021.crt`, öffentlich, gültig bis 2031).

## 2. Schema anlegen (auf deinem Rechner)

Claude-Code-Cloud-Sessions erreichen Postgres-Port 5432 nicht (dort ist nur HTTPS freigegeben). Diese
Schritte laufen daher auf deinem Mac (oder später auf dem Server):

```sh
git clone https://github.com/christiandobler-a11y/agent.git avelio && cd avelio
git checkout claude/ecstatic-goldberg-lsnx6n   # bis der Stand in main ist
nvm use && npm install
cp .env.example .env    # DATABASE_URL (Supabase) und die anderen Keys eintragen

npm run check-env       # DATABASE_URL: "… 0 Migration(en) angewendet (TLS, Zertifikat geprüft)"
npm run migrate         # Angewendet: 001_init, 002_lock_down_data_api
npm run db-status       # alle Tabellen mit ✔, RLS an, Data API gesperrt
```

`db-status` endet mit Fehlercode 1, wenn eine Tabelle ungeschützt ist oder noch keine Migration lief.

Danach kannst du direkt die Recherche gegen Supabase ausprobieren:

```sh
npm run cli -- research "Fahrradladen" rosenheim -n 3
```

Die Ergebnisse siehst du im Dashboard unter **Table Editor** (`companies`, `search_runs`, `agent_runs`).

## 3. Einstellungen im Dashboard

| Einstellung | Wo | Wert | Warum |
|---|---|---|---|
| SSL erzwingen | Database → Settings, Abschnitt „SSL Configuration“ (`supabase.com/dashboard/project/_/database/settings`) | **Enforce SSL on incoming connections** an (Datenbank startet kurz neu) | Verbindungen ohne TLS werden abgelehnt. Erst einschalten, wenn `check-env` „TLS, Zertifikat geprüft“ meldet. |
| Data API | Integrations → Data API → Overview (`supabase.com/dashboard/project/_/integrations/data_api/overview`) | **Enable Data API** aus | Wir nutzen sie nicht. Migration 002 sperrt sie schon per RLS und Rechte; das ist die zweite Absicherung. |
| Security Advisor | Advisors → Security | keine Fehler | Prüft u. a., dass alle Tabellen RLS haben. Warnung „Extension in public“ (pg_trgm) ist bekannt und unkritisch. |
| Netzwerk-Beschränkung | Database → Settings → Network Restrictions | ab Schritt 9: nur Server-IP + deine IP | Datenbank nur von bekannten Adressen erreichbar. |

## 4. Was Migration 002 tut

Supabase veröffentlicht Tabellen im Schema `public` automatisch über die REST-API, erreichbar mit dem
öffentlichen `anon`-Key. Migration `002_lock_down_data_api.sql`

- schaltet Row Level Security auf allen Tabellen ein (ohne Policies, also kein Zugriff für `anon` und
  `authenticated`),
- entzieht diesen Rollen alle Rechte, auch für künftig angelegte Tabellen.

Die App verbindet sich als Tabellen-Eigentümer (`postgres`) und ist davon nicht betroffen. **Neue Tabellen in
späteren Migrationen** brauchen ebenfalls `alter table … enable row level security;` – `db-status` zeigt es an.

## 5. Gut zu wissen

- **Free-Plan pausiert** Projekte nach rund einer Woche ohne Aktivität. Wieder starten: Dashboard → „Restore“.
  Für den Dauerbetrieb (ab Schritt 9) ist der Pro-Plan mit täglichen Backups vorgesehen (ARCHITECTURE.md 13).
- **Logs → Postgres** zeigt rote Einträge `3F000 schema "pg_pgrst_no_exposed_schemas" does not exist`. Das ist
  harmlos und die Folge der abgeschalteten Data API: PostgREST läuft weiter, hat aber kein Schema mehr
  freigegeben und setzt diesen Platzhalter. Die Zeile `SET statement_timeout … count_estimate` stammt vom Table
  Editor im Dashboard.
- **Tests** laufen nie gegen Supabase, sondern gegen ein lokales Postgres (`TEST_DATABASE_URL`).
- **Schritt 9 (Deploy):** eigene Datenbank-Rolle für die App mit nur DML-Rechten; Migrationen laufen dann
  getrennt mit der Eigentümer-Rolle (ARCHITECTURE.md 12.1).

## 6. Fehlerbilder

| Meldung bei `check-env` | Ursache / Lösung |
|---|---|
| `timeout expired` | Netz blockiert Port 5432 (z. B. Claude-Cloud-Session, Firmen-WLAN) oder Projekt pausiert. |
| `password authentication failed` | Passwort falsch oder nicht URL-kodiert; Benutzer muss `postgres.<projekt-ref>` heißen. |
| `self-signed certificate in certificate chain` / `unable to verify` | Zertifikat passt nicht zur Supabase-CA im Repo. Bitte melden. Übergangsweise verschlüsselt, aber ohne Prüfung: `?sslmode=no-verify` an die URL hängen. |
| `Tenant or user not found` | Falscher Pooler-Host (Region) oder Projekt-Ref; URL neu aus „Connect“ kopieren. |
