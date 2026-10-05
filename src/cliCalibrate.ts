import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, requireKeys } from "./config/env.js";
import { createDb } from "./db/client.js";
import { GRADES, setRating, type Grade } from "./db/calibration.js";
import { findCompany } from "./db/companies.js";
import type { LlmGateway } from "./llm/gateway.js";
import { loadCrawlConfig } from "./pipeline/crawl/config.js";
import { loadGoldenEntries } from "./pipeline/calibration.js";
import { loadBranches } from "./pipeline/research/branches.js";
import { loadRecheckRules } from "./pipeline/research/recheck.js";
import {
  evaluateGoldenSet,
  formatCalibrationReport,
  parseGoldenFile,
  toGoldenFile,
  type GoldenEntry,
} from "./pipeline/scoring/calibration.js";
import { loadScoringConfig } from "./pipeline/scoring/config.js";

/** CLI: Kalibrierung am Golden Set (ARCHITECTURE.md 7.4). */

export const GOLDEN_FILE = "tests/golden/golden.json";

const USAGE = `Verwendung:
  avelio calibrate                       Auswertung aus der Datenbank (deine Bewertungen gegen den Score)
  avelio calibrate --file [Pfad]         Auswertung aus der exportierten Datei (ohne Datenbank, Standard ${GOLDEN_FILE})
  avelio calibrate export [Pfad]         Golden Set als Datei speichern (für den Regressionstest im Repo)
  avelio calibrate rate <Firma> <A|B|C|X>  eine Firma bewerten (sonst in Telegram: /kalibrieren)`;

const NO_LLM: LlmGateway = {
  structured: () => Promise.reject(new Error("Kein LLM in diesem Befehl")),
  toolStep: () => Promise.reject(new Error("Kein LLM in diesem Befehl")),
  research: () => Promise.reject(new Error("Kein LLM in diesem Befehl")),
};

async function fromDb<T>(fn: (entries: GoldenEntry[]) => T): Promise<T> {
  const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
  const db = createDb(DATABASE_URL, { max: 2 });
  try {
    const entries = await loadGoldenEntries({
      db,
      llm: NO_LLM,
      crawl: loadCrawlConfig(),
      scoring: loadScoringConfig(),
      branches: loadBranches(),
      recheck: loadRecheckRules(),
    });
    return fn(entries);
  } finally {
    await db.end();
  }
}

function report(entries: GoldenEntry[]): number {
  if (entries.length === 0) {
    console.log("Noch keine Firma bewertet. In Telegram: /kalibrieren");
    return 0;
  }
  const scoring = loadScoringConfig();
  const r = evaluateGoldenSet(entries, scoring);
  console.log(formatCalibrationReport(r, scoring.version));
  return 0;
}

export async function calibrate(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined) return fromDb(report);

  if (sub === "--file") {
    const path = rest[0] ?? GOLDEN_FILE;
    return report(parseGoldenFile(JSON.parse(readFileSync(path, "utf8"))));
  }

  if (sub === "export") {
    const path = rest[0] ?? GOLDEN_FILE;
    return fromDb((entries) => {
      if (entries.length === 0) {
        console.log("Noch keine Firma bewertet, nichts zu exportieren.");
        return 1;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(toGoldenFile(entries, new Date()), null, 2)}\n`);
      console.log(`${entries.length} Firmen nach ${path} geschrieben.`);
      return 0;
    });
  }

  if (sub === "rate" && rest.length === 2) {
    const grade = rest[1]!.toUpperCase();
    if (!(GRADES as readonly string[]).includes(grade)) {
      console.error(USAGE);
      return 2;
    }
    const { DATABASE_URL } = requireKeys(loadEnv(), ["DATABASE_URL"]);
    const db = createDb(DATABASE_URL, { max: 1 });
    try {
      const company = await findCompany(db, rest[0]!);
      if (!company) {
        console.log(`Keine Firma gefunden für "${rest[0]}".`);
        return 1;
      }
      await setRating(db, { companyId: company.id, grade: grade as Grade });
      console.log(`${company.name}: ${grade} gespeichert.`);
      return 0;
    } finally {
      await db.end();
    }
  }

  console.error(USAGE);
  return 2;
}
