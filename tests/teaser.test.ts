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
import { pickProbeLead, pickProbeLeads, runProbe } from "../src/outreach/probe.js";
import { sendDraft } from "../src/outreach/send.js";
import {
  buildTeaser,
  monogram,
  PHYSIO_PHOTOS,
  physioAssetDir,
  renderPhysioTeaser,
  renderTeaserMockup,
  teaserQuote,
  teaserServices,
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

  it("Geräte-Bild: Laptop und Smartphone mit derselben Seite, Name escaped, kein Skript", () => {
    const html = renderTeaserMockup(data({ name: "Physio <b>Test</b>" }), assets);
    expect(html.match(/<iframe srcdoc="/g)).toHaveLength(2);
    expect(html).toContain("Physio &amp;lt;b&amp;gt;Test&amp;lt;/b&amp;gt;");
    expect(html).toContain("width:390px;height:844px");
    expect(html).not.toContain("<script");
  });

  it("Stil rund: ovales Foto, Bewertung als Karte, Leistungs-Kacheln, auch als Geräte-Bild", () => {
    const rund = renderPhysioTeaser(data({ name: "Physio <b>Test</b>" }), assets, "rund");
    expect(rund).toContain("Physio &lt;b&gt;Test&lt;/b&gt;");
    expect(rund).toContain('class="oval"');
    expect(rund).toContain("4,9 · 63 Bewertungen");
    expect(rund.match(/class="tile"/g)).toHaveLength(4);
    expect(rund).not.toContain("<script");
    expect(renderPhysioTeaser(data({ rating: 4 }), assets, "rund")).not.toContain("Bewertungen");
    const mock = renderTeaserMockup(data(), assets, "rund");
    expect(mock.match(/<iframe srcdoc="/g)).toHaveLength(2);
    expect(mock).toContain("class=&quot;oval&quot;");
    // Mischung: am Rechner rund, am Handy Foto über die ganze Breite und die vier Kacheln
    const mix = renderTeaserMockup(data(), assets, "mix");
    expect(mix).toContain("class=&quot;oval&quot;");
    expect(mix).toContain("class=&quot;wave&quot;");
    expect(mix.match(/class=&quot;tile&quot;/g)).toHaveLength(8);
  });

  it("Geräte-Bild: am Handy ihre Leistungen und Kennzahlen, die echte Bewertung als Abschnitt (keine schwebende Karte)", () => {
    const withQuote = renderTeaserMockup(
      data({
        services: ["Krankengymnastik am Gerät", "Kiefergelenksbehandlung (CMD)", "x", "Hausbesuche"],
        quote: { text: "Super <b>Team</b>, sehr empfehlenswert und immer pünktlich.", author: "Anna M." },
        hours: ["Mo–Fr: 07:30–19:00 Uhr"],
      }),
      assets,
      "vital",
    );
    expect(withQuote).toContain("Wobei wir Ihnen helfen");
    expect(withQuote).toContain("Kiefergelenksbehandlung"); // Klammerzusatz weg
    expect(withQuote).toContain("Mo–Fr"); // Kennzahl aus den Öffnungszeiten
    // Bewertung steht in der Handy-Seite (srcdoc, doppelt escaped), nicht als Karte über dem Bild
    expect(withQuote).toContain("Super &amp;lt;b&amp;gt;Team&amp;lt;/b&amp;gt;, sehr empfehlenswert");
    expect(withQuote).toContain("Anna M. auf Google");
    expect(withQuote).not.toContain('class="quote"');
    expect(withQuote).not.toContain("<script");
    // Ohne Bewertungstext (keine extra Google-Abfrage): Note und Anzahl, beides echt; ohne gute Note die Öffnungszeiten
    const noQuote = renderTeaserMockup(data(), assets, "vital");
    expect(noQuote).toContain("4,9 von 5 Sternen");
    expect(noQuote).toContain("63 Bewertungen auf Google");
    expect(renderTeaserMockup(data({ rating: 4 }), assets, "vital")).toContain("Öffnungszeiten");
    expect(teaserServices(undefined)).toEqual([
      "Krankengymnastik",
      "Manuelle Therapie",
      "Lymphdrainage",
      "Sportphysiotherapie",
    ]);
    expect(
      teaserServices(["manuelle Therapie (MT)", "Wirbelsäulengymnastik nach Dorn und Breuß in Kombination"]),
    ).toEqual(["Manuelle Therapie", "Krankengymnastik", "Lymphdrainage", "Sportphysiotherapie"]);
    expect(teaserQuote("a".repeat(70) + ". " + "b ".repeat(80), 120)).toBe(`${"a".repeat(70)}.`);
  });

  it("Stil elementa: Farbflächen, Google-Zeile nur bei guter Note, Name escaped, auch als Geräte-Bild", () => {
    const html = renderPhysioTeaser(data({ name: "Physio <b>Test</b>" }), assets, "elementa");
    expect(html).toContain("Physio &lt;b&gt;Test&lt;/b&gt;");
    expect(html).toContain('class="gline"');
    expect(html).toContain("Jetzt Termin vereinbaren");
    expect(html).not.toContain("<script");
    expect(renderPhysioTeaser(data({ rating: 4 }), assets, "elementa")).not.toContain('class="gline"');
    const mock = renderTeaserMockup(data(), assets, "elementa");
    expect(mock.match(/<iframe srcdoc="/g)).toHaveLength(2);
    expect(mock).toContain("Wobei wir Ihnen helfen");
  });

  it("Farbwelt aqua: Off-White, helle Flächen, dunkle Schrift auf Türkis", () => {
    const hero = renderPhysioTeaser(data({ palette: "aqua" }), assets, "elementa");
    expect(hero).toContain(".big.y{background:#41d6c3;color:#23343a}");
    expect(hero).toContain('fill="#f7f5ef"');
    const mock = renderTeaserMockup(data({ palette: "aqua" }), assets, "elementa");
    expect(mock).toContain("background:#e8f4f2");
    expect(mock).toContain("background:#f7f5ef");
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
    expect(mail.body).toMatch(
      /\nP\.S\. Falls sich bei Ihnen jemand anderes um die Website kümmert, leiten Sie das gern weiter\.\n\nSie möchten keine weiteren Nachrichten von mir\? Eine kurze Antwort genügt, dann melde ich mich nicht mehr\.$/,
    );
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
    // Mehrere: verschiedene Praxen, nie mehr als vorhanden
    const { company: c2 } = await upsertCompany(db(), { name: "Physio Probe 2", placeId: "probe-2" });
    await db().query(
      "update companies set branch_key = 'physiotherapie', status = 'QUALIFIED' where id = $1",
      [c2.id],
    );
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', '[]', '{}', '{}', 's')`,
      [c2.id],
    );
    const several = await pickProbeLeads(db(), ["physiotherapie"], 3);
    expect(new Set(several.map((x) => x.id))).toEqual(new Set([c.id, c2.id]));
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
