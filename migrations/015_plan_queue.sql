-- Verteilt senden (04.10.2026): "Alle senden" plant die Mails des Morgen-Pakets mit zufälligem Abstand ein (Status
-- 'queued', Zeitpunkt send_after); der Sweep verschickt jeweils die nächste fällige (src/outreach/queue.ts).
alter table outreach_plan drop constraint outreach_plan_status_check;
alter table outreach_plan add constraint outreach_plan_status_check
  check (status in ('ready', 'queued', 'done', 'later', 'dropped'));
alter table outreach_plan add column send_after timestamptz;
create index outreach_plan_queue on outreach_plan (send_after) where status = 'queued';
