import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { teaserForCompany, usesTeaser, type TeaserDeps } from "../prototype/teaser.js";
import { draftEmail, type OutreachDeps } from "./draft.js";
import type { Mailbox } from "./mail.js";
import { withTeaser } from "./send.js";

/**
 * Probelauf (04.10.2026, Christian): eine Mail genau wie im Morgen-Paket (Vorschau-Bild, Text, Termine), aber an
 * Christians eigenes Postfach mit "[Probe]" im Betreff. Kein Status, kein Plan, keine XP; der Entwurf wird danach
 * wieder gelöscht, damit er nirgends als echter Entwurf auftaucht.
 */

export interface ProbeDeps {
  db: Db;
  outreach: OutreachDeps;
  mailbox: Mailbox | null;
  teaser: TeaserDeps | null;
}

export interface ProbeResult {
  company: Company;
  /** Echte Empfänger-Adresse des Leads (nur zur Anzeige). */
  leadAddress: string | null;
  subject: string;
  body: string;
  teaser: string | null;
  /** Wohin die Probe ging (`null` = Postfach nicht eingerichtet, nur in Telegram gezeigt). */
  sentTo: string | null;
  costUsd: number;
  warnings: string[];
}

/** Bester Lead fürs Morgen-Paket aus den Vorschau-Bild-Branchen (vorgemerkt zuerst, dann Score), mit Audit. */
export async function pickProbeLead(db: Db, branches: readonly string[]): Promise<Company | null> {
  const { rows } = await db.query<Company>(
    `select c.* from companies c
      where c.status in ('READY_FOR_CONTACT', 'QUALIFIED') and c.branch_key = any($1::text[])
        and exists (select 1 from audits a where a.company_id = c.id)
      order by (c.status = 'READY_FOR_CONTACT') desc, c.current_score desc nulls last
      limit 1`,
    [branches],
  );
  return rows[0] ?? null;
}

export async function runProbe(
  deps: ProbeDeps,
  company: Company,
  by: string,
): Promise<ProbeResult | { kind: "no_audit" }> {
  const teaser = usesTeaser(deps.teaser, company)
    ? await teaserForCompany(deps.db, deps.teaser!, company)
    : null;
  const draft = await draftEmail(deps.outreach, company, by);
  if ("kind" in draft) return draft;
  const { rows } = await deps.db.query<{
    body: string;
    meta: { teaser?: string; teaser_after?: string | null };
  }>("select body, meta from interactions where id = $1", [draft.draftId]);
  await deps.db.query("delete from interactions where id = $1", [draft.draftId]);
  let sentTo: string | null = null;
  if (deps.mailbox) {
    await deps.mailbox.send({
      to: deps.mailbox.address,
      subject: `[Probe] ${draft.subject}`,
      text: draft.body,
      ...(await withTeaser({ body: rows[0]?.body ?? draft.body, meta: rows[0]?.meta ?? {} })),
    });
    sentTo = deps.mailbox.address;
  }
  return {
    company,
    leadAddress: draft.to,
    subject: draft.subject,
    body: draft.body,
    teaser,
    sentTo,
    costUsd: draft.costUsd,
    warnings: draft.warnings,
  };
}
