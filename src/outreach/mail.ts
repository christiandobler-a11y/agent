import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";

/**
 * Christians Postfach (Phase 2, Morgen-Paket): Senden per SMTP auf Knopfdruck, Ablage unter "Gesendet" und
 * Antwort-Erkennung per IMAP. Eingehende Mails sind fremder Inhalt: Sie werden nur zugeordnet, gekürzt gespeichert
 * und escaped angezeigt, nie an ein LLM oder Werkzeug weitergereicht.
 */

const server = z.object({ host: z.string(), port: z.number().int(), secure: z.boolean().default(true) });
export const mailConfigSchema = z.object({
  providers: z.record(
    z.string(),
    z.object({ smtp: server, imap: server.omit({ secure: true }), append_sent: z.boolean() }),
  ),
  max_per_day: z.number().int().min(1),
  verteilt: z
    .object({
      abstand_min: z.number().min(0),
      abstand_max: z.number().min(0),
      von: z.string().regex(/^\d{2}:\d{2}$/),
      bis: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .default({ abstand_min: 5, abstand_max: 15, von: "08:00", bis: "18:00" }),
  reply_window_days: z.number().int().min(1),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

export function loadMailConfig(): MailConfig {
  return loadYamlConfig("mail.yaml", mailConfigSchema);
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** Message-ID der Mail, auf die geantwortet wird (Nachfassen im selben Verlauf). */
  inReplyTo?: string | null;
  /** HTML-Fassung (z. B. mit eingebettetem Vorschau-Bild); `text` bleibt die Textfassung. */
  html?: string;
  /** Eingebettete Bilder (`cid` wie im HTML) bzw. Anhänge. */
  attachments?: {
    filename: string;
    path?: string;
    content?: Buffer;
    contentType?: string;
    cid?: string;
    contentDisposition?: "inline" | "attachment";
  }[];
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Text-Mail als schlichtes HTML (wirkt wie von Hand geschrieben): Absätze, Zeilenumbrüche, klickbare Links. Nach dem
 * Absatz `after` (oder am Ende) steht das Bild `cid`.
 */
export function textToHtml(
  text: string,
  image: { cid: string; alt: string; after: string | null } | null,
): string {
  const paragraphs = text.split(/\n{2,}/);
  let index = image?.after ? paragraphs.findIndex((p) => p.trim() === image.after!.trim()) : -1;
  if (image && index < 0) index = paragraphs.length - 1;
  const html = paragraphs.map((p, i) => {
    const body = escapeHtml(p)
      .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}">${url}</a>`)
      .replace(/\n/g, "<br>");
    const img =
      image && i === index
        ? `<p><img src="cid:${image.cid}" alt="${escapeHtml(image.alt)}" width="600" height="375" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:6px"></p>`
        : "";
    return `<p>${body}</p>${img}`;
  });
  return `<!doctype html><html><body style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f">${html.join("")}</body></html>`;
}

export interface IncomingMail {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  subject: string | null;
  date: Date | null;
  text: string;
  /** Kopfzeilen kennzeichnen die Mail als automatisch erzeugt (Auto-Submitted, X-Autoreply, Precedence …). */
  autoHeaders?: boolean;
}

export interface Mailbox {
  readonly address: string;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Neue Mails im Posteingang seit `afterUid` (exklusiv). `uidValidity` ändert sich, wenn der Server neu nummeriert. */
  fetchSince(
    afterUid: number | null,
  ): Promise<{ uidValidity: string; maxUid: number; mails: IncomingMail[] }>;
}

/** Message-ID mit der Domain des Absenders, damit Antworten über In-Reply-To zugeordnet werden können. */
export function newMessageId(address: string): string {
  const domain = address.split("@")[1] ?? "localhost";
  return `<${randomUUID()}@${domain}>`;
}

export const normalizeId = (id: string | null | undefined) =>
  id?.trim().replace(/^<|>$/g, "").toLowerCase() ?? "";

export const normalizeAddress = (a: string | null | undefined) => a?.trim().toLowerCase() ?? "";

/** "Re: " vor den Betreff, außer er beginnt schon damit. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

export interface SentRef {
  companyId: string;
  messageId: string;
  to: string;
}

/**
 * Wem gehört eine eingehende Mail? Zuerst über den Verlauf (In-Reply-To/References), sonst über die Absenderadresse,
 * zuletzt über die Domain (Antwort vom Chef statt von info@), aber nie bei Freemailern.
 */
export function matchReply(mail: IncomingMail, sent: readonly SentRef[]): string | null {
  const ids = new Set([mail.inReplyTo, ...mail.references].map(normalizeId).filter(Boolean));
  const byThread = sent.find((s) => ids.has(normalizeId(s.messageId)));
  if (byThread) return byThread.companyId;
  const from = normalizeAddress(mail.from);
  if (!from) return null;
  const byAddress = sent.find((s) => normalizeAddress(s.to) === from);
  if (byAddress) return byAddress.companyId;
  const domain = from.split("@")[1];
  if (!domain || FREEMAIL.has(domain)) return null;
  const companies = new Set(
    sent.filter((s) => normalizeAddress(s.to).split("@")[1] === domain).map((s) => s.companyId),
  );
  return companies.size === 1 ? [...companies][0]! : null;
}

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "outlook.com",
  "outlook.de",
  "hotmail.com",
  "hotmail.de",
  "yahoo.com",
  "yahoo.de",
  "icloud.com",
  "me.com",
  "mac.com",
  "freenet.de",
  "aol.com",
]);

/** Unzustellbar-Meldung des Mailservers? Dann die Message-IDs der Originalmail aus dem Text holen. */
export function bounceOf(mail: IncomingMail): { bounced: true; ids: string[] } | null {
  const from = normalizeAddress(mail.from);
  const subject = mail.subject ?? "";
  const isBounce =
    /^(mailer-daemon|postmaster)@/.test(from) ||
    /(undeliver|delivery status notification|returned mail|unzustellbar|nicht zugestellt|failure notice)/i.test(
      subject,
    );
  if (!isBounce) return null;
  const ids = [...mail.text.matchAll(/Message-ID:\s*(<[^>\s]+>)/gi)].map((m) => m[1]!);
  return { bounced: true, ids };
}

/**
 * Automatische Antwort (Abwesenheitsnotiz, Eingangsbestätigung)? Kopfzeilen oder typischer Betreff. Solche Mails
 * zählen nicht als Antwort: kein Statuswechsel, Nachfassen bleibt aktiv (04.10.2026, Christian).
 */
export function isAutoReply(mail: Pick<IncomingMail, "subject" | "autoHeaders">): boolean {
  if (mail.autoHeaders) return true;
  return /(abwesen|out of (the )?office|automatische antwort|auto(matic)?[ -]?(reply|response|antwort)|autoreply|nicht im büro|eingangsbestätigung|urlaubsnotiz|im urlaub|praxisurlaub|\booo\b)/i.test(
    mail.subject ?? "",
  );
}

/** Kopfzeilen einer automatisch erzeugten Mail (RFC 3834 und gängige Varianten). Rein. */
export function hasAutoHeaders(get: (name: string) => unknown): boolean {
  const str = (name: string) => {
    // mailparser liefert strukturierte Kopfzeilen als { value, params }.
    const raw = get(name);
    const v = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
    return typeof v === "string" ? v.trim().toLowerCase() : v == null ? "" : JSON.stringify(v).toLowerCase();
  };
  const submitted = str("auto-submitted");
  if (submitted && submitted !== "no") return true;
  if (str("x-autoreply") || str("x-autorespond") || str("x-autoresponder")) return true;
  return /auto[_-]reply/.test(str("precedence"));
}

/** Antworttext ohne zitierte Originalmail, gekürzt (nur zur Anzeige). */
export function replyExcerpt(text: string, max = 400): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^>/.test(line) || /^(Am|On) .+(schrieb|wrote).*:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*(Original|Ursprüngliche)/i.test(line.trim())) break;
    lines.push(line);
  }
  const t = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface MailboxSettings {
  address: string;
  password: string;
  provider: MailConfig["providers"][string];
  fromName: string;
}

export function createMailbox(s: MailboxSettings): Mailbox {
  const transport = nodemailer.createTransport({
    host: s.provider.smtp.host,
    port: s.provider.smtp.port,
    secure: s.provider.smtp.secure,
    requireTLS: !s.provider.smtp.secure,
    auth: { user: s.address, pass: s.password },
  });
  const imap = () =>
    new ImapFlow({
      host: s.provider.imap.host,
      port: s.provider.imap.port,
      secure: true,
      auth: { user: s.address, pass: s.password },
      logger: false,
    });

  async function sentFolder(client: ImapFlow): Promise<string | null> {
    const boxes = await client.list();
    return (
      boxes.find((b) => b.specialUse === "\\Sent")?.path ??
      boxes.find((b) => /^(sent|gesendet|sent messages|gesendete objekte)$/i.test(b.name))?.path ??
      null
    );
  }

  return {
    address: s.address,
    async send(mail) {
      const messageId = newMessageId(s.address);
      const message = {
        from: { name: s.fromName, address: s.address },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
        messageId,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: [mail.inReplyTo] } : {}),
      };
      await transport.sendMail(message);
      if (s.provider.append_sent) {
        // Kopie unter "Gesendet", damit Christian den Verlauf in seiner Mail-App sieht. Fehler hier sind nicht schlimm.
        const raw = await new MailComposer(message).compile().build();
        const client = imap();
        try {
          await client.connect();
          const folder = await sentFolder(client);
          if (folder) await client.append(folder, raw, ["\\Seen"], new Date());
        } catch {
          // bewusst ignoriert
        } finally {
          await client.logout().catch(() => undefined);
        }
      }
      return { messageId };
    },
    async fetchSince(afterUid) {
      const client = imap();
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const box = client.mailbox;
          const uidValidity = box ? String(box.uidValidity) : "0";
          const uidNext = box ? Number(box.uidNext) : 1;
          const maxUid = Math.max(0, uidNext - 1);
          if (afterUid === null || maxUid <= afterUid) return { uidValidity, maxUid, mails: [] };
          const mails: IncomingMail[] = [];
          for await (const msg of client.fetch(
            `${afterUid + 1}:*`,
            { uid: true, source: true },
            { uid: true },
          )) {
            if (msg.uid <= afterUid || !msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const refs = parsed.references;
            mails.push({
              uid: msg.uid,
              messageId: parsed.messageId ?? null,
              inReplyTo: parsed.inReplyTo ?? null,
              references: Array.isArray(refs) ? refs : refs ? [refs] : [],
              from: parsed.from?.value[0]?.address ?? null,
              subject: parsed.subject ?? null,
              date: parsed.date ?? null,
              text: (parsed.text ?? "").slice(0, 20_000),
              autoHeaders: hasAutoHeaders((name) => parsed.headers.get(name)),
            });
          }
          return { uidValidity, maxUid, mails };
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
  };
}

/** Postfach aus der Umgebung, `null` wenn nicht eingerichtet. */
export function mailboxFromEnv(
  env: {
    OUTREACH_MAIL_ADDRESS?: string | undefined;
    OUTREACH_MAIL_PASSWORD?: string | undefined;
    OUTREACH_MAIL_PROVIDER?: string | undefined;
  },
  config: MailConfig,
  fromName: string,
): Mailbox | null {
  const { OUTREACH_MAIL_ADDRESS: address, OUTREACH_MAIL_PASSWORD: password } = env;
  if (!address || !password) return null;
  const key = (env.OUTREACH_MAIL_PROVIDER ?? address.split("@")[1]?.split(".")[0] ?? "").toLowerCase();
  const provider = config.providers[key === "me" || key === "mac" ? "icloud" : key];
  if (!provider) {
    throw new Error(
      `Unbekannter Mail-Anbieter "${key}" (OUTREACH_MAIL_PROVIDER, möglich: ${Object.keys(config.providers).join(", ")})`,
    );
  }
  return createMailbox({ address, password, provider, fromName });
}
