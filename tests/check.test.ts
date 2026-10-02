import { describe, expect, it } from "vitest";
import { checkKeys } from "../src/config/check.js";
import { loadEnv } from "../src/config/env.js";

function fakeFetch(responses: Record<string, Response>): typeof fetch {
  return (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const match = Object.entries(responses).find(([prefix]) => url.startsWith(prefix));
    return Promise.resolve(match ? match[1].clone() : new Response("not found", { status: 404 }));
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("checkKeys", () => {
  it("meldet fehlende Keys ohne Netzwerkaufruf", async () => {
    const results = await checkKeys(loadEnv({}), () => {
      throw new Error("darf nicht aufgerufen werden");
    });
    expect(results.every((r) => r.status === "missing")).toBe(true);
  });

  it("meldet gültige und ungültige Keys, ohne Secrets auszugeben", async () => {
    const env = loadEnv({
      TELEGRAM_BOT_TOKEN: "tok-secret",
      GOOGLE_API_KEY: "goog-secret",
      ANTHROPIC_API_KEY: "ant-secret",
    });
    const results = await checkKeys(
      env,
      fakeFetch({
        "https://api.telegram.org/": json({ ok: true, result: { username: "avelio_manager_bot" } }),
        "https://places.googleapis.com/": json({ places: [{ id: "x" }] }),
        "https://www.googleapis.com/pagespeedonline/": json({}),
        "https://api.anthropic.com/": json({ error: "invalid x-api-key" }, 401),
      }),
    );
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    expect(byName["TELEGRAM_BOT_TOKEN"]).toMatchObject({ status: "ok", detail: "Bot @avelio_manager_bot" });
    expect(byName["GOOGLE_API_KEY (Places)"]).toMatchObject({ status: "ok", detail: "1 Treffer" });
    expect(byName["GOOGLE_API_KEY (PageSpeed)"]?.status).toBe("ok");
    expect(byName["ANTHROPIC_API_KEY"]).toMatchObject({ status: "error" });
    expect(byName["ANTHROPIC_API_KEY"]?.detail).toContain("HTTP 401");

    const output = JSON.stringify(results);
    for (const secret of ["tok-secret", "goog-secret", "ant-secret"]) {
      expect(output).not.toContain(secret);
    }
  });
});
