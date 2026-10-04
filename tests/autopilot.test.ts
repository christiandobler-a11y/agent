import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update, UserFromGetMe } from "grammy/types";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  berlinDate,
  buildDailyPlan,
  chooseChannel,
  dailyNewCount,
  loadAutopilotConfig,
  type AutopilotConfig,
} from "../src/autopilot/plan.js";
import { autopilotTick, berlinTime } from "../src/autopilot/schedule.js";
import { nightOf, nightReport, pickNextSearch, searchTick } from "../src/autopilot/search.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import { loadResearchConfig } from "../src/pipeline/research/run.js";
import { loadRegion } from "../src/pipeline/research/tiling.js";
import { getState, setState } from "../src/db/appState.js";
import { upsertCompany, type Company } from "../src/db/companies.js";
import { insertDraft, takenSlots } from "../src/db/drafts.js";
import { createConfirmDraft, icsInvite, terminLabel } from "../src/outreach/confirm.js";
import { mailEventMessage } from "../src/telegram/format.js";
import { countPlan, planItems, type PlanItem } from "../src/db/plan.js";
import { insertWebsiteSnapshot } from "../src/db/websiteSnapshots.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import {
  createFollowUpDraft,
  dueFollowUps,
  dueLetterFollowUps,
  followUpBody,
} from "../src/outreach/followup.js";
import {
  bounceOf,
  loadMailConfig,
  matchReply,
  replyExcerpt,
  replySubject,
  type IncomingMail,
  type Mailbox,
  type OutgoingMail,
} from "../src/outreach/mail.js";
import { createMxCheck } from "../src/outreach/mx.js";
import { checkReplies, sendDraft } from "../src/outreach/send.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import { createBot } from "../src/telegram/bot.js";
import { parsePlanCallback, planCallback, planHeaderText } from "../src/telegram/plan.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const incoming = (over: Partial<IncomingMail>): IncomingMail => ({
  uid: 1,
  messageId: "<x@kunde.de>",
  inReplyTo: null,
  references: [],
  from: "info@kunde.de",
  subject: "Re: Ihre Website",
  date: null,
  text: "Hallo Christian,\ngern, Dienstag passt.\n\nAm 1.10. schrieb Christian:\n> alter Text",
  ...over,
});

let boxNo = 0;
/** Test-Postfach; Message-IDs je Postfach eindeutig ("<b2m1@…>"), wie echte zufällige IDs. */
function fakeMailbox() {
  const prefix = `b${++boxNo}m`;
  const sent: OutgoingMail[] = [];
  const inbox: IncomingMail[] = [];
  let maxUid = 10;
  const box: Mailbox & { sent: OutgoingMail[]; prefix: string; deliver(m: IncomingMail): void } = {
    address: "christian@example.de",
    prefix,
    sent,
    deliver(m) {
      inbox.push(m);
      maxUid = Math.max(maxUid, m.uid);
    },
    send(m) {
      sent.push(m);
      return Promise.resolve({ messageId: `<${prefix}${sent.length}@example.de>` });
    },
    fetchSince(after) {
      return Promise.resolve({
        uidValidity: "7",
        maxUid,
        mails: after === null ? [] : inbox.filter((m) => m.uid > after),
      });
    },
  };
  return box;
}

/** Message-ID der n-ten gesendeten Mail eines Test-Postfachs (ohne spitze Klammern). */
const idOf = (box: { address: string }, n: number) =>
  `${(box as unknown as { prefix: string }).prefix}${n}@example.de`;

const config = (over: Partial<AutopilotConfig["neue_kontakte"]> = {}): AutopilotConfig => {
  const c = loadAutopilotConfig();
  return { ...c, neue_kontakte: { ...c.neue_kontakte, ...over } };
};

describe("Termin-Bestätigung (rein)", () => {
  it("Termin lesbar und als Kalender-Einladung", () => {
    expect(terminLabel("2026-10-13T10:30:00.000Z")).toBe("Dienstag, 13.10., um 12:30 Uhr");
    expect(terminLabel("2026-10-13T10:00:00.000Z")).toBe("Dienstag, 13.10., um 12 Uhr");
    const ics = icsInvite({
      uid: "x@avelio.digital",
      start: new Date("2026-10-13T10:30:00.000Z"),
      minutes: 15,
      summary: "Gespräch, kurz",
      description: "Zeile 1\nZeile 2",
      now: new Date("2026-10-05T07:00:00.000Z"),
    });
    expect(ics).toContain("DTSTART:20261013T103000Z\r\nDTEND:20261013T104500Z");
    expect(ics).toContain("SUMMARY:Gespräch\\, kurz");
    expect(ics).toContain("DESCRIPTION:Zeile 1\\nZeile 2");
  });
});

describe("Morgen-Paket (rein)", () => {
  it("Menge je Tag: Start, später mehr, am Wochenende keine neuen", () => {
    const monday = new Date("2026-10-05T06:00:00Z");
    const saturday = new Date("2026-10-03T06:00:00Z");
    const c = config({ start: 15, spaeter: 30, steigern_nach_tagen: 14, nur_werktags: true });
    expect(dailyNewCount(c, monday, null)).toBe(15);
    expect(dailyNewCount(c, monday, new Date("2026-09-30T06:00:00Z"))).toBe(15);
    expect(dailyNewCount(c, monday, new Date("2026-09-01T06:00:00Z"))).toBe(30);
    expect(dailyNewCount(c, saturday, null)).toBe(0);
  });

  it("Kanal: Erstkontakt per Mail, Brief nur ohne erreichbare Mail-Adresse", () => {
    expect(chooseChannel({ hasAddress: true, mailOk: true }, 3)).toBe("email");
    expect(chooseChannel({ hasAddress: true, mailOk: false }, 3)).toBe("letter");
    expect(chooseChannel({ hasAddress: true, mailOk: false }, 0)).toBeNull();
    expect(chooseChannel({ hasAddress: false, mailOk: false }, 3)).toBeNull();
  });

  it("Zeit und Datum in Deutschland", () => {
    expect(berlinDate(new Date("2026-10-04T22:30:00Z"))).toBe("2026-10-05");
    expect(berlinTime(new Date("2026-10-05T03:00:00Z"))).toBe("05:00");
  });

  it("Zähler und Kopf: Später und Aussortiert zählen nicht", () => {
    const item = (over: Partial<PlanItem>): PlanItem =>
      ({ kind: "new", channel: "email", status: "ready", ...over }) as PlanItem;
    const counts = countPlan([
      item({ status: "done" }),
      item({}),
      item({ status: "later" }),
      item({ channel: "letter" }),
      item({ kind: "followup", status: "done" }),
    ]);
    expect(counts).toEqual({
      email: { done: 1, total: 2 },
      letter: { done: 0, total: 1 },
      followup: { done: 1, total: 1 },
    });
    const text = planHeaderText("2026-10-05", counts);
    expect(text).toContain("Montag, 5. Oktober");
    expect(text).toContain("📧 Neue Mails: <b>1/2</b>");
    expect(text).toContain("🔁 Nachfassen: <b>1/1</b> ✅");
    const id = "0b9a3f0e-1111-4222-8333-444455556666";
    expect(parsePlanCallback(planCallback({ kind: "send", id }))).toEqual({ kind: "send", id });
    expect(parsePlanCallback("pl:n")).toEqual({ kind: "next" });
    expect(parsePlanCallback("ps:kaputt")).toBeNull();
  });

  it("Postfach: Antworten zuordnen (Verlauf, Adresse, Domain), Unzustellbar erkennen, Zitat abschneiden", () => {
    const sent = [
      { companyId: "a", messageId: "<m1@example.de>", to: "info@kunde.de" },
      { companyId: "b", messageId: "<m2@example.de>", to: "info@gmx.de" },
    ];
    expect(matchReply(incoming({ inReplyTo: "<M1@example.de>", from: "chef@anders.de" }), sent)).toBe("a");
    expect(matchReply(incoming({ from: "INFO@kunde.de" }), sent)).toBe("a");
    expect(matchReply(incoming({ from: "chef@kunde.de" }), sent)).toBe("a");
    expect(matchReply(incoming({ from: "jemand@gmx.de" }), sent)).toBeNull(); // Freemailer: Domain zählt nicht
    expect(matchReply(incoming({ from: "x@fremd.de" }), sent)).toBeNull();
    expect(
      bounceOf(
        incoming({
          from: "MAILER-DAEMON@mx.example.de",
          subject: "Undelivered Mail Returned to Sender",
          text: "Message-ID: <m2@example.de>",
        }),
      ),
    ).toEqual({ bounced: true, ids: ["<m2@example.de>"] });
    expect(bounceOf(incoming({}))).toBeNull();
    expect(replyExcerpt(incoming({}).text)).toBe("Hallo Christian,\ngern, Dienstag passt.");
    expect(replySubject("Re: Hallo")).toBe("Re: Hallo");
    expect(replySubject("Hallo")).toBe("Re: Hallo");
  });

  it("MX-Prüfung: ohne MX kein Versand, Ergebnis je Domain gemerkt", async () => {
    const lookup = vi.fn((d: string) =>
      d === "gibtsnicht.de" ? Promise.reject(new Error("ENOTFOUND")) : Promise.resolve([{}]),
    );
    const mx = createMxCheck(lookup);
    expect(await mx("info@kunde.de")).toBe(true);
    expect(await mx("chef@kunde.de")).toBe(true);
    expect(await mx("a@gibtsnicht.de")).toBe(false);
    expect(await mx("kaputt")).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("Nachfass-Text: kurz, mit Entwurf-Link und Ausstieg", () => {
    const body = followUpBody({
      greeting: "Hallo Herr Ernst,",
      sentence: "Ich wollte nur kurz nachhaken.",
      preview: "Den Entwurf sehen Sie hier: https://v.example/x/",
      exit: "Wenn es gerade nicht passt, melde ich mich nicht mehr.",
      closing: "Viele Grüße",
      signature: "Christian Dobler",
    });
    expect(body).toBe(
      "Hallo Herr Ernst,\n\nich wollte nur kurz nachhaken. Den Entwurf sehen Sie hier: https://v.example/x/\n\nWenn es gerade nicht passt, melde ich mich nicht mehr.\n\nViele Grüße\nChristian Dobler",
    );
  });
});

const ALLOWED = 4242;
const BOT_INFO = { id: 1, is_bot: true, first_name: "Avelio", username: "avelio_test_bot" } as UserFromGetMe;
let updateId = 1;
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

describeDb("Morgen-Paket mit Datenbank", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-05T04:00:00Z"); // Montag, 06:00 in Berlin
  let n = 0;
  const mail = { ...loadMailConfig(), max_per_day: 2 };

  async function lead(
    over: { score?: number; email?: string | null; street?: string | null } = {},
  ): Promise<Company> {
    const { company } = await upsertCompany(db(), {
      name: `Praxis ${++n}`,
      placeId: `ap-${n}`,
      city: "Rosenheim",
    });
    await db().query(
      "update companies set status = 'QUALIFIED', current_score = $2, street = $3, postal_code = '83022' where id = $1",
      [company.id, over.score ?? 70, over.street === undefined ? "Hauptstr. 1" : over.street],
    );
    if (over.email !== null)
      await db().query(
        "insert into contacts (company_id, name, email, source) values ($1, null, $2, 'impressum')",
        [company.id, over.email ?? `info@praxis${n}.de`],
      );
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', $2, '{}', '{}', 's')`,
      [
        company.id,
        JSON.stringify([
          {
            title: "Kein Termin-Knopf",
            detail: "d",
            evidence: "e",
            severity: "high",
            category: "conversion",
          },
        ]),
      ],
    );
    const { rows } = await db().query<Company>("select * from companies where id = $1", [company.id]);
    return rows[0]!;
  }

  async function emailDraft(c: Company, sentDaysAgo: number | null = null) {
    const meta: Record<string, unknown> = {
      subject: "Ihr erster Eindruck online",
      to: `info@${c.name.replace(/\W/g, "").toLowerCase()}.de`,
    };
    if (sentDaysAgo !== null) {
      meta.sent_at = new Date(NOW.getTime() - sentDaysAgo * 86_400_000).toISOString();
      meta.message_id = `<first-${c.id}@example.de>`;
    }
    return insertDraft(db(), c.id, { channel: "email", body: "Hallo,\n\nText", meta, by: "test", now: NOW });
  }

  it("Senden per Knopf: nur einmal, setzt kontaktiert, Tageslimit für neue Mails", async () => {
    const box = fakeMailbox();
    const deps = { db: db(), mailbox: box, mail, now: () => NOW, followUpDays: 5 };
    const [a, b, c] = [await lead(), await lead(), await lead()];
    const da = await emailDraft(a);
    const r = await sendDraft(deps, da.id, "test");
    expect(r.kind).toBe("sent");
    expect(box.sent[0]).toMatchObject({ subject: "Ihr erster Eindruck online", text: "Hallo,\n\nText" });
    expect((await sendDraft(deps, da.id, "test")).kind).toBe("already_sent");
    expect(box.sent).toHaveLength(1);
    const { rows } = await db().query<{ status: string }>("select status from companies where id = $1", [
      a.id,
    ]);
    expect(rows[0]!.status).toBe("CONTACTED");
    await sendDraft(deps, (await emailDraft(b)).id, "test");
    expect((await sendDraft(deps, (await emailDraft(c)).id, "test")).kind).toBe("limit");
  });

  it("Antworten erkennen: erster Lauf merkt nur den Stand, dann geantwortet + Nachfassen gestoppt; Unzustellbar", async () => {
    const box = fakeMailbox();
    const notify = vi.fn(() => Promise.resolve());
    const deps = { db: db(), mailbox: box, mail: { ...mail, max_per_day: 50 }, now: () => NOW, notify };
    const a = await lead();
    const b = await lead();
    await sendDraft({ ...deps, followUpDays: 5 }, (await emailDraft(a)).id, "test");
    await sendDraft({ ...deps, followUpDays: 5 }, (await emailDraft(b)).id, "test");
    box.deliver(incoming({ uid: 5, inReplyTo: `<${idOf(box, 1)}>` })); // vor dem ersten Lauf: alt, zählt nicht
    expect(await checkReplies(deps)).toEqual([]);
    box.deliver(incoming({ uid: 11, inReplyTo: `<${idOf(box, 1)}>`, from: "chef@irgendwo.de" }));
    box.deliver(
      incoming({
        uid: 12,
        from: "mailer-daemon@mx.example.de",
        subject: "Undelivered Mail",
        text: `Message-ID: <${idOf(box, 2)}>`,
      }),
    );
    const events = await checkReplies(deps);
    expect(events.map((e) => e.kind)).toEqual(["reply", "bounce"]);
    expect(notify).toHaveBeenCalledTimes(2);
    const { rows } = await db().query<{ id: string; status: string }>(
      "select id, status from companies where id = any($1)",
      [[a.id, b.id]],
    );
    expect(rows.find((r) => r.id === a.id)!.status).toBe("REPLIED");
    const { rows: reminders } = await db().query<{ n: number }>(
      "select count(*)::int as n from interactions where company_id = $1 and type = 'reminder' and done_at is null",
      [a.id],
    );
    expect(reminders[0]!.n).toBe(0);
    expect(await checkReplies(deps)).toEqual([]); // nichts doppelt
  });

  it("Termin bestätigen: Knöpfe aus der Antwort, Bestätigung im Verlauf mit Einladung, Status und Erinnerung", async () => {
    const box = fakeMailbox();
    const deps = { db: db(), mailbox: box, mail: { ...mail, max_per_day: 50 }, now: () => NOW };
    const a = await lead();
    const slots = ["2026-10-07T10:30:00.000Z", "2026-10-08T11:15:00.000Z"];
    const first = await insertDraft(db(), a.id, {
      channel: "email",
      body: "Hallo,\n\nText",
      meta: { subject: "Ihr erster Eindruck online", to: "info@termin.de", slots },
      by: "test",
      now: NOW,
    });
    await sendDraft({ ...deps, followUpDays: 5 }, first.id, "test");
    await checkReplies(deps); // erster Lauf: nur Stand merken
    box.deliver(
      incoming({
        uid: 21,
        messageId: "<antwort-1@termin.de>",
        inReplyTo: `<${idOf(box, 1)}>`,
        from: "info@termin.de",
      }),
    );
    const [event] = await checkReplies(deps);
    expect(event).toMatchObject({ kind: "reply", offer: { draftId: first.id, slots } });
    const msg = mailEventMessage(event!);
    expect(msg.keyboard[0]!.map((b) => ("callback_data" in b ? b.callback_data : null))).toEqual([
      `tb:${first.id}:0`,
      `tb:${first.id}:1`,
    ]);

    const confirm = (await createConfirmDraft(
      { db: db(), outreach: loadOutreachConfig(), contact: { phone: "0151 1" }, now: NOW },
      first.id,
      1,
      "test",
    ))!;
    expect(confirm.body).toContain("Donnerstag, 8.10., um 13:15 Uhr");
    expect(confirm.subject).toBe("Re: Ihr erster Eindruck online");
    const r = await sendDraft({ ...deps, followUpDays: 5 }, confirm.draftId, "test");
    expect(r.kind).toBe("sent");
    const sent = box.sent.at(-1)!;
    expect(sent.inReplyTo).toBe("<antwort-1@termin.de>");
    expect(sent.attachments?.[0]?.filename).toBe("termin.ics");
    expect(String(sent.attachments?.[0]?.content)).toContain("DTSTART:20261008T111500Z");
    const { rows } = await db().query<{ status: string; due: Date }>(
      `select c.status, (select due_at from interactions where company_id = c.id and type = 'reminder'
                          and done_at is null order by due_at desc limit 1) as due
         from companies c where c.id = $1`,
      [a.id],
    );
    expect(rows[0]!.status).toBe("INTERESTED");
    expect(rows[0]!.due.toISOString()).toBe("2026-10-08T10:45:00.000Z");
    // Der bestätigte Termin ist für alle anderen belegt.
    expect((await takenSlots(db(), NOW)).get(slots[1]!)).toBeGreaterThanOrEqual(1000);
  });

  it("Nachfassen: fällig nach 5 Tagen, im selben Verlauf, nur einmal", async () => {
    const a = await lead();
    await db().query("update companies set status = 'CONTACTED' where id = $1", [a.id]);
    await emailDraft(a, 6);
    const b = await lead();
    await db().query("update companies set status = 'CONTACTED' where id = $1", [b.id]);
    await emailDraft(b, 2);
    const due = await dueFollowUps(db(), NOW, 5);
    expect(due.map((d) => d.company.id)).toEqual([a.id]);
    const draft = await createFollowUpDraft(
      { db: db(), outreach: loadOutreachConfig(), phone: null, now: NOW },
      due[0]!.company,
      due[0]!.first,
      "test",
    );
    expect(draft.subject).toBe("Re: Ihr erster Eindruck online");
    expect(draft.body).toMatch(/nachhaken|Nachfrage/);
    const { rows } = await db().query<{ meta: { in_reply_to: string; follow_up: boolean } }>(
      "select meta from interactions where id = $1",
      [draft.draftId],
    );
    expect(rows[0]!.meta).toMatchObject({ in_reply_to: `<first-${a.id}@example.de>`, follow_up: true });
    // Gesendet → nicht mehr fällig.
    await db().query(
      'update interactions set meta = meta || \'{"sent_at": "2026-10-05T05:00:00Z"}\' where id = $1',
      [draft.draftId],
    );
    expect(await dueFollowUps(db(), NOW, 5)).toEqual([]);
  });

  it("Brief als zweites Nachfassen nur für sehr gute Leads ohne Antwort", async () => {
    await db().query("update companies set status = 'LOST'");
    const followUpSent = async (c: Company, daysAgo: number) => {
      await db().query("update companies set status = 'CONTACTED' where id = $1", [c.id]);
      await insertDraft(db(), c.id, {
        channel: "email",
        body: "Nachfassen",
        meta: { follow_up: true, sent_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() },
        by: "test",
        now: NOW,
      });
    };
    const top = await lead({ score: 86 });
    const weak = await lead({ score: 70 });
    const recent = await lead({ score: 90 });
    const noAddress = await lead({ score: 88, street: null });
    await followUpSent(top, 8);
    await followUpSent(weak, 8);
    await followUpSent(recent, 3);
    await followUpSent(noAddress, 8);
    expect((await dueLetterFollowUps(db(), NOW, 7, 80, 3)).map((c) => c.id)).toEqual([top.id]);
    expect(await dueLetterFollowUps(db(), NOW, 7, 80, 0)).toEqual([]);
  });

  it("Plan bauen und in Telegram durchklicken: Senden geht übers Postfach, Zähler und nächste Karte", async () => {
    // Leads aus den vorigen Tests dieser Datei nicht mitplanen.
    await db().query("update companies set status = 'LOST'");
    const tmp = mkdtempSync(join(tmpdir(), "avelio-plan-"));
    const shot = join(tmp, "desktop.jpg");
    await sharp({ create: { width: 1440, height: 1800, channels: 3, background: "#fff" } })
      .jpeg()
      .toFile(shot);
    const strong = await lead({ score: 88 });
    const normal = await lead({ score: 72 });
    // Ohne erreichbare Mail-Adresse, aber mit Anschrift: Brief.
    const letterOnly = await lead({ score: 71, email: "post@gibtsnicht.de" });
    await insertWebsiteSnapshot(db(), {
      companyId: letterOnly.id,
      url: "https://x.de",
      screenshotDesktop: shot,
      screenshotMobile: shot,
    });
    const noMail = await lead({ score: 70, email: "info@gibtsnicht.de", street: null });
    const old = await lead();
    await db().query("update companies set status = 'CONTACTED' where id = $1", [old.id]);
    await emailDraft(old, 6);

    const structured = vi.fn((req: { role: string }) =>
      Promise.resolve({
        output:
          req.role === "letter"
            ? { markierungen: [], zeilen: "Ihre Seite ist mir aufgefallen.", popup_im_bild: false }
            : { absatz: "ich heiße Christian und mache Online-Auftritte zeitgemäß." },
        agentRunId: "r",
        costUsd: 0.005,
        model: "m",
      }),
    );
    const llm = { structured, toolStep: vi.fn() } as unknown as LlmGateway;
    const outreach = loadOutreachConfig();
    const letterDeps = {
      db: db(),
      llm,
      outreach,
      branches: {},
      now: () => NOW,
      contact: { whatsapp: "+49 151 1", phone: null },
      render: () => Promise.resolve({ pdf: Buffer.from("%PDF"), png: Buffer.from("png") }),
      desktopScreenPx: 900,
    };
    const result = await buildDailyPlan({
      db: db(),
      now: () => NOW,
      config: { ...config({ start: 5 }), briefe: { pro_tag: 1, ab_score: 80, nachfassen_nach_tagen: 7 } },
      letter: letterDeps,
      prototype: null,
      mx: (a) => Promise.resolve(!a.endsWith("gibtsnicht.de")),
      lettersDir: join(tmp, "letters"),
    });
    expect(result).toMatchObject({ followups: 1, letters: 1, emails: 2, stoppedByBudget: false });
    expect(result.skipped.map((s) => s.name)).toEqual([noMail.name]);
    const items = await planItems(db(), "2026-10-05");
    expect(items.map((i) => [i.company_name, i.kind, i.channel])).toEqual([
      [old.name, "followup", "email"],
      [strong.name, "new", "email"],
      [normal.name, "new", "email"],
      [letterOnly.name, "new", "letter"],
    ]);

    // Telegram
    const box = fakeMailbox();
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = createBot({
      token: "123:test",
      allowedChatIds: [ALLOWED],
      manager: {
        ctx: {
          db: db(),
          now: () => NOW,
          crm: { follow_up_days: 5, quiet_hours: { start: "21:00", end: "08:00" } },
          lead: { branches: {} },
        } as unknown as PipelineContext,
        llm,
      },
      botInfo: BOT_INFO,
      outreach: { config: outreach, contact: { whatsapp: "+49 151 1", phone: null } },
      mail: { mailbox: box, config: mail },
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload });
      return Promise.resolve({
        ok: true,
        result: method.startsWith("send")
          ? { message_id: calls.length, date: 0, chat: { id: ALLOWED, type: "private" } }
          : true,
      } as never);
    });
    // Morgens ohne Befehl: Kopf mit Nachtbericht und gleich die erste Karte.
    await bot.sendMorning("2026-10-05", ["Physiotherapie · Landkreis Weilheim-Schongau: 12 neue Betriebe"]);
    const sentMessages = calls.filter((c) => c.method === "sendMessage");
    const header = sentMessages[0]!.payload;
    expect(String(header.text)).toContain("📧 Neue Mails: <b>0/2</b>");
    expect(String(header.text)).toContain(
      "🌙 <b>Heute Nacht:</b>\nPhysiotherapie · Landkreis Weilheim-Schongau",
    );
    expect(sentMessages).toHaveLength(2);
    const card = sentMessages[1]!.payload;
    expect(String(card.text)).toContain("🔁 Nachfassen <b>1/4</b>");
    const buttons = (
      card.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toContain("📤 Senden");
    await bot.handleUpdate(callbackUpdate(buttons.find((b) => b.text === "📤 Senden")!.callback_data!));
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.inReplyTo).toBe(`<first-${old.id}@example.de>`);
    expect(calls.some((c) => c.method === "editMessageText" && String(c.payload.text).includes("0/1"))).toBe(
      true,
    );
    // Als Nächstes die Mail an den stärksten Lead
    expect(calls.at(-1)!.method).toBe("sendMessage");
    expect(String(calls.at(-1)!.payload.text)).toContain(strong.name);
    const after = await planItems(db(), "2026-10-05");
    expect(after[0]!.status).toBe("done");
  });

  it("Takt: Plan um 05:00 anstoßen, um 07:00 melden, je Tag einmal", async () => {
    const send = vi.fn(() => Promise.resolve("job"));
    const planReady = vi.fn(() => Promise.resolve());
    let now = new Date("2026-10-05T02:30:00Z"); // 04:30 Berlin
    const ctx = {
      db: db(),
      boss: { send },
      now: () => now,
      notifier: { planReady },
      autopilot: {
        config: { ...loadAutopilotConfig(), suche: { ...loadAutopilotConfig().suche, aktiv: false } },
        planDeps: () => ({}),
      },
    } as unknown as PipelineContext;
    await autopilotTick(ctx);
    expect(send).not.toHaveBeenCalled();
    now = new Date("2026-10-05T03:05:00Z"); // 05:05
    await autopilotTick(ctx);
    await autopilotTick(ctx);
    expect(send).toHaveBeenCalledTimes(1);
    await setState(db(), "plan-built:2026-10-05", { date: "2026-10-05" });
    await autopilotTick(ctx);
    expect(planReady).not.toHaveBeenCalled(); // erst ab 07:00
    now = new Date("2026-10-05T05:01:00Z"); // 07:01
    await autopilotTick(ctx);
    await autopilotTick(ctx);
    expect(planReady).toHaveBeenCalledTimes(1);
    expect(await getState(db(), "plan-sent:2026-10-05")).toBe(true);
  });
  it("Alle Mails senden: mit Rückfrage, jede einzeln übers Postfach", async () => {
    await db().query("update companies set status = 'LOST'");
    await db().query("delete from outreach_plan");
    const date = "2026-10-05";
    const box = fakeMailbox();
    const a = await lead();
    const b = await lead();
    for (const c of [a, b]) {
      const d = await emailDraft(c);
      await db().query(
        "insert into outreach_plan (plan_date, company_id, kind, channel, draft_id, position) values ($1, $2, 'new', 'email', $3, 1)",
        [date, c.id, d.id],
      );
    }
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = createBot({
      token: "123:test",
      allowedChatIds: [ALLOWED],
      manager: {
        ctx: {
          db: db(),
          now: () => NOW,
          crm: { follow_up_days: 5, quiet_hours: { start: "21:00", end: "08:00" } },
          lead: { branches: {} },
        } as unknown as PipelineContext,
        llm: { structured: vi.fn(), toolStep: vi.fn() },
      },
      botInfo: BOT_INFO,
      outreach: { config: loadOutreachConfig(), contact: { whatsapp: null, phone: null } },
      mail: { mailbox: box, config: { ...mail, max_per_day: 50 } },
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload });
      return Promise.resolve({
        ok: true,
        result: method.startsWith("send")
          ? { message_id: calls.length, date: 0, chat: { id: ALLOWED, type: "private" } }
          : true,
      } as never);
    });
    await bot.sendMorning(date, []);
    const header = calls.find((c) => c.method === "sendMessage")!.payload;
    const headerButtons = (
      header.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }
    ).inline_keyboard.flat();
    expect(headerButtons.map((x) => x.text)).toContain("📤 Alle 2 Mails senden");
    await bot.handleUpdate(callbackUpdate("pl:a"));
    expect(box.sent).toHaveLength(0); // erst die Rückfrage
    expect(String(calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text)).toContain(
      "Wirklich alle 2 Mails",
    );
    await bot.handleUpdate(callbackUpdate("pl:A"));
    expect(box.sent).toHaveLength(2);
    expect((await planItems(db(), date)).every((i) => i.status === "done")).toBe(true);
  });

  it("Nachtsuche: nächste offene Kombination, eine je Nacht, nie zwei gleichzeitig", async () => {
    const send = vi.fn(() => Promise.resolve("job"));
    let now = new Date("2026-10-05T18:00:00Z"); // 20:00 Berlin, noch nicht dran
    const base = loadAutopilotConfig();
    const ctx = {
      db: db(),
      boss: { send },
      now: () => now,
      loadRegion,
      research: { branches: loadBranches(), config: loadResearchConfig() },
      notifier: {},
      autopilot: {
        config: {
          ...base,
          suche: {
            aktiv: true,
            ab: "22:00",
            pro_nacht: 1,
            regionen: ["rosenheim"],
            branchen: ["physiotherapie", "fahrrad"],
          },
        },
        planDeps: () => ({}),
      },
    } as unknown as PipelineContext;
    expect(await searchTick(ctx)).toBeNull();
    now = new Date("2026-10-05T20:30:00Z"); // 22:30
    expect(await searchTick(ctx)).toMatchObject({ regionKey: "rosenheim", branchKey: "physiotherapie" });
    expect(send).toHaveBeenCalledTimes(1);
    const { rows } = await db().query<{ requested_by: string; query: { complete: boolean } }>(
      "select requested_by, query from search_runs order by created_at desc limit 1",
    );
    expect(rows[0]).toMatchObject({ requested_by: "autopilot", query: { complete: true } });
    // Läuft noch → keine zweite; auch nach Ende nicht, weil pro_nacht = 1.
    expect(await searchTick(ctx)).toBeNull();
    await db().query("update search_runs set status = 'COMPLETED' where requested_by = 'autopilot'");
    now = new Date("2026-10-06T01:00:00Z"); // 03:00, gleiche Nacht
    expect(await searchTick(ctx)).toBeNull();
    expect(nightOf(new Date("2026-10-06T01:00:00Z"), "22:00")).toBe("2026-10-05");
    expect(nightOf(new Date("2026-10-06T10:00:00Z"), "22:00")).toBeNull();
    // Bericht fürs Morgen-Paket
    // Suchläufe tragen die echte Erstellungszeit, daher hier die echte Uhr.
    const report = await nightReport({ ...ctx, now: () => new Date() });
    expect(report[0]).toContain("Landkreis Rosenheim");
  });
  it("Ein fehlerhafter Lead wirft den Plan nicht um", async () => {
    await db().query("update companies set status = 'LOST'");
    await db().query("delete from outreach_plan");
    const bad = await lead({ score: 79 });
    const good = await lead({ score: 70 });
    const structured = vi.fn((req: { companyId?: string }) =>
      req.companyId === bad.id
        ? Promise.reject(new Error("Modell überlastet"))
        : Promise.resolve({
            output: { absatz: "ich heiße Christian und mache Online-Auftritte zeitgemäß." },
            agentRunId: "r",
            costUsd: 0,
            model: "m",
          }),
    );
    const llm = { structured } as unknown as LlmGateway;
    const tmp = mkdtempSync(join(tmpdir(), "avelio-plan2-"));
    const result = await buildDailyPlan({
      db: db(),
      now: () => NOW,
      config: { ...config({ start: 5 }), briefe: { pro_tag: 0, ab_score: 80, nachfassen_nach_tagen: 7 } },
      letter: {
        db: db(),
        llm,
        outreach: loadOutreachConfig(),
        branches: {},
        now: () => NOW,
        contact: { whatsapp: null, phone: null },
        render: () => Promise.resolve({ pdf: Buffer.from(""), png: Buffer.from("") }),
        desktopScreenPx: 900,
      },
      prototype: null,
      mx: () => Promise.resolve(true),
      lettersDir: tmp,
    });
    expect(result.emails).toBe(1);
    expect(result.skipped).toEqual([{ name: bad.name, reason: "Fehler: Modell überlastet" }]);
    expect((await planItems(db(), "2026-10-05")).map((i) => i.company_id)).toEqual([good.id]);
  });

  it("Nachtsuche überspringt eine Kombination nach zwei Fehlschlägen", async () => {
    await db().query("delete from search_runs");
    for (let i = 0; i < 2; i++)
      await db().query(
        `insert into search_runs (requested_by, query, target_count, status) values ('autopilot', $1, 1, 'FAILED')`,
        [JSON.stringify({ term: "Physiotherapie", region: "rosenheim", complete: true })],
      );
    const ctx = {
      db: db(),
      now: () => NOW,
      loadRegion,
      research: { branches: loadBranches(), config: loadResearchConfig() },
    } as unknown as PipelineContext;
    expect(await pickNextSearch(ctx, ["rosenheim"], ["physiotherapie", "fahrrad"])).toMatchObject({
      branchKey: "fahrrad",
    });
  });
});
