import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import {
  addNote,
  companyHistory,
  dueReminders,
  openReminders,
  setSalesStatus,
  snoozeReminder,
} from "../src/db/crm.js";
import { isQuietTime, SALES_STATUSES, salesStatusFromCode, SALES_CODES } from "../src/crm/status.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { berlinDateTime, runTool } from "../src/manager/tools.js";
import { deliverDueReminders, type PipelineContext } from "../src/queue/pipeline.js";
import type { DueReminder } from "../src/queue/notifier.js";
import { createBot } from "../src/telegram/bot.js";
import { callbackData, crmCallback, parseCrmCallback, pipelineMessage } from "../src/telegram/format.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const QUIET = { start: "21:00", end: "08:00" };
const ID = "0b5e5a1e-1111-4222-8333-944455556666";

describe("CRM (rein)", () => {
  it("Status-Codes sind eindeutig und Buttons passen in 64 Byte", () => {
    const codes = SALES_STATUSES.map((s) => SALES_CODES[s]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const s of SALES_STATUSES) {
      expect(salesStatusFromCode(SALES_CODES[s])).toBe(s);
      const data = crmCallback({ kind: "status", status: s, companyId: ID });
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCrmCallback(data)).toEqual({ kind: "status", status: s, companyId: ID });
    }
    expect(parseCrmCallback(crmCallback({ kind: "remind", days: 7, companyId: ID }))).toEqual({
      kind: "remind",
      days: 7,
      companyId: ID,
    });
    expect(parseCrmCallback(`rd:${ID}`)).toEqual({ kind: "done", interactionId: ID });
    expect(parseCrmCallback(`ss:x:${ID}`)).toBeNull();
    expect(parseCrmCallback(callbackData("c", ID))).toBeNull();
  });

  it("Ruhezeit über Mitternacht, deutsche Zeit", () => {
    expect(isQuietTime(new Date("2026-10-03T20:30:00Z"), QUIET)).toBe(true); // 22:30 MESZ
    expect(isQuietTime(new Date("2026-10-04T05:30:00Z"), QUIET)).toBe(true); // 07:30
    expect(isQuietTime(new Date("2026-10-04T06:30:00Z"), QUIET)).toBe(false); // 08:30
    expect(isQuietTime(new Date("2026-12-04T07:30:00Z"), QUIET)).toBe(false); // 08:30 MEZ
  });

  it("Datum + Uhrzeit in Berlin (Sommer- und Winterzeit)", () => {
    expect(berlinDateTime("2026-10-09", "09:00").toISOString()).toBe("2026-10-09T07:00:00.000Z");
    expect(berlinDateTime("2026-12-09", "09:00").toISOString()).toBe("2026-12-09T08:00:00.000Z");
  });
});

const ALLOWED = 4242;
const BOT_INFO = { id: 1, is_bot: true, first_name: "Avelio", username: "avelio_test_bot" } as UserFromGetMe;
let updateId = 1;
const textUpdate = (text: string): Update => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: ALLOWED, type: "private", first_name: "X" },
    from: { id: ALLOWED, is_bot: false, first_name: "X" },
    text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}),
  },
});
const callbackUpdate = (data: string): Update => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    chat_instance: "x",
    from: { id: ALLOWED, is_bot: false, first_name: "X" },
    data,
    message: { message_id: 7, date: 0, chat: { id: ALLOWED, type: "private", first_name: "X" }, text: "alt" },
  },
});

describeDb("CRM mit Datenbank", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-03T10:00:00Z"); // 12:00 in Berlin
  const DAY = 86_400_000;
  let n = 0;
  async function lead(name = `Radl ${++n}`) {
    const { company } = await upsertCompany(db(), { name, placeId: `crm-${name}`, city: "Rosenheim" });
    await db().query("update companies set status = 'QUALIFIED', current_score = 77 where id = $1", [
      company.id,
    ]);
    return company;
  }

  it("kontaktiert → Status, Verlauf, automatische Nachfass-Erinnerung; gewonnen schließt Erinnerungen", async () => {
    const c = await lead();
    const { company, reminder } = await setSalesStatus(db(), c.id, "CONTACTED", {
      by: "test",
      channel: "email",
      now: NOW,
      followUpDays: 5,
    });
    expect(company.status).toBe("CONTACTED");
    expect(reminder!.due_at!.toISOString()).toBe(new Date(NOW.getTime() + 5 * DAY).toISOString());
    // Zweites "kontaktiert" legt keine zweite Erinnerung an.
    expect(
      (await setSalesStatus(db(), c.id, "CONTACTED", { by: "test", now: NOW, followUpDays: 5 })).reminder,
    ).toBeNull();
    await addNote(db(), c.id, { text: "will Angebot", by: "test", now: NOW });
    const history = await companyHistory(db(), c.id);
    expect(history.map((h) => h.type).sort()).toEqual(["note", "reminder", "status", "status"]);
    expect(history.find((h) => h.type === "status")).toMatchObject({
      from_status: "QUALIFIED",
      to_status: "CONTACTED",
    });

    await setSalesStatus(db(), c.id, "WON", { by: "test", now: NOW, followUpDays: 5 });
    expect(await openReminders(db(), c.id)).toEqual([]);
  });

  it("Erinnerungen: fällig, zugestellt nur außerhalb der Ruhezeit, je einmal; verschieben stellt erneut zu", async () => {
    await db().query("delete from interactions");
    const c = await lead();
    await setSalesStatus(db(), c.id, "CONTACTED", { by: "test", now: NOW, followUpDays: 1 });
    const delivered: DueReminder[][] = [];
    const ctx = (now: Date) =>
      ({
        db: db(),
        now: () => now,
        crm: { follow_up_days: 1, quiet_hours: QUIET },
        notifier: { remindersDue: (r: DueReminder[]) => (delivered.push(r), Promise.resolve()) },
      }) as unknown as PipelineContext;

    expect(await deliverDueReminders(ctx(NOW))).toBe(0); // noch nicht fällig
    expect(await deliverDueReminders(ctx(new Date(NOW.getTime() + DAY + 11 * 3_600_000)))).toBe(0); // 23:00 Ruhezeit
    const morning = new Date(NOW.getTime() + 2 * DAY - 3 * 3_600_000); // 09:00
    expect(await deliverDueReminders(ctx(morning))).toBe(1);
    expect(delivered[0]![0]).toMatchObject({ company_name: c.name, body: "Nachfassen: noch keine Antwort?" });
    expect(await deliverDueReminders(ctx(morning))).toBe(0); // schon zugestellt
    await snoozeReminder(db(), delivered[0]![0]!.id, 2, morning);
    expect(await dueReminders(db(), new Date(morning.getTime() + 2 * DAY))).toHaveLength(1);
  });

  it("Telegram: Kontakt-Button zeigt die CRM-Karte, Status-Button setzt Status und aktualisiert die Karte", async () => {
    const c = await lead("Hotel Ariadne");
    const pctx = {
      db: db(),
      now: () => NOW,
      crm: { follow_up_days: 5, quiet_hours: QUIET },
    } as unknown as PipelineContext;
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const toolStep = vi.fn();
    const bot = createBot({
      token: "123:test",
      allowedChatIds: [ALLOWED],
      manager: { ctx: pctx, llm: { toolStep } as unknown as LlmGateway },
      botInfo: BOT_INFO,
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({
        ok: true,
        result:
          method === "sendMessage"
            ? { message_id: 1, date: 0, chat: { id: ALLOWED, type: "private" } }
            : true,
      } as never);
    });
    const last = (method: string) => calls.filter((x) => x.method === method).at(-1)!.payload;

    await bot.handleUpdate(callbackUpdate(callbackData("c", c.id)));
    expect(String(last("sendMessage").text)).toContain("<b>Hotel Ariadne</b> (Rosenheim) – 77/100");
    expect(String(last("sendMessage").text)).toContain("noch nicht im Vertrieb (QUALIFIED)");
    const keyboard = (
      last("sendMessage").reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard;
    const contacted = keyboard.flat().find((b) => b.text.includes("kontaktiert"))!;

    await bot.handleUpdate(callbackUpdate(contacted.callback_data));
    expect(last("answerCallbackQuery")).toMatchObject({ text: "kontaktiert · Nachfassen in 5 Tagen" });
    expect(String(last("editMessageText").text)).toContain("Status: 📤 kontaktiert");
    expect(String(last("editMessageText").text)).toContain("⏰ Nachfassen: noch keine Antwort?");

    await bot.handleUpdate(textUpdate("/pipeline"));
    expect(String(last("sendMessage").text)).toMatch(/📤 kontaktiert \(\d+\): .*Hotel Ariadne/);

    const [reminder] = await openReminders(db(), c.id);
    await bot.handleUpdate(callbackUpdate(crmCallback({ kind: "done", interactionId: reminder!.id })));
    expect(last("answerCallbackQuery")).toMatchObject({ text: "Erledigt" });
    expect(await openReminders(db(), c.id)).toEqual([]);
    expect(toolStep).not.toHaveBeenCalled();
  });

  it("Manager-Werkzeuge: Status mit Kanal, Notiz, Erinnerung mit Datum, Pipeline, Verlauf im Lead", async () => {
    const c = await lead("Radl Sepp");
    const t = {
      ctx: {
        db: db(),
        now: () => NOW,
        crm: { follow_up_days: 5, quiet_hours: QUIET },
      } as unknown as PipelineContext,
      chatId: ALLOWED,
    };
    expect(
      (await runTool("set_status", { lead: "Radl Sepp", status: "CONTACTED", kanal: "phone" }, t)).text,
    ).toBe("Radl Sepp: Status kontaktiert. Nachfass-Erinnerung am 2026-10-08.");
    expect((await runTool("add_note", { lead: c.id.slice(0, 8), text: "Rückruf Montag" }, t)).text).toContain(
      "gespeichert",
    );
    expect(
      (await runTool("add_reminder", { lead: "Radl Sepp", datum: "2026-10-09", text: "Angebot schicken" }, t))
        .text,
    ).toBe("Erinnerung für Radl Sepp am 2026-10-09 um 09:00: Angebot schicken");
    expect(
      (await runTool("add_reminder", { lead: "Radl Sepp", datum: "2026-01-01", text: "alt" }, t)).text,
    ).toContain("Vergangenheit");
    const details = (await runTool("get_lead", { lead: "Radl Sepp" }, t)).text;
    expect(details).toContain("status → CONTACTED");
    expect(details).toContain("note: Rückruf Montag");
    expect(details).toContain("Offene Erinnerung (fällig 2026-10-09): Angebot schicken");
    expect((await runTool("pipeline", {}, t)).text).toContain("Radl Sepp");
    expect(pipelineMessage([], [])).toContain("Noch kein Lead im Vertrieb");
  });
});
