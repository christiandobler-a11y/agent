/** Argumente der CLI-Befehle (getrennt von cli.ts, damit Tests sie ohne Programmstart importieren können). */

const RESEARCH_USAGE = 'Verwendung: avelio research "<Suchbegriff>" <region> [-n <Ziel> | --alle]';

export function parseResearchArgs(args: string[]): {
  term: string;
  region: string;
  target: number;
  complete: boolean;
} {
  const positional: string[] = [];
  let target = 20;
  let complete = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-n" || arg === "--ziel") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 200)
        throw new Error("-n erwartet eine Zahl von 1 bis 200");
      target = value;
    } else if (arg === "--alle" || arg === "--komplett") {
      complete = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unbekannte Option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [term, region] = positional;
  if (!term || !region || positional.length > 2) throw new Error(RESEARCH_USAGE);
  return { term, region, target, complete };
}

const CRAWL_USAGE =
  "Verwendung: avelio crawl <Firmen-ID|Place-ID|Domain> | avelio crawl --pending [-n <Anzahl>] | avelio crawl --leads";

export type CrawlArgs = { mode: "one"; ref: string } | { mode: "pending"; limit: number };

/** `--leads`: alle qualifizierten Leads und Leads im Vertrieb neu crawlen (frische Impressum-Daten, Screenshots). */
export function parseCrawlArgs(args: string[]): CrawlArgs | { mode: "leads" } {
  if (args.length === 1 && args[0] === "--leads") return { mode: "leads" };
  return parseTargetArgs(args, CRAWL_USAGE);
}

/** Eine Firma (ID, Place-ID, Domain) oder `--pending [-n N]` bzw. `--all` (gleiche Form wie crawl). */
export function parseTargetArgs(args: string[], usage: string, allowAll = false): CrawlArgs {
  if (allowAll && args[0] === "--all" && args.length === 1) return { mode: "pending", limit: 100_000 };
  if (args[0] === "--pending") {
    let limit = 10;
    if (args[1] === "-n") {
      limit = Number(args[2]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("-n erwartet eine Zahl von 1 bis 500");
      if (args.length > 3) throw new Error(usage);
    } else if (args.length > 1) {
      throw new Error(usage);
    }
    return { mode: "pending", limit };
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new Error(usage);
  return { mode: "one", ref: args[0] };
}

export const AUDIT_USAGE =
  "Verwendung: avelio audit <Firmen-ID|Place-ID|Domain> | avelio audit --pending [-n <Anzahl>]";
export const SCORE_USAGE = "Verwendung: avelio score <Firmen-ID|Place-ID|Domain> | avelio score --all";
