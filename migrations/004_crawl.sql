-- Crawl (Schritt 5): Fehlerart getrennt von der Meldung (für Auswertung und Recheck) und gekürzter Seitentext
-- für das Audit (Startseite + Leistungen, höchstens ~1.500 Wörter, ARCHITECTURE.md 11.1).
alter table website_snapshots
  add column error_kind text,
  add column text_excerpt text;

create index website_snapshots_ok on website_snapshots (company_id) where error is null;
