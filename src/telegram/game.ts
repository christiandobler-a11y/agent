import type { Api } from "grammy";
import type { DbClient } from "../db/client.js";
import { checkProgress, loadGameConfig, type GameConfig, type GameState, type Progress } from "../game/xp.js";
import { escapeHtml } from "./format.js";

/** Telegram-Texte zum Spiel (XP, Level, Abzeichen). */

export function progressBar(progress: number, width = 10): string {
  const full = Math.max(0, Math.min(width, Math.floor(progress * width)));
  return "▰".repeat(full) + "▱".repeat(width - full);
}

/** Eine Zeile für Kopf und Bilanz. */
export function levelLine(s: GameState): string {
  const l = s.level;
  const next = l.next
    ? ` · noch ${l.next.at - s.xp} XP bis ${l.next.emoji} ${escapeHtml(l.next.name)}`
    : " · höchstes Level";
  return `🎮 Level ${l.number} ${l.emoji} <b>${escapeHtml(l.name)}</b> · ${s.xp} XP ${progressBar(l.progress)}${next}`;
}

/** Übersicht für /level. */
export function levelText(s: GameState, c: GameConfig): string {
  const st = s.stats;
  const earned = Object.entries(c.abzeichen).filter(([k]) => s.badges.includes(k));
  const open = Object.entries(c.abzeichen).filter(([k]) => !s.badges.includes(k));
  return [
    levelLine(s),
    "",
    `📤 Leads angeschrieben: <b>${st.contacted}</b>`,
    `💬 Antworten: <b>${st.replied}</b> · 🤝 Interessenten: <b>${st.interested}</b> · 🥇 Kunden: <b>${st.won}</b>`,
    `✅ Perfekte Tage: <b>${st.perfectDays}</b> · ⚡ Serie: <b>${st.streak}</b> (Rekord ${st.bestStreak})`,
    "",
    `<b>Abzeichen (${earned.length}/${earned.length + open.length})</b>`,
    ...earned.map(([, b]) => `${b.emoji} ${escapeHtml(b.name)}`),
    ...open.map(([, b]) => `🔒 ${escapeHtml(b.name)}: ${escapeHtml(b.text)}`),
    "",
    `XP: Lead angeschrieben +${c.xp.kontaktiert} · Antwort +${c.xp.antwort} · Interessent +${c.xp.interessiert} · Kunde +${c.xp.gewonnen} · perfekter Tag +${c.xp.perfekter_tag}`,
  ].join("\n");
}

/** Glückwunsch bei neuem Level oder Abzeichen; `null`, wenn es nichts zu feiern gibt. */
export function celebrationText(p: Progress, c: GameConfig): string | null {
  if (!p.levelUp && p.newBadges.length === 0) return null;
  const lines: string[] = [];
  const l = p.state.level;
  if (p.levelUp) {
    lines.push(`🎉 <b>Level ${l.number} erreicht: ${l.emoji} ${escapeHtml(l.name)}!</b>`);
    lines.push(`${p.state.stats.contacted} Leads angeschrieben, ${p.state.xp} XP.`);
    if (l.next) lines.push(`Nächstes Ziel: ${l.next.emoji} ${escapeHtml(l.next.name)} bei ${l.next.at} XP.`);
  }
  for (const k of p.newBadges) {
    const b = c.abzeichen[k];
    if (b) lines.push(`🏅 Neues Abzeichen: ${b.emoji} <b>${escapeHtml(b.name)}</b> · ${escapeHtml(b.text)}`);
  }
  return lines.join("\n");
}

/** Fortschritt prüfen und neue Level oder Abzeichen melden. Fehler stören nie den eigentlichen Ablauf. */
export async function reportProgress(
  api: Api,
  chatIds: readonly number[],
  db: DbClient,
  now: Date,
): Promise<Progress | null> {
  try {
    const c = loadGameConfig();
    const p = await checkProgress(db, now, c);
    const text = celebrationText(p, c);
    if (text) for (const id of chatIds) await api.sendMessage(id, text, { parse_mode: "HTML" });
    return p;
  } catch {
    return null;
  }
}

/** " · +5 XP" für Bestätigungen. */
export const xpSuffix = (p: Progress | null) => (p && p.gained > 0 ? ` · +${p.gained} XP` : "");
