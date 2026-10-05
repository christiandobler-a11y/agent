import { domainIdentity } from "../pipeline/research/identity.js";
import { isFreemail } from "./mail.js";

/**
 * Gleicher Betrieb, anderer Standort (05.10.2026, Christian: tc-rosenheim.de und tc-stollstrasse.de sind zwei
 * Standorte derselben GmbH, "peinlich, wenn wir die gleiche Mail zweimal schicken"). Google führt Standorte als
 * eigene Firmen mit eigener Website, Mail und Telefon. Gemeinsam haben sie meist das Impressum: Handelsregister,
 * USt-IdNr., Geschäftsführer. Rein: aus den Daten einer Firma entstehen Schlüssel; teilen zwei Firmen einen, gehören
 * sie zusammen, und das Morgen-Paket schreibt nur eine davon an.
 */

export interface GroupInput {
  websiteUrl: string | null;
  email: string | null;
  postalCode: string | null;
  impressum?: Impressum | null | undefined;
}

export interface Impressum {
  register?: string | null;
  vat_id?: string | null;
  person?: string | null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function groupKeys(g: GroupInput): string[] {
  const keys = new Set<string>();
  const site = domainIdentity(g.websiteUrl);
  if (site) keys.add(`web:${site.split("/")[0]}`);
  const email = g.email?.trim().toLowerCase();
  if (email) {
    keys.add(`mail:${email}`);
    const domain = email.split("@")[1];
    if (domain && !isFreemail(domain)) keys.add(`maildomain:${domain}`);
  }
  const i = g.impressum;
  if (i?.vat_id) keys.add(`vat:${i.vat_id.replace(/\s/g, "").toUpperCase()}`);
  const person = i?.person ? norm(i.person) : null;
  // Registernummern wiederholen sich je Amtsgericht: nur zusammen mit derselben Person eindeutig genug.
  if (i?.register && person) keys.add(`reg:${norm(i.register)}|${person}`);
  // Dieselbe Person im Impressum in derselben Gegend (erste zwei Ziffern der PLZ).
  if (person && person.includes(" ") && g.postalCode)
    keys.add(`person:${person}|${g.postalCode.slice(0, 2)}`);
  return [...keys];
}

/** Welche Schlüssel schon vergeben sind und an wen (für die Meldung "gleicher Betrieb wie …"). */
export class GroupIndex {
  private readonly owner = new Map<string, string>();

  add(keys: readonly string[], name: string): void {
    for (const k of keys) if (!this.owner.has(k)) this.owner.set(k, name);
  }

  /** Name der Firma, mit der `keys` zusammengehören, sonst `null`. */
  match(keys: readonly string[]): string | null {
    for (const k of keys) {
      const o = this.owner.get(k);
      if (o) return o;
    }
    return null;
  }
}
