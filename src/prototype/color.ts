/**
 * Farben für Prototypen: aus einer Markenfarbe eine stimmige Palette ableiten (hell, dunkel, Text darauf), mit
 * genug Kontrast. Rein und unit-getestet.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Keine Farbe: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mischung a → b mit Anteil t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** Relative Leuchtdichte nach WCAG. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

export interface Palette {
  primary: string;
  /** Text auf `primary`. */
  onPrimary: string;
  /** Kräftige, dunkle Variante (Buttons-Hover, Footer). */
  deep: string;
  /** Sehr helle Tönung (Kachel-Hintergründe). */
  tint: string;
  /** Helle Tönung (Flächen, Bergkamm hinten). */
  soft: string;
  ink: string;
  paper: string;
}

/**
 * Palette aus der Markenfarbe. Zu helle Farben (Gelb, Pastell) werden für Buttons abgedunkelt, damit weißer Text
 * lesbar bleibt (Kontrast ≥ 4,5); Graustufen bekommen ein ruhiges Petrol, damit die Seite nicht farblos wirkt.
 */
export function paletteFrom(brand: string): Palette {
  let primary = brand.toLowerCase();
  const { r, g, b } = parseHex(primary);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 24) primary = "#1f6f78";
  for (let i = 0; i < 12 && contrast(primary, "#ffffff") < 4.5; i++) primary = mix(primary, "#000000", 0.12);
  const ink = mix(primary, "#0b0f14", 0.88);
  return {
    primary,
    onPrimary: "#ffffff",
    deep: mix(primary, "#000000", 0.45),
    tint: mix(primary, "#ffffff", 0.92),
    soft: mix(primary, "#ffffff", 0.75),
    ink,
    paper: "#fbfaf7",
  };
}
