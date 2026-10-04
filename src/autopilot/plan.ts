import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { addPlanItem, planItems } from "../db/plan.js";
import { BudgetExceededError } from "../llm/budget.js";
import { draftEmail, recipient, type OutreachDeps } from "../outreach/draft.js";
import { createFollowUpDraft, dueFollowUps, dueLetterFollowUps } from "../outreach/followup.js";
import { draftLetter, type LetterDeps } from "../outreach/letter.js";
import type { MxCheck } from "../outreach/mx.js";
import { buildPrototype, type PrototypeDeps } from "../prototype/run.js";
import { teaserForCompany, usesTeaser, type TeaserDeps } from "../prototype/teaser.js";

/**
 * Morgen-Paket (Phase 2): Avelio bereitet nachts den Tagesplan vor. Zuerst fällige Nachfass-Mails, dann neue Leads
 * (vorgemerkte zuerst, dann nach Score): Prototyp bauen, dann Mail oder Befund-Seite. Nichts wird verschickt; das
 * passiert erst morgens per Knopf in Telegram.
 */

const hm = z.string().regex(/^\d{2}:\d{2}$/);
export const autopilotConfigSchema = z.object({
  zeiten: z.object({ vorbereiten: hm, morgens: hm, abends: hm }),
  neue_kontakte: z.object({
    stufen: z.array(z.object({ ab_tag: z.number().int().min(0), pro_tag: z.number().int().min(0) })).min(1),
    nur_werktags: z.boolean(),
    bremse: z
      .object({
        quote: z.number().min(0).max(1),
        mindestens: z.number().int().min(1),
        tage: z.number().int().min(1),
      })
      .default({ quote: 0.05, mindestens: 20, tage: 7 }),
  }),
  briefe: z.object({
    pro_tag: z.number().int().min(0),
    ab_score: z.number().int(),
    /** Brief als zweites Nachfassen: so viele Tage nach der Nachfass-Mail ohne Antwort (nur ab `ab_score`). */
    nachfassen_nach_tagen: z.number().int().min(1).default(7),
  }),
  prototyp_fuer_neue: z.boolean(),
  nachfassen: z.object({ nach_tagen: z.number().int().min(1), hoechstens: z.number().int().min(0) }),
  suche: z
    .object({
      aktiv: z.boolean(),
      ab: hm,
      pro_nacht: z.number().int().min(0),
      regionen: z.array(z.string()),
      branchen: z.array(z.string()),
    })
    .default({ aktiv: false, ab: "22:00", pro_nacht: 0, regionen: [], branchen: [] }),
});
export type AutopilotConfig = z.infer<typeof autopilotConfigSchema>;
export const loadAutopilotConfig = () => loadYamlConfig("autopilot.yaml", autopilotConfigSchema);

export interface PlanDeps {
  db: Db;
  now: () => Date;
  config: AutopilotConfig;
  /** Für Mails (draftEmail) und Briefe (draftLetter, mit Renderer und Prototyp-Screenshots). */
  letter: LetterDeps;
  prototype: PrototypeDeps | null;
  /** Einheitliches Vorschau-Bild statt Prototyp für bestimmte Branchen (Physio). */
  teaser?: TeaserDeps | null;
  mx: MxCheck;
  /** Ablage der Brief-PDFs (z. B. data/letters). */
  lettersDir: string;
}

export interface PlanBuildResult {
  date: string;
  followups: number;
  emails: number;
  letters: number;
  prototypes: number;
  skipped: { name: string; reason: string }[];
  stoppedByBudget: boolean;
  warnings: string[];
}

/** Kalendertag in Deutschland (YYYY-MM-DD). */
export function berlinDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);
}

/** Uhrzeit in Deutschland (HH:MM), zum Vergleich mit den Zeiten aus config/autopilot.yaml. */
export function berlinTime(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(d);
}

export function isWeekday(d: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" }).format(d);
  return !["Sat", "Sun"].includes(day);
}

/**
 * Wie viele neue Kontakte heute: Stufe nach Tagen seit der ersten gesendeten Mail (Aufwärmen der Adresse). Kamen
 * zuletzt zu viele Mails als unzustellbar zurück (`bremse`), eine Stufe tiefer.
 */
export function dailyNewCount(
  config: AutopilotConfig,
  now: Date,
  firstSentAt: Date | null,
  bounces: { sent: number; bounced: number } = { sent: 0, bounced: 0 },
): { count: number; braked: boolean } {
  const n = config.neue_kontakte;
  if (n.nur_werktags && !isWeekday(now)) return { count: 0, braked: false };
  const stages = [...n.stufen].sort((a, b) => a.ab_tag - b.ab_tag);
  const days = firstSentAt ? (now.getTime() - firstSentAt.getTime()) / 86_400_000 : 0;
  let stage = 0;
  stages.forEach((s, i) => {
    if (days >= s.ab_tag) stage = i;
  });
  const braked =
    bounces.sent >= n.bremse.mindestens && bounces.bounced / bounces.sent > n.bremse.quote && stage > 0;
  return { count: stages[braked ? stage - 1 : stage]!.pro_tag, braked };
}

/** Gesendete neue Mails und davon unzustellbare in den letzten `days` Tagen. */
async function recentBounces(db: Db, now: Date, days: number): Promise<{ sent: number; bounced: number }> {
  const { rows } = await db.query<{ sent: number; bounced: number }>(
    `select count(*)::int as sent, count(*) filter (where meta ? 'bounced_at')::int as bounced
       from interactions
      where type = 'draft' and channel = 'email' and meta ? 'sent_at'
        and coalesce((meta->>'follow_up')::boolean, false) = false
        and (meta->>'sent_at')::timestamptz > $1::timestamptz - make_interval(days => $2)`,
    [now, days],
  );
  return rows[0] ?? { sent: 0, bounced: 0 };
}

/** Kanal je Lead: Brief für die stärksten (solange Platz) und für Leads ohne Mail; sonst Mail; sonst nichts. */
export function chooseChannel(
  lead: { hasAddress: boolean; mailOk: boolean },
  lettersLeft: number,
): "email" | "letter" | null {
  // 04.10.2026 (Christian): Erstkontakt immer per Mail; Brief nur ohne erreichbare Mail-Adresse (und später als
  // Nachfassen für sehr gute Leads, siehe dueLetterFollowUps).
  if (lead.mailOk) return "email";
  if (lead.hasAddress && lettersLeft > 0) return "letter";
  return null;
}

async function firstSentAt(db: Db): Promise<Date | null> {
  const { rows } = await db.query<{ first: Date | null }>(
    `select min((meta->>'sent_at')::timestamptz) as first from interactions
      where type = 'draft' and channel = 'email' and meta ? 'sent_at'`,
  );
  return rows[0]?.first ?? null;
}

/** Befund-Seite erstellen, als PDF/PNG ablegen und in den Plan nehmen; `false`, wenn es nicht ging. */
async function planLetter(
  deps: PlanDeps,
  company: Company,
  date: string,
  by: string,
  kind: "new" | "followup",
  result: PlanBuildResult,
): Promise<boolean> {
  const letter = await draftLetter(deps.letter, company, by, { followUp: kind === "followup" });
  if ("kind" in letter) {
    result.skipped.push({ name: company.name, reason: letter.kind });
    return false;
  }
  const dir = join(deps.lettersDir, date);
  await mkdir(dir, { recursive: true });
  const pdf = join(dir, letter.filename);
  const png = pdf.replace(/\.pdf$/, ".png");
  await writeFile(pdf, letter.pdf);
  await writeFile(png, letter.png);
  await deps.db.query(
    `update interactions set meta = meta || jsonb_build_object('pdf', $2::text, 'png', $3::text) where id = $1`,
    [letter.draftId, pdf, png],
  );
  await addPlanItem(deps.db, {
    date,
    companyId: company.id,
    kind,
    channel: "letter",
    draftId: letter.draftId,
  });
  result.letters++;
  return true;
}

/** Neue Kandidaten: vorgemerkt zuerst, dann qualifiziert nach Score; nie schon angeschrieben oder heute geplant. */
async function candidates(db: Db, date: string, limit: number): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select c.* from companies c
      where c.status in ('READY_FOR_CONTACT', 'QUALIFIED')
        and not exists (select 1 from outreach_plan p
                         where p.company_id = c.id and (p.plan_date = $1 or p.status in ('done', 'dropped')))
        and not exists (select 1 from interactions i
                         where i.company_id = c.id and i.type = 'draft' and i.meta ? 'sent_at')
      order by (c.status = 'READY_FOR_CONTACT') desc, c.current_score desc nulls last
      limit $2`,
    [date, limit],
  );
  return rows;
}

/**
 * Ein Lead darf den Plan nicht umwerfen: Fehler (LLM, Browser, Website) werden als übersprungen vermerkt, nur das
 * Budget-Ende bricht ab.
 */
async function isolated(company: Company, result: PlanBuildResult, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    result.skipped.push({ name: company.name, reason: `Fehler: ${message.slice(0, 120)}` });
  }
}

export async function buildDailyPlan(deps: PlanDeps, by = "autopilot"): Promise<PlanBuildResult> {
  const now = deps.now();
  const date = berlinDate(now);
  const { db, config } = deps;
  const result: PlanBuildResult = {
    date,
    followups: 0,
    emails: 0,
    letters: 0,
    prototypes: 0,
    skipped: [],
    stoppedByBudget: false,
    warnings: [],
  };
  const outreachDeps: OutreachDeps = deps.letter;

  try {
    // 1. Nachfassen (auch am Wochenende vorbereitet, gesendet wird per Knopf).
    if (config.nachfassen.hoechstens > 0) {
      for (const { company, first } of await dueFollowUps(db, now, config.nachfassen.nach_tagen)) {
        await isolated(company, result, async () => {
          const draft = await createFollowUpDraft(
            { db, outreach: outreachDeps.outreach, phone: outreachDeps.contact.phone, now },
            company,
            first,
            by,
          );
          if (
            await addPlanItem(db, {
              date,
              companyId: company.id,
              kind: "followup",
              channel: "email",
              draftId: draft.draftId,
            })
          )
            result.followups++;
        });
      }
    }

    // 1b. Brief als zweites Nachfassen für sehr gute Leads ohne Antwort (Christian, 04.10.2026).
    for (const company of await dueLetterFollowUps(
      db,
      now,
      config.briefe.nachfassen_nach_tagen,
      config.briefe.ab_score,
      config.briefe.pro_tag,
    )) {
      await isolated(company, result, async () => {
        await planLetter(deps, company, date, by, "followup", result);
      });
    }

    // 2. Neue Leads.
    const bounces = await recentBounces(db, now, config.neue_kontakte.bremse.tage);
    const { count: target, braked } = dailyNewCount(config, now, await firstSentAt(db), bounces);
    if (braked)
      result.warnings.push(
        `Bremse: ${bounces.bounced} von ${bounces.sent} Mails der letzten ${config.neue_kontakte.bremse.tage} Tage waren unzustellbar, heute nur ${target} neue`,
      );
    const already = (await planItems(db, date)).filter((i) => i.kind === "new").length;
    let lettersLeft = config.briefe.pro_tag;
    for (const company of await candidates(db, date, Math.max(0, target - already) * 3)) {
      if (result.emails + result.letters + already >= target) break;
      await isolated(company, result, async () => {
        const person = await recipient(db, company.id);
        const mailOk = person.email ? await deps.mx(person.email) : false;
        const channel = chooseChannel(
          { hasAddress: Boolean(company.street && company.postal_code), mailOk },
          lettersLeft,
        );
        if (!channel) {
          result.skipped.push({ name: company.name, reason: "keine gültige E-Mail und keine Anschrift" });
          return;
        }
        if (usesTeaser(deps.teaser, company)) {
          try {
            await teaserForCompany(db, deps.teaser!, company);
            result.prototypes++;
          } catch (err) {
            result.warnings.push(`Vorschau-Bild ${company.name}: ${String(err).slice(0, 120)}`);
          }
        } else if (deps.prototype && config.prototyp_fuer_neue && company.segment !== "NO_WEBSITE") {
          try {
            const p = await buildPrototype(deps.prototype, company, by);
            if (!("kind" in p)) result.prototypes++;
          } catch (err) {
            if (err instanceof BudgetExceededError) throw err;
            result.warnings.push(`Prototyp ${company.name}: ${String(err).slice(0, 120)}`);
          }
        }
        if (channel === "letter") {
          if (!(await planLetter(deps, company, date, by, "new", result))) return;
          lettersLeft--;
        } else {
          const mail = await draftEmail(outreachDeps, company, by);
          if ("kind" in mail) {
            result.skipped.push({ name: company.name, reason: mail.kind });
            return;
          }
          await addPlanItem(db, {
            date,
            companyId: company.id,
            kind: "new",
            channel: "email",
            draftId: mail.draftId,
          });
          result.emails++;
        }
      });
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    result.stoppedByBudget = true;
  }
  return result;
}
