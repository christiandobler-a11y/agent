import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateGoldenSet,
  formatCalibrationReport,
  parseGoldenFile,
} from "../src/pipeline/scoring/calibration.js";
import { loadScoringConfig } from "../src/pipeline/scoring/config.js";

/**
 * Regressionstest am Golden Set (ARCHITECTURE.md 7.4, Kriterium 10): Jede Gewichts- oder Prompt-Änderung muss
 * Christians Bewertungen bestehen. Die Datei entsteht mit `npm run cli -- calibrate export`.
 */
const GOLDEN = "tests/golden/golden.json";

describe.skipIf(!existsSync(GOLDEN))("Golden Set", () => {
  it("besteht Abnahmekriterium 10 mit den aktuellen Gewichten", () => {
    const config = loadScoringConfig();
    const report = evaluateGoldenSet(parseGoldenFile(JSON.parse(readFileSync(GOLDEN, "utf8"))), config);
    expect(report.pass, formatCalibrationReport(report, config.version)).toBe(true);
  });
});
