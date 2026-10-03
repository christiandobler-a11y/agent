import type { SiteContent } from "../content.js";
import { renderPhysio } from "./physio.js";
import { renderWerkstatt } from "./werkstatt.js";

/** Vorlagen je Name (config/prototype.yaml → templates). Unbekannte Namen nutzen "physio". */
export const TEMPLATES: Record<string, (c: SiteContent) => string> = {
  physio: renderPhysio,
  werkstatt: renderWerkstatt,
};

export function renderTemplate(name: string, content: SiteContent): string {
  return (TEMPLATES[name] ?? renderPhysio)(content);
}
