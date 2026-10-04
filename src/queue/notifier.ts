import type { Interaction } from "../db/crm.js";
import type { SearchRun } from "../db/searchRuns.js";
import type { PlanBuildResult } from "../autopilot/plan.js";
import type { EveningSummary } from "../autopilot/schedule.js";

/**
 * Meldungen an Christian (ARCHITECTURE.md 5.2 Schritt 11, 11.1). In Schritt 8 per Telegram, sonst als Log.
 * Der Notifier darf nie den Workflow abbrechen: Fehler beim Senden werden geloggt, nicht geworfen.
 */

export interface TopLead {
  companyId: string;
  name: string;
  city: string | null;
  score: number;
  segment: string | null;
  mainOpportunity: string | null;
}

export interface RunSummary {
  run: SearchRun;
  /** Anzahl Firmen dieses Laufs je Endzustand. */
  counts: Record<string, number>;
  topLeads: TopLead[];
  costUsd: number;
  /** Abdeckung der Region für diese Branche nach dem Lauf, z. B. "◐ Hotel …: 9/28 Orte vollständig". */
  coverage?: string | undefined;
}

export interface Notifier {
  runCompleted(summary: RunSummary): Promise<void>;
  runFailed(run: SearchRun, error: string): Promise<void>;
  /** Höchstens einmal je Tag bzw. Monat (Dedupe übernimmt der Aufrufer). */
  budgetExceeded(message: string): Promise<void>;
  /** Fällige CRM-Erinnerungen (Phase 2). Optional: Kanäle ohne Zustellung ignorieren sie. */
  remindersDue?(reminders: DueReminder[]): Promise<void>;
  /** Morgen-Paket fertig (ab der Uhrzeit "morgens"). */
  planReady?(date: string, result: PlanBuildResult, nightReport?: string[]): Promise<void>;
  /** Abend-Bilanz des Morgen-Pakets. */
  eveningSummary?(summary: EveningSummary): Promise<void>;
  /** Antwort erkannt oder Mail unzustellbar. */
  mailEvent?(event: MailEvent): Promise<void>;
}

export type DueReminder = Interaction & { company_name: string };

/** Ereignisse aus Christians Posteingang (Antwort erkannt, Mail unzustellbar). */
export type MailEvent =
  | {
      kind: "reply";
      companyId: string;
      companyName: string;
      from: string | null;
      subject: string | null;
      excerpt: string;
      /** Angebotene Termine der ersten Mail (zum Bestätigen per Knopf). */
      offer?: { draftId: string; slots: string[] };
    }
  | { kind: "bounce"; companyId: string; companyName: string; address: string };

const log = (msg: string, extra: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: "info", msg, ...extra }));

export const logNotifier: Notifier = {
  runCompleted: (s) => {
    log("Suchlauf abgeschlossen", {
      run: s.run.id,
      counts: s.counts,
      top: s.topLeads.map((l) => `${l.name} ${l.score}`),
      cost_usd: s.costUsd,
      coverage: s.coverage,
    });
    return Promise.resolve();
  },
  runFailed: (run, error) => {
    log("Suchlauf fehlgeschlagen", { run: run.id, error });
    return Promise.resolve();
  },
  budgetExceeded: (message) => {
    log("Budget erreicht", { message });
    return Promise.resolve();
  },
  remindersDue: (reminders) => {
    log("Erinnerungen fällig", { reminders: reminders.map((r) => `${r.company_name}: ${r.body ?? ""}`) });
    return Promise.resolve();
  },
};

/** Mehrere Notifier (z. B. Log + Telegram); Fehler einzelner Kanäle stoppen die anderen nicht. */
export function combineNotifiers(...notifiers: Notifier[]): Notifier {
  const all = (fn: (n: Notifier) => Promise<void>) =>
    Promise.all(
      notifiers.map((n) =>
        fn(n).catch((err: unknown) =>
          console.error(
            JSON.stringify({ level: "error", msg: "Benachrichtigung fehlgeschlagen", error: String(err) }),
          ),
        ),
      ),
    ).then(() => undefined);
  return {
    runCompleted: (s) => all((n) => n.runCompleted(s)),
    runFailed: (r, e) => all((n) => n.runFailed(r, e)),
    budgetExceeded: (m) => all((n) => n.budgetExceeded(m)),
    remindersDue: (r) => all((n) => n.remindersDue?.(r) ?? Promise.resolve()),
  };
}
