import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import {
  teaserForCompany,
  teaserLook,
  usesTeaser,
  type TeaserDeps,
  type TeaserLook,
} from "../prototype/teaser.js";
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
  /** Andere Empfänger-Adresse, z. B. die Test-Adresse von mail-tester.com (dann ohne "[Probe]" im Betreff). */
  to?: string | null;
}

export interface ProbeResult {
  company: Company;
  /** Echte Empfänger-Adresse des Leads (nur zur Anzeige). */
  leadAddress: string | null;
  subject: string;
  body: string;
  teaser: string | null;
  /** Foto, Farben, Logo des Vorschau-Bildes (und warum kein eigenes Foto). */
  look: TeaserLook | null;
  /** Wohin die Probe ging (`null` = Postfach nicht eingerichtet, nur in Telegram gezeigt). */
  sentTo: string | null;
  costUsd: number;
  warnings: string[];
}

/**
 * Zufällige Leads, wie sie ins Morgen-Paket kämen (Vorschau-Bild-Branche, qualifiziert, mit Audit), damit Probeläufe
 * nicht immer dieselbe Praxis zeigen. Je Website nur ein Eintrag (05.10.2026: Google führt Standorte und Abteilungen
 * wie "Therapie Centrum Rosenheim" mehrfach, die kamen sonst ständig dran).
 */
export async function pickProbeLeads(db: Db, branches: readonly string[], count: number): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select * from (
       select distinct on (coalesce(regexp_replace(lower(c.website_url), '^https?://(www\\.)?([^/]+).*$', '\\2'), c.id::text))
              c.*
         from companies c
        where c.status in ('READY_FOR_CONTACT', 'QUALIFIED') and c.branch_key = any($1::text[])
          and exists (select 1 from audits a where a.company_id = c.id)
        order by coalesce(regexp_replace(lower(c.website_url), '^https?://(www\\.)?([^/]+).*$', '\\2'), c.id::text), random()
     ) one_per_site
     order by random()
     limit $2`,
    [branches, count],
  );
  return rows;
}

/** Wie viele verschiedene Praxen (je Website eine) für Probeläufe in Frage kommen. */
export async function probePoolSize(db: Db, branches: readonly string[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(distinct coalesce(regexp_replace(lower(c.website_url), '^https?://(www\\.)?([^/]+).*$', '\\2'), c.id::text))::int as n
       from companies c
      where c.status in ('READY_FOR_CONTACT', 'QUALIFIED') and c.branch_key = any($1::text[])
        and exists (select 1 from audits a where a.company_id = c.id)`,
    [branches],
  );
  return rows[0]?.n ?? 0;
}

export async function pickProbeLead(db: Db, branches: readonly string[]): Promise<Company | null> {
  return (await pickProbeLeads(db, branches, 1))[0] ?? null;
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
    const to = deps.to?.trim() || deps.mailbox.address;
    await deps.mailbox.send({
      to,
      subject: deps.to ? draft.subject : `[Probe] ${draft.subject}`,
      text: draft.body,
      ...(await withTeaser({ body: rows[0]?.body ?? draft.body, meta: rows[0]?.meta ?? {} })),
    });
    sentTo = to;
  }
  return {
    company,
    leadAddress: draft.to,
    subject: draft.subject,
    body: draft.body,
    teaser,
    look: teaser ? await teaserLook(deps.db, company.id) : null,
    sentTo,
    costUsd: draft.costUsd,
    warnings: draft.warnings,
  };
}
