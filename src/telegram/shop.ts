import { InputFile, type Api, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { findCompany } from "../db/companies.js";
import { loadBranches } from "../pipeline/research/branches.js";
import type { PipelineContext } from "../queue/pipeline.js";
import { briefingMarkdown, buildBriefing, type Briefing, type Direction } from "../shop/briefing.js";
import { proposeShop, type ShopProposal } from "../shop/job.js";
import { getPick, setPick, type ShopCandidate } from "../shop/pick.js";
import { escapeHtml, websiteButton } from "./format.js";

/** Laden der Woche in Telegram: Vorschlag mit Nehmen/Anderer, danach Briefing und drei Richtungen zum Wählen. */

export type ShopCallback = { kind: "take" | "next"; id: string } | { kind: "dir"; id: string; index: number };

export function shopCallback(c: ShopCallback): string {
  return c.kind === "dir" ? `sw:r:${c.id}:${c.index}` : `sw:${c.kind === "take" ? "t" : "n"}:${c.id}`;
}

export function parseShopCallback(data: string): ShopCallback | null {
  const m = /^sw:(t|n|r):([0-9a-f-]{36})(?::(\d))?$/.exec(data);
  if (!m) return null;
  if (m[1] === "r") return m[3] === undefined ? null : { kind: "dir", id: m[2]!, index: Number(m[3]) };
  return { kind: m[1] === "t" ? "take" : "next", id: m[2]! };
}

const km = (d: number | null) => (d === null ? null : `${d.toFixed(1).replace(".", ",")} km`);

export function shopCard(
  c: ShopCandidate,
  pickId: string,
  branchLabel: string | null,
): { text: string; keyboard: InlineKeyboardButton[][] } {
  const rating =
    c.rating !== null ? `⭐ ${Number(c.rating).toFixed(1).replace(".", ",")} (${c.review_count ?? 0})` : null;
  const text = [
    "🏪 <b>Laden der Woche</b>",
    "",
    `<b>${escapeHtml(c.name)}</b>${branchLabel ? ` · ${escapeHtml(branchLabel)}` : ""}`,
    [c.street, c.city]
      .filter(Boolean)
      .map((s) => escapeHtml(s!))
      .join(", ") + (km(c.distance_km) ? ` · ${km(c.distance_km)} von dir` : ""),
    [rating, c.current_score !== null ? `Website-Score ${c.current_score}` : null]
      .filter(Boolean)
      .join(" · "),
    "",
    "Nimmst du ihn? Dann baue ich das Design-Briefing mit drei Richtungen (dauert etwa eine Minute).",
  ].join("\n");
  const site = websiteButton(c.website_url);
  return {
    text,
    keyboard: [
      [
        { text: "✅ Nehmen", callback_data: shopCallback({ kind: "take", id: pickId }) },
        { text: "🔄 Anderer Laden", callback_data: shopCallback({ kind: "next", id: pickId }) },
      ],
      ...(site ? [[site]] : []),
    ],
  };
}

export function briefingSummary(b: Briefing): string {
  return [
    `🎨 <b>Briefing: ${escapeHtml(b.laden.name)}</b>`,
    "",
    escapeHtml(b.laden_kurz),
    "",
    `<b>Stärken:</b> ${escapeHtml(b.staerken.join(" · "))}`,
    `<b>Alte Seite:</b> ${escapeHtml(b.schwaechen_alte_seite.join(" · "))}`,
    "",
    "Drei Richtungen folgen, wähl eine. Das ganze Briefing kommt als Datei, die bringst du in die Claude-Session mit, dann bauen wir die Seite.",
  ].join("\n");
}

export function directionCard(
  d: Direction,
  index: number,
  pickId: string,
): { text: string; keyboard: InlineKeyboardButton[][] } {
  const letter = String.fromCharCode(65 + index);
  const text = [
    `<b>${letter}: ${escapeHtml(d.name)}</b>`,
    escapeHtml(d.idee),
    "",
    `🧱 ${escapeHtml(d.grundform)}`,
    `🎨 ${d.farben.map((f) => `<code>${escapeHtml(f)}</code>`).join(" ")}`,
    `🔤 ${escapeHtml(d.schriften.titel)} + ${escapeHtml(d.schriften.text)}`,
    `✨ ${escapeHtml(d.signatur_element)}`,
    `<i>${escapeHtml(d.warum)}</i>`,
  ].join("\n");
  return {
    text,
    keyboard: [
      [
        {
          text: `👉 Richtung ${letter} nehmen`,
          callback_data: shopCallback({ kind: "dir", id: pickId, index }),
        },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Senden und Knöpfe

const branchName = (key: string | null): string | null => {
  if (!key) return null;
  try {
    return loadBranches()[key]?.label ?? key;
  } catch {
    return key;
  }
};

export async function sendShopProposal(api: Api, chatIds: readonly number[], p: ShopProposal): Promise<void> {
  const card = shopCard(p.candidate, p.pick.id, branchName(p.candidate.branch_key));
  for (const chatId of chatIds)
    await api.sendMessage(chatId, card.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: card.keyboard },
    });
}

async function sendBriefing(ctx: Context, b: Briefing, chosen: number | null): Promise<void> {
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(briefingMarkdown(b, chosen), "utf8"), `briefing-${slugify(b.laden.name)}.md`),
    {
      caption:
        chosen === null
          ? "📄 Das ganze Briefing"
          : `📄 Briefing mit Richtung ${String.fromCharCode(65 + chosen)}`,
    },
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "laden";

/** Knopf aus einer Laden-Karte; `false`, wenn es keiner war. */
export async function handleShopCallback(ctx: Context, pipeline: PipelineContext): Promise<boolean> {
  const cb = parseShopCallback(ctx.callbackQuery?.data ?? "");
  if (!cb) return false;
  const shop = pipeline.shop;
  const pick = await getPick(pipeline.db, cb.id);
  if (!shop || !pick) {
    await ctx.answerCallbackQuery({ text: "Nicht gefunden" });
    return true;
  }
  const now = pipeline.now();
  if (cb.kind === "next") {
    await setPick(pipeline.db, pick.id, { status: "abgelehnt" }, now);
    await ctx.answerCallbackQuery({ text: "Suche einen anderen …" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    const next = await proposeShop(pipeline.db, shop, now);
    if (!next) {
      await ctx.reply("Gerade finde ich keinen weiteren passenden Laden in deiner Nähe.");
      return true;
    }
    const card = shopCard(next.candidate, next.pick.id, branchName(next.candidate.branch_key));
    await ctx.reply(card.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: card.keyboard },
    });
    return true;
  }
  if (cb.kind === "take") {
    await ctx.answerCallbackQuery({ text: "Baue das Briefing …" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    const company = await findCompany(pipeline.db, pick.company_id);
    if (!company) return true;
    await ctx.reply(
      `🎨 Ich schaue mir ${company.name} genau an und entwerfe drei Richtungen. Dauert etwa eine Minute …`,
    );
    let briefing: Briefing;
    try {
      briefing = await buildBriefing(shop.briefing(), company);
    } catch (err) {
      await ctx.reply(
        `Das Briefing hat nicht geklappt: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      );
      return true;
    }
    await setPick(pipeline.db, pick.id, { status: "genommen", briefing }, now);
    await ctx.reply(briefingSummary(briefing), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    for (const [i, d] of briefing.richtungen.entries()) {
      const card = directionCard(d, i, pick.id);
      await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: card.keyboard } });
    }
    await sendBriefing(ctx, briefing, null);
    return true;
  }
  // Richtung gewählt
  if (cb.kind !== "dir") return true;
  const briefing = pick.briefing as Briefing | null;
  const d = briefing?.richtungen[cb.index];
  if (!briefing || !d) {
    await ctx.answerCallbackQuery({ text: "Richtung nicht gefunden" });
    return true;
  }
  await setPick(pipeline.db, pick.id, { chosen: cb.index }, now);
  await ctx.answerCallbackQuery({ text: `Richtung ${String.fromCharCode(65 + cb.index)} gemerkt` });
  await ctx.reply(
    `👉 <b>${escapeHtml(d.name)}</b> für ${escapeHtml(briefing.laden.name)}. Schick mir die Datei unten in die Claude-Session, dann bauen wir die Seite. Die nächsten Briefings setzen sich von dieser Richtung ab.`,
    { parse_mode: "HTML" },
  );
  await sendBriefing(ctx, briefing, cb.index);
  return true;
}
