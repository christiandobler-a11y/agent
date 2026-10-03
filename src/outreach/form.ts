/**
 * Anredeform: "sie" (Standard), "du" (eine Person in einer Du-Branche, Name bekannt) oder "ihr" (Du-Branche ohne
 * Ansprechpartner, also das Team). Die Textbausteine in config/outreach.yaml gibt es in Sie- und Du-Form; die
 * Ihr-Form wird aus der Du-Form abgeleitet.
 */
export type Form = "sie" | "du" | "ihr";

const DU_TO_IHR: [RegExp, string][] = [
  [/\bHättest du\b/g, "Hättet ihr"],
  [/\bPasst dir\b/g, "Passt euch"],
  [/\bantwortest du\b/g, "antwortet ihr"],
  [/\bschreibst mir\b/g, "schreibt mir"],
  [/\bdu\b/g, "ihr"],
  [/\bdir\b/g, "euch"],
  [/\bdich\b/g, "euch"],
  [/\bdeine\b/g, "eure"],
  [/\bdein\b/g, "euer"],
];

export function duToIhr(text: string): string {
  return DU_TO_IHR.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** Sie-Betreff in Du-Form. Die Website gehört dem Betrieb, also "Eure Website" (auch bei du an eine Person). */
export function subjectFor(subject: string, form: Form): string {
  if (form === "sie") return subject;
  const [ihr, ihre, ihrer, ihren, ihrem] = ["Euer", "Eure", "Eurer", "Euren", "Eurem"];
  return subject
    .replace(/\bIhrem\b/g, ihrem)
    .replace(/\bIhrer\b/g, ihrer)
    .replace(/\bIhren\b/g, ihren)
    .replace(/\bIhre\b/g, ihre)
    .replace(/\bIhr\b/g, ihr);
}

/** Nach "Hallo …," geht es klein weiter (außer bei Sie/Ihnen). */
export function lowerFirst(text: string): string {
  return /^(Sie|Ihnen|Ihr)\b/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}
