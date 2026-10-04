import { claimState } from "../db/appState.js";
import type { Db } from "../db/client.js";

/**
 * Zahlen der Testphase (04.10.2026, Christian: "nach 100 / 200 / 500 Mails sehen, ob Termine reinkommen"; Grenze
 * ca. 150 €). Alles aus dem Verlauf berechnet, nichts extra gezählt. Meilensteine und die Warnung "keine Antworten"
 * meldet der Sweep je einmal.
 */

export interface OutreachStats {
  /** Neue Mails (Erstkontakt) gesendet. */
  sent: number;
  followUps: number;
  bounced: number;
  /** Firmen mit mindestens einer Antwort per Mail. */
  replied: number;
  /** Firmen, die einmal auf "interessiert" standen (Termin bestätigt o. Ä.). */
  interested: number;
  won: number;
  /** Ausgaben insgesamt (LLM + Google), in $. */
  costUsd: number;
}

export async function outreachStats(db: Db): Promise<OutreachStats> {
  const { rows } = await db.query<OutreachStats>(
    `select
       (select count(*)::int from interactions where type = 'draft' and channel = 'email' and meta ? 'sent_at'
          and coalesce((meta->>'follow_up')::boolean, false) = false and not (meta ? 'termin')) as "sent",
       (select count(*)::int from interactions where type = 'draft' and channel = 'email' and meta ? 'sent_at'
          and coalesce((meta->>'follow_up')::boolean, false) = true and not (meta ? 'termin')) as "followUps",
       (select count(*)::int from interactions where type = 'draft' and meta ? 'bounced_at') as "bounced",
       (select count(distinct company_id)::int from interactions
          where type = 'note' and created_by = 'mail' and body like 'Antwort%') as "replied",
       (select count(distinct company_id)::int from interactions where type = 'status' and to_status = 'INTERESTED')
          as "interested",
       (select count(distinct company_id)::int from interactions where type = 'status' and to_status = 'WON') as "won",
       (select coalesce(sum(cost_usd), 0)::float from agent_runs)
         + (select coalesce(sum(cost_usd), 0)::float from api_usage) as "costUsd"`,
  );
  return rows[0]!;
}

const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1).replace(".", ",")} %` : "–");
const eur = (usd: number) => `${(usd * 0.92).toFixed(2).replace(".", ",")} €`;

/** Übersicht als reiner Text (Telegram escaped beim Senden). */
export function statsText(s: OutreachStats, title = "📊 Zahlen bisher"): string {
  const perMail = s.sent > 0 ? s.costUsd / s.sent : 0;
  return [
    title,
    "",
    `📧 Neue Mails: ${s.sent} (+ ${s.followUps} Nachfass-Mails)`,
    `↩️ Unzustellbar: ${s.bounced} (${pct(s.bounced, s.sent)})`,
    `💬 Antworten: ${s.replied} (${pct(s.replied, s.sent)})`,
    `🤝 Interessiert / Termin: ${s.interested}`,
    `🏆 Aufträge: ${s.won}`,
    "",
    `💶 Kosten bisher: ca. ${eur(s.costUsd)}${s.sent > 0 ? ` (ca. ${eur(perMail)} je Mail)` : ""}`,
  ].join("\n");
}

export const MILESTONES = [50, 100, 200, 300, 500, 750, 1000];

/** Meilensteine und Warnungen, je einmal. Gibt die gemeldeten Texte zurück. */
export async function statsTick(db: Db, notify?: (text: string) => Promise<void>): Promise<string[]> {
  const s = await outreachStats(db);
  const out: string[] = [];
  for (const m of MILESTONES)
    if (s.sent >= m && (await claimState(db, `stats:milestone:${m}`, true)))
      out.push(statsText(s, `🎯 ${m} Mails raus. Zwischenstand:`));
  // Eine Antwortquote von 0 nach so vielen Mails spricht für Spam oder einen Text, der nicht zieht.
  if (s.sent >= 60 && s.replied === 0 && (await claimState(db, "stats:no-replies", true)))
    out.push(
      `⚠️ ${s.sent} Mails raus und noch keine einzige Antwort. Das spricht für Spam oder dafür, dass der Text nicht zieht. Schau bitte, was die Kontrollmails sagen, und lass uns Betreff und Text überdenken.`,
    );
  for (const t of out) await notify?.(t);
  return out;
}
