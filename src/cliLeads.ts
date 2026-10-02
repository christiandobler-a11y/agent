import { AUDIT_USAGE, SCORE_USAGE, parseTargetArgs } from "./cli-args.js";
import { loadEnv, requireKeys } from "./config/env.js";
import { createDb, type Db } from "./db/client.js";
import { companiesToAudit, companiesWithScore, findCompany, type Company } from "./db/companies.js";
import { createBudgetGuard, BudgetExceededError } from "./llm/budget.js";
import { loadModelsConfig } from "./llm/config.js";
import { createAnthropicMessages, createLlmGateway, LlmError, type LlmGateway } from "./llm/gateway.js";
import { explainStoredLead } from "./pipeline/audit/explainStored.js";
import { auditCompany, pitchCompany, scoreCompany, type LeadDeps } from "./pipeline/audit/run.js";
import { loadCrawlConfig } from "./pipeline/crawl/config.js";
import { loadBranches } from "./pipeline/research/branches.js";
import { loadRecheckRules } from "./pipeline/research/recheck.js";
import { loadScoringConfig } from "./pipeline/scoring/config.js";

/** CLI: audit, score, explain (Schritt 6). */

const usd = (n: number) => `${n.toFixed(3).replace(".", ",")} $`;

function leadDeps(db: Db, llm: LlmGateway): LeadDeps {
  return {
    db,
    llm,
    crawl: loadCrawlConfig(),
    scoring: loadScoringConfig(),
    branches: loadBranches(),
    recheck: loadRecheckRules(),
  };
}

/** Ohne Anthropic-Key: Gateway, das jeden Aufruf ablehnt (für score/explain reicht die Datenbank). */
const NO_LLM: LlmGateway = {
  structured: () => Promise.reject(new Error("Kein LLM in diesem Befehl")),
};

async function targets(
  db: Db,
  args: ReturnType<typeof parseTargetArgs>,
  pending: (limit: number) => Promise<Company[]>,
) {
  if (args.mode === "one") {
    const c = await findCompany(db, args.ref);
    return c ? [c] : [];
  }
  return pending(args.limit);
}

export async function audit(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseTargetArgs(argv, AUDIT_USAGE);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const keys = requireKeys(loadEnv(), ["DATABASE_URL", "ANTHROPIC_API_KEY"]);
  const db = createDb(keys.DATABASE_URL, { max: 3 });
  try {
    const models = loadModelsConfig();
    const llm = createLlmGateway({
      db,
      messages: createAnthropicMessages(keys.ANTHROPIC_API_KEY),
      models,
      budget: createBudgetGuard(db, models.budget),
    });
    const deps = leadDeps(db, llm);
    const companies = await targets(db, args, (n) => companiesToAudit(db, n));
    if (companies.length === 0) {
      console.log(args.mode === "one" ? `Keine Firma gefunden für "${args.ref}".` : "Nichts zu bewerten.");
      return args.mode === "one" ? 1 : 0;
    }
    let cost = 0;
    for (const company of companies) {
      try {
        const a = await auditCompany(deps, company);
        if (a.kind === "no_snapshot") {
          console.log(`– ${company.name}: noch nicht gecrawlt (zuerst: crawl ${company.id})`);
          continue;
        }
        if (a.kind === "audited") cost += a.costUsd;
        const scored = await scoreCompany(deps, company);
        const pitch = await pitchCompany(deps, company, scored);
        const r = scored.result;
        const label = r.knockout
          ? `SKIPPED (${r.knockout.detail})`
          : r.qualified
            ? "QUALIFIED"
            : "SKIPPED (low_score)";
        const how =
          a.kind === "audited"
            ? `Audit ${usd(a.costUsd)}`
            : a.kind === "reused"
              ? "Audit wiederverwendet"
              : "ohne Website";
        console.log(
          `${r.qualified ? "✔" : "–"} ${company.name.padEnd(40)} ${String(r.total).padStart(3)}/100  ${label}  · ${how}${pitch ? " · Pitch erstellt" : ""}`,
        );
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.log(`\n${err.message}`);
          break;
        }
        if (err instanceof LlmError) {
          console.log(`✘ ${company.name}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    console.log(
      `\nAudit-Kosten dieses Laufs: ${usd(cost)} (Pitch-Kosten siehe npm run costs). Details: npm run cli -- explain <Firma>`,
    );
    return 0;
  } finally {
    await db.end();
  }
}

export async function score(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseTargetArgs(argv, SCORE_USAGE, true);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const deps = leadDeps(db, NO_LLM);
    const companies = await targets(db, args, () => companiesWithScore(db));
    for (const company of companies) {
      const before = company.current_score;
      const { result } = await scoreCompany(deps, company);
      const change = before === null || before === result.total ? "" : ` (vorher ${before})`;
      console.log(
        `${company.name.padEnd(40)} ${String(result.total).padStart(3)}/100${change}${result.knockout ? `  aussortiert: ${result.knockout.detail}` : ""}`,
      );
    }
    console.log(
      `\n${companies.length} Firma/Firmen neu bewertet mit config/scoring.${deps.scoring.version}.yaml (ohne LLM).`,
    );
    return 0;
  } finally {
    await db.end();
  }
}

export async function explain(argv: string[]): Promise<number> {
  const full = argv.includes("--full");
  const refs = argv.filter((a) => a !== "--full");
  if (refs.length !== 1) {
    console.error("Verwendung: avelio explain <Firmen-ID|Place-ID|Domain> [--full]");
    return 2;
  }
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 1 });
  try {
    const company = await findCompany(db, refs[0]!);
    if (!company) {
      console.log(`Keine Firma gefunden für "${refs[0]}".`);
      return 1;
    }
    console.log(await explainStoredLead(db, company, full));
    return 0;
  } finally {
    await db.end();
  }
}
