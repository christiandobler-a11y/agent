import { readdirSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CONFIG_DIR } from "../config/files.js";
import type { Company } from "../db/companies.js";
import { contactsOf, latestAudit, latestPitch } from "../db/leads.js";
import { latestPlacesSnapshot } from "../db/leads.js";
import { costReport } from "../db/costs.js";
import { explainStoredLead } from "../pipeline/audit/explainStored.js";
import type { Finding } from "../pipeline/audit/schema.js";
import { pendingJobs, runSummary, startSearch, type PipelineContext } from "../queue/pipeline.js";
import { findLead, shortId } from "./leads.js";

/**
 * Werkzeuge des Managers (ARCHITECTURE.md 5.1, 10, 12.1): feste Funktionen mit geprüften Parametern.
 * Kein freies SQL, keine Shell, kein Mailversand. Ergebnisse sind kurze Texte für das Modell.
 */

export interface ToolContext {
  ctx: PipelineContext;
  chatId: number;
}

interface ToolDef<S extends z.ZodType> {
  description: string;
  schema: S;
  run: (input: z.output<S>, t: ToolContext) => Promise<string>;
}

const define = <S extends z.ZodType>(d: ToolDef<S>) => d;

export function availableRegions(): string[] {
  return readdirSync(`${CONFIG_DIR}regions`)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
}

const STATUS = [
  "NEW",
  "RESEARCHED",
  "AUDITED",
  "QUALIFIED",
  "SKIPPED",
  "FAILED",
  "READY_FOR_CONTACT",
  "CONTACTED",
  "REPLIED",
  "INTERESTED",
  "PROTOTYPE",
  "WON",
  "LOST",
] as const;

function line(c: Company): string {
  const score = c.current_score === null ? "–" : String(c.current_score);
  const site = c.segment === "NO_WEBSITE" ? "ohne Website" : (c.website_url ?? "");
  return `${shortId(c.id)} | ${c.name} | ${c.city ?? "?"} | Score ${score} | ${c.status}${c.skip_reason ? ` (${c.skip_reason})` : ""} | ${site}`;
}

async function lookup(t: ToolContext, ref: string): Promise<Company | string> {
  const r = await findLead(t.ctx.db, ref);
  if (r.kind === "found") return r.company;
  if (r.kind === "none") return `Kein Lead gefunden für "${ref}".`;
  return `Mehrdeutig, bitte genauer angeben:\n${r.candidates.map(line).join("\n")}`;
}

export const TOOLS = {
  search_leads: define({
    description:
      "Startet eine neue Lead-Suche (läuft im Hintergrund, Ergebnis kommt als eigene Nachricht). Nur aufrufen, wenn Christian ausdrücklich suchen lassen will.",
    schema: z.object({
      branche: z
        .string()
        .min(2)
        .describe('Suchbegriff wie bei Google Maps, z. B. "Fahrradladen", "Schreiner"'),
      region: z.string().describe("Regionsschlüssel aus config/regions, z. B. rosenheim"),
      ziel: z.number().int().min(1).max(50).describe("Gewünschte Zahl an Leads"),
    }),
    run: async (i, t) => {
      const regions = availableRegions();
      if (!regions.includes(i.region.toLowerCase())) {
        return `Region "${i.region}" ist nicht eingerichtet. Verfügbar: ${regions.join(", ")}. Neue Regionen legt Christian als config/regions/<name>.yaml an.`;
      }
      const run = await startSearch(t.ctx, {
        term: i.branche,
        regionKey: i.region.toLowerCase(),
        target: i.ziel,
        requestedBy: `telegram:${t.chatId}`,
      });
      return `Suchlauf ${shortId(run.id)} gestartet: "${i.branche}" in ${i.region}, Ziel ${i.ziel}. Die Ergebnisse kommen automatisch, sobald alle Firmen geprüft sind.`;
    },
  }),

  list_leads: define({
    description: "Listet Leads aus der Datenbank, nach Score absteigend. Standard: qualifizierte Leads.",
    schema: z.object({
      status: z.enum(STATUS).optional().describe("Standard QUALIFIED"),
      min_score: z.number().int().min(0).max(100).optional(),
      ort: z.string().optional().describe("Teil des Ortsnamens"),
      branche: z.string().optional().describe("Branchenschlüssel, z. B. fahrrad"),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    run: async (i, t) => {
      const { rows } = await t.ctx.db.query<Company>(
        `select * from companies
          where status = $1 and ($2::int is null or current_score >= $2)
            and ($3::text is null or city ilike '%' || $3 || '%')
            and ($4::text is null or branch_key = $4)
          order by current_score desc nulls last, updated_at desc limit $5`,
        [i.status ?? "QUALIFIED", i.min_score ?? null, i.ort ?? null, i.branche ?? null, i.limit ?? 10],
      );
      return rows.length === 0
        ? "Keine passenden Leads."
        : `ID | Name | Ort | Score | Status | Website\n${rows.map(line).join("\n")}`;
    },
  }),

  get_lead: define({
    description:
      "Details zu einem Lead: Google-Daten, Website, Kontakte aus dem Impressum, Audit-Befunde, Pitch.",
    schema: z.object({ lead: z.string().describe("ID (erste 8 Zeichen reichen), Domain oder Name") }),
    run: async (i, t) => {
      const c = await lookup(t, i.lead);
      if (typeof c === "string") return c;
      const db = t.ctx.db;
      const places = await latestPlacesSnapshot(db, c.id);
      const contacts = await contactsOf(db, c.id);
      const audit = await latestAudit(db, c.id);
      const pitch = await latestPitch(db, c.id);
      const out = [
        line(c),
        `Adresse: ${[c.street, c.postal_code, c.city].filter(Boolean).join(", ") || "?"} · Telefon: ${c.phone ?? "?"}`,
        places
          ? `Google: ${places.rating ?? "?"}★ bei ${places.review_count ?? 0} Bewertungen, Status ${places.business_status ?? "?"}`
          : "Google: keine Daten",
      ];
      for (const k of contacts) {
        out.push(
          `Kontakt (${k.source}): ${[k.name && `${k.name}${k.role ? ` (${k.role})` : ""}`, k.email, k.phone].filter(Boolean).join(" · ")}`,
        );
      }
      if (c.skip_detail) out.push(`Hinweis: ${c.skip_detail}`);
      if (audit) {
        out.push(`Audit: ${audit.summary ?? ""}`);
        for (const f of (audit.findings as Finding[]).slice(0, 6))
          out.push(`- [${f.severity}] ${f.title}: ${f.evidence}`);
      }
      if (pitch)
        out.push(`Pitch: ${pitch.main_opportunity}`, ...pitch.arguments.map((a, n) => `${n + 1}. ${a}`));
      return out.join("\n");
    },
  }),

  explain_score: define({
    description:
      'Erklärt den Score eines Leads oder warum er aussortiert wurde, aus gespeicherten Daten (inkl. Rolle und Modell der Bewertung). Für Fragen wie "Warum 91 Punkte?".',
    schema: z.object({ lead: z.string() }),
    run: async (i, t) => {
      const c = await lookup(t, i.lead);
      return typeof c === "string" ? c : explainStoredLead(t.ctx.db, c);
    },
  }),

  skip_lead: define({
    description:
      "Markiert einen Lead als aussortiert (SKIPPED, manuell). Nur auf ausdrücklichen Wunsch von Christian.",
    schema: z.object({ lead: z.string(), grund: z.string().min(2).max(200) }),
    run: async (i, t) => {
      const c = await lookup(t, i.lead);
      if (typeof c === "string") return c;
      await t.ctx.db.query(
        `update companies set status = 'SKIPPED', skip_reason = 'manual', skip_detail = $2, recheck_after = null, updated_at = now()
          where id = $1`,
        [c.id, `Manuell: ${i.grund}`],
      );
      return `${c.name} ist aussortiert (Grund: ${i.grund}).`;
    },
  }),

  stats: define({
    description: "Stand der Pipeline: Firmen je Status und die letzten Suchläufe mit Fortschritt.",
    schema: z.object({ laeufe: z.number().int().min(1).max(10).optional() }),
    run: async (i, t) => {
      const db = t.ctx.db;
      const { rows: counts } = await db.query<{ status: string; n: number }>(
        "select status, count(*)::int as n from companies group by status order by n desc",
      );
      const { rows: runs } = await db.query<Parameters<typeof runSummary>[1]>(
        "select * from search_runs order by created_at desc limit $1",
        [i.laeufe ?? 3],
      );
      const out = [`Firmen je Status: ${counts.map((c) => `${c.status} ${c.n}`).join(", ") || "keine"}`];
      for (const run of runs) {
        const s = await runSummary(t.ctx, run);
        const q = run.query as { term?: string; region?: string };
        const pending = run.status === "RUNNING" ? await pendingJobs(t.ctx, run.id) : 0;
        out.push(
          `Lauf ${shortId(run.id)} "${q.term}" ${q.region} (${run.status}${pending ? `, ${pending} Jobs offen` : ""}): ${
            Object.entries(s.counts)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ") || "noch keine Firmen"
          } · Kosten ${s.costUsd.toFixed(2)} $`,
        );
      }
      return out.join("\n");
    },
  }),

  costs: define({
    description:
      "Kosten (LLM und Google Places) heute, im Monat und je Tag/Rolle der letzten Tage, mit Budget.",
    schema: z.object({ tage: z.number().int().min(1).max(31).optional() }),
    run: async (i, t) => {
      const r = await costReport(t.ctx.db, t.ctx.now(), i.tage ?? 7);
      const limits = t.ctx.budget.limits;
      const byDay = new Map<string, number>();
      for (const row of r.rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.cost_usd);
      const lines = [
        `Heute ${r.today.toFixed(2)} $ von ${limits.daily_usd} $, Monat ${r.month.toFixed(2)} $ von ${limits.monthly_usd} $.`,
        ...[...byDay].map(([day, usd]) => `${day}: ${usd.toFixed(2)} $`),
        ...r.rows.map(
          (row) =>
            `  ${row.day} ${row.source}/${row.name}: ${row.calls} Aufrufe, ${row.cost_usd.toFixed(3)} $`,
        ),
      ];
      return lines.join("\n");
    },
  }),

  failed_leads: define({
    description: "Fehlgeschlagene Firmen der letzten 14 Tage mit Grund (z. B. Website nicht erreichbar).",
    schema: z.object({}),
    run: async (_i, t) => {
      const { rows } = await t.ctx.db.query<Company>(
        "select * from companies where status = 'FAILED' and updated_at > now() - interval '14 days' order by updated_at desc limit 20",
      );
      return rows.length === 0
        ? "Keine fehlgeschlagenen Firmen."
        : rows.map((c) => `${line(c)} – ${c.skip_detail ?? ""}`).join("\n");
    },
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

export function toolDefinitions(): Anthropic.Tool[] {
  return Object.entries(TOOLS).map(([name, t]) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema as Anthropic.Tool["input_schema"] };
  });
}

/** Tool ausführen; ungültige Eingaben und Fehler werden als Text an das Modell zurückgegeben. */
export async function runTool(
  name: string,
  input: unknown,
  t: ToolContext,
): Promise<{ text: string; isError: boolean }> {
  const tool = (TOOLS as Record<string, ToolDef<z.ZodType>>)[name];
  if (!tool) return { text: `Unbekanntes Werkzeug ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { text: `Ungültige Eingabe: ${z.prettifyError(parsed.error)}`, isError: true };
  try {
    return { text: await tool.run(parsed.data, t), isError: false };
  } catch (err) {
    return { text: `Fehler: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
