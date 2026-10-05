-- Anruf-Liste (06.10.2026, Christian): Erstkontakt per Telefon. Sagt die Praxis Ja, geht die Mail mit Entwurf raus
-- (mit Einwilligung); sonst Brief. Der Anruf steht als eigener Eintrag im Tagesplan.
alter table outreach_plan drop constraint outreach_plan_channel_check;
alter table outreach_plan add constraint outreach_plan_channel_check check (channel in ('email', 'letter', 'phone'));
