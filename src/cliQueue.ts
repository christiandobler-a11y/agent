import { createApp } from "./app.js";
import { parseResearchArgs } from "./cli-args.js";
import { loadEnv, requireKeys } from "./config/env.js";
import { createDb, type Db } from "./db/client.js";
import { getSearchRun, type SearchRun } from "./db/searchRuns.js";
import { pendingJobs, runSummary, startSearch, type PipelineContext } from "./queue/pipeline.js";
import { startWorkers } from "./queue/workers.js";
import { askManager } from "./manager/agent.js";
import { runAdvisor } from "./advisor/run.js";
import { runTool } from "./manager/tools.js";
import { loadBranches } from "./pipeline/research/branches.js";
import { loadResearchConfig } from "./pipeline/research/run.js";
import { loadRegion } from "./pipeline/research/tiling.js";

/** CLI für den Queue-Betrieb (Schritt 7): search, worker, runs, failed. */

const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const time = (d: Date) =>
  d.toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });

/** Für reine Lesebefehle reichen Datenbank und Schema-Name. */
function readCtx(db: Db): PipelineContext {
  return { db, bossSchema: "pgboss" } as PipelineContext;
}

function formatCounts(counts: Record<string, number>): string {
  const order = ["QUALIFIED", "SKIPPED", "FAILED", "AUDITED", "RESEARCHED", "NEW"];
  return order
    .filter((s) => counts[s])
    .map((s) => `${s} ${counts[s]}`)
    .join(" · ");
}

async function printRun(ctx: PipelineContext, run: SearchRun) {
  const s = await runSummary(ctx, run);
  const q = run.query as { term?: string; region?: string };
  const pending = run.status === "RUNNING" ? await pendingJobs(ctx, run.id).catch(() => 0) : 0;
  console.log(
    `${time(run.created_at)}  ${run.status.padEnd(9)} "${q.term}" ${q.region} (Ziel ${run.target_count})  ${run.id.slice(0, 8)}`,
  );
  console.log(
    `   ${formatCounts(s.counts) || "noch keine Firmen"}${pending ? ` · ${pending} Jobs offen` : ""} · Kosten ${usd(s.costUsd)}`,
  );
  for (const l of s.topLeads)
    console.log(`   ✔ ${String(l.score).padStart(3)}  ${l.name} (${l.city ?? "?"})`);
}

export async function search(argv: string[]): Promise<number> {
  const wait = argv.includes("--wait");
  let parsed;
  try {
    parsed = parseResearchArgs(argv.filter((a) => a !== "--wait"));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)} [--wait]`);
    return 2;
  }
  const app = await createApp();
  try {
    const run = await startSearch(app.ctx, {
      term: parsed.term,
      regionKey: parsed.region,
      target: parsed.target,
      requestedBy: "cli",
      complete: parsed.complete,
    });
    console.log(`Suchlauf ${run.id} eingereiht. Er läuft im Worker (npm start bzw. npm run cli -- worker).`);
    if (!wait) {
      console.log("Stand abfragen: npm run cli -- runs");
      return 0;
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, 15_000));
      const current = (await getSearchRun(app.db, run.id))!;
      const summary = await runSummary(app.ctx, current);
      console.log(`  ${time(new Date())}  ${current.status}  ${formatCounts(summary.counts)}`);
      if (current.status !== "RUNNING") {
        await printRun(app.ctx, current);
        return current.status === "COMPLETED" ? 0 : 1;
      }
    }
  } finally {
    await app.close();
  }
}

export async function worker(): Promise<number> {
  const app = await createApp({ worker: true });
  await startWorkers(app.ctx);
  console.log("Worker läuft (Strg+C beendet; laufende Jobs dürfen fertig werden).");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await app.close();
  return 0;
}

export async function runs(argv: string[]): Promise<number> {
  const n = argv[0] === "-n" ? Number(argv[1]) : 5;
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const { rows } = await db.query<SearchRun>(
      "select * from search_runs order by created_at desc limit $1",
      [Number.isInteger(n) && n > 0 ? n : 5],
    );
    if (rows.length === 0) console.log("Noch keine Suchläufe.");
    for (const run of rows) await printRun(readCtx(db), run);
    return 0;
  } finally {
    await db.end();
  }
}

export async function failed(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const { rows } = await db.query<{
      name: string;
      city: string | null;
      skip_detail: string | null;
      updated_at: Date;
      recheck_after: Date | null;
    }>(
      `select name, city, skip_detail, updated_at, recheck_after from companies
        where status = 'FAILED' and updated_at > now() - interval '14 days'
        order by updated_at desc limit 50`,
    );
    console.log(
      rows.length === 0
        ? "Keine fehlgeschlagenen Firmen in den letzten 14 Tagen."
        : "Fehlgeschlagen (letzte 14 Tage):",
    );
    for (const r of rows) {
      const again = r.recheck_after ? `, neuer Versuch ab ${time(r.recheck_after)}` : "";
      console.log(`  ✘ ${r.name} (${r.city ?? "?"}) – ${r.skip_detail ?? "ohne Angabe"}${again}`);
    }
    const dead = await db
      .query<{ n: number }>("select count(*)::int as n from pgboss.job where name = 'dead'")
      .then((r) => r.rows[0]!.n)
      .catch(() => 0);
    if (dead > 0) console.log(`\n${dead} Job(s) endgültig gescheitert (Dead-Letter-Queue "dead").`);
    return 0;
  } finally {
    await db.end();
  }
}

/** Manager ohne Telegram befragen (gleicher Agent, gleicher Verlauf wie im Chat). */
export async function chat(argv: string[]): Promise<number> {
  const text = argv.join(" ").trim();
  if (!text) {
    console.error('Verwendung: avelio chat "Was hat das diese Woche gekostet?"');
    return 2;
  }
  const chatId = loadEnv().TELEGRAM_ALLOWED_CHAT_IDS[0] ?? 0;
  const app = await createApp();
  try {
    const reply = await askManager({ ctx: app.ctx, llm: app.llm }, chatId, text);
    console.log(reply.text);
    const tools = reply.toolCalls.map((t) => `${t.name}${t.isError ? " (Fehler)" : ""}`).join(", ");
    console.log(
      `\n[Werkzeuge: ${tools || "keine"} · Kosten ${reply.costUsd.toFixed(4).replace(".", ",")} $]`,
    );
    return 0;
  } finally {
    await app.close();
  }
}

/** Abdeckung je Region und Branche: `avelio coverage [region] [branche]` (nur Datenbank, keine API-Keys). */
export async function coverage(argv: string[]): Promise<number> {
  const [region, term] = argv;
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const ctx = {
      db,
      loadRegion,
      research: { branches: loadBranches(), config: loadResearchConfig() },
      now: () => new Date(),
    } as unknown as PipelineContext;
    const { text, isError } = await runTool(
      "coverage",
      { ...(region ? { region } : {}), ...(term ? { branche: term } : {}) },
      { ctx, chatId: 0 },
    );
    console.log(text);
    return isError ? 1 : 0;
  } finally {
    await db.end();
  }
}

/** Berater-Runde direkt ausführen (ohne Queue): `avelio berater [--ohne-suche] [--fokus "Frage"]`. Speichert und gibt den Bericht aus. */
export async function advisor(argv: string[]): Promise<number> {
  const app = await createApp();
  try {
    const base = app.ctx.advisor;
    if (!base) throw new Error("Berater nicht eingerichtet");
    const deps = base.deps();
    if (argv.includes("--ohne-suche")) deps.config = { ...deps.config, websuchen: 0 };
    const i = argv.indexOf("--fokus");
    const r = await runAdvisor(deps, "cli", i >= 0 ? (argv[i + 1] ?? null) : null);
    console.log(`LAGE: ${r.lage}`);
    if (r.rueckblick) console.log(`RÜCKBLICK: ${r.rueckblick}`);
    console.log(`GEGENPRÜFER: ${r.fazit} (${r.dropped} verworfen)\n`);
    for (const s of r.suggestions)
      console.log(
        [
          `[${s.area}] ${s.title} · Sicherheit ${s.confidence} · Aufwand ${s.effort}`,
          `  Beobachtung: ${s.observation}`,
          `  Beleg: ${s.evidence}`,
          `  Vorschlag: ${s.proposal}`,
          `  Wirkung: ${s.impact}`,
          `  Risiko: ${s.risk}`,
          `  Gegenprüfer: ${s.critique ?? "–"}`,
          `  Quellen: ${s.sources.join(" ") || "–"}`,
          "",
        ].join("\n"),
      );
    console.log(`[${r.searches} Websuchen · Kosten ${usd(r.costUsd)}]`);
    return 0;
  } finally {
    await app.close();
  }
}
