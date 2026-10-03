/**
 * Befund-Seite (Brief, Phase 2): ein Blatt A4 als HTML, das Chromium zu PDF druckt. Rein und ohne I/O, damit Layout
 * und Markierungen unit-getestet werden können. Handschrift in dunkelblauer Tinte, Markierungen rot wie mit Stift.
 */

export interface Box {
  /** Prozent der Bildbreite bzw. -höhe (0–100), linke obere Ecke und Größe. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LetterMark {
  n: number;
  box: Box | null;
  note: string;
}

export interface LetterPage {
  dateLine: string;
  greeting: string;
  image: { dataUri: string; width: number; height: number };
  caption: string;
  marks: LetterMark[];
  lines: string;
  closing: string;
  signature: string;
  qr: { svg: string; text: string } | null;
  phoneLine: string | null;
  footer: string;
  /** Handschrift (woff2 als data-URI); ohne Angabe eine Systemschrift. */
  fontDataUri: string | null;
  seed: number;
}

const INK = "#1d3557";
const RED = "#d62828";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Kleiner, deterministischer Zufall (mulberry32), damit jede Markierung etwas anders, aber reproduzierbar ist. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Box aus dem LLM säubern: in den Bildbereich ziehen, Mindestgröße, und zu große Bereiche verwerfen (ein Kreis um
 * fast alles zeigt nichts).
 */
export function normalizeBox(box: Box | null | undefined): Box | null {
  if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return null;
  const x = clamp(box.x, 0, 97);
  const y = clamp(box.y, 0, 97);
  const w = clamp(box.w, 3, 100 - x);
  const h = clamp(box.h, 3, 100 - y);
  // Große Bereiche (halber Bildschirm, ganze Menüleiste) zeigen nichts Bestimmtes; dann nur als Notiz.
  if (w > 60 || h > 50) return null;
  return { x, y, w, h };
}

/**
 * Handgezeichnete Ellipse als SVG-Pfad (Bildpixel): leicht unrund, etwas gedreht und mit Überschwung am Ende, wie
 * schnell mit dem Stift eingekreist.
 */
export function handEllipse(cx: number, cy: number, rx: number, ry: number, seed: number): string {
  const r = rng(seed);
  const start = r() * Math.PI * 2;
  const sweep = Math.PI * 2 + 0.35 + r() * 0.3;
  const tilt = (r() - 0.5) * 0.12;
  const p1 = r() * 6;
  const p2 = r() * 6;
  const steps = 72;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    // Radius wackelt leicht; am Ende etwas weiter außen, damit sich Anfang und Ende nicht decken.
    const wobble = 1 + 0.035 * Math.sin(3 * t + p1) + 0.015 * Math.sin(7 * t + p2) + (0.06 * i) / steps;
    const ex = rx * wobble * Math.cos(t);
    const ey = ry * wobble * Math.sin(t);
    const x = cx + ex * Math.cos(tilt) - ey * Math.sin(tilt);
    const y = cy + ex * Math.sin(tilt) + ey * Math.cos(tilt);
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

/** SVG-Überlagerung mit Kreisen und Nummern in Bildpixeln (gleiches Seitenverhältnis wie das Bild). */
export function marksSvg(marks: readonly LetterMark[], width: number, height: number, seed: number): string {
  const stroke = Math.max(3, width / 260);
  const font = Math.max(28, width / 26);
  const parts: string[] = [];
  for (const m of marks) {
    if (!m.box) continue;
    const bx = (m.box.x / 100) * width;
    const by = (m.box.y / 100) * height;
    const bw = (m.box.w / 100) * width;
    const bh = (m.box.h / 100) * height;
    // Ellipse umschließt das Rechteck (Faktor √2) plus etwas Luft.
    const rx = (bw / 2) * 1.25 + stroke * 2;
    const ry = (bh / 2) * 1.35 + stroke * 2;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    parts.push(
      `<path d="${handEllipse(cx, cy, rx, ry, seed + m.n * 7919)}" fill="none" stroke="${RED}" stroke-width="${stroke.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`,
    );
    // Nummer rechts oben neben der Ellipse, im Bild gehalten.
    const nx = clamp(cx + rx * 0.8 + font * 0.2, font * 0.4, width - font * 0.6);
    const ny = clamp(cy - ry * 0.75, font * 0.9, height - font * 0.2);
    parts.push(
      `<text x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" font-family="Hand, cursive" font-weight="700" font-size="${font.toFixed(0)}" fill="${RED}" stroke="#fff" stroke-width="${(stroke * 1.6).toFixed(1)}" paint-order="stroke">${m.n}</text>`,
    );
  }
  return `<svg class="marks" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

export function renderLetterHtml(page: LetterPage): string {
  const font = page.fontDataUri
    ? `@font-face { font-family: Hand; src: url(${page.fontDataUri}) format("woff2"); font-weight: 400 700; }`
    : "";
  const notes = page.marks
    .map((m) => `<li><span class="n">${m.n}</span><span>${escapeHtml(m.note)}</span></li>`)
    .join("");
  const qr = page.qr
    ? `<div class="qr">${page.qr.svg}<div class="qrtext">${escapeHtml(page.qr.text)}${page.phoneLine ? `<br><span class="phone">${escapeHtml(page.phoneLine).replace(/\n/g, "<br>")}</span>` : ""}</div></div>`
    : page.phoneLine
      ? `<div class="qr"><div class="qrtext"><span class="phone">${escapeHtml(page.phoneLine).replace(/\n/g, "<br>")}</span></div></div>`
      : "<div></div>";
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Befund-Seite</title>
<style>
${font}
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: 210mm; height: 297mm; padding: 14mm 18mm 10mm; font-family: "Helvetica Neue", Arial, sans-serif;
  color: #222; display: flex; flex-direction: column; overflow: hidden; }
.hand { font-family: Hand, "Comic Sans MS", cursive; color: ${INK}; }
.date { text-align: right; font-size: 9pt; color: #777; }
.greeting { font-size: 25pt; margin: 4mm 0 4mm; line-height: 1; }
.shot { position: relative; width: 100%; border: 0.3mm solid #ccc; box-shadow: 0 1mm 3mm rgba(0,0,0,.18); }
.shot img { display: block; width: 100%; height: auto; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; }
.caption { font-size: 7.5pt; color: #888; margin: 1.6mm 0 0; }
ol.notes { list-style: none; margin: 4mm 0 0; padding: 0; font-size: 18pt; line-height: 1.15; }
ol.notes li { display: flex; gap: 3mm; margin: 0 0 1.2mm; }
ol.notes .n { color: ${RED}; font-weight: 700; min-width: 5mm; }
.lines { font-size: 18pt; line-height: 1.2; margin: 4mm 0 0; }
.lines p { margin: 0 0 1.5mm; }
.bottom { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; }
.qr { display: flex; align-items: center; gap: 4mm; }
.qr svg { width: 27mm; height: 27mm; }
.qrtext { font-size: 15pt; line-height: 1.15; max-width: 62mm; }
.phone { font-size: 14pt; white-space: nowrap; }
.sign { text-align: right; }
.closing { font-size: 18pt; }
.signature { font-size: 34pt; line-height: 1; transform: rotate(-3deg); margin-top: 1mm; }
.footer { margin-top: 5mm; font-size: 7.5pt; color: #888; text-align: center; }
</style></head>
<body>
<div class="date">${escapeHtml(page.dateLine)}</div>
<div class="greeting hand">${escapeHtml(page.greeting)}</div>
<div class="shot"><img src="${page.image.dataUri}" alt="Startseite">${marksSvg(page.marks, page.image.width, page.image.height, page.seed)}</div>
<div class="caption">${escapeHtml(page.caption)}</div>
${notes ? `<ol class="notes hand">${notes}</ol>` : ""}
<div class="lines hand">${paragraphs(page.lines)}</div>
<div class="bottom hand">${qr}<div class="sign"><div class="closing">${escapeHtml(page.closing)}</div><div class="signature">${escapeHtml(page.signature)}</div></div></div>
<div class="footer">${escapeHtml(page.footer)}</div>
</body></html>`;
}
