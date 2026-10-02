import { TLSSocket } from "node:tls";
import pg from "pg";
import { tlsFor } from "../db/client.js";
import type { Env } from "./env.js";

export type CheckStatus = "ok" | "missing" | "error";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

type Fetch = typeof fetch;

const TIMEOUT_MS = 30_000;

async function probe(
  name: string,
  value: string | undefined,
  run: (value: string) => Promise<string>,
): Promise<CheckResult> {
  if (!value) return { name, status: "missing", detail: "nicht gesetzt" };
  try {
    return { name, status: "ok", detail: await run(value) };
  } catch (err) {
    return { name, status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function expectOk(res: Response, service: string): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`${service}: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

/** Prüft die gesetzten Keys mit je einem günstigen Live-Aufruf. Gibt nie Secret-Werte aus. */
export async function checkKeys(env: Env, fetchFn: Fetch = fetch): Promise<CheckResult[]> {
  const signal = () => AbortSignal.timeout(TIMEOUT_MS);

  return Promise.all([
    probe("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN, async (token) => {
      const res = await fetchFn(`https://api.telegram.org/bot${token}/getMe`, { signal: signal() });
      const data = (await expectOk(res, "Telegram")) as { result?: { username?: string } };
      return `Bot @${data.result?.username ?? "?"}`;
    }),
    probe("TELEGRAM_ALLOWED_CHAT_IDS", env.TELEGRAM_ALLOWED_CHAT_IDS.join(",") || undefined, (ids) =>
      Promise.resolve(`${ids.split(",").length} Chat-ID(s)`),
    ),
    probe("GOOGLE_API_KEY (Places)", env.GOOGLE_API_KEY, async (key) => {
      const res = await fetchFn("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.id",
        },
        body: JSON.stringify({ textQuery: "Fahrradladen Rosenheim", pageSize: 1 }),
        signal: signal(),
      });
      const data = (await expectOk(res, "Places")) as { places?: unknown[] };
      return `${data.places?.length ?? 0} Treffer`;
    }),
    probe("GOOGLE_API_KEY (PageSpeed)", env.GOOGLE_API_KEY, async (key) => {
      const url = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
      url.search = new URLSearchParams({
        url: "https://example.com",
        strategy: "mobile",
        category: "performance",
        key,
      }).toString();
      const res = await fetchFn(url, { signal: AbortSignal.timeout(90_000) });
      await expectOk(res, "PageSpeed");
      return "Antwort erhalten";
    }),
    probe("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY, async (key) => {
      const res = await fetchFn("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: signal(),
      });
      await expectOk(res, "Anthropic");
      return "Key gültig";
    }),
    probe("DATABASE_URL", env.DATABASE_URL, checkDatabase),
  ]);
}

export async function checkDatabase(url: string): Promise<string> {
  const ssl = tlsFor(url);
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: TIMEOUT_MS,
    ...(ssl ? { ssl } : {}),
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ version: string; has_migrations: boolean }>(
      `select current_setting('server_version') as version,
              to_regclass('schema_migrations') is not null as has_migrations`,
    );
    const r = rows[0]!;
    // Eigene Abfrage: Auf einer frischen Datenbank gibt es die Tabelle vor dem ersten `migrate` noch nicht.
    const migrations = r.has_migrations
      ? (await client.query<{ n: number }>("select count(*)::int as n from schema_migrations")).rows[0]!.n
      : 0;
    const stream = (client as unknown as { connection?: { stream?: unknown } }).connection?.stream;
    const tls =
      stream instanceof TLSSocket
        ? stream.authorized
          ? "TLS, Zertifikat geprüft"
          : "TLS ohne Zertifikatsprüfung"
        : "unverschlüsselt";
    return `Postgres ${r.version}, ${migrations} Migration(en) angewendet (${tls})`;
  } catch (err) {
    // Fehlermeldungen von pg enthalten keine Passwörter, die Host-Angabe ist zur Diagnose nützlich.
    throw new Error(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
