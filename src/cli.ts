import { checkKeys } from "./config/check.js";
import { loadDotEnv, loadEnv, requireKeys } from "./config/env.js";
import { createDb, describeDbError } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { dbStatus } from "./db/status.js";
import { costReport } from "./db/costs.js";
import { createBudgetGuard } from "./llm/budget.js";
import { loadModelsConfig } from "./llm/config.js";
import { createAnthropicMessages, createLlmGateway } from "./llm/gateway.js";
import { loadBranches } from "./pipeline/research/branches.js";
import { loadGateRules } from "./pipeline/research/gate.js";
import { createPlacesClient } from "./pipeline/research/places.js";
import { createPrefilter } from "./pipeline/research/prefilter.js";
import { loadRecheckRules } from "./pipeline/research/recheck.js";
import { loadResearchConfig, runResearch, type ResearchStats } from "./pipeline/research/run.js";
import { loadRegion } from "./pipeline/research/tiling.js";
import { parseResearchArgs } from "./cli-args.js";

const ICONS = { ok: "✔", missing: "–", error: "✘" } as const;

async function checkEnv(): Promise<number> {
  const results = await checkKeys(loadEnv());
  for (const r of results) {
    console.log(`${ICONS[r.status]} ${r.name.padEnd(28)} ${r.detail}`);
  }
  return results.some((r) => r.status === "error") ? 1 : 0;
}

async function runMigrations(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const applied = await migrate(db);
    console.log(
      applied.length > 0 ? `Angewendet: ${applied.join(", ")}` : "Datenbank ist auf dem neuesten Stand.",
    );
    return 0;
  } finally {
    await db.end();
  }
}

const usd = (n: number) => `${n.toFixed(3).replace(".", ",")} $`;
const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "–";

const STOP_LABELS: Record<NonNullable<ResearchStats["stopped_because"]>, string> = {
  goal_reached: "Ziel erreicht",
  tiles_exhausted: "alle Orte abgesucht",
  request_limit: "Limit für Places-Anfragen erreicht (config/research.yaml)",
  budget_exceeded: "Budget erreicht",
};

function printStats(s: ResearchStats) {
  console.log(`
Kacheln:        ${s.tiles_searched}/${s.tiles_total} · Places-Anfragen ${s.places_requests} (~${usd(s.places_cost_usd)})
Treffer:        ${s.results} · außerhalb der Region ${s.out_of_region} · doppelt im Lauf ${s.duplicates_in_run}
Firmen:         neu ${s.new_companies} · bekannt ${s.known_companies} (davon noch nicht fällig ${s.known_not_due})
Gate:           ${counts(s.gate_skipped)}
Prefilter:      ${counts(s.prefilter_skipped)} · Fehler ${s.prefilter_errors} · LLM ${usd(s.llm_cost_usd)}
Bestanden:      ${s.passed} (Ziel ${s.goal}) · Ende: ${s.stopped_because ? STOP_LABELS[s.stopped_because] : (s.error ?? "?")}`);
  if (s.stopped_because === "budget_exceeded" && s.error) {
    console.log(
      `\n${s.error}\nNoch nicht geprüfte Firmen bleiben NEW und werden beim nächsten Lauf fertig geprüft.`,
    );
  }
}

async function research(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseResearchArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const env = loadEnv();
  const keys = requireKeys(env, ["DATABASE_URL", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]);
  const region = loadRegion(parsed.region);
  const db = createDb(keys.DATABASE_URL, { max: 6 });
  try {
    const models = loadModelsConfig();
    const budget = createBudgetGuard(db, models.budget);
    const llm = createLlmGateway({
      db,
      messages: createAnthropicMessages(keys.ANTHROPIC_API_KEY),
      models,
      budget,
    });
    console.log(`Suche "${parsed.term}" in ${region.name}, Ziel ${parsed.target} …`);
    const result = await runResearch(
      {
        db,
        places: createPlacesClient({ apiKey: keys.GOOGLE_API_KEY }),
        prefilter: createPrefilter(llm),
        branches: loadBranches(),
        gate: loadGateRules(),
        recheck: loadRecheckRules(),
        config: loadResearchConfig(),
        budget,
        onProgress: (m) => console.log(`  ${m}`),
      },
      { term: parsed.term, region, target: parsed.target, requestedBy: "cli" },
    );
    console.log(`\nSuchlauf ${result.run.id}`);
    for (const c of result.passed) {
      const site = c.website_url ?? "keine Website";
      console.log(`  ✔ ${c.name.padEnd(40)} ${(c.city ?? "").padEnd(22)} ${site}`);
    }
    printStats(result.stats);
    return 0;
  } finally {
    await db.end();
  }
}

async function showDbStatus(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const status = await dbStatus(db);
    console.log(`Schema ${status.schema}`);
    console.log(
      `Migrationen: ${status.migrations.map((m) => m.version).join(", ") || "keine – erst npm run migrate"}`,
    );
    let unprotected = 0;
    for (const t of status.tables) {
      const open = !t.rls || t.anonCanRead === true;
      if (open) unprotected++;
      const access =
        t.anonCanRead === null ? "" : t.anonCanRead ? " · Data API: OFFEN" : " · Data API: gesperrt";
      console.log(
        `  ${open ? "✘" : "✔"} ${t.name.padEnd(20)} ${String(t.rows).padStart(7)} Zeilen · RLS ${t.rls ? "an" : "AUS"}${access}`,
      );
    }
    if (unprotected > 0) console.log(`\n${unprotected} Tabelle(n) ungeschützt – npm run migrate ausführen.`);
    return unprotected > 0 || status.migrations.length === 0 ? 1 : 0;
  } finally {
    await db.end();
  }
}

async function showCosts(): Promise<number> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const { budget } = loadModelsConfig();
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const report = await costReport(db);
    const line = (label: string, spent: number, limit: number) =>
      `${label.padEnd(8)} ${usd(spent).padStart(10)} von ${usd(limit)} (${Math.round((spent / limit) * 100)} %)`;
    console.log(line("Heute", report.today, budget.daily_usd));
    console.log(line("Monat", report.month, budget.monthly_usd));
    console.log("\nLetzte 7 Tage nach Rolle bzw. Dienst:");
    if (report.rows.length === 0) console.log("  noch keine Kosten");
    for (const r of report.rows) {
      const errors = r.errors > 0 ? ` · ${r.errors} Fehler` : "";
      console.log(
        `  ${r.day}  ${`${r.source}/${r.name}`.padEnd(16)} ${String(r.calls).padStart(5)} Aufrufe ${usd(r.cost_usd).padStart(10)}${errors}`,
      );
    }
    return 0;
  } finally {
    await db.end();
  }
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  costs: showCosts,
  "check-env": checkEnv,
  migrate: runMigrations,
  "db-status": showDbStatus,
  research,
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) {
    console.error(`Verwendung: avelio <${Object.keys(commands).join("|")}>`);
    return 2;
  }
  return command(rest);
}

loadDotEnv();
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // Kurze Meldung statt Stacktrace; Details mit DEBUG=1.
  console.error(`Fehler: ${describeDbError(err, process.env.DATABASE_URL)}`);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
}
