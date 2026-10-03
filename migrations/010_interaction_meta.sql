-- Kontakt-Entwürfe (Phase 2): Zusatzdaten je Eintrag, z. B. Betreff, Empfänger und angebotene Termine eines Entwurfs.
alter table interactions add column meta jsonb;
