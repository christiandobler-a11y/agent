/**
 * Impressum auswerten (ARCHITECTURE.md 5.2 Schritt 7, 7.3 E): Inhaber/Geschäftsführung, E-Mail, Telefon.
 * Rein und regelbasiert; Eingabe ist der sichtbare Text (Zeilen) der Impressum-Seite.
 */

export interface ImpressumData {
  person: string | null;
  /** Wie die Person im Impressum geführt wird, z. B. "Inhaber", "Geschäftsführer". */
  role: string | null;
  emails: string[];
  phones: string[];
  vat_id: string | null;
  register: string | null;
}

const ROLES: [RegExp, string][] = [
  [/^(?:inhaber(?:in)?|inh\.)/i, "Inhaber"],
  [/^geschäftsführ(?:er(?:in)?|ung|ender gesellschafter)/i, "Geschäftsführer"],
  [
    /^(?:vertreten durch|vertretungsberechtigt(?:e|er)?(?: geschäftsführer(?:in)?| gesellschafter(?:in)?)?)/i,
    "Vertreten durch",
  ],
  [/^(?:verantwortlich|v\.i\.s\.d\.p|inhaltlich verantwortlich)/i, "Verantwortlich"],
];

/** Wörter aus Firmennamen, die in Personennamen praktisch nie vorkommen. */
const BUSINESS_WORDS =
  /\b(?:rad(?:haus|sport|laden|l)?|fahrr[aä]d\w*|bikes?\w*|e-?bikes?|zweir[aä]d\w*|shop|store|sport\w*|service|werkstatt|center|zentrum|team|markt|handel|studio|salon|praxis|technik|betrieb|gruppe|verwaltung|holding)\b/i;

const NOT_A_NAME =
  /gmbh|\bag\b|\bkg\b|\bug\b|e\.\s?k\.|e\.\s?v\.|straße|str\.|\d|@|http|www\.|telefon|tel\.|fax|e-mail|inhalt|gemäß|§|rstv|mstv|ddg|tmg|siehe|oben|impressum/i;

/** "Thomas Müller", "Dipl.-Ing. Anna-Lena von Berg", "Max Mustermann (Inhaber)" → Name ohne Zusätze. */
export function cleanPersonName(raw: string): string | null {
  let s = raw
    .replace(/\(.*?\)/g, " ")
    .replace(/(?:^|\s)(?:Herrn?|Frau|Hr\.|Fr\.)\s+/g, " ")
    .replace(/\b(?:Dipl\.-?\s?[A-ZÄÖÜa-zäöü]+\.?|Dr\.|Prof\.|Ing\.|M\.\s?A\.|B\.\s?A\.|Meister)\s*/g, "")
    .replace(/[:;,|].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[-–\s]+|[-–\s.]+$/g, "");
  if (!s || NOT_A_NAME.test(s) || BUSINESS_WORDS.test(s)) return null;
  const words = s.split(" ");
  if (words.length < 2 || words.length > 5) return null;
  const capitalized = words.filter((w) => /^[A-ZÄÖÜ]/.test(w)).length;
  return capitalized >= 2 ? s : null;
}

function findPerson(lines: string[]): { person: string; role: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const role = ROLES.find(([re]) => re.test(line));
    if (!role) continue;
    // Name hinter dem Doppelpunkt in derselben Zeile, sonst in der nächsten Zeile.
    const rest = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line.replace(role[0], "");
    const candidates = [rest, lines[i + 1] ?? ""];
    for (const c of candidates) {
      // Mehrere Namen ("Max Muster, Erika Muster" oder "und") → der erste zählt.
      const first = c.split(/,| und | & /)[0] ?? "";
      const person = cleanPersonName(first);
      if (person) return { person, role: role[1] };
    }
  }
  return null;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Entschärfte Schreibweisen ("info [at] firma [dot] de") zurückverwandeln. */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({]\s*(?:at|ät)\s*[\])}]\s*/gi, "@")
    .replace(/\s+(?:at)\s+(?=[a-z0-9-]+\s*(?:[[({]\s*(?:dot|punkt)\s*[\])}]|\.))/gi, "@")
    .replace(/\s*[[({]\s*(?:dot|punkt)\s*[\])}]\s*/gi, ".");
}

const PHONE_LABEL =
  /^(?:tel(?:efon)?|fon|phone|mobil(?:funk)?|handy|telefonnummer)\b\.?\s*(?:\([^)]*\))?\s*:?\s*/i;
const PHONE = /(?:\+|00)?[\d][\d\s/()–.-]{5,}\d/;

export function parseImpressum(text: string): ImpressumData {
  const lines = deobfuscate(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const joined = lines.join("\n");

  const emails = [
    ...new Set(
      [...joined.matchAll(EMAIL)]
        .map((m) => m[0].toLowerCase().replace(/\.$/, ""))
        .filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/example\.|sentry|wixpress/.test(e)),
    ),
  ].slice(0, 3);

  const phones: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!PHONE_LABEL.test(line) || /fax/i.test(line.slice(0, 6))) continue;
    const after = line.replace(PHONE_LABEL, "");
    const m = PHONE.exec(after) ?? PHONE.exec(lines[i + 1] ?? "");
    if (m) phones.push(m[0].replace(/\s+/g, " ").trim());
  }

  const person = findPerson(lines);
  const vat = /(?:USt[-.\s]*Id|Umsatzsteuer[-\s]*Ident)[^\n]{0,80}?(DE\s?\d{3}\s?\d{3}\s?\d{3})/i.exec(
    joined,
  );
  const register = /\b(HR[AB])\s*(?:Nr\.?\s*)?(\d{2,7})/.exec(joined);

  return {
    person: person?.person ?? null,
    role: person?.role ?? null,
    emails,
    phones: [...new Set(phones)].slice(0, 3),
    vat_id: vat ? vat[1]!.replace(/\s/g, "") : null,
    register: register ? `${register[1]} ${register[2]}` : null,
  };
}
