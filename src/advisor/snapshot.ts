import type { Db } from "../db/client.js";

/**
 * Lagebild für die Berater-Runde: alles aus dem Verlauf berechnet (wie /zahlen), nichts extra gezählt. Die Zahlen
 * gehen als JSON an die Berater; Firmennamen und Mail-Texte bleiben draußen, die Berater brauchen nur Mengen.
 */

/** Eine gesendete Erstmail mit dem, was danach passiert ist. */
export interface MailRow {
  sentAt: Date;
  region: string | null;
  branch: string | null;
  prompt: string | null;
  /** Herkunft des Fotos im Vorschau-Bild: website, google, stock oder "ohne Bild". */
  photo: string;
  weekday: number; // 1 = Montag
  hour: number;
  replied: boolean;
  /** Nachfass-Mails, die vor der ersten Antwort rausgingen (0 = Antwort auf die Erstmail). */
  followupsBeforeReply: number | null;
  autoReply: boolean;
  bounced: boolean;
  interested: boolean;
  won: boolean;
}

export interface Funnel {
  gesendet: number;
  unzustellbar: number;
  antworten: number;
  interessiert: number;
  gewonnen: number;
  antwortquote: string;
}

const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)} %` : "–");

export function funnel(rows: readonly MailRow[]): Funnel {
  const n = (f: (r: MailRow) => boolean) => rows.filter(f).length;
  const replied = n((r) => r.replied);
  return {
    gesendet: rows.length,
    unzustellbar: n((r) => r.bounced),
    antworten: replied,
    interessiert: n((r) => r.interested),
    gewonnen: n((r) => r.won),
    antwortquote: pct(replied, rows.length),
  };
}

/** Trichter je Ausprägung, die größten Gruppen zuerst. Rein. */
export function funnelBy(
  rows: readonly MailRow[],
  key: (r: MailRow) => string,
  max = 12,
): Record<string, Funnel> {
  const groups = new Map<string, MailRow[]>();
  for (const r of rows) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return Object.fromEntries(
    [...groups]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, max)
      .map(([k, list]) => [k, funnel(list)]),
  );
}

const WEEKDAYS = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const hourBucket = (h: number) =>
  h < 9 ? "vor 9" : h < 12 ? "9–12" : h < 15 ? "12–15" : h < 18 ? "15–18" : "ab 18";

/** Wann kam die erste Antwort: auf die Erstmail oder nach der wievielten Nachfass-Mail? Rein. */
export function replyStages(rows: readonly MailRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.replied || r.followupsBeforeReply === null) continue;
    const k = r.followupsBeforeReply === 0 ? "auf Erstmail" : `nach Nachfass ${r.followupsBeforeReply}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface CoverageLine {
  region: string;
  branche: string;
  orte_erledigt: number;
  orte_gesamt: number;
}

export interface PastSuggestion {
  datum: string;
  bereich: string;
  titel: string;
  vorschlag: string;
  status: string;
  entschieden: string | null;
}

export interface Snapshot {
  stand: string;
  erste_mail: string | null;
  tage_seit_start: number;
  insgesamt: Funnel & { nachfass_mails: number; abwesenheitsnotizen: number };
  letzte_7_tage: Funnel;
  je_foto: Record<string, Funnel>;
  je_mail_version: Record<string, Funnel>;
  je_region: Record<string, Funnel>;
  je_wochentag: Record<string, Funnel>;
  je_uhrzeit: Record<string, Funnel>;
  antwort_wann: Record<string, number>;
  neue_mails_je_tag_14_tage: Record<string, number>;
  leads_je_status: Record<string, number>;
  kontaktierbar_noch_offen: number;
  abdeckung: CoverageLine[];
  kosten_28_tage_usd: Record<string, number>;
  einstellungen: Record<string, unknown>;
  fruehere_vorschlaege: PastSuggestion[];
}

const berlinDay = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

export async function mailRows(db: Db): Promise<MailRow[]> {
  const { rows } = await db.query<{
    sent_at: Date;
    region: string | null;
    branch_key: string | null;
    prompt: string | null;
    photo: string;
    dow: number;
    hour: number;
    first_reply: Date | null;
    follow_before: number;
    auto_reply: boolean;
    bounced: boolean;
    interested: boolean;
    won: boolean;
  }>(
    `with first as (
       select distinct on (i.company_id) i.company_id, (i.meta->>'sent_at')::timestamptz as sent_at,
              i.meta->>'prompt' as prompt, i.meta ? 'bounced_at' as bounced,
              coalesce(i.meta->'teaser_look'->>'quelle', case when i.meta ? 'teaser' then 'stock' else 'ohne Bild' end)
                as photo
         from interactions i
        where i.type = 'draft' and i.channel = 'email' and i.meta ? 'sent_at'
          and coalesce((i.meta->>'follow_up')::boolean, false) = false and not (i.meta ? 'termin')
        order by i.company_id, (i.meta->>'sent_at')::timestamptz
     ), replies as (
       select company_id, min(created_at) as first_reply from interactions
        where type = 'note' and created_by = 'mail' and body like 'Antwort%' group by company_id
     )
     select f.sent_at, c.region, c.branch_key, f.prompt, f.photo, f.bounced,
            extract(isodow from f.sent_at at time zone 'Europe/Berlin')::int as dow,
            extract(hour from f.sent_at at time zone 'Europe/Berlin')::int as hour,
            r.first_reply,
            (select count(*)::int from interactions x
              where x.company_id = f.company_id and x.type = 'draft' and x.meta ? 'sent_at'
                and coalesce((x.meta->>'follow_up')::boolean, false)
                and (x.meta->>'sent_at')::timestamptz < coalesce(r.first_reply, 'infinity')) as follow_before,
            exists (select 1 from interactions a where a.company_id = f.company_id and a.type = 'note'
                     and a.created_by = 'mail' and a.body like 'Automatische Antwort%') as auto_reply,
            exists (select 1 from interactions s where s.company_id = f.company_id and s.type = 'status'
                     and s.to_status = 'INTERESTED') as interested,
            exists (select 1 from interactions s where s.company_id = f.company_id and s.type = 'status'
                     and s.to_status = 'WON') as won
       from first f join companies c on c.id = f.company_id
       left join replies r on r.company_id = f.company_id`,
  );
  return rows.map((r) => ({
    sentAt: r.sent_at,
    region: r.region,
    branch: r.branch_key,
    prompt: r.prompt,
    photo: r.photo,
    weekday: r.dow,
    hour: r.hour,
    replied: r.first_reply !== null,
    followupsBeforeReply: r.first_reply ? r.follow_before : null,
    autoReply: r.auto_reply,
    bounced: r.bounced,
    interested: r.interested,
    won: r.won,
  }));
}

export interface SnapshotDeps {
  db: Db;
  now: Date;
  /** Abdeckung je Region × Branche (aus src/pipeline/research/coverage.ts); fehlt sie, bleibt die Liste leer. */
  coverage?: () => Promise<CoverageLine[]>;
  /** Wichtige Einstellungen (Stufen, Regionen, Branchen), damit die Berater wissen, woran man drehen kann. */
  settings: Record<string, unknown>;
  branches: readonly string[];
}

export async function buildSnapshot(deps: SnapshotDeps): Promise<Snapshot> {
  const { db, now } = deps;
  const rows = await mailRows(db);
  const first = rows.reduce<Date | null>((m, r) => (!m || r.sentAt < m ? r.sentAt : m), null);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const { rows: totals } = await db.query<{ follow: number; auto: number }>(
    `select
       (select count(*)::int from interactions where type = 'draft' and channel = 'email' and meta ? 'sent_at'
          and coalesce((meta->>'follow_up')::boolean, false)) as follow,
       (select count(distinct company_id)::int from interactions
          where type = 'note' and created_by = 'mail' and body like 'Automatische Antwort%') as auto`,
  );
  const perDay: Record<string, number> = {};
  for (const r of rows)
    if (now.getTime() - r.sentAt.getTime() < 14 * 86_400_000) {
      const d = berlinDay(r.sentAt);
      perDay[d] = (perDay[d] ?? 0) + 1;
    }
  const { rows: status } = await db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from companies
      where cardinality($1::text[]) = 0 or branch_key = any($1) group by status order by n desc`,
    [deps.branches],
  );
  const { rows: open } = await db.query<{ n: number }>(
    `select count(*)::int as n from companies c
      where c.status in ('QUALIFIED', 'READY_FOR_CONTACT')
        and (cardinality($1::text[]) = 0 or c.branch_key = any($1))
        and not exists (select 1 from interactions i where i.company_id = c.id and i.type = 'draft'
                         and i.meta ? 'sent_at')`,
    [deps.branches],
  );
  const { rows: costs } = await db.query<{ k: string; usd: number }>(
    `select 'LLM ' || role as k, sum(cost_usd)::float as usd from agent_runs
      where started_at >= $1 group by role
     union all
     select service || ' ' || operation, sum(cost_usd)::float from api_usage where created_at >= $1
      group by service, operation`,
    [new Date(now.getTime() - 28 * 86_400_000)],
  );
  const { rows: past } = await db.query<{
    created_at: Date;
    area: string;
    title: string;
    proposal: string;
    status: string;
    decided_at: Date | null;
  }>(
    `select created_at, area, title, proposal, status, decided_at from advisor_suggestions
      where created_at >= $1 order by created_at desc limit 40`,
    [new Date(now.getTime() - 84 * 86_400_000)],
  );
  return {
    stand: berlinDay(now),
    erste_mail: first ? berlinDay(first) : null,
    tage_seit_start: first ? Math.floor((now.getTime() - first.getTime()) / 86_400_000) : 0,
    insgesamt: {
      ...funnel(rows),
      nachfass_mails: totals[0]?.follow ?? 0,
      abwesenheitsnotizen: totals[0]?.auto ?? 0,
    },
    letzte_7_tage: funnel(rows.filter((r) => r.sentAt >= weekAgo)),
    je_foto: funnelBy(rows, (r) => r.photo),
    je_mail_version: funnelBy(rows, (r) => r.prompt ?? "unbekannt"),
    je_region: funnelBy(rows, (r) => r.region ?? "unbekannt"),
    je_wochentag: funnelBy(rows, (r) => WEEKDAYS[r.weekday] ?? "?"),
    je_uhrzeit: funnelBy(rows, (r) => hourBucket(r.hour)),
    antwort_wann: replyStages(rows),
    neue_mails_je_tag_14_tage: perDay,
    leads_je_status: Object.fromEntries(status.map((s) => [s.status, s.n])),
    kontaktierbar_noch_offen: open[0]?.n ?? 0,
    abdeckung: deps.coverage ? await deps.coverage().catch(() => []) : [],
    kosten_28_tage_usd: Object.fromEntries(costs.map((c) => [c.k, Math.round(c.usd * 100) / 100])),
    einstellungen: deps.settings,
    fruehere_vorschlaege: past.map((p) => ({
      datum: berlinDay(p.created_at),
      bereich: p.area,
      titel: p.title,
      vorschlag: p.proposal,
      status: p.status,
      entschieden: p.decided_at ? berlinDay(p.decided_at) : null,
    })),
  };
}
