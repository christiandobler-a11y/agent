import { checkKeys } from "./config/check.js";
import { loadEnv, requireKeys } from "./config/env.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
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

function printStats(s: ResearchStats) {
  console.log(`
Kacheln:        ${s.tiles_searched}/${s.tiles_total} · Places-Anfragen ${s.places_requests} (~${usd(s.places_cost_usd)})
Treffer:        ${s.results} · außerhalb der Region ${s.out_of_region} · doppelt im Lauf ${s.duplicates_in_run}
Firmen:         neu ${s.new_companies} · bekannt ${s.known_companies} (davon noch nicht fällig ${s.known_not_due})
Gate:           ${counts(s.gate_skipped)}
Prefilter:      ${counts(s.prefilter_skipped)} · Fehler ${s.prefilter_errors} · LLM ${usd(s.llm_cost_usd)}
Bestanden:      ${s.passed} (Ziel ${s.goal}) · Ende: ${s.stopped_because ?? s.error ?? "?"}`);
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
    const llm = createLlmGateway({
      db,
      messages: createAnthropicMessages(keys.ANTHROPIC_API_KEY),
      models: loadModelsConfig(),
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

const commands: Record<string, (args: string[]) => Promise<number>> = {
  "check-env": checkEnv,
  migrate: runMigrations,
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

process.exitCode = await main(process.argv.slice(2));
