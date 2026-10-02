import { describe, expect, it } from "vitest";
import { loadEnv, requireKeys } from "../src/config/env.js";

describe("loadEnv", () => {
  it("setzt Standardwerte und behandelt leere Secrets als nicht gesetzt", () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: "  " });
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_ALLOWED_CHAT_IDS).toEqual([]);
  });

  it("parst kommagetrennte Chat-IDs inklusive Gruppen-IDs", () => {
    const env = loadEnv({ TELEGRAM_ALLOWED_CHAT_IDS: "123, -100456" });
    expect(env.TELEGRAM_ALLOWED_CHAT_IDS).toEqual([123, -100456]);
  });

  it("lehnt ungültige Chat-IDs ab", () => {
    expect(() => loadEnv({ TELEGRAM_ALLOWED_CHAT_IDS: "123,@christian" })).toThrow(/Chat-ID/);
  });

  it("nutzt AVELIO_ANTHROPIC_API_KEY, wenn ANTHROPIC_API_KEY fehlt oder leer ist", () => {
    expect(loadEnv({ AVELIO_ANTHROPIC_API_KEY: "a" }).ANTHROPIC_API_KEY).toBe("a");
    expect(loadEnv({ ANTHROPIC_API_KEY: "", AVELIO_ANTHROPIC_API_KEY: "a" }).ANTHROPIC_API_KEY).toBe("a");
    expect(loadEnv({ ANTHROPIC_API_KEY: "b", AVELIO_ANTHROPIC_API_KEY: "a" }).ANTHROPIC_API_KEY).toBe("b");
  });

  it("lehnt unbekannte NODE_ENV-Werte ab", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});

describe("requireKeys", () => {
  it("liefert nur die angeforderten Secrets", () => {
    const env = loadEnv({ GOOGLE_API_KEY: "g", TELEGRAM_BOT_TOKEN: "t" });
    expect(requireKeys(env, ["GOOGLE_API_KEY"])).toEqual({ GOOGLE_API_KEY: "g" });
  });

  it("nennt alle fehlenden Keys, aber keine Werte", () => {
    const env = loadEnv({ GOOGLE_API_KEY: "geheim" });
    expect(() => requireKeys(env, ["GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"])).toThrow(
      "Fehlende Umgebungsvariablen: ANTHROPIC_API_KEY, DATABASE_URL",
    );
  });
});
