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
import { dueCallLetters, prepareCall } from "../outreach/call.js";
import { draftLetter, type LetterDeps } from "../outreach/letter.js";
import type { MxCheck } from "../outreach/mx.js";
import { buildPrototype, type PrototypeDeps } from "../prototype/run.js";
import { teaserForCompany, usesTeaser, type TeaserDeps } from "../prototype/teaser.js";
import { recentSeedProblem } from "../outreach/seed.js";
import { GroupIndex, groupKeys, type Impressum } from "../outreach/group.js";

/**
 * Morgen-Paket (Phase 2): Avelio bereitet nachts den Tagesplan vor. Zuerst fällige Nachfass-Mails, dann neue Leads
 * (vorgemerkte zuerst, dann nach Score): Prototyp bauen, dann Mail oder Befund-Seite. Nichts wird verschickt; das
 * passiert erst morgens per Knopf in Telegram.
 */

const hm = z.string().regex(/^\d{2}:\d{2}$/);
export const autopilotConfigSchema = z.object({
  zeiten: z.object({
    vorbereiten: hm,
    morgens: hm,
    /** Kurzer Zwischenstand am Mittag (fehlt = keiner). */
    mittags: hm.optional(),
    abends: hm,
  }),
  neue_kontakte: z.object({
    stufen: z.array(z.object({ ab_tag: z.number().int().min(0), pro_tag: z.number().int().min(0) })).min(1),
    nur_werktags: z.boolean(),
    /** Nur Leads dieser Branchen (fehlt = Branchen der Nachtsuche, [] = alle). Vorgemerkte immer. */
    branchen: z.array(z.string()).optional(),
    /** Erst die Praxen in der Nähe (Christian kann bei den ersten Kunden vorbeifahren), dann der Rest nach Score. */
    heimat: z
      .object({ ort: z.string(), lat: z.number(), lng: z.number(), umkreis_km: z.number().positive() })
      .optional(),
    bremse: z
      .object({
        quote: z.number().min(0).max(1),
        mindestens: z.number().int().min(1),
        tage: z.number().int().min(1),
      })
      .default({ quote: 0.05, mindestens: 20, tage: 7 }),
  }),
  briefe: z.object({
    /** Wochentag, an dem die gesammelten Briefe ins Morgen-Paket kommen. */
    tag: z.enum(["montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag"]),
    pro_woche: z.number().int().min(0),
    ab_score: z.number().int(),
    /** Brief als zweites Nachfassen: so viele Tage nach der Nachfass-Mail ohne Antwort (nur ab `ab_score`). */
    nachfassen_nach_tagen: z.number().int().min(1).default(7),
  }),
  /**
   * Morgen-Paket an/aus (09.10.2026, Christian: "keine Mails und Scrapes mehr notwendig"). Aus: kein Plan, keine
   * Meldungen morgens, mittags, abends. Die Nachtsuche hat ihren eigenen Schalter (`suche.aktiv`).
   */
  morgen_paket: z.boolean().default(true),
  prototyp_fuer_neue: z.boolean(),
  /**
   * Erstkontakt (06.10.2026, Christian): "brief" = neue Leads bekommen einen Brief (Befund-Seite mit Vorschau-Bild und
   * QR-Code zur Vorschau-Seite) statt einer Kaltmail; die Stufen in `neue_kontakte` zählen dann Briefe je Werktag.
   * Grund: Werbe-Mails ohne Einwilligung sind nach § 7 UWG auch an Firmen unzulässig, Werbebriefe nicht.
   * "anruf" (06.10.2026): Praxen mit Telefonnummer kommen auf die Anruf-Liste (Ja → Mail mit Einwilligung, sonst
   * Brief), ohne Nummer gleich ein Brief; die Stufen zählen dann Anrufe und Briefe zusammen.
   * "aus" (06.10.2026, Christian: Physio-Anrufe pausieren, Fokus Laden der Woche): keine neuen Kontakte.
   */
  erstkontakt: z.enum(["mail", "brief", "anruf", "aus"]).default("mail"),
  /**
   * Anruf-Modus (06.10.2026, Christian: "Tagesziel ist erst erreicht, wenn ich 20× eine Mail zustellen durfte"): Ziel
   * sind `ziel_ja` Einwilligungen am Tag. Avelio legt je fehlendem Ja `je_ja` Anruf-Karten bereit und legt nach, sobald
   * sie aufgebraucht sind. Praxen ohne Nummer bekommen einen Brief, höchstens `briefe_ohne_nummer` am Tag.
   */
  anrufe: z
    .object({
      ziel_ja: z.number().int().min(1),
      je_ja: z.number().int().min(1),
      briefe_ohne_nummer: z.number().int().min(0),
      /** Nach "lieber per Post" bzw. `versuche`× nicht erreicht einen Brief planen. */
      brief_nach_versuchen: z.boolean().default(true),
    })
    .default({ ziel_ja: 20, je_ja: 3, briefe_ohne_nummer: 5, brief_nach_versuchen: true }),
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
  /** Absender-Adresse (OUTREACH_MAIL_ADDRESS): das Aufwärmen zählt je Adresse. */
  senderAddress?: string | null;
  /** Öffnungszeiten für die Anruf-Karte (src/prototype/placeDetails.ts → cachedOpeningHours). */
  openingHours?: ((company: Company) => Promise<string[]>) | null;
}

export interface PlanBuildResult {
  date: string;
  followups: number;
  emails: number;
  letters: number;
  prototypes: number;
  skipped: { name: string; reason: string }[];
  /** Anruf-Liste: vorbereitete Anrufe (fehlt bei älteren Ergebnissen). */
  calls?: number;
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

/** Wochentag in Deutschland, klein geschrieben ("samstag"). */
export function berlinWeekday(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "long" })
    .format(d)
    .toLowerCase();
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
  /** Kontrollmail lag zuletzt im Spam (src/outreach/seed.ts). */
  spamSeen = false,
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
    spamSeen || (bounces.sent >= n.bremse.mindestens && bounces.bounced / bounces.sent > n.bremse.quote);
  if (!braked) return { count: stages[stage]!.pro_tag, braked };
  // Eine Stufe zurück; auf der ersten Stufe halbieren.
  return { count: stage > 0 ? stages[stage - 1]!.pro_tag : Math.floor(stages[0]!.pro_tag / 2), braked };
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

/**
 * Erste gesendete Mail dieser Absender-Adresse (Aufwärmen gilt je Adresse: Wechsel vom privaten Postfach auf
 * christian@avelio.digital beginnt wieder bei der ersten Stufe). Ohne bekannte Adresse: erste Mail überhaupt.
 */
async function firstSentAt(db: Db, from: string | null | undefined): Promise<Date | null> {
  const { rows } = await db.query<{ first: Date | null }>(
    `select min((meta->>'sent_at')::timestamptz) as first from interactions
      where type = 'draft' and channel = 'email' and meta ? 'sent_at'
        and ($1::text is null or lower(meta->>'from') = lower($1))`,
    [from ?? null],
  );
  return rows[0]?.first ?? null;
}

/** Einwilligungen ("Ja" am Telefon) an diesem Tag. */
export async function yesToday(db: Db, date: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(distinct company_id)::int as n from interactions
      where type = 'note' and meta->>'call' = 'ja' and (created_at at time zone 'Europe/Berlin')::date = $1::date`,
    [date],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Vorschau-Bild und Vorschau-Seite (Prototyp) einer Praxis bauen, falls es sie noch nicht gibt. Im Anruf-Modus erst
 * nach dem Ja (Telegram) bzw. für Briefe, damit die vielen Anruf-Karten schnell und billig bereitliegen.
 */
export async function prepareVisuals(
  deps: Pick<PlanDeps, "db" | "teaser" | "prototype" | "config">,
  company: Company,
  by: string,
  warnings: string[] = [],
  /** Nur das Vorschau-Bild (Mail nach dem Ja; die Vorschau-Seite kommt erst nach der Antwort der Praxis). */
  teaserOnly = false,
): Promise<number> {
  let built = 0;
  const teaser = usesTeaser(deps.teaser, company);
  if (teaser) {
    try {
      await teaserForCompany(deps.db, deps.teaser!, company);
      built++;
    } catch (err) {
      warnings.push(`Vorschau-Bild ${company.name}: ${String(err).slice(0, 120)}`);
    }
  }
  if (
    !(teaserOnly && teaser) &&
    deps.prototype &&
    deps.config.prototyp_fuer_neue &&
    company.segment !== "NO_WEBSITE" &&
    !(await hasPrototype(deps.db, company.id))
  ) {
    try {
      const p = await buildPrototype(deps.prototype, company, by);
      if (!("kind" in p)) built++;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      warnings.push(`Prototyp ${company.name}: ${String(err).slice(0, 120)}`);
    }
  }
  return built;
}

async function hasPrototype(db: Db, companyId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from prototypes where company_id = $1 limit 1", [companyId]);
  return rows.length > 0;
}

/** Erster erledigter neuer Kontakt auf diesem Weg (Stufen im Brief- bzw. Anruf-Modus zählen ab da). */
async function firstContactAt(db: Db, channel: "letter" | "phone"): Promise<Date | null> {
  const { rows } = await db.query<{ first: Date | null }>(
    `select min(done_at) as first from outreach_plan
      where channel = $1 and kind = 'new' and status = 'done'`,
    [channel],
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

/** Impressum der letzten erfolgreichen Website-Prüfung (Handelsregister, USt-IdNr., Person). */
async function impressumOf(db: Db, companyId: string): Promise<Impressum | null> {
  const { rows } = await db.query<{ imp: Impressum | null }>(
    `select facts->'impressum' as imp from website_snapshots
      where company_id = $1 and error is null order by fetched_at desc limit 1`,
    [companyId],
  );
  return rows[0]?.imp ?? null;
}

/**
 * Schon angeschriebene Betriebe und die heute geplanten: deren Schlüssel (groupKeys), damit kein zweiter Standort
 * derselben Firma eine Mail bekommt.
 */
async function contactedGroups(db: Db, date: string): Promise<GroupIndex> {
  const { rows } = await db.query<Company & { email: string | null }>(
    `select c.*, (select i.meta->>'to' from interactions i
                   where i.company_id = c.id and i.type = 'draft' and i.channel = 'email'
                   order by (i.meta ? 'sent_at') desc, i.created_at desc limit 1) as email
       from companies c
      where exists (select 1 from interactions i where i.company_id = c.id and i.type = 'draft' and i.meta ? 'sent_at')
         or exists (select 1 from outreach_plan p where p.company_id = c.id and p.plan_date = $1)`,
    [date],
  );
  const index = new GroupIndex();
  for (const c of rows)
    index.add(
      groupKeys({
        websiteUrl: c.website_url,
        email: c.email,
        postalCode: c.postal_code,
        impressum: await impressumOf(db, c.id),
      }),
      c.name,
    );
  return index;
}

/** Neue Kandidaten: vorgemerkt zuerst, dann qualifiziert nach Score; nie schon angeschrieben oder heute geplant. */
export async function candidates(
  db: Db,
  date: string,
  limit: number,
  branches: readonly string[],
  home?: { lat: number; lng: number; umkreis_km: number },
  /** Anruf-Liste: so oft nicht erreicht, dann nicht mehr anrufen (kommt als Brief, siehe dueCallLetters). */
  callAttempts = 3,
): Promise<Company[]> {
  // Von Christian vorgemerkte (READY_FOR_CONTACT) immer, sonst nur die Fokus-Branchen (leer = alle).
  const { rows } = await db.query<Company>(
    `select c.* from companies c
      where (c.status = 'READY_FOR_CONTACT'
             or (c.status = 'QUALIFIED' and (cardinality($3::text[]) = 0 or c.branch_key = any($3))))
        and not exists (select 1 from outreach_plan p
                         where p.company_id = c.id and (p.plan_date = $1 or p.status in ('done', 'dropped')))
        and not exists (select 1 from interactions i
                         where i.company_id = c.id and i.type = 'draft' and i.meta ? 'sent_at')
        -- Schon angerufen: Ja, lieber Brief oder kein Interesse; oder zu oft nicht erreicht.
        and not exists (select 1 from interactions n where n.company_id = c.id
                         and n.meta->>'call' in ('ja', 'brief', 'kein_interesse'))
        and (select count(*) from interactions n
              where n.company_id = c.id and n.meta->>'call' = 'nicht_erreicht') < $7
      order by (c.status = 'READY_FOR_CONTACT') desc,
               -- Im Umkreis zuerst (Entfernung näherungsweise, reicht für ein paar Dutzend Kilometer).
               (c.lat is not null and $4::float is not null
                and 111.32 * sqrt(power(c.lat::float - $4::float, 2)
                                  + power(cos(radians($4::float)) * (c.lng::float - $5::float), 2)) <= $6::float) desc,
               c.current_score desc nulls last
      limit $2`,
    [date, limit, branches, home?.lat ?? null, home?.lng ?? null, home?.umkreis_km ?? null, callAttempts],
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
            {
              db,
              outreach: outreachDeps.outreach,
              phone: outreachDeps.contact.phone,
              address: outreachDeps.contact.address ?? null,
              now,
            },
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

    const letterMode = config.erstkontakt === "brief";
    const callMode = config.erstkontakt === "anruf";
    const offline = letterMode || callMode;
    // 1b. Brief als zweites Nachfassen für sehr gute Leads ohne Antwort (Christian, 04.10.2026). Briefe gesammelt
    // nur am Brief-Tag (05.10.2026).
    const letterDay = berlinWeekday(now) === config.briefe.tag;
    let lettersLeft = letterDay ? config.briefe.pro_woche : 0;
    for (const company of await dueLetterFollowUps(
      db,
      now,
      config.briefe.nachfassen_nach_tagen,
      config.briefe.ab_score,
      lettersLeft,
    )) {
      await isolated(company, result, async () => {
        if (await planLetter(deps, company, date, by, "followup", result)) lettersLeft--;
      });
    }

    // 2. Neue Leads (nicht bei erstkontakt "aus"). Im Brief-Modus zählen die Stufen Briefe; Bremsen für Unzustellbare
    // und Spam gelten nur für Mails.
    if (config.erstkontakt === "aus") return result;
    const bounces = offline
      ? { sent: 0, bounced: 0 }
      : await recentBounces(db, now, config.neue_kontakte.bremse.tage);
    const spamSeen = offline ? false : await recentSeedProblem(db, now);
    const { count: target, braked } = dailyNewCount(
      config,
      now,
      offline
        ? await firstContactAt(db, callMode ? "phone" : "letter")
        : await firstSentAt(db, deps.senderAddress),
      bounces,
      spamSeen,
    );
    // 1c. Anruf-Modus: Brief für Praxen, die lieber Post wollten oder mehrfach nicht erreicht wurden.
    const attempts = outreachDeps.outreach.anruf?.versuche ?? 3;
    if (callMode && config.anrufe.brief_nach_versuchen)
      for (const company of await dueCallLetters(db, attempts, 10))
        await isolated(company, result, async () => {
          await planLetter(deps, company, date, by, "followup", result);
        });
    if (braked)
      result.warnings.push(
        spamSeen
          ? `Bremse: Eine Kontrollmail der letzten Tage lag im Spam oder kam nicht an, heute nur ${target} neue`
          : `Bremse: ${bounces.bounced} von ${bounces.sent} Mails der letzten ${config.neue_kontakte.bremse.tage} Tage waren unzustellbar, heute nur ${target} neue`,
      );
    // Nur neue Mails zählen zum Tagesziel; Briefe kommen gesammelt am Brief-Tag dazu. Wer ausfällt (keine Mail,
    // Fehler) oder aussortiert wurde, wird durch den nächsten Kandidaten ersetzt (/nachlegen baut erneut).
    const newChannels = callMode ? ["phone", "letter"] : [letterMode ? "letter" : "email"];
    const already = (await planItems(db, date)).filter(
      (i) => i.kind === "new" && newChannels.includes(i.channel) && i.status !== "dropped",
    ).length;
    let newLetters = 0;
    // Anruf-Modus: so viele Karten, wie für die fehlenden Ja nötig sind (abzüglich der noch offenen), plus Briefe für
    // Praxen ohne Nummer.
    const today = callMode ? await planItems(db, date) : [];
    let cardsWanted = callMode
      ? Math.max(
          0,
          (config.anrufe.ziel_ja - (await yesToday(db, date))) * config.anrufe.je_ja -
            today.filter((i) => i.channel === "phone" && i.status === "ready").length,
        )
      : 0;
    let lettersWanted = callMode
      ? Math.max(
          0,
          config.anrufe.briefe_ohne_nummer -
            today.filter((i) => i.kind === "new" && i.channel === "letter" && i.status !== "dropped").length,
        )
      : 0;
    const branches = config.neue_kontakte.branchen ?? config.suche.branchen;
    const pool = callMode
      ? (cardsWanted + lettersWanted) * 3 + 20
      : Math.max(0, target - already) * 4 + (lettersLeft > 0 && !offline ? 300 : 0);
    const groups = await contactedGroups(db, date);
    for (const company of await candidates(db, date, pool, branches, config.neue_kontakte.heimat, attempts)) {
      const mailsDone = callMode
        ? cardsWanted <= 0 && lettersWanted <= 0
        : (offline ? newLetters : result.emails) + already >= target;
      if (mailsDone && (offline || lettersLeft <= 0)) break;
      await isolated(company, result, async () => {
        const person = await recipient(db, company.id);
        // Anderer Standort eines schon angeschriebenen oder heute geplanten Betriebs: auslassen (zählt nicht).
        const keys = groupKeys({
          websiteUrl: company.website_url,
          email: person.email,
          postalCode: company.postal_code,
          impressum: await impressumOf(db, company.id),
        });
        const sibling = groups.match(keys);
        if (sibling) {
          result.skipped.push({
            name: company.name,
            reason: `gleicher Betrieb wie ${sibling} (anderer Standort)`,
          });
          return;
        }
        const hasAddress = Boolean(company.street && company.postal_code);
        const canCall = callMode && Boolean(company.phone) && outreachDeps.outreach.anruf !== null;
        if (offline && !canCall && !hasAddress) {
          result.skipped.push({
            name: company.name,
            reason: callMode ? "keine Telefonnummer und keine Anschrift" : "keine Anschrift für den Brief",
          });
          return;
        }
        const mailOk = !offline && person.email ? await deps.mx(person.email) : false;
        const channel: "email" | "letter" | "phone" | null = canCall
          ? "phone"
          : offline
            ? "letter"
            : chooseChannel({ hasAddress, mailOk }, lettersLeft);
        if (!channel) {
          if (!mailsDone)
            result.skipped.push({
              name: company.name,
              reason: hasAddress
                ? `keine gültige E-Mail, Brief kommt am ${config.briefe.tag}`
                : "keine gültige E-Mail und keine Anschrift",
            });
          return;
        }
        // Tagesziel erreicht: nur noch Briefe sammeln (am Brief-Tag).
        if (channel === "email" && mailsDone) return;
        if (callMode && channel === "phone" && cardsWanted <= 0) return;
        if (callMode && channel === "letter" && lettersWanted <= 0) return;
        if (callMode) {
          // Anruf-Karten ohne Bild und Vorschau-Seite (kommen erst nach dem Ja); Briefe brauchen beides.
          if (channel === "letter")
            result.prototypes += await prepareVisuals(deps, company, by, result.warnings);
        } else {
          const teaser = usesTeaser(deps.teaser, company);
          if (teaser) {
            try {
              await teaserForCompany(db, deps.teaser!, company);
              result.prototypes++;
            } catch (err) {
              result.warnings.push(`Vorschau-Bild ${company.name}: ${String(err).slice(0, 120)}`);
            }
          }
          // Prototyp (Vorschau-Seite): ohne Vorschau-Bild immer, im Brief-Modus auch dazu, damit der QR-Code im Brief
          // auf eine eigene Seite der Praxis führt.
          if (
            (!teaser || offline) &&
            deps.prototype &&
            config.prototyp_fuer_neue &&
            company.segment !== "NO_WEBSITE" &&
            !(offline && (await hasPrototype(db, company.id)))
          ) {
            try {
              const p = await buildPrototype(deps.prototype, company, by);
              if (!("kind" in p)) result.prototypes++;
            } catch (err) {
              if (err instanceof BudgetExceededError) throw err;
              result.warnings.push(`Prototyp ${company.name}: ${String(err).slice(0, 120)}`);
            }
          }
        }
        if (channel === "phone") {
          const call = await prepareCall(db, outreachDeps.outreach, company, by, now, deps.openingHours);
          if (!call) return;
          if (
            await addPlanItem(db, {
              date,
              companyId: company.id,
              kind: "new",
              channel: "phone",
              draftId: call.draftId,
            })
          )
            result.calls = (result.calls ?? 0) + 1;
          newLetters++;
          cardsWanted--;
          groups.add(keys, company.name);
        } else if (channel === "letter") {
          if (!(await planLetter(deps, company, date, by, "new", result))) return;
          if (callMode) lettersWanted--;
          if (offline) newLetters++;
          else lettersLeft--;
          groups.add(keys, company.name);
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
          groups.add(keys, company.name);
        }
      });
    }
    // Anruf-Modus: Vorrat im Blick (Christian: "so viele Leads müssen wir immer im Rücken haben").
    if (callMode) {
      if (cardsWanted > 0)
        result.warnings.push(
          `Nur ${result.calls ?? 0} neue Anruf-Karten, ${cardsWanted} haben gefehlt: Es gehen die Praxen mit Nummer aus`,
        );
      const need = config.anrufe.ziel_ja * config.anrufe.je_ja;
      const left = (
        await candidates(db, date, need * 3, branches, config.neue_kontakte.heimat, attempts)
      ).filter((c) => c.phone).length;
      if (left < need)
        result.warnings.push(
          `Vorrat: nur noch ${left} Praxen mit Nummer zum Anrufen (für ${config.anrufe.ziel_ja} Ja am Tag braucht es etwa ${need}). Die Nachtsuche legt nach, sonst eine Region oder Branche dazunehmen.`,
        );
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    result.stoppedByBudget = true;
  }
  return result;
}
