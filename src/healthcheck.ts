import { statSync } from "node:fs";
import { HEALTH_FILE, HEALTH_MAX_AGE_MS } from "./health.js";

/** Docker-HEALTHCHECK: gesund, wenn das letzte Lebenszeichen jünger als 3 Minuten ist. */
try {
  const age = Date.now() - statSync(HEALTH_FILE).mtimeMs;
  process.exitCode = age < HEALTH_MAX_AGE_MS ? 0 : 1;
  if (age >= HEALTH_MAX_AGE_MS) console.error(`Letztes Lebenszeichen vor ${Math.round(age / 1000)} s`);
} catch {
  console.error("Noch kein Lebenszeichen");
  process.exitCode = 1;
}
