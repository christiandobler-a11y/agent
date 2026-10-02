import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import type { Company } from "../../db/companies.js";
import {
  contactsOf,
  insertAudit,
  insertPitch,
  latestAudit,
  latestOkSnapshotId,
  latestPlacesSnapshot,
  markAudited,
  saveLeadScore,
  type AuditRow,
  type LeadScoreRow,
  type PitchRow,
} from "../../db/leads.js";
import type { WebsiteSnapshot } from "../../db/websiteSnapshots.js";
import { loadPrompt } from "../../llm/config.js";
import type { LlmGateway } from "../../llm/gateway.js";
import type { CrawlConfig } from "../crawl/config.js";
import type { Branches } from "../research/branches.js";
import { computeRecheckAfter, type RecheckRules } from "../research/recheck.js";
import type { ScoringConfig } from "../scoring/config.js";
import { scoreLead, type ScoreInput, type ScoreResult } from "../scoring/score.js";
import { prepareAuditImages } from "./images.js";
import { auditOutputSchema, type AuditOutput } from "./schema.js";

/**
 * Audit → Score → Pitch je Firma (ARCHITECTURE.md 5.2 Schritte 8–10). Jeder Schritt ist einzeln aufrufbar und
 * idempotent: Ein Audit wird wiederverwendet, solange sich die Website nicht geändert hat (content_hash).
 */

export const AUDIT_PROMPT_VERSION = "v1";
export const PITCH_PROMPT_VERSION = "v1";

export interface LeadDeps {
  db: Db;
  llm: LlmGateway;
  crawl: CrawlConfig;
  scoring: ScoringConfig;
  branches: Branches;
  recheck: RecheckRules;
  now?: () => Date;
  jobId?: string | null;
}

async function snapshotById(db: Db, id: string): Promise<WebsiteSnapshot> {
  const { rows } = await db.query<WebsiteSnapshot>("select * from website_snapshots where id = $1", [id]);
  return rows[0]!;
}

/** Fakten fürs Audit: technische Messwerte, keine personenbezogenen Daten aus dem Impressum. */
export function auditFacts(snapshot: WebsiteSnapshot): Record<string, unknown> {
  const f = snapshot.facts ?? {};
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => k in f).map((k) => [k, f[k]]));
  return {
    url: snapshot.final_url ?? snapshot.url,
    ...pick([
      "title",
      "meta_description",
      "h1",
      "nav_items",
      "cta_texts",
      "has_viewport_meta",
      "mobile_too_wide",
      "mobile_overflow_px",
      "cms",
      "copyright_year",
      "word_count",
      "image_count",
      "images_without_alt",
      "has_contact_form",
      "social_links",
      "layout_tables",
      "https",
      "tls_valid",
      "has_structured_data",
    ]),
    tel_link_vorhanden: Array.isArray(f.tel_links) && f.tel_links.length > 0,
    mailto_vorhanden: Array.isArray(f.mailto_links) && f.mailto_links.length > 0,
    impressum_gefunden: Boolean(f.impressum),
    pagespeed_mobil: snapshot.psi,
  };
}

export async function buildAuditInput(
  company: Company,
  snapshot: WebsiteSnapshot,
  crawl: CrawlConfig,
  branchLabel: string | null,
): Promise<Anthropic.ContentBlockParam[]> {
  if (!snapshot.screenshot_desktop || !snapshot.screenshot_mobile)
    throw new Error("Snapshot ohne Screenshots");
  const images = await prepareAuditImages({
    desktopPath: snapshot.screenshot_desktop,
    mobilePath: snapshot.screenshot_mobile,
    desktopScreenPx: crawl.desktop.height * crawl.desktop.scale,
    mobileScreenPx: crawl.mobile.height * crawl.mobile.scale,
  });
  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: `Betrieb: ${company.name}${company.city ? ` in ${company.city}` : ""}${branchLabel ? ` (Branche: ${branchLabel})` : ""}.\nDie folgenden Bilder und Daten stammen von seiner Website.`,
    },
  ];
  images.forEach((img, i) => {
    blocks.push({ type: "text", text: `Bild ${i + 1}: ${img.label}` });
    blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  });
  blocks.push({ type: "text", text: `<fakten>\n${JSON.stringify(auditFacts(snapshot))}\n</fakten>` });
  blocks.push({ type: "text", text: `<website_text>\n${snapshot.text_excerpt ?? ""}\n</website_text>` });
  return blocks;
}

export type AuditOutcome =
  | { kind: "audited"; audit: AuditRow; output: AuditOutput; costUsd: number }
  | { kind: "reused"; audit: AuditRow }
  | { kind: "no_website" }
  | { kind: "no_snapshot" };

export async function auditCompany(deps: LeadDeps, company: Company): Promise<AuditOutcome> {
  if (company.segment === "NO_WEBSITE") return { kind: "no_website" };
  const snapshotId = await latestOkSnapshotId(deps.db, company.id);
  if (!snapshotId) return { kind: "no_snapshot" };
  const snapshot = await snapshotById(deps.db, snapshotId);

  // Keine Doppel-Audits (ARCHITECTURE.md 8, 11.1): gleiche Website → letztes Audit gilt weiter.
  const previous = await latestAudit(deps.db, company.id);
  if (previous && snapshot.content_hash && previous.content_hash === snapshot.content_hash) {
    await markAudited(deps.db, company.id);
    return { kind: "reused", audit: previous };
  }

  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  const result = await deps.llm.structured({
    role: "audit",
    promptVersion: AUDIT_PROMPT_VERSION,
    system: loadPrompt("audit", AUDIT_PROMPT_VERSION),
    input: await buildAuditInput(company, snapshot, deps.crawl, branch?.label ?? null),
    schema: auditOutputSchema,
    companyId: company.id,
    jobId: deps.jobId ?? null,
    inputSummary: `${company.name} · ${snapshot.final_url ?? snapshot.url}`,
  });
  const o = result.output;
  const audit = await insertAudit(deps.db, {
    companyId: company.id,
    snapshotId: snapshot.id,
    agentRunId: result.agentRunId,
    promptVersion: AUDIT_PROMPT_VERSION,
    model: result.model,
    findings: o.findings,
    rubric: o.rubric,
    commercial: o.commercial,
    summary: o.summary,
    designEra: o.design_era,
  });
  await markAudited(deps.db, company.id);
  return { kind: "audited", audit, output: o, costUsd: result.costUsd };
}

/** Gespeicherte Fakten robust lesen (ältere Snapshots haben evtl. weniger Felder). */
const siteFactsSchema = z.object({
  https: z.boolean().default(true),
  tls_valid: z.boolean().default(true),
  has_viewport_meta: z.boolean().default(true),
  mobile_too_wide: z.boolean().default(false),
  tel_links: z.array(z.string()).default([]),
  mailto_links: z.array(z.string()).default([]),
  has_contact_form: z.boolean().default(false),
  copyright_year: z.number().nullable().default(null),
  layout_tables: z.number().default(0),
  cms: z.string().nullable().default(null),
});

/** Audit-Zeile → Audit-Ausgabe (für erneutes Scoren ohne LLM). */
export function auditFromRow(row: AuditRow): AuditOutput {
  return auditOutputSchema.parse({
    summary: row.summary ?? "",
    design_era: (row.commercial as { design_era?: string | null } | null)?.design_era ?? null,
    rubric: row.rubric,
    findings: row.findings,
    commercial: row.commercial,
  });
}

export async function scoreInputFor(
  deps: LeadDeps,
  company: Company,
): Promise<{ input: ScoreInput; auditId: string | null }> {
  const now = deps.now ?? (() => new Date());
  const places = await latestPlacesSnapshot(deps.db, company.id);
  const contacts = await contactsOf(deps.db, company.id);

  let site: z.infer<typeof siteFactsSchema> | null = null;
  let psiPerformance: number | null = null;
  let audit: AuditOutput | null = null;
  let auditId: string | null = null;
  if (company.segment !== "NO_WEBSITE") {
    const snapshotId = await latestOkSnapshotId(deps.db, company.id);
    if (snapshotId) {
      const snapshot = await snapshotById(deps.db, snapshotId);
      site = siteFactsSchema.parse(snapshot.facts ?? {});
      const perf = (snapshot.psi as { performance?: unknown } | null)?.performance;
      psiPerformance = typeof perf === "number" ? perf : null;
    }
    const row = await latestAudit(deps.db, company.id);
    if (row) {
      audit = auditFromRow(row);
      auditId = row.id;
    }
  }

  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  return {
    auditId,
    input: {
      segment: company.segment === "NO_WEBSITE" ? "NO_WEBSITE" : "WEBSITE",
      branchValue: branch?.value ?? null,
      places: {
        rating: places?.rating ?? null,
        reviewCount: places?.review_count ?? null,
        businessStatus: places?.business_status ?? null,
        photoCount: places?.photo_count ?? null,
      },
      site,
      psiPerformance,
      audit,
      contacts: {
        ownerNamed: contacts.some((c) => c.name),
        email: contacts.some((c) => c.email) || (site?.mailto_links.length ?? 0) > 0,
        phone: contacts.some((c) => c.phone) || Boolean(company.phone) || (site?.tel_links.length ?? 0) > 0,
      },
      now: now(),
    },
  };
}

export interface ScoreOutcome {
  result: ScoreResult;
  score: LeadScoreRow;
}

/** Score aus gespeicherten Daten berechnen und speichern (ohne LLM; nach Gewichtsänderung beliebig wiederholbar). */
export async function scoreCompany(deps: LeadDeps, company: Company): Promise<ScoreOutcome> {
  const now = deps.now ?? (() => new Date());
  const { input, auditId } = await scoreInputFor(deps, company);
  if (input.segment === "WEBSITE" && !input.audit) throw new Error(`${company.name}: kein Audit vorhanden`);
  const result = scoreLead(input, deps.scoring);
  const skipReason = result.knockout?.reason ?? (result.qualified ? null : "low_score");
  const status = result.qualified ? "QUALIFIED" : "SKIPPED";
  const score = await saveLeadScore(deps.db, {
    companyId: company.id,
    auditId,
    version: result.version,
    total: result.total,
    breakdown: result,
    knockedOut: result.knockout !== null,
    knockoutReason: result.knockout?.reason ?? null,
    status,
    skipReason,
    skipDetail:
      result.knockout?.detail ??
      (result.qualified ? null : `Score ${result.total} unter ${deps.scoring.qualify_min_total}`),
    recheckAfter: computeRecheckAfter(deps.recheck, status, skipReason, now()),
  });
  return { result, score };
}

export const pitchOutputSchema = z.object({
  main_opportunity: z.string().min(1).max(700),
  arguments: z.array(z.string().min(1).max(400)).length(3),
  opening_line: z.string().min(1).max(300),
});

/** Pitch (Opus) nur für Top-Leads ab `pitch_min_total`. Gibt `null` zurück, wenn kein Pitch fällig ist. */
export async function pitchCompany(
  deps: LeadDeps,
  company: Company,
  scored: ScoreOutcome,
): Promise<PitchRow | null> {
  const { result, score } = scored;
  if (!result.qualified || result.total < deps.scoring.pitch_min_total) return null;
  const { input } = await scoreInputFor(deps, company);
  const data = {
    firma: {
      name: company.name,
      ort: company.city,
      kategorie: company.category,
      website: company.website_url,
    },
    google: input.places,
    score: {
      gesamt: result.total,
      dimensionen: result.dimensions.map((d) => ({
        name: d.label,
        punkte: d.points,
        max: d.max,
        positionen: d.items.filter((i) => i.points > 0).map((i) => `${i.label}: ${i.detail}`),
      })),
    },
    audit: input.audit
      ? {
          zusammenfassung: input.audit.summary,
          befunde: input.audit.findings,
          wirtschaftlich: input.audit.commercial,
        }
      : "keine Website",
  };
  const out = await deps.llm.structured({
    role: "pitch",
    promptVersion: PITCH_PROMPT_VERSION,
    system: loadPrompt("pitch", PITCH_PROMPT_VERSION),
    input: JSON.stringify(data),
    schema: pitchOutputSchema,
    companyId: company.id,
    jobId: deps.jobId ?? null,
    inputSummary: `${company.name} · Score ${result.total}`,
  });
  return insertPitch(deps.db, {
    companyId: company.id,
    leadScoreId: score.id,
    agentRunId: out.agentRunId,
    promptVersion: PITCH_PROMPT_VERSION,
    model: out.model,
    mainOpportunity: out.output.main_opportunity,
    arguments: out.output.arguments,
    openingLine: out.output.opening_line,
  });
}
