import { WEEKDAYS, type OutreachConfig, type Weekday } from "./config.js";

/**
 * Terminvorschläge mit Knappheit (rein): 2 konkrete Tage mit je 2 Uhrzeiten aus festen Zeitfenstern um Christians
 * Hauptjob herum. Bereits oft angebotene Termine werden ausgelassen, die Auswahl wechselt je Lead (Seed).
 */

export interface SlotDay {
  /** JJJJ-MM-TT (deutsche Zeit). */
  date: string;
  weekday: Weekday;
  times: string[];
}

export interface SlotProposal {
  days: SlotDay[];
  /** Zeitpunkte (UTC, ISO) aller vorgeschlagenen Termine, zum Merken. */
  slots: string[];
  sentence: string;
}

const DAY = 86_400_000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function berlinDate(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

/** Wanduhrzeit Berlin → UTC-Zeitpunkt (Sommer-/Winterzeit). */
export function berlinInstant(date: string, time: string): Date {
  const asUtc = new Date(`${date}T${time}:00Z`);
  const offset = (d: Date) =>
    new Date(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" })).getTime() -
    new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const first = new Date(asUtc.getTime() - offset(asUtc));
  return new Date(asUtc.getTime() - offset(first));
}

/** "08:00" → "8", "19:30" → "19:30" (so schreibt man das). */
export function spokenTime(t: string): string {
  const [h, m] = t.split(":") as [string, string];
  return m === "00" ? String(Number(h)) : `${Number(h)}:${m}`;
}

/** "Dienstag", ab nächster Woche mit Datum ("Dienstag, den 14.10."). */
function dayLabel(day: SlotDay, today: string): string {
  const diff = (Date.parse(day.date) - Date.parse(today)) / DAY;
  const name = cap(day.weekday);
  if (diff <= 6) return name;
  const [, mo, d] = day.date.split("-");
  return `${name}, den ${Number(d)}.${Number(mo)}.`;
}

/** Einfacher, stabiler Zahlenwert aus einem Text (für die Abwechslung je Lead). */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function proposeSlots(input: {
  now: Date;
  config: OutreachConfig["termine"];
  branchKey: string | null;
  du: boolean;
  /** Bereits angebotene Termine (ISO) → Anzahl Leads, denen sie gerade angeboten sind. */
  taken: ReadonlyMap<string, number>;
  seed: number;
  /** Laufende Nummer des Entwurfs (0, 1, 2 …): "Neu schreiben" bekommt andere Tage und Formulierung. */
  variant?: number;
}): SlotProposal | null {
  const variant = input.variant ?? 0;
  const c = input.config;
  const today = berlinDate(input.now);
  const preferred = input.branchKey ? c.branchen_bevorzugt[input.branchKey] : undefined;
  const free = (date: string, t: string) =>
    (input.taken.get(berlinInstant(date, t).toISOString()) ?? 0) < c.max_leads_je_termin;

  const candidates: SlotDay[] = [];
  for (let i = c.fruehestens_in_tagen; i <= c.spaetestens_in_tagen; i++) {
    const date = berlinDate(new Date(input.now.getTime() + i * DAY));
    const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
    let times = (c.zeitfenster[weekday] ?? []).filter((t) => free(date, t));
    // Branchen mit Vorzugszeiten (z. B. Gastro: nicht ins Abendgeschäft) bekommen nur diese.
    if (preferred) times = times.filter((t) => preferred.includes(t));
    // Mittagspause nur, wenn sonst zu wenig da ist (höchstens eine je Nachricht, siehe unten).
    const lunch = (c.ausnahmen_mittagspause[weekday] ?? []).filter((t) => free(date, t));
    if (!preferred && times.length < c.uhrzeiten_je_tag && lunch.length > 0) times = [...times, lunch[0]!];
    if (times.length >= c.uhrzeiten_je_tag) candidates.push({ date, weekday, times });
  }
  if (candidates.length < c.tage_je_nachricht) return null;

  // Tage mit Abstand wählen (nicht direkt hintereinander), Startpunkt je Lead verschieden.
  const days: SlotDay[] = [];
  const start = (input.seed + variant) % candidates.length;
  for (let k = 0; k < candidates.length && days.length < c.tage_je_nachricht; k++) {
    const day = candidates[(start + k) % candidates.length]!;
    const tooClose = days.some(
      (d) => d.weekday === day.weekday || Math.abs(Date.parse(d.date) - Date.parse(day.date)) < 2 * DAY,
    );
    if (!tooClose) days.push(day);
  }
  // Notfalls (wenig frei) auch nah beieinander, aber nie zweimal derselbe Wochentag.
  for (const day of candidates) {
    if (days.length >= c.tage_je_nachricht) break;
    if (!days.some((d) => d.weekday === day.weekday)) days.push(day);
  }
  if (days.length < c.tage_je_nachricht) return null;
  days.sort((a, b) => a.date.localeCompare(b.date));

  let lunchUsed = false;
  const chosen = days.map((day, i) => {
    const lunchTimes = new Set(c.ausnahmen_mittagspause[day.weekday] ?? []);
    const pool = day.times.filter((t) => !(lunchUsed && lunchTimes.has(t)));
    // Je Tag eine andere Uhrzeit, damit nicht zweimal "um 13 Uhr" dasteht.
    const offset = ((input.seed >>> 3) + i) % pool.length;
    const picked = [...pool.slice(offset), ...pool.slice(0, offset)].slice(0, c.uhrzeiten_je_tag).sort();
    if (picked.some((t) => lunchTimes.has(t))) lunchUsed = true;
    return { ...day, times: picked };
  });

  const templates = input.du ? c.formulierungen_du : c.formulierungen;
  const template = templates[((input.seed >>> 5) + variant) % templates.length]!;
  const values: Record<string, string> = {};
  chosen.forEach((d, i) => {
    values[`tag${i + 1}`] = dayLabel(d, today);
    values[`zeit${i + 1}a`] = spokenTime(d.times[0]!);
    values[`zeit${i + 1}b`] = spokenTime(d.times[1] ?? d.times[0]!);
  });
  const sentence = template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? "");
  return {
    days: chosen,
    slots: chosen.flatMap((d) => d.times.map((t) => berlinInstant(d.date, t).toISOString())),
    sentence,
  };
}
