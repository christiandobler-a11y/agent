import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { Db } from "../db/client.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";
import { buildSnapshot, type Snapshot, type SnapshotDeps } from "./snapshot.js";

/**
 * Berater-Runde (05.10.2026, Christian: "ein Agent nur für Prozessoptimierung mit Critical Thinking, und einer für
 * Skalierung"). Drei Schritte, alle über das LLM-Gateway:
 *
 * 1. Recherche (Rolle `advisor_research`): Websuche zu ähnlichen Abläufen; das Ergebnis ist fremder Inhalt.
 * 2. Entwürfe (Rolle `advisor`): Lagebild aus der Datenbank + Recherche → Vorschläge mit Beleg, festes Schema.
 * 3. Gegenprüfung (Rolle `advisor_critic`): jeder Entwurf wird behalten oder verworfen, mit Einwand.
 *
 * Kein Schritt hat Werkzeuge zum Handeln (nur die Websuche in Schritt 1): Die Berater ändern nichts, Christian
 * entscheidet per Knopf (src/telegram/advisor.ts), umgesetzt wird im Code.
 */

// v2 (06.10.2026): dritte Rolle "Website-Werkstatt" (Vorschau-Bild, Prototyp, fertige Kunden-Website).
// v3 (06.10.2026): Ablauf ohne Kaltmails (Anruf-Liste, Ja → Mail, sonst Brief) und optionaler Fokus von Christian.
export const ADVISOR_RESEARCH_PROMPT = "v3";
export const ADVISOR_PROMPT = "v3";
export const ADVISOR_CRITIC_PROMPT = "v1";

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"] as const;

export const advisorConfigSchema = z.object({
  aktiv: z.boolean().default(true),
  tag: z.enum(WEEKDAYS),
  ab: z.string().regex(/^\d\d:\d\d$/),
  max_vorschlaege: z.number().int().min(1).max(10),
  websuchen: z.number().int().min(0).max(30),
  /** Fundstück zwischendurch (src/advisor/finds.ts); fehlt = keins. */
  zwischendurch: z
    .object({
      tage: z.array(z.enum(WEEKDAYS)),
      ab: z.string().regex(/^\d\d:\d\d$/),
      websuchen: z.number().int().min(1).max(5),
    })
    .optional(),
});

export type AdvisorConfig = z.infer<typeof advisorConfigSchema>;

export function loadAdvisorConfig(): AdvisorConfig {
  return loadYamlConfig("advisor.yaml", advisorConfigSchema);
}

/** Ist heute (Berliner Zeit) ein Fundstück dran und die Uhrzeit erreicht? Rein. */
export function findDue(config: AdvisorConfig, weekday: number, time: string): boolean {
  const z = config.zwischendurch;
  return config.aktiv && !!z && z.tage.includes(WEEKDAYS[weekday]!) && time >= z.ab;
}

/** Ist jetzt (Berliner Zeit) der Tag der Wochen-Runde und die Uhrzeit erreicht? Rein. */
export function advisorDue(config: AdvisorConfig, weekday: number, time: string): boolean {
  return config.aktiv && WEEKDAYS[weekday] === config.tag && time >= config.ab;
}

const draftSchema = z.object({
  bereich: z.enum(["prozess", "wachstum", "website"]),
  titel: z.string(),
  beobachtung: z.string(),
  beleg: z.string(),
  vorschlag: z.string(),
  wirkung: z.string(),
  aufwand: z.enum(["klein", "mittel", "gross"]),
  risiko: z.string(),
  sicherheit: z.enum(["niedrig", "mittel", "hoch"]),
  quellen: z.array(z.string()),
});

export const advisorOutputSchema = z.object({
  lage: z.string(),
  rueckblick: z.string().nullable(),
  vorschlaege: z.array(draftSchema),
});

export const criticOutputSchema = z.object({
  bewertungen: z.array(
    z.object({
      nr: z.number().int(),
      urteil: z.enum(["behalten", "verwerfen"]),
      sicherheit: z.enum(["niedrig", "mittel", "hoch"]),
      einwand: z.string(),
    }),
  ),
  fazit: z.string(),
});

export type Draft = z.infer<typeof draftSchema>;
export type CriticOutput = z.infer<typeof criticOutputSchema>;

export interface KeptSuggestion extends Draft {
  einwand: string;
}

const RANK = { hoch: 0, mittel: 1, niedrig: 2 } as const;

/**
 * Nur Entwürfe, die der Gegenprüfer behält, mit seiner Sicherheit und seinem Einwand; die sichersten zuerst,
 * höchstens `max`. Entwürfe ohne Urteil gelten als verworfen. Rein.
 */
export function keepSuggestions(
  drafts: readonly Draft[],
  critic: CriticOutput,
  max: number,
): KeptSuggestion[] {
  const kept: KeptSuggestion[] = [];
  drafts.forEach((d, i) => {
    const verdict = critic.bewertungen.find((b) => b.nr === i + 1);
    if (verdict?.urteil !== "behalten") return;
    kept.push({ ...d, sicherheit: verdict.sicherheit, einwand: verdict.einwand });
  });
  return kept
    .map((k, i) => ({ k, i }))
    .sort((a, b) => RANK[a.k.sicherheit] - RANK[b.k.sicherheit] || a.i - b.i)
    .slice(0, max)
    .map(({ k }) => k);
}

/** Quellen eines Vorschlags: nur URLs, die die Recherche wirklich gefunden hat (keine erfundenen). Rein. */
export function knownSources(claimed: readonly string[], found: ReadonlySet<string>): string[] {
  return [...new Set(claimed.filter((u) => found.has(u)))].slice(0, 4);
}

export interface AdvisorSuggestion {
  id: string;
  area: "prozess" | "wachstum" | "website";
  title: string;
  observation: string;
  evidence: string;
  proposal: string;
  impact: string;
  effort: "klein" | "mittel" | "gross";
  risk: string;
  confidence: "niedrig" | "mittel" | "hoch";
  critique: string | null;
  sources: string[];
  status: string;
}

export interface AdvisorReport {
  id: string;
  trigger: string;
  lage: string;
  rueckblick: string | null;
  fazit: string;
  dropped: number;
  costUsd: number;
  searches: number;
  suggestions: AdvisorSuggestion[];
}

export interface AdvisorDeps {
  db: Db;
  llm: LlmGateway;
  config: AdvisorConfig;
  now: () => Date;
  snapshot: Omit<SnapshotDeps, "db" | "now">;
}

/** Wie die Daten in der Nutzernachricht stehen: als JSON, fremde Recherche klar abgegrenzt. */
function userInput(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .map(([k, v]) => `<${k}>\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}\n</${k}>`)
    .join("\n\n");
}

export async function runAdvisor(
  deps: AdvisorDeps,
  trigger: string,
  /** Konkrete Frage von Christian für diese Runde (/berater <Frage>). */
  focus?: string | null,
): Promise<AdvisorReport> {
  const fokus = focus?.trim() ? { fokus: focus.trim().slice(0, 1000) } : {};
  const { db, llm, config } = deps;
  const snap: Snapshot = await buildSnapshot({ db, now: deps.now(), ...deps.snapshot });

  let research = { text: "(keine Recherche in dieser Runde)", sources: [] as { url: string }[], searches: 0 };
  let cost = 0;
  if (config.websuchen > 0) {
    const r = await llm.research({
      role: "advisor_research",
      promptVersion: ADVISOR_RESEARCH_PROMPT,
      system: loadPrompt("advisor_research", ADVISOR_RESEARCH_PROMPT),
      input: userInput({ ...fokus, lagebild: snap }),
      maxSearches: config.websuchen,
      inputSummary: `Berater-Recherche (${trigger})`,
    });
    research = r;
    cost += r.costUsd;
  }

  const drafts = await llm.structured({
    role: "advisor",
    promptVersion: ADVISOR_PROMPT,
    system: loadPrompt("advisor", ADVISOR_PROMPT),
    input: userInput({ ...fokus, lagebild: snap, recherche: research.text }),
    schema: advisorOutputSchema,
    inputSummary: `Berater-Entwürfe (${trigger})`,
  });
  cost += drafts.costUsd;

  let critic: CriticOutput = { bewertungen: [], fazit: "Keine Entwürfe." };
  if (drafts.output.vorschlaege.length > 0) {
    const r = await llm.structured({
      role: "advisor_critic",
      promptVersion: ADVISOR_CRITIC_PROMPT,
      system: loadPrompt("advisor_critic", ADVISOR_CRITIC_PROMPT),
      input: userInput({
        ...fokus,
        lagebild: snap,
        entwuerfe: drafts.output.vorschlaege.map((d, i) => ({ nr: i + 1, ...d })),
      }),
      schema: criticOutputSchema,
      inputSummary: `Berater-Gegenprüfung (${trigger})`,
    });
    critic = r.output;
    cost += r.costUsd;
  }

  const kept = keepSuggestions(drafts.output.vorschlaege, critic, config.max_vorschlaege);
  const found = new Set(research.sources.map((s) => s.url));
  const { rows } = await db.query<{ id: string }>(
    `insert into advisor_reports (trigger, lage, rueckblick, research, sources, cost_usd, dropped)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      trigger,
      drafts.output.lage,
      drafts.output.rueckblick,
      research.text,
      JSON.stringify(research.sources),
      cost.toFixed(5),
      drafts.output.vorschlaege.length - kept.length,
    ],
  );
  const reportId = rows[0]!.id;
  const suggestions: AdvisorSuggestion[] = [];
  for (const k of kept) {
    const sources = knownSources(k.quellen, found);
    const { rows: ins } = await db.query<{ id: string }>(
      `insert into advisor_suggestions
         (report_id, area, title, observation, evidence, proposal, impact, effort, risk, confidence, critique, sources)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [
        reportId,
        k.bereich,
        k.titel,
        k.beobachtung,
        k.beleg,
        k.vorschlag,
        k.wirkung,
        k.aufwand,
        k.risiko,
        k.sicherheit,
        k.einwand,
        JSON.stringify(sources),
      ],
    );
    suggestions.push({
      id: ins[0]!.id,
      area: k.bereich,
      title: k.titel,
      observation: k.beobachtung,
      evidence: k.beleg,
      proposal: k.vorschlag,
      impact: k.wirkung,
      effort: k.aufwand,
      risk: k.risiko,
      confidence: k.sicherheit,
      critique: k.einwand,
      sources,
      status: "offen",
    });
  }
  return {
    id: reportId,
    trigger,
    lage: drafts.output.lage,
    rueckblick: drafts.output.rueckblick,
    fazit: critic.fazit,
    dropped: drafts.output.vorschlaege.length - kept.length,
    costUsd: cost,
    searches: research.searches,
    suggestions,
  };
}

export type SuggestionStatus = "umsetzen" | "verworfen" | "spaeter" | "erledigt";

/** Christians Entscheidung zu einem Vorschlag. `null`, wenn es ihn nicht gibt. */
export async function decideSuggestion(
  db: Db,
  id: string,
  status: SuggestionStatus,
  now: Date,
): Promise<{ title: string } | null> {
  const { rows } = await db.query<{ title: string }>(
    "update advisor_suggestions set status = $2, decided_at = $3 where id = $1 returning title",
    [id, status, now],
  );
  return rows[0] ?? null;
}

/** Vorschläge mit diesem Status (für /vorschlaege), neueste zuerst. */
export async function suggestionsByStatus(
  db: Db,
  statuses: readonly string[],
  limit = 20,
): Promise<AdvisorSuggestion[]> {
  const { rows } = await db.query<AdvisorSuggestion>(
    `select id, area, title, observation, evidence, proposal, impact, effort, risk, confidence, critique, sources,
            status
       from advisor_suggestions where status = any($1) order by created_at desc limit $2`,
    [statuses, limit],
  );
  return rows;
}
