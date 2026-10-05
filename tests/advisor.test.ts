import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it, vi } from "vitest";
import { advisorTick, berlinWeekday, FIND_TRIGGER } from "../src/advisor/job.js";
import { clipFind, findSomething } from "../src/advisor/finds.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import {
  advisorDue,
  advisorOutputSchema,
  findDue,
  criticOutputSchema,
  decideSuggestion,
  keepSuggestions,
  knownSources,
  loadAdvisorConfig,
  runAdvisor,
  suggestionsByStatus,
  type AdvisorReport,
  type Draft,
} from "../src/advisor/run.js";
import { buildSnapshot, funnel, funnelBy, replyStages, type MailRow } from "../src/advisor/snapshot.js";
import { upsertCompany } from "../src/db/companies.js";
import { loadModelsConfig, loadPrompt } from "../src/llm/config.js";
import { NO_BUDGET } from "../src/llm/budget.js";
import { createLlmGateway, type LlmGateway } from "../src/llm/gateway.js";
import { combineNotifiers, logNotifier, type Notifier } from "../src/queue/notifier.js";
import {
  advisorCallback,
  advisorHeader,
  decisionKeyboard,
  parseAdvisorCallback,
  suggestionCard,
  suggestionList,
} from "../src/telegram/advisor.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const draft = (over: Partial<Draft> = {}): Draft => ({
  bereich: "prozess",
  titel: "Nachfass-Abstand verlängern",
  beobachtung: "Kaum Antworten auf Nachfass 2",
  beleg: "1 von 80",
  vorschlag: "Abstand von 4 auf 6 Tage",
  wirkung: "weniger genervte Praxen",
  aufwand: "klein",
  risiko: "gering",
  sicherheit: "mittel",
  quellen: [],
  ...over,
});

const row = (over: Partial<MailRow> = {}): MailRow => ({
  sentAt: new Date("2026-10-05T08:00:00Z"),
  region: "weilheim-schongau",
  branch: "physiotherapie",
  prompt: "v8",
  photo: "website",
  weekday: 1,
  hour: 10,
  replied: false,
  followupsBeforeReply: null,
  autoReply: false,
  bounced: false,
  interested: false,
  won: false,
  ...over,
});

describe("Berater-Runde (rein)", () => {
  it("Gegenprüfung: nur behaltene Entwürfe, mit neuer Sicherheit und Einwand, die sichersten zuerst", () => {
    const drafts = [
      draft({ titel: "A" }),
      draft({ titel: "B" }),
      draft({ titel: "C" }),
      draft({ titel: "D" }),
    ];
    const kept = keepSuggestions(
      drafts,
      {
        fazit: "ok",
        bewertungen: [
          { nr: 1, urteil: "behalten", sicherheit: "niedrig", einwand: "dünn" },
          { nr: 2, urteil: "verwerfen", sicherheit: "niedrig", einwand: "Zufall" },
          { nr: 3, urteil: "behalten", sicherheit: "hoch", einwand: "trägt" },
          // D ohne Urteil: gilt als verworfen
        ],
      },
      5,
    );
    expect(kept.map((k) => [k.titel, k.sicherheit, k.einwand])).toEqual([
      ["C", "hoch", "trägt"],
      ["A", "niedrig", "dünn"],
    ]);
    expect(keepSuggestions(drafts, { fazit: "", bewertungen: [] }, 5)).toEqual([]);
    const all = drafts.map((_, i) => ({
      nr: i + 1,
      urteil: "behalten" as const,
      sicherheit: "mittel" as const,
      einwand: "",
    }));
    expect(keepSuggestions(drafts, { fazit: "", bewertungen: all }, 2)).toHaveLength(2);
  });

  it("Quellen: nur URLs, die die Recherche wirklich gefunden hat", () => {
    const found = new Set(["https://a.de/x", "https://b.de/y"]);
    expect(knownSources(["https://a.de/x", "https://erfunden.de", "https://a.de/x"], found)).toEqual([
      "https://a.de/x",
    ]);
  });

  it("Wochen-Runde: am eingestellten Tag ab der Uhrzeit, nicht wenn ausgeschaltet", () => {
    const c = { aktiv: true, tag: "sonntag" as const, ab: "18:00", max_vorschlaege: 5, websuchen: 8 };
    expect(advisorDue(c, 0, "18:05")).toBe(true);
    expect(advisorDue(c, 0, "17:59")).toBe(false);
    expect(advisorDue(c, 1, "18:05")).toBe(false);
    expect(advisorDue({ ...c, aktiv: false }, 0, "18:05")).toBe(false);
    // 2026-10-04 war ein Sonntag; 23:30 UTC ist in Deutschland schon Montag.
    expect(berlinWeekday(new Date("2026-10-04T12:00:00Z"))).toBe(0);
    expect(berlinWeekday(new Date("2026-10-04T23:30:00Z"))).toBe(1);
  });

  it("Fundstück: an den eingestellten Tagen ab der Uhrzeit, Text gekürzt", () => {
    const c = {
      aktiv: true,
      tag: "sonntag" as const,
      ab: "18:00",
      max_vorschlaege: 5,
      websuchen: 8,
      zwischendurch: { tage: ["dienstag" as const, "donnerstag" as const], ab: "16:30", websuchen: 3 },
    };
    expect(findDue(c, 2, "16:30")).toBe(true);
    expect(findDue(c, 2, "16:00")).toBe(false);
    expect(findDue(c, 3, "17:00")).toBe(false);
    const { zwischendurch: _, ...ohne } = c;
    expect(findDue(ohne, 2, "17:00")).toBe(false);
    expect(loadAdvisorConfig().zwischendurch?.tage).toEqual(["dienstag", "donnerstag"]);
    expect(clipFind("  kurz \n")).toBe("kurz");
    expect(clipFind("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    expect(loadPrompt("fundstueck", "v1")).toContain("Quelle");
  });

  it("Konfiguration, Prompts und Ausgabe-Schemas sind gültig", () => {
    expect(loadAdvisorConfig().tag).toBe("sonntag");
    const roles = loadModelsConfig().roles;
    for (const r of ["advisor_research", "advisor", "advisor_critic"]) expect(roles[r]).toBeDefined();
    expect(loadPrompt("advisor", "v1")).toContain("kritisch");
    expect(loadPrompt("advisor", "v2")).toContain('Website-Werkstatt (bereich "website")');
    expect(loadPrompt("advisor_research", "v2")).toContain("Websites bauen");
    expect(loadPrompt("advisor", "v3")).toContain("Anruf-Liste");
    expect(loadPrompt("advisor", "v3")).toContain("`fokus`");
    expect(loadPrompt("advisor_research", "v3")).toContain("§ 7 Abs. 2 Nr. 1 UWG");
    expect(loadPrompt("advisor_critic", "v1")).toContain("Gegenprüfer");
    expect(loadPrompt("advisor_research", "v1")).toContain("fremder Inhalt");
    expect(zodOutputFormat(advisorOutputSchema).type).toBe("json_schema");
    expect(zodOutputFormat(criticOutputSchema).type).toBe("json_schema");
  });

  it("Lagebild: Trichter je Gruppe und wann die Antworten kamen", () => {
    const rows = [
      row({ replied: true, followupsBeforeReply: 0, interested: true }),
      row({ replied: true, followupsBeforeReply: 1, photo: "stock" }),
      row({ bounced: true, photo: "stock" }),
      row({ photo: "stock" }),
    ];
    expect(funnel(rows)).toEqual({
      gesendet: 4,
      unzustellbar: 1,
      antworten: 2,
      interessiert: 1,
      gewonnen: 0,
      antwortquote: "50.0 %",
    });
    const byPhoto = funnelBy(rows, (r) => r.photo);
    expect(Object.keys(byPhoto)).toEqual(["stock", "website"]);
    expect(byPhoto.stock?.antworten).toBe(1);
    expect(replyStages(rows)).toEqual({ "auf Erstmail": 1, "nach Nachfass 1": 1 });
    expect(funnel([]).antwortquote).toBe("–");
  });
});

describe("Berater in Telegram", () => {
  const suggestion = {
    id: "11111111-2222-3333-4444-555555555555",
    area: "wachstum" as const,
    title: "Ergotherapie <testen>",
    observation: "Physio in Weilheim fast abgegrast",
    evidence: "18 von 22 Orten erledigt",
    proposal: "Ergotherapie in die Nachtsuche aufnehmen",
    impact: "ca. 40 neue Leads",
    effort: "klein" as const,
    risk: "andere Ansprache nötig",
    confidence: "mittel" as const,
    critique: "Erst 10 Mails testen",
    sources: ["https://quelle.de/a", "javascript:alert(1)", 'https://x.de/"><b>'],
    status: "offen",
  };

  it("Karte escaped alles, nimmt nur saubere https-Links und hat die Knöpfe", () => {
    const { text, keyboard } = suggestionCard(suggestion);
    expect(text).toContain("📈 Wachstum · Sicherheit: mittel · Aufwand: klein");
    expect(text).toContain("<b>Ergotherapie &lt;testen&gt;</b>");
    expect(text).toContain('<a href="https://quelle.de/a">1</a>');
    expect(text).not.toContain("javascript");
    expect(text).not.toContain("x.de");
    expect(keyboard.flat().map((b) => b.text)).toEqual(["👍 Umsetzen", "👎 Verwerfen", "💬 Später"]);
    expect(
      decisionKeyboard(suggestion.id, "umsetzen")
        .flat()
        .map((b) => b.text),
    ).toEqual(["✅ Ist umgesetzt"]);
    expect(decisionKeyboard(suggestion.id, "verworfen")).toEqual([]);
    expect(suggestionCard({ ...suggestion, area: "website" }).text).toMatch(/^🎨 Website/);
  });

  it("Knopf-Daten hin und zurück, unter 64 Bytes", () => {
    for (const s of ["umsetzen", "verworfen", "spaeter", "erledigt"] as const) {
      const data = advisorCallback(s, suggestion.id);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(parseAdvisorCallback(data)).toEqual({ status: s, id: suggestion.id });
    }
    expect(parseAdvisorCallback("av:x:123")).toBeNull();
  });

  it("Kopf und Übersicht", () => {
    const report: AdvisorReport = {
      id: "r",
      trigger: "woche",
      lage: "Läuft <gut>",
      rueckblick: null,
      fazit: "Zwei tragen",
      dropped: 3,
      costUsd: 0.5,
      searches: 6,
      suggestions: [suggestion],
    };
    const head = advisorHeader(report);
    expect(head).toContain("Berater-Runde der Woche");
    expect(head).toContain("Läuft &lt;gut&gt;");
    expect(head).toContain("1 Vorschlag folgt (3 hat der Gegenprüfer aussortiert)");
    expect(advisorHeader({ ...report, suggestions: [] })).toContain("kein Vorschlag");
    const list = suggestionList([
      { ...suggestion, status: "umsetzen" },
      { ...suggestion, id: "99999999-2222-3333-4444-555555555555", status: "spaeter" },
    ]);
    expect(list.text).toContain("👍 Umsetzen");
    expect(list.text).toContain("1. 📈 <b>Ergotherapie &lt;testen&gt;</b>");
    expect(list.keyboard.map((r) => r.map((b) => b.text))).toEqual([
      ["✅ 1. ist umgesetzt", "🗑 1. verwerfen"],
      ["👍 2. umsetzen", "🗑 2. verwerfen"],
    ]);
    expect(suggestionList([]).text).toContain("/berater");
  });

  it("combineNotifiers reicht den Bericht weiter", async () => {
    const advisorReport = vi.fn(() => Promise.resolve());
    const tg = { ...logNotifier, advisorReport } as Notifier;
    const combined = combineNotifiers(logNotifier, tg);
    expect("advisorReport" in combined).toBe(true);
    await combined.advisorReport?.({} as AdvisorReport);
    expect(advisorReport).toHaveBeenCalledOnce();
    expect("advisorReport" in combineNotifiers(logNotifier)).toBe(false);
  });
});

function message(
  content: Anthropic.ContentBlock[],
  over: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
    },
    ...over,
  } as Anthropic.Message;
}

const searchResult = (url: string) =>
  ({
    type: "web_search_tool_result",
    tool_use_id: "t",
    content: [
      { type: "web_search_result", url, title: `Titel ${url}`, encrypted_content: "", page_age: null },
    ],
  }) as unknown as Anthropic.ContentBlock;

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;

describeDb("Berater-Runde", () => {
  const db = useTestDb();
  const models = {
    roles: { advisor_research: { model: "claude-sonnet-5-5", max_tokens: 1000, cache_system: false } },
    pricing: { "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 } },
    tools: { web_search_per_1000_usd: 10 },
    budget: { daily_usd: 5, monthly_usd: 50 },
  };

  it("Recherche: setzt pausierte Runden fort, sammelt Quellen und rechnet Suchen mit", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message([searchResult("https://a.de")], { stop_reason: "pause_turn" }))
      .mockResolvedValueOnce(message([searchResult("https://b.de"), text("Notizen")]));
    const llm = createLlmGateway({ db: db(), messages: { create }, models, budget: NO_BUDGET });
    const r = await llm.research({
      role: "advisor_research",
      promptVersion: "v1",
      system: "S",
      input: "Lage",
      maxSearches: 8,
    });
    expect(r.text).toBe("Notizen");
    expect(r.searches).toBe(4);
    expect(r.sources.map((s) => s.url)).toEqual(["https://a.de", "https://b.de"]);
    // je Runde 1000 × 2 $/Mio + 100 × 10 $/Mio = 0,003 $ und 2 Suchen × 0,01 $
    expect(r.costUsd).toBeCloseTo(2 * (0.003 + 0.02));
    const first = (create.mock.calls[0] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(first.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 8 }]);
    const second = (create.mock.calls[1] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(second.tools?.[0]).toMatchObject({ max_uses: 6 });
    const { rows } = await db().query<{ n: number }>(
      "select count(*)::int as n from agent_runs where role = 'advisor_research' and status = 'OK'",
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("Runde: Lagebild, Entwürfe, Gegenprüfung, nur Behaltenes wird gespeichert; Entscheidung per Knopf", async () => {
    const { company } = await upsertCompany(db(), {
      name: "Physio Test",
      placeId: "adv-1",
      city: "Weilheim",
    });
    await db().query(
      "update companies set branch_key = 'physiotherapie', region = 'weilheim-schongau' where id = $1",
      [company.id],
    );
    await db().query(
      `insert into interactions (company_id, type, channel, body, meta, created_by, created_at)
       values ($1, 'draft', 'email', 'x', $2, 'test', now())`,
      [company.id, JSON.stringify({ sent_at: "2026-10-05T08:00:00Z", prompt: "v8", teaser: "t.jpg" })],
    );
    await db().query(
      `insert into interactions (company_id, type, body, created_by, created_at)
       values ($1, 'note', 'Antwort von x', 'mail', '2026-10-05T12:00:00Z')`,
      [company.id],
    );
    const snap = await buildSnapshot({
      db: db(),
      now: new Date("2026-10-06T10:00:00Z"),
      settings: { stufen: [20] },
      branches: ["physiotherapie"],
    });
    expect(snap.insgesamt).toMatchObject({ gesendet: 1, antworten: 1 });
    expect(snap.je_foto).toHaveProperty("stock");
    expect(snap.antwort_wann).toEqual({ "auf Erstmail": 1 });
    expect(snap.prototypen_je_vorlage).toEqual({});
    expect(snap.anrufe).toEqual({ ergebnisse: {}, je_uhrzeit: {} });
    expect(snap.vorbild_notizen).toEqual([]);

    const structured = vi
      .fn()
      .mockResolvedValueOnce({
        output: {
          lage: "Erste Antwort da",
          rueckblick: null,
          vorschlaege: [
            draft({ titel: "Behalten", quellen: ["https://a.de", "https://erfunden.de"] }),
            draft({ titel: "Weg" }),
          ],
        },
        costUsd: 0.1,
      })
      .mockResolvedValueOnce({
        output: {
          fazit: "Einer trägt",
          bewertungen: [
            { nr: 1, urteil: "behalten", sicherheit: "hoch", einwand: "gut belegt" },
            { nr: 2, urteil: "verwerfen", sicherheit: "niedrig", einwand: "Zufall" },
          ],
        },
        costUsd: 0.05,
      });
    const research = vi.fn().mockResolvedValue({
      text: "Recherche-7f3a",
      sources: [{ url: "https://a.de", title: "A" }],
      searches: 3,
      costUsd: 0.2,
    });
    const llm = { structured, research, toolStep: vi.fn() } as unknown as LlmGateway;
    const report = await runAdvisor(
      {
        db: db(),
        llm,
        config: { aktiv: true, tag: "sonntag", ab: "18:00", max_vorschlaege: 5, websuchen: 4 },
        now: () => new Date("2026-10-06T10:00:00Z"),
        snapshot: { settings: {}, branches: ["physiotherapie"] },
      },
      "telegram:1",
      "Ist der Anruf rechtlich ok?",
    );
    expect(report).toMatchObject({ lage: "Erste Antwort da", fazit: "Einer trägt", dropped: 1, searches: 3 });
    expect(report.costUsd).toBeCloseTo(0.35);
    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]).toMatchObject({
      title: "Behalten",
      confidence: "hoch",
      critique: "gut belegt",
      sources: ["https://a.de"],
    });
    // Die Recherche geht als abgegrenzter Nutzerinhalt an die Entwürfe, nie in den System-Prompt.
    const draftCall = structured.mock.calls[0]![0] as { system: string; input: string };
    expect(draftCall.input).toContain("<recherche>\nRecherche-7f3a\n</recherche>");
    expect(draftCall.system).not.toContain("Recherche-7f3a");
    expect(research.mock.calls[0]![0]).toMatchObject({ maxSearches: 4, role: "advisor_research" });
    expect((research.mock.calls[0]![0] as { input: string }).input).toMatch(
      /^<fokus>\nIst der Anruf rechtlich ok\?\n<\/fokus>/,
    );
    expect((structured.mock.calls[1]![0] as { input: string }).input).toContain("<fokus>");

    const id = report.suggestions[0]!.id;
    expect(await decideSuggestion(db(), id, "umsetzen", new Date())).toEqual({ title: "Behalten" });
    expect((await suggestionsByStatus(db(), ["umsetzen"])).map((s) => s.title)).toEqual(["Behalten"]);
    expect(
      await decideSuggestion(db(), "00000000-0000-0000-0000-000000000000", "verworfen", new Date()),
    ).toBeNull();
    // Nächste Runde sieht den Vorschlag samt Entscheidung im Lagebild.
    const next = await buildSnapshot({ db: db(), now: new Date(), settings: {}, branches: [] });
    expect(next.fruehere_vorschlaege[0]).toMatchObject({ titel: "Behalten", status: "umsetzen" });
  });

  it("Fundstück: merkt sich die letzten Themen und gibt sie beim nächsten Mal mit", async () => {
    const research = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Erstes Ding 😄\nQuelle: https://a.de",
        sources: [],
        searches: 1,
        costUsd: 0.03,
      })
      .mockResolvedValueOnce({ text: "Zweites Ding", sources: [], searches: 1, costUsd: 0.03 });
    const llm = { research } as unknown as LlmGateway;
    expect((await findSomething({ db: db(), llm, maxSearches: 3 })).text).toContain("Erstes Ding");
    await findSomething({ db: db(), llm, maxSearches: 3 });
    const second = research.mock.calls[1]![0] as { input: string; system: string; maxSearches: number };
    expect(second.input).toContain("- Erstes Ding 😄");
    expect(second.maxSearches).toBe(3);
  });

  it("Sweep: Fundstück und Wochen-Runde je einmal am Tag einreihen", async () => {
    const send = vi.fn(() => Promise.resolve("job"));
    const config = {
      aktiv: true,
      tag: "sonntag" as const,
      ab: "18:00",
      max_vorschlaege: 5,
      websuchen: 8,
      zwischendurch: { tage: ["sonntag" as const], ab: "16:30", websuchen: 3 },
    };
    const ctx = {
      db: db(),
      boss: { send },
      now: () => new Date("2026-10-04T17:00:00Z"), // Sonntag 19:00 in Deutschland
      advisor: { config, deps: () => ({}) },
    } as unknown as PipelineContext;
    expect(await advisorTick(ctx)).toBe(true);
    expect(await advisorTick(ctx)).toBe(false);
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { trigger: FIND_TRIGGER },
      { trigger: "woche" },
    ]);
  });
});
