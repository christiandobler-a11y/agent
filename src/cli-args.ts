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
