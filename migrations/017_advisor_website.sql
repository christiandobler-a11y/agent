-- Berater (06.10.2026, Christian): der Optimierer schaut auch aufs Website-Bauen (Vorschau-Bild, Prototyp, fertige
-- Seite). Eigener Bereich, damit sich die Vorschläge auseinanderhalten lassen.
alter table advisor_suggestions drop constraint advisor_suggestions_area_check;
alter table advisor_suggestions add constraint advisor_suggestions_area_check
  check (area in ('prozess', 'wachstum', 'website'));
