import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../src/db/client.js";
import { createHeartbeat } from "../src/health.js";

describe("Lebenszeichen", () => {
  it("schreibt die Datei, pingt selten bei Erfolg und sofort /fail bei Datenbankfehler", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "avelio-")), "hb");
    let t = Date.parse("2026-10-03T10:00:00Z");
    let dbOk = true;
    const db = { query: vi.fn(() => (dbOk ? Promise.resolve({}) : Promise.reject(new Error("weg")))) };
    const fetch = vi.fn((_url: string) => Promise.resolve(new Response("ok")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hb = createHeartbeat({
      db: db as unknown as DbClient,
      pingUrl: "https://hc-ping.com/abc",
      fetch: fetch as unknown as typeof globalThis.fetch,
      file,
      intervalMs: 3_600_000,
      now: () => new Date(t),
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); // erster Lauf beim Start
    expect(readFileSync(file, "utf8")).toBe("2026-10-03T10:00:00.000Z");

    t += 60_000;
    await hb.beat(); // innerhalb von 5 Minuten: kein weiterer Ping
    expect(fetch).toHaveBeenCalledTimes(1);

    dbOk = false;
    t += 60_000;
    expect(await hb.beat()).toBe(false);
    expect(fetch.mock.calls.at(-1)![0]).toBe("https://hc-ping.com/abc/fail");
    expect(readFileSync(file, "utf8")).toBe("2026-10-03T10:01:00.000Z"); // nicht aktualisiert

    dbOk = true;
    t += 60_000;
    await hb.beat(); // wieder gesund: sofort melden
    expect(fetch.mock.calls.at(-1)![0]).toBe("https://hc-ping.com/abc");
    hb.stop();
  });
});
