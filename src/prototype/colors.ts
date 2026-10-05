/**
 * Farbwelt aus dem Hero-Foto der Praxis (05.10.2026, Christian: "anhand des Hero-Bildes die restlichen Farben
 * bestimmen", später auswerten, welche Farben gut ankommen). Rein und unit-getestet: Pixel rein, Farben raus.
 *
 * Regeln, damit es immer stimmig und lesbar bleibt:
 * - Hauptfarbe = die prägende, ausreichend farbige Fläche des Fotos (Gewicht × Sättigung), so weit abgedunkelt, dass
 *   weiße Schrift darauf gut lesbar ist (Kontrast ≥ 4,5 nach WCAG).
 * - Akzent = eine zweite Farbe des Fotos mit klar anderem Farbton; fehlt die, derselbe Farbton heller und kräftiger
 *   (wie Petrol + Türkis). Schrift auf dem Akzent: weiß oder dunkel, je nachdem was besser lesbar ist.
 * - Schrift, Hintergrund und Flächen: derselbe Farbton, sehr dunkel bzw. sehr hell und zurückhaltend.
 * - Haut, Holzboden, Beige (Orange-Braun, nicht kräftig) taugen nicht als Markenfarbe und zählen nicht.
 * - Ist das Foto fast farblos (grau, schwarz-weiß) oder nur haut- und holzfarben, gibt es keine eigene Farbwelt: `null`,
 *   dann gilt die Standardfarbe (sie passt zu einem ruhigen Foto immer).
 */

export type Rgb = readonly [number, number, number];

export interface HeroPalette {
  primary: string;
  accent: string;
  ink: string;
  veil: string;
  label: string;
  bg: string;
  soft: string;
  onAccent: string;
}

export function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function rgbOf(h: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`Keine Farbe: ${h}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** HSL mit h in Grad (0–360), s und l von 0 bis 1. */
export function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rr
      ? ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60
      : max === gg
        ? ((bb - rr) / d + 2) * 60
        : ((rr - gg) / d + 4) * 60;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(hh + 1 / 3) * 255, ch(hh) * 255, ch(hh - 1 / 3) * 255];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Kontrast nach WCAG (1 bis 21). */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

export interface Cluster {
  color: Rgb;
  /** Anteil der Pixel (0 bis 1). */
  weight: number;
}

/** Farbgruppen eines Bildes (k-means, feste Startwerte, damit gleiche Pixel immer gleiche Farben ergeben). */
export function clusters(pixels: ArrayLike<number>, k = 6, rounds = 10): Cluster[] {
  const n = Math.floor(pixels.length / 3);
  if (n === 0) return [];
  const px: Rgb[] = [];
  for (let i = 0; i < n; i++) px.push([pixels[i * 3]!, pixels[i * 3 + 1]!, pixels[i * 3 + 2]!]);
  // Startwerte: gleichmäßig über die nach Helligkeit sortierten Pixel.
  const sorted = [...px].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let centers: Rgb[] = Array.from(
    { length: Math.min(k, n) },
    (_, i) => sorted[Math.floor(((i + 0.5) * n) / k)]!,
  );
  let assign = new Array<number>(n).fill(0);
  for (let r = 0; r < rounds; r++) {
    assign = px.map((p) => {
      let best = 0;
      let bestD = Infinity;
      centers.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) [best, bestD] = [j, d];
      });
      return best;
    });
    centers = centers.map((c, j) => {
      const members = px.filter((_, i) => assign[i] === j);
      if (members.length === 0) return c;
      const sum = members.reduce<[number, number, number]>(
        (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]],
        [0, 0, 0],
      );
      return [sum[0] / members.length, sum[1] / members.length, sum[2] / members.length];
    });
  }
  return centers
    .map((color, j) => ({ color, weight: assign.filter((a) => a === j).length / n }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/** Helligkeit so weit senken, bis weiße Schrift gut lesbar ist. */
function darkenForWhite(h: number, s: number, l: number, min = 4.6): Rgb {
  let ll = Math.min(l, 0.5);
  while (ll > 0.12 && contrast(fromHsl(h, s, ll), WHITE) < min) ll -= 0.01;
  return fromHsl(h, s, ll);
}

/** Haut, Holz, Beige: Orange-Braun-Töne ohne große Leuchtkraft. */
export const isSkinOrWood = ([h, s]: readonly [number, number, number]) => h >= 12 && h <= 50 && s < 0.65;

/** Gelb bis Gelbgrün (Farbton etwa 45 bis 80 Grad). */
export const isYellowish = ([h]: readonly [number, number, number]) => h >= 45 && h <= 80;

export function paletteFromClusters(cs: readonly Cluster[]): HeroPalette | null {
  const colorful = cs
    .map((c) => ({ ...c, hsl: toHsl(c.color) }))
    .filter((c) => c.hsl[1] >= 0.18 && c.hsl[2] >= 0.1 && c.hsl[2] <= 0.85 && c.weight >= 0.03)
    .filter((c) => !isSkinOrWood(c.hsl));
  if (colorful.length === 0) return null;
  const rank = (a: (typeof colorful)[number], b: (typeof colorful)[number]) =>
    b.weight * b.hsl[1] - a.weight * a.hsl[1];
  // Gelb bis Gelbgrün wird abgedunkelt oliv und trüb: taugt nur als Akzent. Dann Anthrazit als Hauptfarbe (wie das
  // Elementa-Vorbild: Dunkelblau-Grau + Gelb).
  const main = colorful.filter((c) => !isYellowish(c.hsl)).sort(rank)[0] ?? null;
  const [h, s0] = main ? main.hsl : [215, 0.18];
  const s = main ? Math.max(0.35, Math.min(0.7, s0)) : 0.18;
  const primary = main ? darkenForWhite(h, s, main.hsl[2]) : fromHsl(215, 0.18, 0.2);

  const other = colorful
    .filter((c) => c !== main && (!main || hueDistance(c.hsl[0], h) >= 30) && c.hsl[1] >= 0.25)
    .sort(rank)[0];
  const accent = other
    ? fromHsl(
        other.hsl[0],
        Math.max(0.5, Math.min(0.8, other.hsl[1])),
        Math.max(0.45, Math.min(0.6, other.hsl[2])),
      )
    : fromHsl(h - 18, Math.min(0.75, s + 0.2), 0.55);
  const ink = fromHsl(h, 0.25, 0.17);
  const onAccent = contrast(accent, WHITE) >= 3 ? WHITE : ink;
  const [pr, pg, pb] = primary.map(Math.round) as [number, number, number];
  return {
    primary: hex(primary),
    accent: hex(accent),
    ink: hex(ink),
    veil: `rgba(${pr},${pg},${pb},.70)`,
    label: `aus dem Foto: ${hex(primary)} + ${hex(accent)}`,
    bg: hex(fromHsl(h, 0.3, 0.965)),
    soft: hex(fromHsl(h, 0.4, 0.92)),
    onAccent: hex(onAccent),
  };
}

/** Farbwelt aus rohen RGB-Pixeln (z. B. ein auf 48 × 48 verkleinertes Foto). */
export function derivePalette(pixels: ArrayLike<number>): HeroPalette | null {
  return paletteFromClusters(clusters(pixels));
}
