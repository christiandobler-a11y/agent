import { describe, expect, it } from "vitest";
import { dailyNewCount, loadAutopilotConfig } from "../src/autopilot/plan.js";
import { upsertCompany } from "../src/db/companies.js";
import { loadMailConfig, type Mailbox, type OutgoingMail } from "../src/outreach/mail.js";
import {
  imapReason,
  recentSeedProblem,
  seedBoxesFromEnv,
  seedReport,
  seedTick,
  type Placement,
  type SeedBox,
} from "../src/outreach/seed.js";
import { outreachStats, statsText, statsTick } from "../src/outreach/stats.js";
import { describeDb, useTestDb } from "./helpers/db.js";

describe("Kontrollmail und Zahlen (rein)", () => {
  it("Bericht: alles im Posteingang kurz, sonst Warnung", () => {
    expect(seedReport({ Gmail: "inbox", GMX: "inbox" })).toBe(
      "📬 Kontrollmail von heute: Gmail: Posteingang ✅, GMX: Posteingang ✅",
    );
    const bad = seedReport({ Gmail: "spam", GMX: "inbox" });
    expect(bad).toContain("Gmail: SPAM ⚠️");
    expect(bad).toContain("bremse ab morgen");
  });

  it("Postfächer aus der Umgebung: Anbieter aus der Adresse, unvollständige übersprungen", () => {
    const boxes = seedBoxesFromEnv(
      {
        SEED_1_ADDRESS: "test@gmail.com",
        SEED_1_PASSWORD: "pw",
        SEED_2_ADDRESS: "test@gmx.de",
        SEED_3_ADDRESS: "ohne@passwort.de",
      },
      loadMailConfig(),
    );
    expect(boxes.map((b) => [b.label, b.address])).toEqual([["Gmail", "test@gmail.com"]]);
  });

  it("IMAP-Fehler verständlich", () => {
    expect(
      imapReason({
        message: "Command failed",
        authenticationFailed: true,
        responseText: "Invalid credentials",
      }),
    ).toBe("Login abgelehnt (Invalid credentials): App-Passwort und IMAP-Freigabe prüfen");
    expect(imapReason({ message: "Command failed", responseText: "IMAP access disabled" })).toBe(
      "IMAP access disabled",
    );
  });

  it("Spam bremst: eine Stufe zurück, auf der ersten Stufe halbiert", () => {
    const c = loadAutopilotConfig();
    const monday = new Date("2026-10-05T06:00:00Z");
    expect(dailyNewCount(c, monday, null, undefined, true)).toEqual({ count: 10, braked: true });
    expect(dailyNewCount(c, monday, new Date("2026-09-01T06:00:00Z"), undefined, true).count).toBe(30);
  });

  it("Zahlen als Text", () => {
    const text = statsText({
      sent: 100,
      followUps: 40,
      bounced: 2,
      replied: 5,
      interested: 2,
      won: 1,
      costUsd: 13,
    });
    expect(text).toContain("📧 Neue Mails: 100 (+ 40 Nachfass-Mails)");
    expect(text).toContain("💬 Antworten: 5 (5,0 %)");
    expect(text).toContain("🏆 Aufträge: 1");
    expect(text).toContain("je Mail");
  });
});

describeDb("Kontrollmail und Zahlen mit Datenbank", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-05T07:00:00Z"); // Montag, 09:00 Berlin

  const sent: OutgoingMail[] = [];
  const mailbox: Mailbox = {
    address: "christian@avelio.digital",
    send: (m) => {
      sent.push(m);
      return Promise.resolve({ messageId: `<seed${sent.length}@avelio.digital>` });
    },
    fetchSince: () => Promise.resolve({ uidValidity: "1", maxUid: 0, mails: [] }),
  };
  const box = (label: string, place: () => Placement): SeedBox => ({
    label,
    address: `${label.toLowerCase()}@test.de`,
    locate: () => Promise.resolve(place()),
  });

  async function sentDraft(name: string, at: Date, extra: Record<string, unknown> = {}) {
    const { company } = await upsertCompany(db(), { name, placeId: `mon-${name}` });
    await db().query(
      `insert into interactions (company_id, type, channel, body, meta, created_by)
       values ($1, 'draft', 'email', 'Grüß Sie,\n\nText', $2, 'test')`,
      [
        company.id,
        JSON.stringify({ subject: `Betreff ${name}`, to: "x@y.de", sent_at: at.toISOString(), ...extra }),
      ],
    );
    return company;
  }

  it("schickt die Kopie der ersten Mail, wartet, meldet Posteingang und Spam, bremst danach", async () => {
    let gmail: Placement = null;
    const boxes = [box("Gmail", () => gmail), box("GMX", () => "inbox")];
    const notes: string[] = [];
    const tick = (at: Date) =>
      seedTick({
        db: db(),
        mailbox,
        boxes,
        now: () => at,
        date: "2026-10-05",
        notify: (t) => Promise.resolve(void notes.push(t)),
      });
    expect(await tick(NOW)).toBe("idle"); // heute noch nichts gesendet
    await sentDraft("Physio Seed", new Date("2026-10-05T06:10:00Z"));
    expect(await tick(NOW)).toBe("sent");
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ["gmail@test.de", "Betreff Physio Seed"],
      ["gmx@test.de", "Betreff Physio Seed"],
    ]);
    expect(await tick(new Date(NOW.getTime() + 5 * 60_000))).toBe("waiting"); // zu früh
    expect(await tick(new Date(NOW.getTime() + 20 * 60_000))).toBe("waiting"); // Gmail noch nicht da
    gmail = "spam";
    expect(await tick(new Date(NOW.getTime() + 30 * 60_000))).toBe("reported");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Gmail: SPAM ⚠️");
    expect(await tick(new Date(NOW.getTime() + 40 * 60_000))).toBe("idle"); // einmal am Tag
    expect(sent).toHaveLength(2);
    expect(await recentSeedProblem(db(), new Date("2026-10-06T04:00:00Z"))).toBe(true);
    expect(await recentSeedProblem(db(), new Date("2026-10-12T04:00:00Z"))).toBe(false);
  });

  it("Zahlen und Meilensteine je einmal, Warnung ohne Antworten", async () => {
    await db().query("delete from interactions");
    for (let i = 0; i < 60; i++) await sentDraft(`Lead ${i}`, NOW);
    await sentDraft("Nachfass", NOW, { follow_up: true });
    const s = await outreachStats(db());
    expect(s).toMatchObject({ sent: 60, followUps: 1, replied: 0 });
    const notes: string[] = [];
    const out = await statsTick(db(), (t) => Promise.resolve(void notes.push(t)));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("🎯 50 Mails raus");
    expect(out[1]).toContain("noch keine einzige Antwort");
    expect(await statsTick(db())).toEqual([]);
  });
});
