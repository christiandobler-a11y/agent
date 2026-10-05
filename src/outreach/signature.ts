import type { OutreachConfig } from "./config.js";

/**
 * Absender unter jeder Mail (Erstmail, Nachfassen, Bestätigung): Name, Zusatz, Anschrift, Telefon. 06.10.2026
 * (Christian, bis das Rechtliche geklärt ist): vollständige Anbieterangaben machen klar, wer schreibt; Anschrift und
 * Datenschutz-Link kommen aus der .env (OUTREACH_ADDRESS, OUTREACH_PRIVACY_URL), nicht aus dem Repo. Rein.
 */
export interface SenderContact {
  phone: string | null;
  address?: string | null;
  privacyUrl?: string | null;
}

export function senderSignature(o: OutreachConfig, c: SenderContact): string {
  return [o.absender_name, o.absender_zusatz, c.address, c.phone].filter(Boolean).join("\n");
}

/**
 * Schlussabsatz der Erstmail: woher die Adresse stammt (Art. 14 DSGVO), wie man keine weiteren Nachrichten bekommt
 * und, wenn eingerichtet, der Link zur Datenschutzerklärung. `null`, wenn nichts davon konfiguriert ist. Rein.
 */
export function closingNotice(
  o: OutreachConfig,
  c: SenderContact,
  du: boolean,
  /** Woher die Adresse stammt (impressum, website, google); unbekannt = kein Herkunfts-Satz. */
  source: string | null,
): string | null {
  const pick = (t: { sie: string; du: string } | null | undefined) => (t ? (du ? t.du : t.sie) : null);
  const where = source ? pick(o.herkunft?.quelle[source]) : null;
  const origin = where ? pick(o.herkunft)!.replace("{quelle}", where) : null;
  const link =
    c.privacyUrl && o.datenschutz_link ? pick(o.datenschutz_link)!.replace("{url}", c.privacyUrl) : null;
  const parts = [origin, pick(o.abmeldung), link].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" ") : null;
}
