import type { Db, DbClient } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { insertDraft } from "../db/drafts.js";
import type { OutreachConfig } from "./config.js";
import { pick, recipient, salutationLine } from "./draft.js";
import { duToIhr, lowerFirst, type Form } from "./form.js";
import { replySubject } from "./mail.js";
import { seedOf } from "./slots.js";

/**
 * Nachfass-Mail (Morgen-Paket): einmal nach `nach_tagen` ohne Antwort, im selben Verlauf (In-Reply-To), kurz und mit
 * offenem Ausstieg. Text aus `config/outreach.yaml → nachfassen`, kein LLM.
 */

export interface FirstMail {
  draftId: string;
  subject: string;
  to: string;
  messageId: string;
  previewUrl: string | null;
}

/**
 * Leads, bei denen die erste Mail älter als `days` Tage ist, keine Antwort kam (Status noch "kontaktiert"), sie nicht
 * unzustellbar war und noch nicht nachgefasst wurde.
 */
export async function dueFollowUps(
  db: DbClient,
  now: Date,
  days: number,
): Promise<{ company: Company; first: FirstMail }[]> {
  const { rows } = await db.query<Company & { f_id: string; f_meta: Record<string, string | null> }>(
    `select c.*, d.id as f_id, d.meta as f_meta
       from companies c
       join lateral (
         select id, meta from interactions
          where company_id = c.id and type = 'draft' and channel = 'email' and meta ? 'sent_at'
            and coalesce((meta->>'follow_up')::boolean, false) = false
          order by (meta->>'sent_at')::timestamptz asc limit 1
       ) d on true
      where c.status = 'CONTACTED'
        and (d.meta->>'sent_at')::timestamptz <= $1::timestamptz - make_interval(days => $2)
        and not (d.meta ? 'bounced_at')
        and not exists (
          select 1 from interactions f
           where f.company_id = c.id and f.type = 'draft' and f.channel = 'email'
             and coalesce((f.meta->>'follow_up')::boolean, false) = true
        )
      order by (d.meta->>'sent_at')::timestamptz`,
    [now, days],
  );
  return rows.map(({ f_id, f_meta, ...company }) => ({
    company: company,
    first: {
      draftId: f_id,
      subject: f_meta.subject ?? "",
      to: f_meta.to ?? "",
      messageId: f_meta.message_id ?? "",
      previewUrl: f_meta.preview_url ?? null,
    },
  }));
}

export function followUpBody(parts: {
  greeting: string;
  sentence: string;
  preview: string | null;
  exit: string;
  closing: string;
  signature: string;
}): string {
  return [
    parts.greeting,
    [lowerFirst(parts.sentence), parts.preview].filter(Boolean).join(" "),
    parts.exit,
    `${parts.closing}\n${parts.signature}`,
  ].join("\n\n");
}

export async function createFollowUpDraft(
  deps: { db: Db; outreach: OutreachConfig; phone: string | null; now: Date },
  company: Company,
  first: FirstMail,
  by: string,
): Promise<{ draftId: string; body: string; subject: string }> {
  const o = deps.outreach;
  const n = o.nachfassen;
  const person = await recipient(deps.db, company.id);
  const duBranch = company.branch_key !== null && o.du_branchen.includes(company.branch_key);
  const form: Form = !duBranch ? "sie" : person.name ? "du" : "ihr";
  const inForm = (sie: string, du: string) => (form === "sie" ? sie : form === "du" ? du : duToIhr(du));
  const seed = seedOf(company.id);
  const body = followUpBody({
    greeting: salutationLine(form, person, company.name),
    sentence: inForm(pick(n.saetze, seed, 5, 0), pick(n.saetze_du, seed, 5, 0)),
    preview: first.previewUrl ? inForm(n.entwurf, n.entwurf_du).replace("{link}", first.previewUrl) : null,
    exit: inForm(n.ausstieg, n.ausstieg_du),
    closing: pick(o.spamschutz.gruesse, seed, 17, 1),
    signature: [o.absender_name, o.absender_zusatz, deps.phone].filter(Boolean).join("\n"),
  });
  const subject = replySubject(first.subject);
  const draft = await insertDraft(deps.db, company.id, {
    channel: "email",
    body,
    meta: {
      subject,
      to: first.to,
      in_reply_to: first.messageId,
      follow_up: true,
      first_draft: first.draftId,
    },
    by,
    now: deps.now,
  });
  return { draftId: draft.id, body, subject };
}
