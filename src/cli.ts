import { checkKeys } from "./config/check.js";
import { loadEnv } from "./config/env.js";

const ICONS = { ok: "✔", missing: "–", error: "✘" } as const;

async function checkEnv(): Promise<number> {
  const results = await checkKeys(loadEnv());
  for (const r of results) {
    console.log(`${ICONS[r.status]} ${r.name.padEnd(28)} ${r.detail}`);
  }
  return results.some((r) => r.status === "error") ? 1 : 0;
}

const commands: Record<string, () => Promise<number>> = {
  "check-env": checkEnv,
};

async function main(argv: string[]): Promise<number> {
  const [name] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) {
    console.error(`Verwendung: avelio <${Object.keys(commands).join("|")}>`);
    return 2;
  }
  return command();
}

process.exitCode = await main(process.argv.slice(2));
