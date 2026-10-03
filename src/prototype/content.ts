import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";

/**
 * Inhalt eines Prototyps (Phase 3): Was die Vorlage braucht. Texte, Leistungen und Markenfarbe liefert das LLM
 * (Rolle `prototype`, festes Schema unten), Fakten (Adresse, Telefon, Bewertungen, Fotos, Logo) setzt der Code.
 */

/** Icons, aus denen das LLM je Leistung wählen darf (lucide-static, ISC-Lizenz). */
export const ICONS = [
  "activity",
  "bone",
  "hand",
  "dumbbell",
  "heart-pulse",
  "house",
  "waves",
  "flame",
  "footprints",
  "baby",
  "brain",
  "stethoscope",
  "person-standing",
  "accessibility",
  "leaf",
  "sparkles",
  "shield-check",
  "users",
  "zap",
  "calendar-check",
  // Handwerk, Fahrrad, Kfz, Gastro (Vorlage "werkstatt" und künftige)
  "wrench",
  "hammer",
  "paint-roller",
  "paintbrush",
  "bike",
  "droplets",
  "ruler",
  "drill",
  "hard-hat",
  "truck",
  "bath",
  "plug-zap",
  "thermometer",
  "sofa",
  "trees",
  "car",
  "scissors",
  "utensils",
  "badge-check",
] as const;
export type IconName = (typeof ICONS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Ausgabe des LLM: nur Texte und Gestaltungs-Entscheidungen, keine Fakten. */
/** Längen großzügig: Modelle halten sie nicht exakt ein, die Vorlage kürzt selbst (toSiteContent). */
export const prototypeOutputSchema = z.object({
  anzeigename: z.string().min(2).max(120),
  claim: z.string().min(3).max(80),
  handschrift: z.string().max(60).nullable(),
  hero: z.object({ ueberschrift: z.string().min(5).max(140), text: z.string().min(20).max(440) }),
  markenfarbe: hex,
  vertrauen: z.array(z.string().min(3).max(64)).min(1).max(8),
  leistungen: z
    .array(
      z.object({ titel: z.string().min(3).max(80), text: z.string().min(10).max(280), icon: z.enum(ICONS) }),
    )
    .min(2)
    .max(12),
  ueber_uns: z.object({ titel: z.string().min(3).max(120), text: z.string().min(40).max(1200) }),
  ablauf: z
    .array(z.object({ titel: z.string().min(3).max(80), text: z.string().min(10).max(320) }))
    .min(3)
    .max(4),
  cta: z.string().min(3).max(56),
  /** Index in der Fotoliste für Hero bzw. Über uns (oder null). */
  hero_foto: z.number().int().nullable(),
  ueber_uns_foto: z.number().int().nullable(),
  /** Weitere gute Fotos in Reihenfolge (Nummern), Unpassendes weggelassen. */
  galerie_fotos: z.array(z.number().int()).max(12),
  /** Untaugliche Fotos (Banner, Grafiken): nie verwenden, auch nicht als Ersatz. */
  abgelehnte_fotos: z.array(z.number().int()).max(12),
});
export type PrototypeOutput = z.infer<typeof prototypeOutputSchema>;

export interface SiteContent {
  form: "sie" | "du";
  name: string;
  claim: string;
  handwriting: string | null;
  primary: string;
  logo: string | null;
  /** Helles (z. B. weißes) Logo: Kopfbereich dunkel, sonst ist es unsichtbar. */
  logoOnDark?: boolean;
  hero: { headline: string; text: string; image: string | null };
  trust: string[];
  services: { title: string; text: string; icon: IconName }[];
  about: { title: string; text: string; image: string | null };
  steps: { title: string; text: string }[];
  reviews: { rating: number | null; count: number | null; quotes: { text: string; author: string }[] };
  gallery: string[];
  contact: {
    address: string | null;
    phone: string | null;
    email: string | null;
    hours: string[];
    mapsUrl: string | null;
  };
  cta: string;
  /** Übergänge zwischen Sections (src/prototype/transitions.ts); Standard "curve" (Christians Wahl, 03.10.2026). */
  transition?: "waves" | "curve";
  /** Hinweis oben auf der Seite, dass es ein Entwurf ist (nie weglassen). */
  previewNote: string;
}

const require = createRequire(import.meta.url);
const iconCache = new Map<string, string>();

/** Icon als SVG-String (Strichstärke über CSS). */
export function icon(
  name: IconName | "phone" | "map-pin" | "clock" | "star" | "arrow-right" | "mail" | "check",
): string {
  let svg = iconCache.get(name);
  if (!svg) {
    svg = readFileSync(require.resolve(`lucide-static/icons/${name}.svg`), "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s(width|height)="24"/g, "")
      .replace(/class="[^"]*"/, 'aria-hidden="true"')
      .trim();
    iconCache.set(name, svg);
  }
  return svg;
}
