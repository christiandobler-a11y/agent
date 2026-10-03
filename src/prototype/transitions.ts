/**
 * Übergänge zwischen Sections als SVG (Christians Wunsch: hochwertig statt Clipart). Glatte Kurven (Catmull-Rom →
 * Bézier) statt gerader Zacken; deterministisch, damit Screenshots reproduzierbar sind.
 */

export type TransitionStyle = "waves" | "curve";

type Pt = [number, number];

/** Glatter Pfad durch die Punkte (Catmull-Rom als kubische Bézier), unten geschlossen bis `bottom`. */
export function smoothPath(points: readonly Pt[], bottom: number): string {
  const p = points;
  let d = `M${p[0]![0]} ${p[0]![1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p2;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1].toFixed(1)}`;
  }
  return `${d} L${p.at(-1)![0]} ${bottom} L${p[0]![0]} ${bottom} Z`;
}

/** Sanfte Welle über 1440 px: Grundhöhe, Amplitude, Wellenzahl, Phase. */
function wave(base: number, amp: number, cycles: number, phase: number, steps = 8): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (1440 * i) / steps;
    const t = (i / steps) * Math.PI * 2 * cycles + phase;
    // Zwei überlagerte Sinus-Anteile: wirkt organisch, nicht mechanisch.
    pts.push([Math.round(x), base + amp * Math.sin(t) + amp * 0.35 * Math.sin(t * 2.3 + 1)]);
  }
  return pts;
}

/**
 * Drei fließende Bänder (hinten zart, Mitte Markenfarbe, vorne Hintergrund der nächsten Section): Bewegung statt
 * Gebirge, passt zu Physio, Gesundheit, Beauty.
 */
export function wavesSvg(back: string, middle: string, front: string, cls = "ridge"): string {
  return `<svg class="${cls}" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true">
<path fill="${back}" fill-opacity=".55" d="${smoothPath(wave(52, 16, 1.1, 0.6), 120)}"/>
<path fill="${middle}" fill-opacity=".9" d="${smoothPath(wave(72, 12, 0.9, 2.2), 120)}"/>
<path fill="${front}" d="${smoothPath(wave(90, 10, 1.25, 4.1), 120)}"/>
</svg>`;
}

/** Eine einzige, weite Kurve mit feiner Akzentlinie: ruhig und edel. */
export function curveSvg(accent: string, front: string, cls = "ridge"): string {
  const edge: Pt[] = [
    [0, 92],
    [360, 70],
    [760, 40],
    [1120, 52],
    [1440, 30],
  ];
  // Offene Kante (ohne Boden) als Linie, exakt parallel versetzt.
  const line = smoothPath(edge, 120).replace(/ L[\d.]+ 120 L[\d.]+ 120 Z$/, "");
  return `<svg class="${cls}" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true">
<path d="${line}" transform="translate(0 -10)" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity=".9"/>
<path fill="${front}" d="${smoothPath(edge, 120)}"/>
</svg>`;
}

/** Übergang für Section-Kanten (oben bzw. unten, gespiegelt) im gewählten Stil. */
export function edgeSvg(style: TransitionStyle, fill: string, flip = false): string {
  const cls = `edge${flip ? " flip" : ""}`;
  const pts = style === "waves" ? wave(26, 9, 1.4, 1.3) : wave(28, 12, 0.6, 3.6, 6);
  return `<svg class="${cls}" viewBox="0 0 1440 48" preserveAspectRatio="none" aria-hidden="true"><path fill="${fill}" d="${smoothPath(pts, 48)}"/></svg>`;
}
