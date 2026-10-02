import sharp, { type Sharp } from "sharp";

/**
 * Screenshots für das Audit-Modell aufbereiten. Claude verkleinert Bilder über ~1,15 Megapixel bzw. 1.568 px
 * Kantenlänge ohnehin; wir schneiden vorher sinnvoll zu, damit Details lesbar bleiben und Tokens planbar sind
 * (≈ 1.500 Tokens je Bild).
 */

const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

export interface AuditImage {
  label: string;
  mediaType: "image/jpeg";
  /** base64 */
  data: string;
  width: number;
  height: number;
}

/** Skalierung, sodass Kantenlänge und Pixelzahl im Rahmen bleiben (nie vergrößern). */
export function fitScale(width: number, height: number): number {
  return Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

async function encode(img: Sharp, label: string): Promise<AuditImage> {
  const { data, info } = await img.jpeg({ quality: 80, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return {
    label,
    mediaType: "image/jpeg",
    data: data.toString("base64"),
    width: info.width,
    height: info.height,
  };
}

async function region(path: string, heightPx: number | null, label: string): Promise<AuditImage> {
  const meta = await sharp(path).metadata();
  const width = meta.width ?? 0;
  const full = meta.height ?? 0;
  if (!width || !full) throw new Error(`Screenshot ohne Größe: ${path}`);
  const h = heightPx === null ? full : Math.min(full, heightPx);
  const scale = fitScale(width, h);
  const img = sharp(path)
    .extract({ left: 0, top: 0, width, height: h })
    .resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(h * scale)) });
  return encode(img, label);
}

export interface ScreenshotSpec {
  desktopPath: string;
  mobilePath: string;
  /** Bildschirmhöhe desktop in Pixeln (CSS-Höhe × Skalierung). */
  desktopScreenPx: number;
  /** Bildschirmhöhe mobil in Pixeln (CSS-Höhe × Skalierung). */
  mobileScreenPx: number;
}

/** Drei Bilder: erster Bildschirm desktop (scharf), ganze Seite desktop (Überblick), mobil zwei Bildschirme. */
export async function prepareAuditImages(spec: ScreenshotSpec): Promise<AuditImage[]> {
  return Promise.all([
    region(spec.desktopPath, spec.desktopScreenPx, "Desktop, erster Bildschirm"),
    region(spec.desktopPath, null, "Desktop, Seite bis zu drei Bildschirmhöhen"),
    region(spec.mobilePath, spec.mobileScreenPx * 2, "Smartphone, erste zwei Bildschirme"),
  ]);
}
