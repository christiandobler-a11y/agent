import { claimState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import { setPlanStatus } from "../db/plan.js";
import type { MailConfig } from "./mail.js";
import { sendDraft, type SendDeps } from "./send.js";

/**
 * Verteilt senden (04.10.2026, Christian: mehr Mails, aber nicht im Spam landen). "Alle senden" im Morgen-Paket
 * verschickt nicht alles auf einmal, sondern plant die freigegebenen Mails mit zufälligem Abstand über den Tag ein
 * (nur Mo bis Fr zwischen `von` und `bis`). Der Sweep schickt jeweils die nächste fällige. Gesendet wird nur, was
 * Christian freigegeben hat.
 */

type Window = MailConfig["verteilt"];

const parts = (d: Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`,
    weekend: p.weekday === "Sat" || p.weekday === "Sun",
  };
};

/** Zeitpunkt für Datum + Uhrzeit in Deutschland. */
function berlinAt(date: string, hm: string): Date {
  const guess = new Date(`${date}T${hm}:00Z`);
  const wall = parts(guess);
  const offset = Date.parse(`${wall.date}T${wall.time}:00Z`) - guess.getTime();
  return new Date(guess.getTime() - offset);
}

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Frühester Zeitpunkt ab `t` innerhalb des Versandfensters. */
export function nextOpen(t: Date, w: Window): Date {
  let cur = t;
  for (let i = 0; i < 10; i++) {
    const p = parts(cur);
    if (!p.weekend && p.time >= w.von && p.time < w.bis) return cur;
    cur = !p.weekend && p.time < w.von ? berlinAt(p.date, w.von) : berlinAt(nextDay(p.date), w.von);
  }
  return cur;
}

/** Sendezeitpunkte: der erste sofort (bzw. ab Fensterbeginn), danach mit zufälligem Abstand. Rein bis auf `rand`. */
export function spreadTimes(count: number, now: Date, w: Window, rand: () => number = Math.random): Date[] {
  const times: Date[] = [];
  let t = nextOpen(now, w);
  for (let i = 0; i < count; i++) {
    times.push(t);
    const minutes = w.abstand_min + rand() * Math.max(0, w.abstand_max - w.abstand_min);
    t = nextOpen(new Date(t.getTime() + minutes * 60_000), w);
  }
  return times;
}

/** Offene Mails eines Tagesplans einplanen. Gibt Anzahl, ersten und letzten Zeitpunkt zurück. */
export async function queuePlanMails(
  db: Db,
  date: string,
  now: Date,
  w: Window,
  rand: () => number = Math.random,
): Promise<{ count: number; first: Date | null; last: Date | null }> {
  const { rows } = await db.query<{ id: string }>(
    `select id from outreach_plan
      where plan_date = $1 and status = 'ready' and channel = 'email' and draft_id is not null
      order by position`,
    [date],
  );
  // Schon eingeplante (z. B. vor /nachlegen) laufen weiter; neue reihen sich mit Abstand dahinter ein.
  const { rows: last } = await db.query<{ at: Date | null }>(
    "select max(send_after) as at from outreach_plan where status = 'queued'",
  );
  const lastAt = last[0]?.at ?? null;
  const start =
    lastAt && lastAt > now
      ? new Date(
          lastAt.getTime() + (w.abstand_min + rand() * Math.max(0, w.abstand_max - w.abstand_min)) * 60_000,
        )
      : now;
  const times = spreadTimes(rows.length, start, w, rand);
  for (const [i, r] of rows.entries())
    await db.query("update outreach_plan set status = 'queued', send_after = $2 where id = $1", [
      r.id,
      times[i],
    ]);
  return { count: rows.length, first: times[0] ?? null, last: times.at(-1) ?? null };
}

/** Eingeplante Mails zurück auf "offen" (z. B. Tageslimit erreicht). */
export async function unqueueAll(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    "update outreach_plan set status = 'ready', send_after = null where status = 'queued'",
  );
  return rowCount ?? 0;
}

export async function queuedCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from outreach_plan where status = 'queued'",
  );
  return rows[0]?.n ?? 0;
}

/**
 * Die nächste fällige eingeplante Mail senden (eine je Aufruf, der Sweep läuft alle paar Minuten). Meldet, wenn alle
 * raus sind oder etwas schiefging; bei Fehlern geht die Mail zurück auf "offen" und bleibt im Morgen-Paket.
 */
export async function sendNextQueued(
  deps: SendDeps & { notify?: (text: string) => Promise<void> },
): Promise<"sent" | "idle" | "problem"> {
  const { db } = deps;
  const now = deps.now();
  const { rows } = await db.query<{ id: string; draft_id: string; name: string }>(
    `select p.id, p.draft_id, c.name from outreach_plan p join companies c on c.id = p.company_id
      where p.status = 'queued' and p.send_after <= $1 order by p.send_after limit 1`,
    [now],
  );
  const item = rows[0];
  if (!item) return "idle";
  const back = () =>
    db.query("update outreach_plan set status = 'ready', send_after = null where id = $1", [item.id]);
  let result: Awaited<ReturnType<typeof sendDraft>>;
  try {
    result = await sendDraft(deps, item.draft_id, "verteilt");
  } catch (err) {
    await back();
    await deps.notify?.(
      `⚠️ Mail an ${item.name} ging nicht raus: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}. Sie liegt wieder im Morgen-Paket (/heute).`,
    );
    return "problem";
  }
  if (result.kind === "sent" || result.kind === "already_sent") {
    await setPlanStatus(db, item.id, "done", now);
    const { rows: rest } = await db.query<{ n: number; last: Date | null }>(
      "select count(*)::int as n, max(send_after) as last from outreach_plan where status = 'queued'",
    );
    const left = rest[0]?.n ?? 0;
    // Erste verteilte Mail des Tages: kurze Entwarnung (05.10.2026, Christians Wunsch).
    if (
      result.kind === "sent" &&
      left > 0 &&
      (await claimState(db, `queue-first:${parts(now).date}`, true))
    ) {
      const last = rest[0]?.last ? parts(rest[0].last).time : null;
      await deps.notify?.(
        `🚀 Ging los! Die erste Mail ist ohne Probleme raus (an ${item.name}). ${left === 1 ? `Eine kommt noch${last ? `, gegen ${last} Uhr` : ""}` : `Die restlichen ${left} kommen nach${last ? `, die letzte gegen ${last} Uhr` : ""}`}.`,
      );
    }
    if (left === 0)
      await deps.notify?.("📤 Alle eingeplanten Mails sind raus. Antworten melde ich dir hier.");
    return "sent";
  }
  if (result.kind === "limit") {
    await back();
    const rest = await unqueueAll(db);
    await deps.notify?.(
      `⏸️ Tageslimit erreicht (${result.max} neue Mails). ${rest + 1} Mails bleiben offen im Morgen-Paket.`,
    );
    return "problem";
  }
  await back();
  await deps.notify?.(`⚠️ ${item.name}: keine Adresse oder Entwurf fehlt, bitte selbst ansehen (/heute).`);
  return "problem";
}

/**
 * Mail nach dem Ja am Telefon zeitversetzt (06.10.2026, Christian: "5–10 Minuten nach dem Okay, damit es so
 * rüberkommt, als hätte ich das erst nach dem Telefonat formuliert"). Christian drückt den Knopf, der Entwurf bekommt
 * `meta.send_after`; der Sweep schickt fällige Entwürfe. Zufällige Minuten zwischen `range[0]` und `range[1]`.
 */
export async function scheduleDraft(
  db: Db,
  draftId: string,
  now: Date,
  range: readonly [number, number],
  rand: () => number = Math.random,
): Promise<Date | null> {
  const minutes = range[0] + rand() * Math.max(0, range[1] - range[0]);
  const at = new Date(now.getTime() + minutes * 60_000);
  const { rowCount } = await db.query(
    `update interactions set meta = meta || jsonb_build_object('send_after', $2::text)
      where id = $1 and type = 'draft' and channel = 'email' and not (meta ? 'sent_at')`,
    [draftId, at.toISOString()],
  );
  return rowCount === 1 ? at : null;
}

/** Zeitversetzten Versand abbrechen ("✋ Stopp"). */
export async function unscheduleDraft(db: Db, draftId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update interactions set meta = meta - 'send_after' where id = $1 and meta ? 'send_after' and not (meta ? 'sent_at')`,
    [draftId],
  );
  return rowCount === 1;
}

/** Sweep: fällige zeitversetzte Entwürfe senden und melden. */
export async function sendScheduledDrafts(
  deps: SendDeps & { notify?: (text: string) => Promise<void> },
): Promise<number> {
  const { rows } = await deps.db.query<{ id: string; name: string }>(
    `select i.id, c.name from interactions i join companies c on c.id = i.company_id
      where i.type = 'draft' and i.channel = 'email' and i.meta ? 'send_after' and not (i.meta ? 'sent_at')
        and (i.meta->>'send_after')::timestamptz <= $1
      order by (i.meta->>'send_after')::timestamptz limit 5`,
    [deps.now()],
  );
  let sent = 0;
  for (const r of rows) {
    try {
      const result = await sendDraft(deps, r.id, "zeitversetzt");
      if (result.kind === "sent") {
        sent++;
        await deps.notify?.(`📤 Mail an ${r.name} ist raus (an ${result.to}).`);
      } else if (result.kind !== "already_sent") {
        await unscheduleDraft(deps.db, r.id);
        await deps.notify?.(
          `⚠️ Mail an ${r.name} ging nicht raus (${result.kind}). Bitte über den Lead neu senden.`,
        );
      }
    } catch (err) {
      await unscheduleDraft(deps.db, r.id);
      await deps.notify?.(
        `⚠️ Mail an ${r.name} ging nicht raus: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      );
    }
  }
  return sent;
}
