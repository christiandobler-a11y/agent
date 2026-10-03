-- Anrede aus dem Impressum ("Herr"/"Frau"), nur wenn sie dort steht. Für "Hallo Frau Späth," in Kontakt-Entwürfen.
alter table contacts add column salutation text check (salutation in ('Herr', 'Frau'));
