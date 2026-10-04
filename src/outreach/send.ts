import { existsSync } from "node:fs";
import type { Db, DbClient } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { getState, setState } from "../db/appState.js";
import { setSalesStatus } from "../db/crm.js";
import type { MailEvent } from "../queue/notifier.js";
import {
  bounceOf,
  matchReply,
  normalizeAddress,
  normalizeId,
  replyExcerpt,
  textToHtml,
  type MailConfig,
  type Mailbox,
  type OutgoingMail,
  type SentRef,
} from "./mail.js";

/**
 * Versand eines E-Mail-Entwurfs über Christians Postfach (nur auf Knopfdruck) und Auswertung des Posteingangs:
 * Antworten setzen den Lead auf "geantwortet" und beenden das Nachfassen, Unzustellbar-Meldungen werden gemeldet.
 */

export interface SendDeps {
  db: Db;
  mailbox: Mailbox;
  mail: MailConfig;
  now: () => Date;
  followUpDays: number;
}

export type SendResult =
  | { kind: "sent"; company: Company; to: string; subject: string; followUp: boolean }
  | { kind: "already_sent" }
  | { kind: "no_address" }
  | { kind: "limit"; max: number }
  | { kind: "not_found" };

interface DraftRow {
  id: string;
  company_id: string;
  body: string | null;
  meta: {
    subject?: string;
    to?: string | null;
    /** Nachfassen: Message-ID der ersten Mail, damit es im selben Verlauf landet. */
    in_reply_to?: string | null;
    follow_up?: boolean;
    sent_at?: string;
    sending_at?: string;
    message_id?: string;
    /** Vorschau-Bild (Pfad) und der Absatz, unter dem es steht. */
    teaser?: string;
    teaser_after?: string | null;
  };
}

/** Wie viele neue Mails (ohne Nachfassen) heute schon rausgingen (deutscher Kalendertag). */
export async function sentToday(db: DbClient, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from interactions
      where type = 'draft' and channel = 'email' and meta ? 'sent_at'
        and coalesce((meta->>'follow_up')::boolean, false) = false
        and ((meta->>'sent_at')::timestamptz at time zone 'Europe/Berlin')::date
            = ($1::timestamptz at time zone 'Europe/Berlin')::date`,
    [now],
  );
  return rows[0]?.n ?? 0;
}

const ACTIVE_OR_LATER = new Set(["CONTACTED", "REPLIED", "INTERESTED", "PROTOTYPE", "WON", "LOST"]);

/** Vorschau-Bild als eingebettetes Bild unter seinem Satz; fehlt die Datei, geht die Mail als reiner Text raus. */
function withTeaser(draft: DraftRow): Pick<OutgoingMail, "html" | "attachments"> {
  const path = draft.meta.teaser;
  if (!path || !existsSync(path) || !draft.body) return {};
  const cid = "startseite-entwurf@avelio";
  return {
    html: textToHtml(draft.body, {
      cid,
      alt: "Entwurf Ihrer neuen Startseite",
      after: draft.meta.teaser_after ?? null,
    }),
    attachments: [{ filename: "startseite-entwurf.jpg", path, cid }],
  };
}

export async function sendDraft(deps: SendDeps, draftId: string, by: string): Promise<SendResult> {
  const { db } = deps;
  const now = deps.now();
  const { rows: found } = await db.query<DraftRow>(
    "select id, company_id, body, meta from interactions where id = $1 and type = 'draft' and channel = 'email'",
    [draftId],
  );
  const draft = found[0];
  if (!draft) return { kind: "not_found" };
  if (draft.meta.sent_at) return { kind: "already_sent" };
  const to = draft.meta.to?.trim();
  if (!to || !draft.body || !draft.meta.subject) return { kind: "no_address" };
  const followUp = draft.meta.follow_up === true;
  if (!followUp && (await sentToday(db, now)) >= deps.mail.max_per_day)
    return { kind: "limit", max: deps.mail.max_per_day };

  // Doppelklick-Schutz: nur wer den Entwurf als Erster beansprucht, sendet.
  const { rowCount } = await db.query(
    `update interactions set meta = meta || jsonb_build_object('sending_at', $2::text)
      where id = $1 and not (meta ? 'sent_at')
        and (not (meta ? 'sending_at') or (meta->>'sending_at')::timestamptz < $2::timestamptz - interval '5 minutes')`,
    [draftId, now.toISOString()],
  );
  if (rowCount !== 1) return { kind: "already_sent" };

  let messageId: string;
  try {
    ({ messageId } = await deps.mailbox.send({
      to,
      subject: draft.meta.subject,
      text: draft.body,
      inReplyTo: draft.meta.in_reply_to ?? null,
      ...withTeaser(draft),
    }));
  } catch (err) {
    await db.query("update interactions set meta = meta - 'sending_at' where id = $1", [draftId]);
    throw err;
  }
  await db.query(
    `update interactions set meta = (meta - 'sending_at') || jsonb_build_object('sent_at', $2::text, 'message_id', $3::text)
      where id = $1`,
    [draftId, now.toISOString(), messageId],
  );

  const { rows: companies } = await db.query<Company>("select * from companies where id = $1", [
    draft.company_id,
  ]);
  let company = companies[0]!;
  const note = `${followUp ? "Nachfass-Mail" : "E-Mail"} an ${to} gesendet: ${draft.meta.subject}`;
  if (!ACTIVE_OR_LATER.has(company.status)) {
    ({ company } = await setSalesStatus(db, company.id, "CONTACTED", {
      by,
      note,
      channel: "email",
      now,
      followUpDays: deps.followUpDays,
    }));
  } else {
    await db.query(
      `insert into interactions (company_id, type, channel, body, created_by, created_at)
       values ($1, 'note', 'email', $2, $3, $4)`,
      [company.id, note, by, now],
    );
  }
  if (followUp) {
    // Nachgefasst: die automatische Erinnerung ist erledigt.
    await db.query(
      `update interactions set done_at = $2
        where company_id = $1 and type = 'reminder' and done_at is null and created_by = 'system'`,
      [company.id, now],
    );
  }
  return { kind: "sent", company, to, subject: draft.meta.subject, followUp };
}

/** Gesendete Mails im Antwort-Fenster (für die Zuordnung eingehender Mails). */
export async function sentRefs(
  db: DbClient,
  now: Date,
  windowDays: number,
): Promise<(SentRef & { draftId: string })[]> {
  const { rows } = await db.query<{ id: string; company_id: string; message_id: string; to: string }>(
    `select id, company_id, meta->>'message_id' as message_id, meta->>'to' as to
       from interactions
      where type = 'draft' and channel = 'email' and meta ? 'message_id'
        and (meta->>'sent_at')::timestamptz > $1::timestamptz - make_interval(days => $2)`,
    [now, windowDays],
  );
  return rows.map((r) => ({ draftId: r.id, companyId: r.company_id, messageId: r.message_id, to: r.to }));
}

interface InboxState {
  uidValidity: string;
  lastUid: number;
}

const INBOX_KEY = "mail:inbox";

export interface ReplyDeps {
  db: Db;
  mailbox: Mailbox;
  mail: MailConfig;
  now: () => Date;
  notify?: (event: MailEvent) => Promise<void>;
}

/**
 * Posteingang seit dem letzten Lauf prüfen. Beim ersten Lauf (oder neu nummeriertem Postfach) nur den Stand merken,
 * damit alte Mails nicht als Antworten gelten. Gibt die erkannten Ereignisse zurück.
 */
export async function checkReplies(deps: ReplyDeps): Promise<MailEvent[]> {
  const { db } = deps;
  const now = deps.now();
  const state = await getState<InboxState>(db, INBOX_KEY);
  const first = await deps.mailbox.fetchSince(state ? state.lastUid : null);
  if (!state || state.uidValidity !== first.uidValidity) {
    await setState(db, INBOX_KEY, { uidValidity: first.uidValidity, lastUid: first.maxUid });
    return [];
  }
  const sent = await sentRefs(db, now, deps.mail.reply_window_days);
  const events: MailEvent[] = [];
  const own = normalizeAddress(deps.mailbox.address);
  for (const mail of first.mails.sort((a, b) => a.uid - b.uid)) {
    if (normalizeAddress(mail.from) === own) continue;
    const bounce = bounceOf(mail);
    if (bounce) {
      const ids = new Set(bounce.ids.map(normalizeId));
      const hit = sent.find((s) => ids.has(normalizeId(s.messageId)));
      if (hit) {
        await db.query(
          `update interactions set meta = meta || jsonb_build_object('bounced_at', $2::text) where id = $1`,
          [hit.draftId, now.toISOString()],
        );
        const company = await noteFor(db, hit.companyId, `Unzustellbar: ${hit.to}`, now);
        events.push({ kind: "bounce", companyId: hit.companyId, companyName: company.name, address: hit.to });
      }
    } else {
      const companyId = matchReply(mail, sent);
      if (companyId) {
        const excerpt = replyExcerpt(mail.text);
        let company = await noteFor(
          db,
          companyId,
          `Antwort per Mail von ${mail.from ?? "?"}: ${mail.subject ?? ""}\n\n${excerpt}`,
          now,
        );
        if (["READY_FOR_CONTACT", "CONTACTED", "QUALIFIED"].includes(company.status)) {
          ({ company } = await setSalesStatus(db, companyId, "REPLIED", {
            by: "mail",
            channel: "email",
            now,
            followUpDays: 0,
          }));
        }
        // Wer geantwortet hat, bekommt keine Nachfass-Mail mehr.
        await db.query(
          `update interactions set done_at = $2
            where company_id = $1 and type = 'reminder' and done_at is null and created_by = 'system'`,
          [companyId, now],
        );
        events.push({
          kind: "reply",
          companyId,
          companyName: company.name,
          from: mail.from,
          subject: mail.subject,
          excerpt,
        });
      }
    }
    await setState(db, INBOX_KEY, { uidValidity: first.uidValidity, lastUid: mail.uid });
  }
  if (first.mails.length === 0 && first.maxUid > state.lastUid)
    await setState(db, INBOX_KEY, { uidValidity: first.uidValidity, lastUid: first.maxUid });
  for (const e of events) await deps.notify?.(e).catch(() => undefined);
  return events;
}

async function noteFor(db: DbClient, companyId: string, body: string, now: Date): Promise<Company> {
  await db.query(
    `insert into interactions (company_id, type, channel, body, created_by, created_at)
     values ($1, 'note', 'email', $2, 'mail', $3)`,
    [companyId, body, now],
  );
  const { rows } = await db.query<Company>("select * from companies where id = $1", [companyId]);
  return rows[0]!;
}
