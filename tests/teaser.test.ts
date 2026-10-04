import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { upsertCompany, type Company } from "../src/db/companies.js";
import { insertDraft } from "../src/db/drafts.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { draftEmail } from "../src/outreach/draft.js";
import { loadMailConfig, textToHtml, type Mailbox, type OutgoingMail } from "../src/outreach/mail.js";
import { pickProbeLead, runProbe } from "../src/outreach/probe.js";
import { sendDraft } from "../src/outreach/send.js";
import {
  buildTeaser,
  monogram,
  PHYSIO_PHOTOS,
  physioAssetDir,
  renderPhysioTeaser,
  teaserName,
  teaserPath,
  usesTeaser,
  type TeaserData,
} from "../src/prototype/teaser.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const data = (over: Partial<TeaserData> = {}): TeaserData => ({
  name: "PHYSIOteam Rosenheim",
  city: "Rosenheim",
  street: "Klepperstraße 9",
  phone: "08031 9080982",
  rating: 4.9,
  reviewCount: 63,
  seed: "c1",
  ...over,
});

const assets = { font: (k: string) => `font/${k}`, photo: (f: string) => `photo/${f}` };

describe("Vorschau-Bild Physio (rein)", () => {
  it("Anzeigename: ohne Rechtsform und Zusätze, Gattung und Ort allein zählen nicht", () => {
    expect(teaserName("PhysioErgo Hitzl & Schalk GbR")).toEqual({
      kicker: null,
      title: "PhysioErgo Hitzl & Schalk",
    });
    expect(teaserName("MEDIANA | Physiotherapie & Wellness - Rosenheim").title).toBe("MEDIANA");
    expect(teaserName("Physiotherapie Rosenheim - Salzmann am Salzstadel", "Rosenheim").title).toBe(
      "Salzmann am Salzstadel",
    );
    expect(teaserName("Praxis für Physiotherapie Pickelmann Mike")).toEqual({
      kicker: "Praxis für Physiotherapie",
      title: "Pickelmann Mike",
    });
    expect(teaserName("Physio Salin").title).toBe("Physio Salin");
    expect(monogram("PhysioErgo Hitzl & Schalk")).toBe("PH");
    expect(monogram("körpermanufaktur")).toBe("K");
  });

  it("Seite: Name, Ort und Telefon gesetzt, Bewertung nur wenn gut, alles escaped, kein Skript", () => {
    const html = renderPhysioTeaser(data({ name: "Physio <b>Test</b>" }), assets);
    expect(html).toContain("Physio &lt;b&gt;Test&lt;/b&gt;");
    expect(html).toContain("Physiotherapie Rosenheim");
    expect(html).toContain("08031 9080982");
    expect(html).toContain("<b>4,9</b> aus <b>63</b> Bewertungen");
    expect(html).not.toContain("<script");
    const weak = renderPhysioTeaser(data({ rating: 3.9 }), assets);
    expect(weak).not.toContain("Bewertungen");
    expect(weak).toContain("Klepperstraße 9");
    const vital = renderPhysioTeaser(data(), assets, "vital");
    expect(vital).toContain("4,9 · 63 Google-Bewertungen");
    expect(vital).toContain("Telefon: 08031 9080982");
    expect(vital).not.toContain("<script");
    expect(renderPhysioTeaser(data({ rating: 4 }), assets, "vital")).not.toContain("Google-Bewertungen");
    // Gleiche Firma, gleiches Foto; das Foto stammt aus der Auswahl.
    expect(renderPhysioTeaser(data(), assets)).toBe(renderPhysioTeaser(data(), assets));
    expect(PHYSIO_PHOTOS.some((p) => html.includes(`photo/${p.file}`))).toBe(true);
  });

  it("nur für die eingestellten Branchen", () => {
    const t = { branches: ["physiotherapie"] };
    expect(usesTeaser(t, { branch_key: "physiotherapie" } as never)).toBe(true);
    expect(usesTeaser(t, { branch_key: "fahrrad" } as never)).toBe(false);
    expect(usesTeaser(null, { branch_key: "physiotherapie" } as never)).toBe(false);
  });

  it("Mail als HTML: Bild unter seinem Satz, Links klickbar, Text escaped", () => {
    const text =
      "Hallo Frau Test,\n\nIch hab skizziert:\n\nMehr in 5 Minuten <3\nhttps://wa.me/49151?text=Hallo.\n\nGrüße";
    const html = textToHtml(text, { cid: "x@y", alt: "Entwurf", after: "Ich hab skizziert:" });
    expect(html.indexOf('src="cid:x@y"')).toBeGreaterThan(html.indexOf("Ich hab skizziert:"));
    expect(html.indexOf('src="cid:x@y"')).toBeLessThan(html.indexOf("Mehr in 5 Minuten"));
    expect(html).toContain("&lt;3<br>");
    expect(html).toContain('<a href="https://wa.me/49151?text=Hallo">');
  });

  it("die Fotos liegen im Repo", () => {
    for (const p of PHYSIO_PHOTOS) expect(existsSync(join(physioAssetDir(), p.file))).toBe(true);
  });
});

describeDb("Vorschau-Bild in Mail und Versand", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-05T07:00:00Z");

  it("Entwurf mit Bild-Satz, Versand als HTML mit eingebettetem Bild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avelio-teaser-"));
    const { company: created } = await upsertCompany(db(), {
      name: "Physio Bild",
      placeId: "teaser-1",
      city: "Weilheim",
    });
    const { rows: updated } = await db().query<Company>(
      "update companies set branch_key = 'physiotherapie' where id = $1 returning *",
      [created.id],
    );
    const c = updated[0]!;
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', '[]', '{}', '{}', 's')`,
      [c.id],
    );
    // Bild "bauen" ohne Chromium
    const path = await buildTeaser(dir, c.id, data({ name: c.name }), async (html, out) => {
      expect(html).toContain("Physio Bild");
      mkdirSync(dir, { recursive: true });
      await sharp({ create: { width: 160, height: 100, channels: 3, background: "#1f4d47" } })
        .jpeg()
        .toFile(out);
    });
    expect(path).toBe(teaserPath(dir, c.id));

    const llm = {
      structured: () =>
        Promise.resolve({
          output: { absatz: "mir ist Ihre Website aufgefallen." },
          agentRunId: "r",
          costUsd: 0,
          model: "m",
        }),
    } as unknown as LlmGateway;
    const mail = await draftEmail(
      {
        db: db(),
        llm,
        outreach: loadOutreachConfig(),
        branches: {},
        now: () => NOW,
        contact: { whatsapp: "+49 151 1", phone: null },
        teaserDir: dir,
      },
      c,
      "test",
    );
    if ("kind" in mail) throw new Error("kein Entwurf");
    const sentence = loadOutreachConfig().kontaktweg.bild_satz;
    expect(mail.body).toContain(sentence);
    expect(mail.body).toMatch(/unverbindlich/);
    expect(mail.body).not.toMatch(/kostenlos|gratis/i);

    // Adresse setzen und senden
    await db().query(`update interactions set meta = meta || '{"to":"info@physio-bild.de"}' where id = $1`, [
      mail.draftId,
    ]);
    const sent: OutgoingMail[] = [];
    const box: Mailbox = {
      address: "christian@example.de",
      send: (m) => {
        sent.push(m);
        return Promise.resolve({ messageId: "<teaser1@example.de>" });
      },
      fetchSince: () => Promise.resolve({ uidValidity: "1", maxUid: 0, mails: [] }),
    };
    const r = await sendDraft(
      { db: db(), mailbox: box, mail: loadMailConfig(), now: () => NOW, followUpDays: 5 },
      mail.draftId,
      "test",
    );
    expect(r.kind).toBe("sent");
    const att = sent[0]!.attachments!;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({
      filename: "startseite-entwurf.jpg",
      contentType: "image/jpeg",
      contentDisposition: "inline",
    });
    expect(att[0]!.cid).toMatch(/^startseite-[0-9a-f]{8}@avelio\.digital$/);
    expect(sent[0]!.html).toContain(`src="cid:${att[0]!.cid}"`);
    expect(sent[0]!.html).toContain('height="375"');
    // Für iPhone-Mail verkleinert
    expect((await sharp(att[0]!.content).metadata()).width).toBeLessThanOrEqual(1200);
    // Ohne Namen: Praxisteam mit Bitte um Weiterleitung
    expect(mail.body.startsWith("Liebes Praxisteam,")).toBe(true);
    expect(mail.body).toContain("an die Praxisleitung weiter");
    expect(sent[0]!.text).toBe(mail.body);

    // Ohne Bild bleibt es eine reine Text-Mail.
    const plain = await insertDraft(db(), c.id, {
      channel: "email",
      body: "Hallo",
      meta: { subject: "S", to: "info@physio-bild.de", follow_up: true },
      by: "test",
      now: NOW,
    });
    await sendDraft(
      { db: db(), mailbox: box, mail: loadMailConfig(), now: () => NOW, followUpDays: 5 },
      plain.id,
      "test",
    );
    expect(sent[1]!.html).toBeUndefined();
  });
});

describeDb("Probelauf", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-05T07:00:00Z");

  it("schickt die Mail an Christian selbst, ändert nichts am Lead und hinterlässt keinen Entwurf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avelio-probe-"));
    const { company: c } = await upsertCompany(db(), {
      name: "Physio Probe",
      placeId: "probe-1",
      city: "Murnau",
    });
    await db().query(
      "update companies set branch_key = 'physiotherapie', status = 'QUALIFIED' where id = $1",
      [c.id],
    );
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', '[]', '{}', '{}', 's')`,
      [c.id],
    );
    const picked = await pickProbeLead(db(), ["physiotherapie"]);
    expect(picked?.id).toBe(c.id);
    const sent: OutgoingMail[] = [];
    const box: Mailbox = {
      address: "christian@example.de",
      send: (m) => {
        sent.push(m);
        return Promise.resolve({ messageId: "<p1@example.de>" });
      },
      fetchSince: () => Promise.resolve({ uidValidity: "1", maxUid: 0, mails: [] }),
    };
    const llm = {
      structured: () =>
        Promise.resolve({
          output: { absatz: "mir ist Ihre Website aufgefallen." },
          agentRunId: "r",
          costUsd: 0.01,
          model: "m",
        }),
    } as unknown as LlmGateway;
    const r = await runProbe(
      {
        db: db(),
        outreach: {
          db: db(),
          llm,
          outreach: loadOutreachConfig(),
          branches: {},
          now: () => NOW,
          contact: { whatsapp: null, phone: null },
          teaserDir: dir,
        },
        mailbox: box,
        teaser: {
          dir,
          branches: ["physiotherapie"],
          shoot: async (_html, out) => {
            await sharp({ create: { width: 80, height: 50, channels: 3, background: "#1f5f68" } })
              .jpeg()
              .toFile(out);
          },
        },
      },
      picked!,
      "test",
    );
    if ("kind" in r) throw new Error("kein Audit");
    expect(r.sentTo).toBe("christian@example.de");
    expect(sent[0]!.to).toBe("christian@example.de");
    expect(sent[0]!.subject).toMatch(/^\[Probe\] /);
    expect(sent[0]!.html).toMatch(/cid:startseite-[0-9a-f]{8}@avelio\.digital/);
    const { rows } = await db().query<{ n: number; status: string }>(
      `select (select count(*)::int from interactions where company_id = $1) as n,
              (select status from companies where id = $1) as status`,
      [c.id],
    );
    expect(rows[0]).toEqual({ n: 0, status: "QUALIFIED" });
  });
});
