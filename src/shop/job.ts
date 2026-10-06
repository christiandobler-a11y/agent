import { claimState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import { berlinTime } from "../autopilot/plan.js";
import { berlinWeekday } from "../advisor/job.js";
import type { PipelineContext } from "../queue/pipeline.js";
import type { BriefingDeps } from "./briefing.js";
import {
  insertPick,
  isoWeek,
  pickShop,
  shopDue,
  type ShopCandidate,
  type ShopConfig,
  type ShopPick,
} from "./pick.js";

/** Laden der Woche im Kontext (Worker und Bot). */
export interface ShopContext {
  config: ShopConfig;
  home: { lat: number; lng: number } | null;
  briefing: () => BriefingDeps;
}

export interface ShopProposal {
  pick: ShopPick;
  candidate: ShopCandidate;
}

/** Nächsten Laden vorschlagen und speichern; `null`, wenn keiner passt. */
export async function proposeShop(db: Db, shop: ShopContext, now: Date): Promise<ShopProposal | null> {
  if (!shop.home) return null;
  const candidate = await pickShop(db, shop.config, shop.home);
  if (!candidate) return null;
  const pick = await insertPick(db, candidate.id, isoWeek(now));
  return { pick, candidate };
}

/** Sweep: am eingestellten Wochentag einmal je Woche einen Laden vorschlagen. */
export async function shopTick(ctx: PipelineContext): Promise<boolean> {
  const shop = ctx.shop;
  if (!shop) return false;
  const now = ctx.now();
  if (!shopDue(shop.config, berlinWeekday(now), berlinTime(now))) return false;
  if (!(await claimState(ctx.db, `shop-week:${isoWeek(now)}`, now.toISOString()))) return false;
  const proposal = await proposeShop(ctx.db, shop, now);
  if (proposal) await ctx.notifier.shopProposal?.(proposal);
  else
    await ctx.notifier.info?.(
      "🏪 Diese Woche finde ich keinen passenden Laden in deiner Nähe. Die Nachtsuche sucht weiter nach Fahrradläden und Friseuren.",
    );
  return true;
}
