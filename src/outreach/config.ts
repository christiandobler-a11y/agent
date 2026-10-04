import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";

/** Positionierung, Schreibregeln, Spamschutz und Terminfenster für Kontakt-Entwürfe (config/outreach.yaml). */

const hm = z.string().regex(/^\d{2}:\d{2}$/);
export const WEEKDAYS = [
  "sonntag",
  "montag",
  "dienstag",
  "mittwoch",
  "donnerstag",
  "freitag",
  "samstag",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const outreachConfigSchema = z.object({
  positionierung: z.string(),
  absender_name: z.string().min(1),
  absender_zusatz: z.string().default(""),
  // Letzte Zeile der Erstmail: wie man keine weiteren Nachrichten bekommt.
  abmeldung: z.object({ sie: z.string(), du: z.string() }).nullable().default(null),
  du_branchen: z.array(z.string()).default([]),
  // Termin-Bestätigung per Knopf (src/outreach/confirm.ts); {termin} und {ablauf} setzt der Code.
  bestaetigung: z
    .object({
      text: z.string(),
      text_du: z.string(),
      ablauf_telefon: z.string(),
      ablauf_telefon_du: z.string(),
      ablauf_link: z.string(),
      ablauf_link_du: z.string(),
      erinnerung_minuten: z.number().int().min(0).default(30),
      dauer_minuten: z.number().int().min(5).default(15),
    })
    .default({
      text: "super, dann machen wir {termin}. {ablauf} Eine Kalender-Einladung hängt an, ich freu mich drauf.",
      text_du:
        "super, dann machen wir {termin}. {ablauf} Eine Kalender-Einladung hängt an, ich freu mich drauf.",
      ablauf_telefon:
        "Den Link zum Video-Call (läuft einfach im Browser, nichts installieren) schicke ich Ihnen ein paar Minuten vorher, dann zeige ich Ihnen den Entwurf direkt am Bildschirm.",
      ablauf_telefon_du:
        "Den Link zum Video-Call (läuft einfach im Browser, nichts installieren) schick ich dir ein paar Minuten vorher, dann zeig ich dir den Entwurf direkt am Bildschirm.",
      ablauf_link:
        "Hier schon mal der Link zum Video-Call, der läuft einfach im Browser, nichts installieren: {link}",
      ablauf_link_du:
        "Hier schon mal der Link zum Video-Call, der läuft einfach im Browser, nichts installieren: {link}",
      erinnerung_minuten: 30,
      dauer_minuten: 15,
    }),
  // Warum eine gute Website für die Branche zählt (geht als Kontext an das LLM, Rolle contact).
  branche_kontext: z.record(z.string(), z.string()).default({}),
  // Grußzeile: {anrede} {nachname} nur mit feststehendem Frau/Herr, {vorname} bei du, sonst ans Team.
  anrede: z
    .object({
      sie: z.string(),
      du: z.string(),
      ohne_name: z.string(),
      // Frau/Herr aus einem eindeutigen Vornamen, wenn das Impressum es nicht sagt (src/outreach/names.ts).
      vorname_geschlecht: z.boolean().default(true),
    })
    .default({
      sie: "Grüß Sie, {anrede} {nachname},",
      du: "Servus {vorname},",
      ohne_name: "Hallo Team {firma},",
      vorname_geschlecht: true,
    }),
  // Ohne Ansprechpartner: Anrede ans Team und Bitte um Weiterleitung, je Branche (sonst anrede.ohne_name).
  team_anrede: z
    .record(
      z.string(),
      z.object({ anrede: z.string(), weiterleiten: z.string(), weiterleiten_du: z.string() }),
    )
    .default({}),
  einstieg: z.string().min(1),
  einstiege_abwechslung: z.array(z.string()).default([]),
  regeln: z.array(z.string()),
  spamschutz: z.object({
    betreffe: z.array(z.string()).min(1),
    gruesse: z.array(z.string()).min(1),
    regeln: z.array(z.string()),
  }),
  kontaktweg: z.object({
    whatsapp_text: z.string(),
    whatsapp_text_sie: z.string(),
    email_cta: z.string(),
    email_cta_du: z.string(),
    entwurf_satz: z
      .string()
      .default(
        "Ich hab mir auch schon mal erlaubt zu skizzieren, wie Ihre Startseite aussehen könnte: {link}",
      ),
    entwurf_satz_du: z
      .string()
      .default("Ich hab auch schon mal skizziert, wie eure Startseite aussehen könnte: {link}"),
    bild_satz: z
      .string()
      .default("Ich hab mir auch schon mal erlaubt zu skizzieren, wie Ihre Startseite aussehen könnte:"),
    bild_satz_du: z
      .string()
      .default("Ich hab auch schon mal skizziert, wie eure Startseite aussehen könnte:"),
    email_cta_ohne_whatsapp: z.string(),
    email_cta_ohne_whatsapp_du: z.string(),
    vorbereitet: z.array(z.string()).min(1),
    vorbereitet_du: z.array(z.string()).min(1),
    unverbindlich: z
      .array(z.string())
      .default([
        "Das Ganze ist unverbindlich und kostet Sie nichts. Wenn es Sie nicht überzeugt, ist das völlig in Ordnung.",
      ]),
    unverbindlich_du: z
      .array(z.string())
      .default([
        "Das Ganze ist unverbindlich und kostet dich nichts. Wenn es dich nicht überzeugt, ist das völlig in Ordnung.",
      ]),
    vorbereitet_mit_entwurf: z
      .array(z.string())
      .min(1)
      .default(["Den Rest würde ich Ihnen gern kurz zeigen, 5 bis 10 Minuten reichen."]),
    vorbereitet_mit_entwurf_du: z
      .array(z.string())
      .min(1)
      .default(["Den Rest zeig ich dir gern kurz, 5 bis 10 Minuten reichen."]),
  }),
  brief: z
    .object({
      bildunterschrift: z.string(),
      bildunterschrift_du: z.string(),
      qr_text: z.string(),
      qr_text_du: z.string(),
      qr_text_telefon: z.string(),
      gruss: z.array(z.string()).min(1),
      unterschrift: z.string().min(1),
    })
    .default({
      bildunterschrift: "Ihre Startseite am Rechner, Stand {datum}",
      bildunterschrift_du: "Eure Startseite am Rechner, Stand {datum}",
      qr_text: "Kurz scannen, dann landen Sie direkt bei mir auf WhatsApp.",
      qr_text_du: "Kurz scannen, dann landest du direkt bei mir auf WhatsApp.",
      qr_text_telefon: "Oder einfach kurz anrufen.",
      gruss: ["Viele Grüße"],
      unterschrift: "Christian",
    }),
  nachfassen: z
    .object({
      saetze: z.array(z.string()).min(1),
      saetze_du: z.array(z.string()).min(1),
      entwurf: z.string(),
      entwurf_du: z.string(),
      ausstieg: z.string(),
      ausstieg_du: z.string(),
    })
    .default({
      saetze: ["ich wollte nur kurz nachhaken, ob meine Mail von letzter Woche bei Ihnen angekommen ist."],
      saetze_du: ["ich wollte nur kurz nachhaken, ob meine Mail von letzter Woche bei dir angekommen ist."],
      entwurf: "Den Entwurf für Ihre Startseite können Sie sich weiterhin hier ansehen: {link}",
      entwurf_du: "Den Entwurf für eure Startseite könnt ihr euch weiterhin hier ansehen: {link}",
      ausstieg: "Wenn es gerade nicht passt, ist das völlig in Ordnung, dann melde ich mich nicht mehr.",
      ausstieg_du: "Wenn es gerade nicht passt, ist das völlig in Ordnung, dann melde ich mich nicht mehr.",
    }),
  termine: z.object({
    zeitfenster: z.partialRecord(z.enum(WEEKDAYS), z.array(hm)),
    ausnahmen_mittagspause: z.partialRecord(z.enum(WEEKDAYS), z.array(hm)).default({}),
    branchen_bevorzugt: z.record(z.string(), z.array(hm)).default({}),
    tage_je_nachricht: z.number().int().min(1).max(3),
    uhrzeiten_je_tag: z.number().int().min(1).max(3),
    fruehestens_in_tagen: z.number().int().min(0),
    spaetestens_in_tagen: z.number().int().min(1),
    max_leads_je_termin: z.number().int().min(1),
    formulierungen: z.array(z.string()).min(1),
    formulierungen_du: z.array(z.string()).min(1),
  }),
});

export type OutreachConfig = z.infer<typeof outreachConfigSchema>;

export function loadOutreachConfig(): OutreachConfig {
  return loadYamlConfig("outreach.yaml", outreachConfigSchema);
}
