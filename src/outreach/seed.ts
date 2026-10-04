import { ImapFlow } from "imapflow";
import { getState, setState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import type { MailConfig, Mailbox } from "./mail.js";
import { withTeaser } from "./send.js";

/**
 * Kontroll-Postfächer (04.10.2026, Christian: "wenn ich im Spam lande, kriegen wir das gar nicht mit"). Ob eine Mail
 * im Spam landet, sagt kein Mailserver dem Absender. Deshalb geht jeden Werktag eine Kopie der ersten echten Mail an
 * Christians eigene Test-Postfächer (z. B. Gmail, GMX); Avelio schaut dort per IMAP nach, ob sie im Posteingang oder
 * im Spam liegt, und meldet es. Spam bremst das Morgen-Paket (autopilot.yaml → neue_kontakte).
 */

export type Placement = "inbox" | "spam" | null;

export interface SeedBox {
  /** Anzeigename, z. B. "Gmail". */
  readonly label: string;
  readonly address: string;
  /** Wo liegt die Mail mit dieser Message-ID? `null` = (noch) nicht gefunden. */
  locate(messageId: string): Promise<Placement>;
}

const SPAM_NAME = /^(spam|junk|junk-e-mail|spamverdacht|\[gmail\]\/spam|bulk mail)$/i;

export function createSeedBox(s: {
  label: string;
  address: string;
  password: string;
  imap: { host: string; port: number };
}): SeedBox {
  return {
    label: s.label,
    address: s.address,
    async locate(messageId) {
      const client = new ImapFlow({
        host: s.imap.host,
        port: s.imap.port,
        secure: true,
        auth: { user: s.address, pass: s.password },
        logger: false,
      });
      await client.connect();
      try {
        const boxes = await client.list();
        const spam =
          boxes.find((b) => b.specialUse === "\\Junk")?.path ??
          boxes.find((b) => SPAM_NAME.test(b.name) || SPAM_NAME.test(b.path))?.path ??
          null;
        const found = async (path: string) => {
          const lock = await client.getMailboxLock(path, { readOnly: true });
          try {
            const hits = await client.search({ header: { "message-id": messageId } }, { uid: true });
            return Array.isArray(hits) && hits.length > 0;
          } finally {
            lock.release();
          }
        };
        if (await found("INBOX")) return "inbox";
        if (spam && (await found(spam))) return "spam";
        return null;
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
  };
}

/**
 * Kontroll-Postfächer aus der Umgebung: SEED_1_ADDRESS, SEED_1_PASSWORD (App-Passwort), SEED_1_PROVIDER (gmail, gmx,
 * webde, …; sonst aus der Adresse), ebenso SEED_2_… und SEED_3_…. Unvollständige werden übersprungen.
 */
export function seedBoxesFromEnv(env: Partial<Record<string, unknown>>, config: MailConfig): SeedBox[] {
  const boxes: SeedBox[] = [];
  for (const n of [1, 2, 3]) {
    const str = (k: string) => {
      const v = env[`SEED_${n}_${k}`];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const address = str("ADDRESS");
    const password = str("PASSWORD");
    if (!address || !password) continue;
    const key = (str("PROVIDER") ?? address.split("@")[1]?.split(".")[0] ?? "").toLowerCase();
    const provider = config.providers[key === "googlemail" ? "gmail" : key === "web" ? "webde" : key];
    if (!provider) continue;
    const label =
      { gmail: "Gmail", gmx: "GMX", webde: "Web.de", icloud: "iCloud", ionos: "IONOS" }[key] ?? key;
    boxes.push(createSeedBox({ label, address, password, imap: provider.imap }));
  }
  return boxes;
}

interface SeedState {
  sentAt: string;
  subject: string;
  copies: { label: string; messageId: string }[];
  result?: Record<string, "inbox" | "spam" | "missing">;
}

const KEY = (date: string) => `seed:${date}`;
/** Erst nach so vielen Minuten nachsehen, höchstens so lange auf die Mail warten. */
const CHECK_AFTER_MIN = 15;
const GIVE_UP_AFTER_MIN = 180;

export interface SeedDeps {
  db: Db;
  mailbox: Mailbox;
  boxes: readonly SeedBox[];
  now: () => Date;
  /** Kalendertag in Deutschland. */
  date: string;
  notify?: (text: string) => Promise<void>;
}

/** Ein Takt: Kopie verschicken (sobald heute die erste neue Mail raus ist) bzw. nachsehen und melden. */
export async function seedTick(deps: SeedDeps): Promise<"idle" | "sent" | "waiting" | "reported"> {
  const { db, boxes, date } = deps;
  if (boxes.length === 0) return "idle";
  const now = deps.now();
  const state = await getState<SeedState>(db, KEY(date));

  if (!state) {
    const { rows } = await db.query<{ body: string | null; meta: Record<string, unknown> }>(
      `select body, meta from interactions
        where type = 'draft' and channel = 'email' and meta ? 'sent_at'
          and coalesce((meta->>'follow_up')::boolean, false) = false
          and ((meta->>'sent_at')::timestamptz at time zone 'Europe/Berlin')::date = $1::date
        order by (meta->>'sent_at')::timestamptz limit 1`,
      [date],
    );
    const draft = rows[0];
    const subject = typeof draft?.meta.subject === "string" ? draft.meta.subject : null;
    if (!draft?.body || !subject) return "idle";
    const extra = await withTeaser({ body: draft.body, meta: draft.meta });
    const copies: SeedState["copies"] = [];
    for (const box of boxes) {
      const { messageId } = await deps.mailbox.send({ to: box.address, subject, text: draft.body, ...extra });
      copies.push({ label: box.label, messageId });
    }
    await setState(db, KEY(date), { sentAt: now.toISOString(), subject, copies } satisfies SeedState);
    return "sent";
  }

  if (state.result) return "idle";
  const minutes = (now.getTime() - Date.parse(state.sentAt)) / 60_000;
  if (minutes < CHECK_AFTER_MIN) return "waiting";
  const result: NonNullable<SeedState["result"]> = {};
  for (const copy of state.copies) {
    const box = boxes.find((b) => b.label === copy.label);
    const place = box ? await box.locate(copy.messageId).catch(() => null) : null;
    result[copy.label] = place ?? "missing";
  }
  const missing = Object.values(result).some((r) => r === "missing");
  if (missing && minutes < GIVE_UP_AFTER_MIN) return "waiting";
  await setState(db, KEY(date), { ...state, result } satisfies SeedState);
  await deps.notify?.(seedReport(result));
  return "reported";
}

export function seedReport(result: Record<string, "inbox" | "spam" | "missing">): string {
  const words = { inbox: "Posteingang ✅", spam: "SPAM ⚠️", missing: "nicht angekommen ⚠️" } as const;
  const lines = Object.entries(result).map(([label, r]) => `${label}: ${words[r]}`);
  const bad = Object.values(result).some((r) => r !== "inbox");
  return bad
    ? `⚠️ Kontrollmail von heute:\n${lines.join("\n")}\n\nIch bremse ab morgen eine Stufe. Die Mail dort bitte nicht als „kein Spam“ markieren, sonst taugt der Test nichts mehr. Passiert das öfter, passen wir Betreff, Text oder Bild an.`
    : `📬 Kontrollmail von heute: ${lines.join(", ")}`;
}

/** Lag eine Kontrollmail in den letzten `days` Tagen im Spam (oder kam nicht an)? Dann bremst das Morgen-Paket. */
export async function recentSeedProblem(db: Db, now: Date, days = 3): Promise<boolean> {
  const { rows } = await db.query<{ value: SeedState }>(
    `select value from app_state
      where key ~ '^seed:\\d{4}-\\d{2}-\\d{2}$'
        and substring(key from 6)::date > ($1::timestamptz at time zone 'Europe/Berlin')::date - $2::int`,
    [now, days],
  );
  return rows.some((r) => Object.values(r.value.result ?? {}).some((x) => x !== "inbox"));
}
