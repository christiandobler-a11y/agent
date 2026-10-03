import { describe, expect, it } from "vitest";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { berlinInstant, proposeSlots, seedOf, spokenTime } from "../src/outreach/slots.js";

const cfg = loadOutreachConfig();
// Freitag, 3.10.2026, 12:00 deutsche Zeit
const NOW = new Date("2026-10-03T10:00:00Z");
const berlin = (iso: string) =>
  new Date(iso).toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

describe("Terminvorschläge", () => {
  it("2 Tage mit je 2 Uhrzeiten, nie in der Arbeitszeit (außer höchstens einer Mittagspause)", () => {
    for (let seed = 0; seed < 50; seed++) {
      const p = proposeSlots({
        now: NOW,
        config: cfg.termine,
        branchKey: "physiotherapie",
        du: false,
        taken: new Map(),
        seed,
      })!;
      expect(p.days).toHaveLength(2);
      expect(p.slots).toHaveLength(4);
      expect(p.days[0]!.date < p.days[1]!.date).toBe(true);
      expect(p.days[0]!.weekday).not.toBe(p.days[1]!.weekday);
      const workday = p.slots.filter((iso) => {
        const d = new Date(iso);
        const wd = d.toLocaleDateString("en-US", { timeZone: "Europe/Berlin", weekday: "short" });
        const hm = d.toLocaleTimeString("de-DE", {
          timeZone: "Europe/Berlin",
          hour: "2-digit",
          minute: "2-digit",
        });
        return !["Sat", "Sun"].includes(wd) && hm >= "09:00" && hm < "17:30";
      });
      expect(workday.length).toBeLessThanOrEqual(1);
      expect(workday.every((iso) => berlin(iso).endsWith("12:15"))).toBe(true);
      // frühestens in 2, spätestens in 9 Tagen
      for (const iso of p.slots) {
        const days = (Date.parse(iso) - NOW.getTime()) / 86_400_000;
        expect(days).toBeGreaterThan(1);
        expect(days).toBeLessThan(10);
      }
    }
  });

  it("Satz mit Sie bzw. Du, Uhrzeiten so wie man sie schreibt", () => {
    const sie = proposeSlots({
      now: NOW,
      config: cfg.termine,
      branchKey: null,
      du: false,
      taken: new Map(),
      seed: 1,
    })!;
    expect(sie.sentence).toMatch(/^(Hätten Sie|Passt Ihnen) /);
    expect(sie.sentence).toMatch(/(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag)/);
    expect(sie.sentence).not.toMatch(/[–—]/);
    const du = proposeSlots({
      now: NOW,
      config: cfg.termine,
      branchKey: "fahrrad",
      du: true,
      taken: new Map(),
      seed: 1,
    })!;
    expect(du.sentence).toMatch(/^(Hättest du|Passt dir) /);
    expect(spokenTime("08:00")).toBe("8");
    expect(spokenTime("19:30")).toBe("19:30");
  });

  it("Gastro bekommt Morgen- und Samstagstermine statt Abendgeschäft", () => {
    for (let seed = 0; seed < 30; seed++) {
      const p = proposeSlots({
        now: NOW,
        config: cfg.termine,
        branchKey: "gastro",
        du: true,
        taken: new Map(),
        seed,
      })!;
      for (const iso of p.slots) {
        const hm = new Date(iso).toLocaleTimeString("de-DE", {
          timeZone: "Europe/Berlin",
          hour: "2-digit",
          minute: "2-digit",
        });
        expect(hm <= "18:00").toBe(true);
        expect(["18:30", "19:00", "19:30"]).not.toContain(hm);
      }
    }
  });

  it("ein Termin geht höchstens an 2 Leads gleichzeitig", () => {
    const first = proposeSlots({
      now: NOW,
      config: cfg.termine,
      branchKey: null,
      du: false,
      taken: new Map(),
      seed: 7,
    })!;
    const taken = new Map(first.slots.map((s) => [s, 2]));
    const second = proposeSlots({
      now: NOW,
      config: cfg.termine,
      branchKey: null,
      du: false,
      taken,
      seed: 7,
    })!;
    expect(second.slots.some((s) => first.slots.includes(s))).toBe(false);
  });

  it("funktioniert mit großen Seeds (z. B. aus seedOf)", () => {
    for (const seed of [seedOf("x"), 0xffffffff, 2 ** 31 + 5]) {
      const p = proposeSlots({
        now: NOW,
        config: cfg.termine,
        branchKey: null,
        du: false,
        taken: new Map(),
        seed,
      })!;
      expect(p.sentence).toMatch(/Uhr/);
      expect(p.slots).toHaveLength(4);
    }
  });

  it("Wanduhrzeit Berlin → UTC und Seed stabil", () => {
    expect(berlinInstant("2026-10-06", "18:30").toISOString()).toBe("2026-10-06T16:30:00.000Z");
    expect(berlinInstant("2026-11-03", "18:30").toISOString()).toBe("2026-11-03T17:30:00.000Z");
    expect(seedOf("abc")).toBe(seedOf("abc"));
    expect(seedOf("abc")).not.toBe(seedOf("abd"));
  });
});
