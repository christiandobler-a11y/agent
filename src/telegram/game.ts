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

/** Weg durch alle Level: erreichte als Emoji, das aktuelle mit 👉, kommende als ◽. */
export function levelPath(s: GameState, c: GameConfig): string {
  const levels = [...c.level].sort((a, b) => a.ab - b.ab);
  return levels
    .map((l, i) => (i + 1 < s.level.number ? l.emoji : i + 1 === s.level.number ? `👉${l.emoji}` : "◽"))
    .join(" ");
}

/** Ein Satz, der zum Stand passt (wie ein gut gelaunter Trainer). */
function cheer(s: GameState): string {
  const st = s.stats;
  if (st.won >= 3) return "Kunden am laufenden Band, Chef. Das wird eine Agentur 😎";
  if (st.won > 0) return "Die erste Seite ist verkauft. Ab jetzt wird's nur noch besser 🥂";
  if (st.interested > 0) return "Da beißt einer an! Jetzt den Termin rocken 💪";
  if (st.mastered >= 5) return "Die Einwände sitzen. Zeit, dass ein echter Laden das merkt 🏪";
  if (st.trainings >= 10) return "Zehn Runden Sparring, du wirst richtig gut. Ab in den Laden 🚪";
  if (st.trainings > 0) return "Jede Runde macht den echten Besuch leichter. Weiter so 🔥";
  return "Noch alles auf Anfang. /training bringt dir gleich das erste Abzeichen 🎭";
}

/** Übersicht für /level. */
export function levelText(s: GameState, c: GameConfig): string {
  const st = s.stats;
  const l = s.level;
  const earned = Object.entries(c.abzeichen).filter(([k]) => s.badges.includes(k));
  const open = Object.entries(c.abzeichen).filter(([k]) => !s.badges.includes(k));
  const shownOpen = open.slice(0, 3);
  const levels = [...c.level].sort((a, b) => a.ab - b.ab);
  const from = levels[l.number - 1]?.ab ?? 0;
  const perTraining = st.trainings > 0 ? Math.max(5, Math.round(st.trainingXp / st.trainings)) : 12;
  const progress = l.next
    ? [
        `${progressBar(l.progress, 12)}  ${s.xp - from} / ${l.next.at - from} XP`,
        `Noch <b>${l.next.at - s.xp} XP</b> bis ${l.next.emoji} ${escapeHtml(l.next.name)}, also ca. ${Math.ceil((l.next.at - s.xp) / perTraining)} Trainingsrunden 🎭`,
      ]
    : [`${progressBar(1, 12)}  ${s.xp} XP`, "Höchstes Level erreicht. Mehr geht nicht, Chef 👑"];
  const mailEra = st.contacted > 0 || st.replied > 0;
  return [
    "🎮 <b>Dein Avelio-Level</b>",
    "",
    `${l.emoji} <b>Level ${l.number} · ${escapeHtml(l.name)}</b>`,
    ...progress,
    "",
    `🗺️ ${levelPath(s, c)}`,
    "",
    "📊 <b>Deine Bilanz</b>",
    `🎭 Trainings: <b>${st.trainings}</b> (+${st.trainingXp} XP) · ✅ Ja im Training: <b>${st.trainingYes}</b>`,
    `🧠 Einwände gemeistert: <b>${st.mastered}</b>${st.bestScore > 0 ? ` · bester Schnitt ${st.bestScore.toFixed(1).replace(".", ",")}` : ""}`,
    `🤝 Interessenten: <b>${st.interested}</b> · 🥇 Kunden: <b>${st.won}</b>`,
    ...(mailEra ? [`<i>Aus der Mail-Zeit: ${st.contacted} angeschrieben, ${st.replied} Antworten</i>`] : []),
    "",
    `🏅 <b>Abzeichen ${earned.length}/${earned.length + open.length}</b>`,
    earned.length > 0
      ? earned.map(([, b]) => `${b.emoji} ${escapeHtml(b.name)}`).join(" · ")
      : "Noch keins, das ändert sich gleich 😉",
    ...shownOpen.map(([, b]) => `🔒 ${escapeHtml(b.name)}: <i>${escapeHtml(b.text)}</i>`),
    ...(open.length > shownOpen.length
      ? [`<i>… und ${open.length - shownOpen.length} weitere Geheimnisse</i>`]
      : []),
    "",
    `💬 ${cheer(s)}`,
    "",
    `<i>XP: Training bis +25 (/training) · Interessent +${c.xp.interessiert} · Kunde +${c.xp.gewonnen}</i>`,
  ].join("\n");
}

/** Glückwunsch bei neuem Level oder Abzeichen; `null`, wenn es nichts zu feiern gibt. */
export function celebrationText(p: Progress, c: GameConfig): string | null {
  if (!p.levelUp && p.newBadges.length === 0) return null;
  const lines: string[] = [];
  const l = p.state.level;
  if (p.levelUp) {
    lines.push(`🎉🎉🎉 <b>Level ${l.number} erreicht: ${l.emoji} ${escapeHtml(l.name)}!</b>`);
    lines.push(`Stark, Chef! ${p.state.xp} XP auf dem Konto 💪`);
    if (l.next) lines.push(`Nächstes Ziel: ${l.next.emoji} ${escapeHtml(l.next.name)} bei ${l.next.at} XP.`);
  }
  for (const k of p.newBadges) {
    const b = c.abzeichen[k];
    if (b) {
      if (lines.length > 0) lines.push("");
      lines.push(`🏅 <b>Neues Abzeichen: ${b.emoji} ${escapeHtml(b.name)}</b>`);
      lines.push(`<i>${escapeHtml(b.text)}</i>`);
    }
  }
  lines.push("", "Alles unter /level 🎮");
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
