/** Argumente der CLI-Befehle (getrennt von cli.ts, damit Tests sie ohne Programmstart importieren können). */

const RESEARCH_USAGE = 'Verwendung: avelio research "<Suchbegriff>" <region> [-n <Ziel>]';

export function parseResearchArgs(args: string[]): { term: string; region: string; target: number } {
  const positional: string[] = [];
  let target = 20;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-n" || arg === "--ziel") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 200)
        throw new Error("-n erwartet eine Zahl von 1 bis 200");
      target = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unbekannte Option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [term, region] = positional;
  if (!term || !region || positional.length > 2) throw new Error(RESEARCH_USAGE);
  return { term, region, target };
}

const CRAWL_USAGE =
  "Verwendung: avelio crawl <Firmen-ID|Place-ID|Domain> | avelio crawl --pending [-n <Anzahl>]";

export type CrawlArgs = { mode: "one"; ref: string } | { mode: "pending"; limit: number };

export function parseCrawlArgs(args: string[]): CrawlArgs {
  if (args[0] === "--pending") {
    let limit = 10;
    if (args[1] === "-n") {
      limit = Number(args[2]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("-n erwartet eine Zahl von 1 bis 500");
      if (args.length > 3) throw new Error(CRAWL_USAGE);
    } else if (args.length > 1) {
      throw new Error(CRAWL_USAGE);
    }
    return { mode: "pending", limit };
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new Error(CRAWL_USAGE);
  return { mode: "one", ref: args[0] };
}
