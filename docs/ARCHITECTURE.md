# Avelio Lead Engine – Discovery & Architektur (v0.1, Entwurf)

> Status: **Vorschlag zur Abstimmung**. Es ist noch kein Code geschrieben.
> Offene Entscheidungen stehen in [Abschnitt 16](#16-offene-entscheidungen-für-christian).

---

## 0. Kurzfassung

- **Das Rückgrat ist ein kleiner, deterministischer Workflow-Dienst** (ein Prozess, eine Postgres-Datenbank) und
  **kein Agenten-Netz**. Research, Crawling, Dubletten-Erkennung, Scoring und Retries sind normaler Code.
- **LLM-Aufrufe gibt es nur an drei Stellen**, jeweils als *einzelner, strukturierter API-Aufruf ohne Tools*:
  1. Vorfilter („passt die Firma überhaupt?“) → günstiges Modell
  2. Website-Audit (Screenshots + extrahierte Fakten → konkrete Probleme + Rubrik-Bewertungen) → mittleres Modell
  3. Pitch-Zusammenfassung nur für Top-Leads → starkes Modell
- **Der einzige echte Agent im MVP ist der Manager**: eine Claude-Tool-Schleife hinter Telegram, die *nur* über
  ~10 klar definierte Tools mit dem System spricht (Leads abfragen, Suche starten, Score erklären, Kosten zeigen …).
- **Der Score wird von Code berechnet, nicht vom LLM.** Das LLM liefert Rubrik-Bewertungen mit Belegen
  (z. B. „CTA-Klarheit mobil: 1/5, weil …“), der Code macht daraus Punkte. Jeder Punkt ist nachvollziehbar.
- **Claude-Code-Subagents, Agent Teams, Skills, n8n, LangGraph & Co. brauchen wir im Laufzeitsystem nicht.**
  Claude Code ist unser *Werkzeug zum Bauen*, und in Phase 3 der *Prototyp-Entwickler*.
- Grobe Kosten im MVP bei 100 auditierten Firmen/Tag: **≈ 10–35 €/Monat Infrastruktur + ≈ 60–150 $/Monat LLM**
  (je nach Batch-Nutzung). Mit einem objektiven Vorab-Gate (s. u.) eher am unteren Ende.

---

## 1. Was ich in deinem Setup gefunden habe

**Wichtig vorab:** Diese Session läuft in einem Cloud-Container von Claude Code, nicht auf deinem Mac.
Ich sehe deshalb nur, was in diesem Container und deinem claude.ai-Konto synchronisiert ist, und nicht dein lokales
`~/.claude` auf dem Mac. Falls du dort weitere Skills, Agents oder MCP-Server hast, schick mir die Ausgabe von:

```bash
ls ~/.claude/skills ~/.claude/agents ~/.claude/commands 2>/dev/null
claude mcp list
claude plugin list
```

### 1.1 Bestand

| Bereich | Gefunden | Relevanz für Avelio |
|---|---|---|
| Repository `agent` | leer (noch kein Commit) | Wir starten sauber. |
| Projekt-MCP (`.mcp.json`) | keiner | – |
| Lokale Subagents / Agent-Templates | keine | – |
| Multi-Agent-Frameworks | keine installiert | Gut so, siehe Abschnitt 4. |
| Laufzeit im Container | Node 22, Python 3.11, Docker, psql, Chromium/Playwright | Reicht für Entwicklung und Tests. |
| Connectors (claude.ai) | GitHub, Google Drive, Figma, Canva, Shopify, Claude Docs | GitHub: Repo/PRs. Figma/Canva: eventuell Phase 3. Rest irrelevant. |
| Synchronisierte Skills | ~50, u. a. siehe unten | Hilfreich **beim Bauen**, nicht im Laufzeitsystem. |

### 1.2 Skills, die wir konkret wiederverwenden

| Skill | Wofür | Wann |
|---|---|---|
| `claude-api` | Aktuelle Modell-IDs, Preise, Structured Outputs, Tool Runner, Batches, Caching | Bau von Audit-Call & Manager |
| `writing-plans`, `executing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion` | Disziplinierter Entwicklungsablauf | Gesamte Implementierung |
| `security-review`, `code-review` | Review vor jedem Deploy | Ab Schritt 5 |
| `backend-patterns` | Muster für Queue, Retries, API-Design | Pipeline/Worker |
| `ui-ux-pro-max`, `frontend-design`, `design-ui`, `web-artifacts-builder` | Design-Wissen für Redesign-Konzepte & Prototypen | **Phase 3** (Creative-/Prototype-Agent) |
| `mcp-builder` | Falls wir Avelio-Daten später als MCP in Claude Code/Desktop nutzen wollen | Optional, später |
| `browser-use` / `cloud` (Browser Use Cloud) | Gehostete Browser-Automation | **Nicht nötig**: Wir müssen nur Seiten laden und Screenshots machen. Playwright lokal genügt und kostet nichts. |

### 1.3 Was es für unseren Kern *nicht* fertig gibt

Für „lokale Firmen finden → Website auditieren → Avelio-Score → Telegram“ gibt es kein Plugin oder Template, das
wir einfach übernehmen könnten. Die vorhandenen „Lead-Gen-Agent“-Open-Source-Projekte sind typischerweise auf
US-B2B (Apollo/LinkedIn, Massen-Cold-Mail) ausgelegt und passen weder zu lokalen DACH-Betrieben noch zum deutschen
Recht (siehe 12.3). Wiederverwenden lassen sich **Bausteine**, nicht ein fertiges System:

| Baustein | Fertige Lösung | Unser Eigenanteil |
|---|---|---|
| Firmen finden | Google Places API (New) | Suchstrategie (Orte kacheln), Filter |
| Seite rendern, Screenshots | Playwright (Open Source) | Fakten-Extraktion |
| Performance/Mobile/SEO-Messung | Google PageSpeed Insights API (kostenlos, Lighthouse) | – |
| Job-Queue, Retries, Cron, Dead-Letter | `pg-boss` (TS) bzw. `procrastinate` (Python), beide auf Postgres | Job-Definitionen |
| Telegram-Bot, Buttons | `grammY` (TS) bzw. `python-telegram-bot` | Befehle, Formatierung |
| LLM-Aufrufe, Structured Output, Tool-Schleife | Anthropic SDK (Structured Outputs, Tool Runner, Batches) | Prompts, Schemas |
| Datenbank + Tabellen-Oberfläche | Supabase (Postgres + Studio-UI) | Schema |
| Prototypen bauen (Phase 3) | Claude Agent SDK / Claude-Code-Cloud-Sessions | Briefing-Format, Sandbox |

**Avelio-spezifisch und damit selbst zu schreiben** sind nur: Suchstrategie, Fakten-Extraktion, Audit-Prompt und
Rubrik, Score-Formel, Manager-Tools und die Telegram-Texte. Das ist der Teil, der dein Geschäftswissen enthält,
also genau der, den wir selbst besitzen *wollen*.

---

## 2. Grundsatzentscheidung: Wie viel „Agent“ brauchen wir?

Ich habe jede Rolle gegen vier Fragen geprüft: Ist die Aufgabe offen und nicht vorab spezifizierbar? Rechtfertigt der
Nutzen Kosten und Latenz? Kann Claude es gut? Lassen sich Fehler abfangen?

| Rolle (deine Liste) | Umsetzung | Begründung |
|---|---|---|
| **Manager** | **Echter Agent** (Claude-Tool-Schleife) | Freie Sprache aus Telegram → muss entscheiden, welche Tools/Abfragen nötig sind. |
| **Research** | **Workflow-Code** + 1 günstiger LLM-Klassifikations-Call | Places-Suche, Dubletten-Abgleich und Normalisierung sind deterministisch. Nur „Kette/Franchise? passt zur Zielgruppe?“ braucht Urteil. |
| **Website Audit** | **Workflow-Code** + 1 LLM-Call mit Bildern | Laden, Screenshots und Messen sind Code. Die *Interpretation* („Leasing ist kaum sichtbar“) ist ein einzelner strukturierter Call, keine Schleife. |
| **Qualification** | **Reiner Code** (Score-Formel) + optional 1 starker Call für Top-Leads | Der Score muss erklärbar und stabil sein, also kein „LLM sagt 87“. |
| **Sales/CRM** (Phase 2) | Code (Status, Reminder) + Entwurfs-Call | Status-Logik ist Code, Anschreiben-Entwurf ist ein LLM-Call. |
| **Creative** (Phase 3) | 1–2 LLM-Calls (starkes Modell) | Strukturiertes Briefing-Dokument als Output. |
| **Prototype/Dev** (Phase 3) | **Echter Agent** (Claude Agent SDK oder Claude-Code-Cloud-Session) | Offene Coding-Aufgabe mit Dateien, Build und Tests. Dort ist ein Agent sinnvoll. |

**Folge:** Im MVP gibt es **einen** Agenten (Manager) und **drei** LLM-Funktionen. Die „Mitarbeiter“ existieren für
dich trotzdem als Rollen: Der Manager berichtet „Research hat 42 Firmen gefunden, Audit hat 18 geprüft …“, und jeder
`agent_run` ist mit seiner Rolle protokolliert. Intern sind es aber robuste Funktionen statt frei laufender Prozesse.

---

## 3. Bewertung der Claude-nativen Optionen

| Option | Was es ist | Für Avelio |
|---|---|---|
| **Claude API** (Messages, Structured Outputs, Tool Runner, Batches) | Direkte Modellaufrufe aus unserem Code | ✅ **MVP-Kern.** Audit-Call, Vorfilter, Manager-Schleife. Volle Kontrolle über Kosten und Logging. |
| **Claude Code Subagents / Skills / Agent Teams** | Funktionen *innerhalb* einer laufenden Claude-Code-Sitzung | 🛠 **Zum Bauen**, nicht für den 24/7-Betrieb. Sie brauchen eine laufende Claude-Code-Sitzung und sind auf interaktives Arbeiten ausgelegt. |
| **Claude Code Routines + Channels (Telegram-Plugin)** | Geplante Cloud-Sessions bzw. Telegram-Nachrichten in eine laufende Sitzung | ⚠️ Verlockend („fast kein Code“), aber für das Rückgrat ungeeignet: Jeder Lauf ist eine LLM-gesteuerte Sitzung. Das verbraucht ein Vielfaches an Tokens pro Lead, ist nicht deterministisch, Dubletten-Garantien und Retries pro Lead sind schwach, und es fällt unter das begrenzte Agent-SDK-Guthaben deines Abos. **Gut geeignet für Phase 3** (Prototyp in einer Cloud-Session bauen lassen). |
| **Claude Agent SDK** | Claude-Code-Harness als Bibliothek, mit Datei-/Bash-Tools | 🔜 **Phase 3:** Prototype-Agent in einem abgeschotteten Projektordner. Im MVP unnötig. |
| **Managed Agents** (Anthropic hostet Loop + Sandbox) | Gehostete Agenten mit Container, Scheduling, Outcomes | 🔜 **Phase-3-Alternative** zum Agent SDK (Vorteil: Code läuft nicht auf unserem Server). Für die Lead-Pipeline zu schwergewichtig. |
| **MCP** | Standard-Schnittstelle für Tools | Im Laufzeitsystem nicht nötig: Der Manager ruft unsere eigenen Funktionen direkt als Tools auf. **Optional:** Supabase-MCP in deinem lokalen Claude Code, damit du dort direkt Fragen an die Lead-Datenbank stellen kannst. |

---

## 4. Was wir bewusst weglassen

| Kandidat | Warum nicht (jetzt) |
|---|---|
| **n8n** | Zweites System mit eigener Logik, eigenem Deploy und eigener Fehlerbehandlung. Claude Code schreibt TypeScript schneller und testbarer, als man n8n-Flows klickt. Versionierung, Tests und Code-Review gehen in n8n schlecht. |
| **LangGraph / CrewAI / AutoGen** | Lösen „viele Agenten reden miteinander“, ein Problem, das wir bewusst nicht haben. Mehr Abstraktion und mehr Token, weniger Kontrolle. |
| **Redis / BullMQ / Temporal** | `pg-boss` liefert Queue, Retries, Backoff, Timeouts, Cron und Dead-Letter **in derselben Postgres-DB**. Ein bewegliches Teil weniger. |
| **Firecrawl** | Kostenpflichtig. Wir brauchen gerenderte Seite, Screenshots und HTML, das kann Playwright. Firecrawl bleibt Notlösung für hartnäckige Seiten. |
| **Apollo** | Schlechte Abdeckung bei kleinen lokalen DACH-Betrieben. Das **Impressum** ist in Deutschland Pflicht und die beste Quelle für Inhaber, E-Mail und Telefon. |
| **Webhook-Server / öffentliche Domain für den Bot** | Telegram **Long Polling** braucht keine öffentliche URL, kein TLS und keinen Reverse-Proxy. |
| **Vektordatenbank / RAG** | Alle Daten sind strukturiert. SQL beantwortet „Leads > 85 in Rosenheim“ exakt. |
| **Separate Prozesse pro „Mitarbeiter“** | Ein Prozess mit Worker-Concurrency reicht für hunderte Leads/Tag. |

---

## 5. Architektur

### 5.1 Übersicht

```
                         ┌──────────────────────────┐
   Du (iPhone/Mac) ◄────►│     Telegram Bot API     │
                         └────────────┬─────────────┘
                                      │ Long Polling (keine öffentliche URL nötig)
┌─────────────────────────────────────▼──────────────────────────────────────────┐
│  avelio-app  (EIN Node-Prozess, Docker, auf kleinem VPS)                       │
│                                                                                │
│  ┌───────────────────────┐   Tools (typisiert, begrenzt)                       │
│  │ Telegram-Adapter      │──►┌──────────────────────────────┐                  │
│  │ • Chat-ID-Allowlist   │   │  MANAGER-AGENT               │                  │
│  │ • Buttons/Callbacks   │◄──│  Claude-Tool-Schleife        │                  │
│  └───────────────────────┘   │  search_leads · list_leads   │                  │
│                              │  get_lead · explain_score    │                  │
│                              │  skip_lead · stats · costs   │                  │
│                              └──────────────┬───────────────┘                  │
│                                             │ legt Jobs an / liest DB          │
│  ┌──────────────────────────────────────────▼───────────────────────────────┐  │
│  │  WORKFLOW-ENGINE (pg-boss: Queue · Retries · Timeouts · Cron · DLQ)      │  │
│  │                                                                          │  │
│  │  research ──► dedupe ──► prefilter ──► gate ──► crawl ──► audit ──► score│  │
│  │  (Places)     (Code)     (LLM klein)   (Code)   (Playwright (LLM mittel) (Code)
│  │                                                 + PSI +                  │  │
│  │                                                 Impressum)               │  │
│  │                                        notify ◄── run_complete           │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ┌──────────────────────────────┐   ┌──────────────────────────────────────┐   │
│  │ LLM-Gateway (ein Modul)      │   │ Budget-Wächter                       │   │
│  │ • Modellwahl je Aufgabe      │   │ • Tages-/Monatslimit in $            │   │
│  │ • Caching, Retries           │   │ • pausiert Queue + meldet Telegram   │   │
│  │ • schreibt agent_runs        │   └──────────────────────────────────────┘   │
│  │   (Tokens, Kosten, Fehler)   │                                              │
│  └──────────────────────────────┘                                              │
└───────────────┬───────────────────────────────┬───────────────────┬────────────┘
                │                               │                   │
     ┌──────────▼───────────┐       ┌───────────▼─────────┐  ┌──────▼───────────────┐
     │ Postgres (Supabase,  │       │ Externe APIs        │  │ Screenshots          │
     │ EU/Frankfurt)        │       │ • Anthropic         │  │ (Volume auf VPS oder │
     │ Firmen · Audits ·    │       │ • Google Places     │  │  Supabase Storage)   │
     │ Scores · Jobs · Logs │       │ • PageSpeed Insights│  └──────────────────────┘
     └──────────────────────┘       └─────────────────────┘

  Phase 3 (später, angedockt über einen Job-Typ „prototype“):
     prototype-Job ──► Claude Agent SDK / Claude-Code-Cloud-Session
                       (eigener Ordner/Repo, kein Zugriff auf Prod-DB-Secrets)
                       ──► Preview-Deploy (Vercel/Cloudflare Pages) ──► Telegram-Link
```

### 5.2 Ablauf einer Suche („Such mir 20 Fahrradläden im Landkreis Rosenheim“)

1. **Telegram → Manager:** Der Manager versteht die Absicht und ruft `search_leads({branche, region, ziel: 20})` auf.
2. **search_run anlegen:** Datensatz mit Ziel und Status. Der Manager antwortet sofort: „Läuft, ich melde mich.“
3. **research:** Places Text Search, gekachelt über Orte der Region (eine Query liefert maximal 60 Treffer).
   Die Suche läuft so lange weiter, bis genug *neue, qualifizierbare* Firmen da sind (Übersuche um Faktor 3–5).
4. **dedupe:** Abgleich gegen den Bestand (Place-ID → Domain → Name+PLZ, siehe Abschnitt 8).
   Bekannte Firmen vor `recheck_after` werden übersprungen.
5. **prefilter (Haiku):** Kette/Franchise? Passt die Branche? Geschäftlich aktiv? → sonst `SKIPPED` mit Grund.
6. **gate (Code, kostenlos):** Objektive Mindestwerte (z. B. Bewertung ≥ 4,0 und ≥ 15 Bewertungen, Status
   OPERATIONAL). **Spart die meisten LLM-Kosten**, weil schwache Firmen nie auditiert werden.
   *Umsetzung (Schritt 3):* Das Gate läuft **vor** dem Prefilter, weil es nichts kostet und sonst jede schwache
   Firma einen Haiku-Aufruf verbraucht. Es prüft zusätzlich die Ketten-Namensliste aus `config/branches.yaml`.
7. **crawl:** Startseite und bis zu 3 Unterseiten (Leistungen, Kontakt, Impressum). Screenshots desktop und mobil,
   Fakten extrahieren, PageSpeed mobil. Impressum parsen (Inhaber, E-Mail, Telefon).
8. **audit (Sonnet, mit Bildern):** Konkrete Probleme mit Belegen und Rubrik-Bewertungen als striktes JSON.
9. **score (Code):** Avelio Lead Score inklusive Aufschlüsselung, Status `QUALIFIED` oder `SKIPPED`.
10. **pitch (Opus, nur Score ≥ 80):** „Hauptchance“ in 2–3 Sätzen und die 3 stärksten Argumente.
11. **notify:** Wenn alle Jobs des Runs terminal sind (fertig/übersprungen/fehlgeschlagen), sendet der Bot eine
    Telegram-Zusammenfassung mit Top-Leads und Buttons `[Details] [Skip] [Contact Prep] [Prototyp]`.

Jeder Schritt ist ein **eigener Job pro Firma**. Fällt eine Website aus, scheitert nur dieser Job (mit Retries),
nicht der ganze Lauf.

---

## 6. Komponenten: Was · Warum · Was passiert ohne

| Komponente | Was sie macht | Warum | Ohne sie … |
|---|---|---|---|
| **Postgres (Supabase)** | Einziges Gedächtnis: Firmen, Audits, Scores, Jobs, Logs | Zustand überlebt Neustarts, SQL für alle Fragen, Studio-UI als „Gratis-CRM-Ansicht“ | … stünde alles im Agent-Kontext und wäre nach Neustart weg. Dubletten wären unvermeidbar. |
| **pg-boss** | Queue, Retries mit Backoff, Timeouts, Cron, Dead-Letter | Robustheit ohne Extra-Infrastruktur | … müssten wir das selbst bauen (fehleranfällig) oder Redis betreiben. |
| **Playwright + Chromium** | Seiten rendern, Screenshots desktop/mobil, DOM-Fakten | Modernes/veraltetes Design erkennt man nur visuell. JS-Seiten (Wix/Jimdo) brauchen echtes Rendering. | … nur HTML-Text: Design und Mobile-Eindruck nicht bewertbar. |
| **PageSpeed Insights API** | Lighthouse-Werte (Performance, SEO, Best Practices, Accessibility) mobil | Kostenlose, objektive Zahlen für Score und Verkaufsargument („mobil 23/100“) | … weniger objektive Belege, mehr reines LLM-Urteil. |
| **Google Places API (New)** | Firmen, Bewertung, Anzahl Bewertungen, Website, Telefon, Status | Beste Quelle für lokale Betriebe inklusive Reputationsdaten | … keine Reputationsdaten. Verzeichnisse scrapen ist rechtlich und technisch wackelig. |
| **Anthropic API** | Vorfilter, Audit, Pitch, Manager | Urteil, wo Regeln nicht reichen | … kein Audit-Text, kein natürlicher Chat. |
| **LLM-Gateway (eigenes Modul, ~150 Zeilen)** | Ein Ort für Modellwahl, Retries, Kosten-Logging, Budget | Kostenkontrolle und „welcher Agent hat das erzeugt?“ | … verstreute API-Calls, keine Kostenübersicht. |
| **Telegram-Bot (grammY)** | Chat und Buttons | Dein gewünschtes Interface | … CLI/Supabase-UI als Interface (geht, ist aber unbequem). |
| **VPS (z. B. Hetzner, DE)** | Läuft 24/7 mit Docker Compose | Unabhängig von deinem Mac, günstig, DSGVO-freundlich | … läuft nichts, wenn der Mac zu ist. |

---

## 7. Avelio Lead Score (Vorschlag v1)

### 7.1 Prinzipien

1. **Knock-outs vor Punkten.** Manche Firmen sind kein Lead, egal wie schlecht die Website ist.
2. **Objektive Daten zählen, wo sie existieren.** Das LLM bewertet nur, was sich nicht messen lässt, und zwar
   als **Rubrik (1–5 je Kriterium, mit Beleg)**, nicht als Punktzahl. Der Code rechnet um.
3. **Die „Lücke“ ist das Avelio-Signal:** Starke Firma mit schwacher Website ist der beste Lead.
4. **Versioniert und gespeichert:** Jeder Score speichert `scoring_version` und die volle Aufschlüsselung.

### 7.2 Knock-outs (→ `SKIPPED` mit Grund)

- Places-Status `CLOSED_TEMPORARILY` / `CLOSED_PERMANENTLY`
- Kette/Franchise/Filiale eines Konzerns (Vorfilter oder Namensliste)
- Bewertung < 3,5 bei ≥ 10 Bewertungen, oder < 5 Bewertungen insgesamt (mit Schalter, siehe 7.4)
- Website wirkt bereits modern **und** technisch gut (Website-Chance < 8/30)
- Branche oder Region außerhalb des Ziels, Blockliste, bereits im CRM aktiv

### 7.3 Dimensionen (Summe 100)

| Dimension | Pkt | Quelle | Inhalt |
|---|---|---|---|
| **A. Business-Gesundheit** | 25 | objektiv | Bewertung (≥ 4,7 → voll), Anzahl Bewertungen (log-skaliert, ~150+ → voll), Aktualität der neuesten Bewertungen, Fotos vorhanden |
| **B. Website-Chance** | 30 | 12 objektiv + 18 Rubrik | *Objektiv:* PSI mobil, kein HTTPS, kein Viewport-Meta, kein `tel:`-Link, Copyright-Jahr alt, veralteter Baukasten/CMS. *Rubrik (LLM, 1–5):* Design-Aktualität, mobile Nutzbarkeit, CTA-Klarheit, Sichtbarkeit der Kernleistungen, Vertrauenssignale, Hero-Aussage |
| **C. Wirtschaftliches Potenzial** | 20 | Konfig + Rubrik | Branchenwert aus Konfigurationstabelle (z. B. E-Bike/Leasing, Bad/Sanierung hoch; Kleinstdienstleister niedriger), erkannte hochpreisige Leistungen, Größensignale (Team, mehrere Mitarbeiter) |
| **D. Reputations-Website-Lücke** | 15 | berechnet + Rubrik | `min(A_norm, B_norm)`: hoch nur, wenn Firma stark **und** Website schwach. Dazu „Erklärbarkeit“: Gibt es ≥ 3 konkret zeigbare Probleme? |
| **E. Erreichbarkeit** | 10 | objektiv | Inhaber namentlich im Impressum, direkte E-Mail, Telefon, Kontaktformular |

**Beispiel aus deinem Briefing:** Firma A (4,8★ / 170 Bewertungen, Website ~2014, mobil schwach, kein CTA) ergibt
A ≈ 23, B ≈ 26, C ≈ 14, D ≈ 14, E ≈ 8, also **≈ 85–91**. Firma B (2,2★) fällt per Knock-out raus, mit dem
gespeicherten Grund „Reputation zu schwach (2,2★)“.

**Sonderfall „keine Website“:** eigenes Segment `NO_WEBSITE`. Kein Audit nötig (spart Kosten), B wird maximal
gesetzt, aber getrennt gelistet, weil der Pitch anders ist („Sie werden online nicht gefunden“ statt „Redesign“).

### 7.4 Kalibrierung (wichtiger als die Startgewichte)

Bevor der Score produktiv wird, bewertest **du** 20–30 echte Firmen per Bauchgefühl (A/B/C). Wir vergleichen das
mit dem System und justieren die Gewichte. Diese **Golden-Set-Liste** bleibt als Regressionstest im Repo: Jede
Prompt- oder Gewichtsänderung muss sie bestehen. Alle Schwellen und Gewichte liegen in einer Konfigurationsdatei,
nicht im Code verstreut.

### 7.5 „Warum hat dieser Lead 91 Punkte?“

Der Manager liest `lead_scores.breakdown` und antwortet z. B.:

```
Fahrrad Müller – 91/100 (Scoring v1, 02.10.)
A Business 24/25  4,8★ bei 153 Bewertungen, letzte vor 6 Tagen
B Website  27/30  PSI mobil 21/100 · kein CTA mobil · Design ~2014 (Rubrik 1/5)
C Potenzial 16/20 E-Bike-Leasing + Werkstatt erkannt
D Lücke    14/15  starke Reputation, schwache Website
E Kontakt  10/10  Inhaber Thomas Müller im Impressum, direkte E-Mail
Bewertet von: audit (Sonnet, Run #812), score (Code)
```

---

## 8. Dubletten & Firmenidentität

Abgleich in fester Reihenfolge, jeweils mit Unique-Index in der Datenbank (nicht nur im Code):

1. **Google Place ID** (stabilster Schlüssel)
2. **Normalisierte Domain** (`www.`, Protokoll und Pfad entfernt, Kleinschreibung).
   Ausnahme: Plattform-Domains (facebook.com, instagram.com, jimdo/wix-Subdomains, Branchenportale) gelten nicht als
   Identität, dort zählt der volle Host bzw. Pfad.
3. **Normalisierter Name + PLZ** (Rechtsformen wie GmbH/e.K. entfernt, Umlaute normalisiert, Trigram-Ähnlichkeit
   via `pg_trgm` ≥ 0,8)

**Recheck-Regeln:** `recheck_after` je Endstatus, z. B. `QUALIFIED`: 90 Tage, `SKIPPED (Website gut)`: 180 Tage,
`SKIPPED (Reputation)`: 365 Tage, `LOST`: nie automatisch. Neu gefundene, bekannte Firmen aktualisieren nur
`last_seen_at` und die Places-Momentaufnahme.

**Website-Snapshots** speichern einen `content_hash`. Hat sich die Seite beim Recheck nicht geändert, gibt es kein
neues LLM-Audit.

---

## 9. Datenbankschema (MVP + vorbereitet für später)

```sql
-- Kern ------------------------------------------------------------------
companies (
  id uuid pk,
  name text, name_normalized text,
  place_id text unique null, domain text unique null,
  street text, postal_code text, city text, region text, lat/lng numeric,
  category text, branch_key text,              -- unsere Branchen-Taxonomie
  phone text, website_url text,
  segment text,                                -- WEBSITE | NO_WEBSITE
  status text not null default 'NEW',          -- CRM-Status (Abschnitt 9.1)
  skip_reason text null, skip_detail text null,
  current_score int null, current_score_id uuid null,
  recheck_after timestamptz null,
  first_seen_at, last_seen_at, updated_at,
  first_search_run_id uuid
)
places_snapshots (                              -- Google-Daten mit Zeitstempel (siehe 12.4)
  id, company_id, fetched_at, rating numeric, review_count int,
  business_status text, latest_review_at timestamptz, photo_count int, raw jsonb
)
website_snapshots (
  id, company_id, fetched_at, url, final_url, http_status, https bool,
  facts jsonb,                                  -- extrahierte DOM-Fakten (klein!)
  psi jsonb,                                    -- Lighthouse-Kennzahlen
  screenshot_desktop text, screenshot_mobile text,
  content_hash text, error text null
)
audits (
  id, company_id, website_snapshot_id, agent_run_id,
  prompt_version text, model text,
  findings jsonb,      -- [{title, detail, evidence, severity, category}]
  rubric jsonb,        -- {design_age:{score:1-5, evidence}, mobile_ux:…, cta:…}
  commercial jsonb,    -- erkannte Leistungen, Größensignale
  summary text, created_at
)
lead_scores (
  id, company_id, audit_id null, scoring_version text,
  total int, breakdown jsonb,                   -- je Dimension: Punkte, Gründe, Quelle
  knocked_out bool, knockout_reason text null, created_at
)
contacts (
  id, company_id, name, role, email, phone, source text,   -- 'impressum' | 'places'
  created_at
)

-- Betrieb & Nachvollziehbarkeit ----------------------------------------
search_runs (
  id, requested_by text, query jsonb, target_count int,
  status text, stats jsonb, created_at, finished_at
)
agent_runs (
  id, role text,                -- manager | prefilter | audit | pitch | creative …
  company_id null, search_run_id null, job_id null,
  model text, prompt_version text,
  input_summary text, output_summary text,
  input_tokens int, output_tokens int, cache_read_tokens int,
  cost_usd numeric(10,5), status text, error text null,
  started_at, finished_at
)
messages (                       -- Telegram-Verlauf = Manager-Gedächtnis
  id, chat_id bigint, direction text, text text,
  tool_calls jsonb null, created_at
)
-- Jobs: von pg-boss verwaltet (eigenes Schema "pgboss"), inkl. Retries/Dead-Letter.

-- Phase 2 -----------------------------------------------------------------
interactions (id, company_id, type, channel, body, draft bool, due_at, done_at, created_at)
-- Phase 3 -----------------------------------------------------------------
prototype_jobs (id, company_id, briefing jsonb, status, repo_url, preview_url, cost_usd, …)
```

Für Fragen wie „Kosten diese Woche“, „Leads > 85“ und „Stand der Pipeline“ legen wir **SQL-Views** an
(`v_lead_overview`, `v_costs_daily`, `v_pipeline_status`). Der Manager liest nur diese Views.

### 9.1 Status-Modell

```
NEW → RESEARCHED → AUDITED → QUALIFIED → READY_FOR_CONTACT → CONTACTED → REPLIED
                                  │                                    → INTERESTED → PROTOTYPE → WON
                                  └→ SKIPPED (+ skip_reason)                                     → LOST
technisch zusätzlich: FAILED (+ Fehler, erneut versuchbar)
```

Pipeline-Status (`NEW` … `QUALIFIED/SKIPPED`) setzt der Workflow, Vertriebsstatus (ab `READY_FOR_CONTACT`) nur du
oder der CRM-Teil auf deine Anweisung. Jeder Statuswechsel wird als `interactions`-Eintrag protokolliert (ab Phase 2).

---

## 10. Agenten- und LLM-Struktur

| Rolle | Modell (Vorschlag) | Eingabe | Ausgabe | Tools | Darf |
|---|---|---|---|---|---|
| **Manager** | Sonnet 5.5 (umschaltbar auf Opus 5.5) | Telegram-Text, letzte N Nachrichten | Antwort + Tool-Aufrufe | ~10 eigene Funktionen | DB-Views lesen, Jobs anlegen, Status `SKIPPED` setzen. **Nicht:** crawlen, Mails senden, SQL frei ausführen |
| **Prefilter** | Haiku 4.5 | Name, Kategorie, Places-Daten (~500 Tokens) | `{fit, is_chain, branch_key, reason}` | keine | nichts außer Antwort |
| **Audit** | Sonnet 5.5, niedriger Effort | 2 Screenshots + Fakten-JSON + gekürzter Text (~6k Tokens) | Findings + Rubrik + Commercial (strenges Schema) | **keine** | nichts außer Antwort |
| **Pitch** (Score ≥ 80) | Opus 5.5 | Audit + Score + Places-Daten | Hauptchance, 3 Argumente | keine | nichts außer Antwort |
| *Phase 2:* Contact Prep | Sonnet 5.5 | Lead-Dossier | Entwurf (Brief/Anruf-Leitfaden/E-Mail) | keine | nur Entwurf speichern |
| *Phase 3:* Creative | Opus 5.5 | Dossier + Screenshots | Briefing (Struktur, Hero, CTAs, visuelle Richtung) | keine | – |
| *Phase 3:* Prototype | Agent SDK / Cloud-Session | Briefing | Code + Preview-URL | Dateien/Bash **nur im Projektordner** | eigenes Repo/Ordner, kein Prod-Secret |

**Modellwahl:** Die Zuordnung steht in der Konfiguration, nicht im Code. Wir messen in Woche 1 Qualität und Kosten
pro Rolle und justieren dann. Modell-IDs und Preise habe ich aus der aktuellen Claude-API-Referenz übernommen:
Haiku 4.5 1 $/5 $, Sonnet 5.5 2 $/10 $, Opus 5.5 4 $/20 $ je 1M Input/Output-Tokens.

**Sicherheitsprinzip „Audit-LLM ohne Tools“:** Gecrawlte Websites sind *fremder, nicht vertrauenswürdiger Inhalt*
(Prompt-Injection möglich, z. B. versteckter Text „ignoriere alle Anweisungen …“). Weil das Audit-Modell keine Tools
hat und nur ein festes JSON-Schema zurückgeben kann, richtet so etwas höchstens eine falsche Bewertung an, keinen
Schaden. Der Manager sieht nie rohes HTML, nur unsere strukturierten Felder.

---

## 11. Kosten- und Fehlerkontrolle

### 11.1 Kosten

- **Objektives Gate vor jedem teuren Call** (Abschnitt 5.2, Schritt 6): größter Hebel.
- **Input klein halten:** Statt HTML-Blob gehen ~40 extrahierte Fakten (Titel, H1, Navigationspunkte, CTA-Texte,
  `tel:`/`mailto:`-Links, Viewport, Generator/CMS, Copyright-Jahr, Wortzahl, Bildanzahl …), ~1.500 Wörter
  bereinigter Text und 2 verkleinerte Screenshots an das Modell.
- **Prompt-Caching** für System-Prompt und Rubrik (stabiler Präfix).
- **Batch API (−50 %)** für nächtliche Läufe ab Phase 2. Interaktive Suchen laufen sofort.
- **Keine Doppel-Audits:** `content_hash` und `recheck_after`.
- **Budget-Wächter:** Tages- und Monatslimit in $. Bei Überschreitung pausiert die Queue und Telegram meldet
  „Budget erreicht, weiter mit /budget +5“.
- **Jeder Call** schreibt Tokens und Kosten in `agent_runs`.

### 11.2 Fehler

| Fall | Behandlung |
|---|---|
| Website down / Timeout / DNS | 2 Retries mit Backoff (5 min, 1 h), dann `FAILED (unreachable)`. Ein Recheck in 7 Tagen. |
| CAPTCHA / Bot-Schutz | Erkennen (Cloudflare-Seite, leere Seite), `FAILED (blocked)`, nicht weiter bohren |
| Places/PSI-Timeout, 429 | Retries mit exponentiellem Backoff, Rate-Limit pro API |
| Claude-API-Fehler | SDK-Retries für 429/5xx, danach Job-Retry, Schema-Verletzung → 1 Wiederholung, dann `FAILED` |
| Prozess-Neustart | pg-boss übernimmt Jobs mit abgelaufenem Lock, idempotente Jobs (Upsert über Firmen-ID) |
| DB kurz weg | Verbindungs-Retry, Healthcheck schlägt Alarm |
| Dauerhaft fehlgeschlagen | Dead-Letter-Queue, Ansicht im Telegram via „Was ist fehlgeschlagen?“ |
| Prozess hängt / abgestürzt | Docker `restart: unless-stopped` + Heartbeat. Ausbleibender Heartbeat → externer Uptime-Check (z. B. Healthchecks.io, kostenlos) meldet sich |

**Grundregel:** Ein Job = eine Firma × ein Schritt. Kein Lauf scheitert an einem einzelnen Lead.

---

## 12. Sicherheit, Berechtigungen, Recht

### 12.1 Berechtigungen (technisch erzwungen, nicht nur per Prompt)

- Der **Telegram-Bot** reagiert nur auf deine Chat-ID (Allowlist), alles andere wird ignoriert und geloggt.
- **Manager-Tools** sind feste Funktionen mit validierten Parametern. Es gibt kein freies SQL und keine Shell.
  Zerstörerische Aktionen (z. B. Massen-Skip) fragen per Button nach.
- **Datenbank-Rolle der App:** nur DML auf eigene Tabellen, kein DDL. Migrationen laufen separat beim Deploy.
- **Secrets** liegen nur als Umgebungsvariablen auf dem Server, nie im Repo. Jedes Modul bekommt nur seinen Key
  (der Crawler braucht z. B. keinen Anthropic-Key).
- **Keine** Zahlungsdaten, keine Domain-/DNS-Zugänge, kein E-Mail-Versand im MVP.
- **Phase 3 Prototype-Agent:** läuft in eigenem Container bzw. eigener Cloud-Session mit eigenem Repo, ohne
  DB-Secrets und mit beschränkten Tools. Deploy nur als Preview.

### 12.2 Logging

`agent_runs` (wer, was, Modell, Tokens, Kosten, Fehler), `search_runs` (Lauf-Statistik), Job-Historie in pg-boss,
`lead_scores.breakdown` (Begründung), `messages` (Chat-Verlauf), dazu strukturiertes JSON-Logging auf stdout.

### 12.3 Rechtlicher Hinweis zu Outreach (DE) – *keine Rechtsberatung*

- **E-Mail-Werbung an Unternehmen ohne vorherige Einwilligung ist nach § 7 UWG in Deutschland grundsätzlich
  unzulässig**, auch B2B. Das bestätigt deine Entscheidung, keine automatischen Cold-Mails zu schicken.
- B2B-**Anrufe** sind bei „mutmaßlicher Einwilligung“ möglich, **Briefe** sind in der Regel unproblematisch.
  Ein persönlicher Brief mit Screenshot „vorher/nachher“ kann für lokale Betriebe sehr wirksam sein.
- **DSGVO:** Namen und Kontaktdaten von Inhabern sind personenbezogene Daten. Grundlage ist i. d. R. berechtigtes
  Interesse. Wir speichern minimal, löschen `SKIPPED`-Kontakte nach Frist automatisch, und bei Kontaktaufnahme
  besteht Informationspflicht (Art. 14).
- Bitte vor Phase 2 kurz mit einer Fachperson (z. B. IHK-Merkblatt) abgleichen.

### 12.4 Google-Places-Nutzungsbedingungen

Google erlaubt das dauerhafte Speichern der **Place ID**, aber nicht beliebiges Vorhalten der übrigen Places-Inhalte.
Deshalb sind Places-Daten als **zeitgestempelte Momentaufnahmen** (`places_snapshots`) getrennt von unseren eigenen
Daten (Audit, Score, Impressum-Kontakte) gespeichert und werden bei Bedarf frisch abgerufen. Die genauen Fristen
prüfe ich vor der Umsetzung in den aktuellen Bedingungen.

---

## 13. Externe Accounts / API-Keys

| Dienst | Zweck | Wann | Kosten |
|---|---|---|---|
| **Anthropic Console** (API-Key, Workspace mit Ausgabelimit) | LLM-Aufrufe | MUST (MVP) | Nutzungsbasiert |
| **Google Cloud** (Places API (New) + PageSpeed Insights API, ein Key, auf diese 2 APIs beschränkt, Budget-Alarm) | Firmen + Messung | MUST (MVP) | Places: Freikontingente pro Monat, danach ~32–35 $/1.000 Requests. PSI kostenlos |
| **Telegram** (@BotFather → Bot-Token, deine Chat-ID) | Interface | MUST (MVP) | kostenlos |
| **Supabase** (Projekt in EU/Frankfurt) | Postgres + UI | MUST (MVP) | Free zum Start, Pro 25 $/Monat für Backups im Betrieb |
| **Hetzner Cloud** (oder Railway) | 24/7-Server | MUST (MVP, ab Deploy-Schritt) | ~5–10 €/Monat |
| **GitHub** | Repo, CI | vorhanden | kostenlos |
| Healthchecks.io | Ausfallalarm | NICE | kostenlos |
| Vercel oder Cloudflare Pages | Preview-Deploys von Prototypen | LATER (Phase 3) | Free-Tier reicht anfangs |
| Firecrawl | Fallback-Crawler | LATER, nur bei Bedarf | – |

---

## 14. MUST / NICE / LATER

**MUST HAVE (MVP)**
- Telegram-Bot mit Allowlist und Manager-Agent (Suche starten, Leads listen/filtern, Lead-Details, Score erklären,
  Skip, Status, Kosten)
- Research über Places mit Orts-Kachelung, Dubletten-Erkennung, Recheck-Regeln
- Vorfilter, objektives Gate, Crawl (Screenshots, Fakten, Impressum, PSI), Audit, Score mit Aufschlüsselung
- Pitch-Zusammenfassung für Top-Leads
- pg-boss-Jobs mit Retries, Timeouts und Dead-Letter, Wiederaufnahme nach Neustart
- `agent_runs`-Logging mit Kosten, Budget-Wächter
- Golden-Set-Kalibrierung, Deploy auf VPS, Backups

**NICE TO HAVE (MVP+, wenn billig)**
- Screenshot direkt im Telegram-Detailview
- `/costs`, `/failed`, `/budget` als Schnellbefehle
- Supabase-MCP in deinem lokalen Claude Code zum Herumfragen
- Healthchecks.io-Alarm

**LATER**
- *Phase 2:* CRM-Statuswechsel per Button, Notizen, Kontakt-Entwürfe (Brief/Anruf/E-Mail), Follow-up-Reminder,
  Daily Standup 08:00, nächtliche automatische Recherche (Cron + Batch API), Wochenreport
- *Phase 3:* Creative-Briefing, Prototype-Agent, Preview-Deploy, Review-Schritt, „Bau einen Prototyp“-Button
- *Regionen-Abdeckung Deutschland (Wunsch vom 03.10.2026):* ein auf die Regionen-Suche spezialisierter Agent, damit
  kein Fleck in Deutschland vergessen wird. Skizze:
  - **Abdeckung ist Code, nicht LLM.** Grundlage ist das amtliche Gemeindeverzeichnis (Destatis, rund 10.800 Gemeinden
    mit Gemeindeschlüssel, Einwohnern und Koordinaten). Regionen-Dateien (`config/regions/*.yaml`) werden daraus
    erzeugt statt von Hand gepflegt. Großstädte werden nach Stadtteilen gekachelt, weil Places höchstens 60 Treffer je
    Anfrage liefert.
  - **Abdeckungs-Tabelle** je Gemeinde × Branche: zuletzt gesucht, Treffer, Leads, Kosten. Das zeigt jederzeit, was
    noch fehlt, z. B. als Karte oder Liste („Landkreis Traunstein: 12 von 35 Gemeinden, Hotels fehlen noch“).
  - **Der Agent plant nur:** Er schlägt die nächsten Gebiete vor (Lücken, Ergiebigkeit bisheriger Gebiete, Budget) und
    startet Suchen über die vorhandenen Werkzeuge. Christian bestätigt in Telegram, nächtliche Läufe kommen aus Phase 2.
  - **Kosten grob:** etwa 3 Cent je Places-Anfrage. Ganz Deutschland für eine Branche mit einer Anfrage je Gemeinde
    kostet rund 350 $ Places plus Audits (3–5 Cent je Firma, die durchs Gate kommt). Daher Gebiet für Gebiet
    innerhalb des Budgets.

---

## 15. Repository-Struktur (Vorschlag, TypeScript)

```
avelio/
├── CLAUDE.md                     # Regeln für Claude Code in diesem Repo
├── docs/
│   ├── ARCHITECTURE.md           # dieses Dokument
│   ├── SCORING.md                # Score-Definition, Versionen, Kalibrierung
│   └── adr/                      # kurze Architekturentscheidungen (1 Datei je Entscheidung)
├── config/
│   ├── scoring.v1.yaml           # Gewichte, Schwellen, Knock-outs
│   ├── branches.yaml             # Branchen-Taxonomie + wirtschaftlicher Wert
│   ├── regions/oberbayern.yaml   # Orte für die Places-Kachelung
│   └── models.yaml               # Modell je Rolle, Budgets
├── prompts/
│   ├── prefilter.v1.md
│   ├── audit.v1.md
│   ├── pitch.v1.md
│   └── manager.v1.md
├── src/
│   ├── main.ts                   # startet Bot + Worker + Scheduler
│   ├── db/                       # Schema, Migrationen, Repositories, Views
│   ├── queue/                    # pg-boss-Setup, Job-Typen, Retry-Policies
│   ├── pipeline/
│   │   ├── research/             # places.ts, tiling.ts, dedupe.ts, prefilter.ts
│   │   ├── crawl/                # browser.ts, facts.ts, impressum.ts, pagespeed.ts
│   │   ├── audit/                # audit.ts, schema.ts (Zod)
│   │   └── scoring/              # score.ts, explain.ts  (rein, voll unit-getestet)
│   ├── llm/                      # gateway.ts (Modellwahl, Logging, Kosten, Budget)
│   ├── manager/                  # tools.ts, agent.ts
│   ├── telegram/                 # bot.ts, format.ts, keyboards.ts
│   └── cli.ts                    # jeden Schritt einzeln ausführbar (Debugging!)
├── tests/
│   ├── fixtures/sites/           # gespeicherte Beispiel-Websites
│   └── golden/                   # deine Referenzbewertungen
├── Dockerfile
├── docker-compose.yml            # app (+ lokales Postgres für Entwicklung)
└── .github/workflows/ci.yml      # Lint, Typecheck, Tests
```

---

## 16. Offene Entscheidungen für Christian

1. **Sprache: TypeScript (Empfehlung) oder Python?**
   TypeScript: dieselbe Sprache wie deine Websites (Phase 3 wird einfacher), grammY und pg-boss sind sehr ausgereift,
   Playwright ist dort nativ. Python wäre gleichwertig möglich (python-telegram-bot, procrastinate).
   *Bindet uns langfristig, daher bitte bestätigen.*
2. **Hosting: Hetzner-VPS (Empfehlung, am günstigsten, DE) oder Railway (bequemer, kein Server-Admin, etwas teurer)?**
3. **Datenbank: Supabase (Empfehlung, Tabellen-UI + Backups) oder Postgres selbst auf dem VPS (0 € extra, Backups selbst)?**
4. **Score-Gewichte** (25/30/20/15/10) als Startpunkt in Ordnung?
5. **Zielmarkt für Kalibrierung:** Welche 2–3 Branchen × Regionen zuerst? Was ist ein typisches Projektvolumen pro
   Branche (für „wirtschaftliches Potenzial“)?
6. **Lokales Claude-Setup** (Ausgabe der Befehle aus Abschnitt 1)

---

## 17. Aufwand & Kosten (grobe Schätzung)

### 17.1 Entwicklungsaufwand (mit Claude Code, Schritt für Schritt mit dir)

| Paket | Aufwand |
|---|---|
| MVP (Schritte 1–10 unten) | **~7–10 Arbeitstage**, verteilt auf 2–3 Wochen inkl. Kalibrierung |
| Phase 2 (CRM, Entwürfe, Reminder, Daily Standup, nächtliche Läufe) | ~4–6 Tage |
| Phase 3 (Creative, Prototype-Agent, Preview-Deploy, Review) | ~5–10 Tage |

### 17.2 Laufende Kosten bei ~100 *auditierten* Firmen/Tag (~3.000/Monat)

| Posten | Annahme | €/$ pro Monat |
|---|---|---|
| VPS | Hetzner, 2–4 vCPU / 4–8 GB (Chromium braucht RAM) | ~5–10 € |
| Supabase | Free → Pro | 0–25 $ |
| Google Places | ~200–300 Firmen/Tag gefunden ≈ 15–30 Text-Search-Requests/Tag (20 Treffer je Seite) ≈ 450–900/Monat | ~0–20 $ (großteils im Freikontingent) |
| PageSpeed Insights | 3.000/Monat | 0 $ |
| Prefilter (Haiku) | ~6.000 Calls × ~0,002 $ | ~12 $ |
| Audit (Sonnet 5.5) | 3.000 × ~6k Input + ~3k Output ≈ 0,04–0,05 $ | ~120–150 $ (mit Batch ~60–75 $) |
| Pitch (Opus 5.5) | ~300 Top-Leads × ~0,05 $ | ~15 $ |
| Manager (Chat) | ~20 Nachrichten/Tag | ~10–20 $ |
| **Summe** | | **≈ 10–35 € Infra + ≈ 100–200 $ LLM**, mit Batch und Gate eher **60–120 $** |

**Ehrliche Einordnung:** 100 vollständig auditierte Firmen pro Tag sind vermutlich mehr, als du vertrieblich
bearbeiten kannst. Realistischer Start: 20–40 Audits/Tag, das entspricht **≈ 30–50 $ LLM/Monat**. Die
tatsächlichen Kosten pro Lead messen wir in Woche 1 aus `agent_runs`, statt weiter zu schätzen.

---

## 18. MVP-Abnahmekriterien

1. Telegram: „Such mir 20 Fahrradläden im Landkreis Rosenheim“ → Bestätigung in < 10 s, Ergebnisnachricht mit
   Top-Leads in < 30 min.
2. Jede gefundene Firma endet in einem Endzustand: `QUALIFIED`, `SKIPPED` (mit Grund) oder `FAILED` (mit Fehler).
   Keine hängenden Jobs.
3. Dieselbe Suche erneut ausführen → **0 neue Dubletten**, **0 erneute Audits** vor `recheck_after`.
4. „Warum hat X 91 Punkte?“ und „Warum wurde Y aussortiert?“ werden aus gespeicherten Daten korrekt beantwortet,
   inklusive Rolle und Modell, das die Bewertung erzeugt hat.
5. „Was hat das diese Woche gekostet?“ stimmt auf ±5 % mit der Anthropic-Console überein.
6. Prozess während eines Laufs hart beenden → nach Neustart läuft der Lauf weiter, ohne verlorene oder doppelte Jobs.
7. Nicht erreichbare oder blockierte Website → nur dieser Lead `FAILED`, der Lauf läuft weiter.
8. Budget-Limit greift: Queue pausiert, Telegram meldet sich.
9. Fremde Telegram-Accounts bekommen keine Antwort.
10. **Kalibrierung:** Auf deinem Golden Set (≥ 20 Firmen) liegen deine Top-5 in den System-Top-8, und keine
    deiner „C“-Firmen erreicht Score ≥ 80.
11. Durchschnittliche LLM-Kosten pro auditierter Firma ≤ 0,08 $.
12. Läuft 7 Tage auf dem Server ohne manuellen Eingriff.

---

## 19. Implementierungsplan (kleine, einzeln prüfbare Schritte)

Jeder Schritt endet mit etwas, das du **selbst ausprobieren** kannst, und mit grünen Tests.
Nach Schritt 0 und Schritt 6 stimmen wir uns ausdrücklich ab.

| # | Schritt | Ergebnis / Prüfung |
|---|---|---|
| **0** | Entscheidungen aus Abschnitt 16 + Accounts/Keys anlegen | Du hast Keys, wir haben Sprache/Hosting fixiert |
| **1** | Repo-Gerüst: TS-Projekt, Lint/Typecheck/Test, CI, `CLAUDE.md`, docker-compose mit lokalem Postgres | `npm test` grün, CI grün |
| **2** | DB-Schema + Migrationen + Identitäts-/Dedupe-Logik | Unit-Tests: gleiche Firma über Place-ID/Domain/Name+PLZ wird erkannt |
| **3** | Research: Places-Suche mit Orts-Kachelung, Prefilter (Haiku), Gate → CLI `avelio research "Fahrradladen" rosenheim -n 20` | Firmen stehen in der DB, Dubletten-Test mit Doppellauf |
| **4** | LLM-Gateway: Modellwahl, Retries, `agent_runs`, Kosten, Budget-Wächter | Jeder Call erscheint mit Kosten in `agent_runs` |
| **5** | Crawl: Playwright-Screenshots desktop/mobil, Fakten, Impressum, PSI → CLI `avelio crawl <id>` | Snapshot + Screenshots für 10 echte Seiten, Fehlerfälle getestet |
| **6** | Audit-Call + Score-Engine + Erklärung → CLI `avelio audit <id>`, `avelio explain <id>` | **Kalibrier-Workshop mit dir am Golden Set**, Gewichte anpassen |
| **7** | Workflow: pg-boss-Jobs verketten, Retries, Timeouts, Dead-Letter, `search_run`-Abschluss | Kill-Test (Kriterium 6), Fehler-Test (Kriterium 7) |
| **8** | Telegram-Bot + Manager-Agent mit Tools, Buttons, Allowlist | Kriterien 1, 4, 5, 9 über echtes Telegram |
| **9** | Deploy: Dockerfile, VPS, Secrets, Backups, Healthcheck | Läuft ohne deinen Mac |
| **10** | 1 Woche Echtbetrieb, Kosten messen, nachjustieren | **MVP-Abnahme** (Abschnitt 18) |

Danach: Phase 2 und 3 jeweils mit eigenem kurzen Plan auf Basis der Erfahrungen aus Schritt 10.
