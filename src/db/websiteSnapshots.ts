import type { DbClient } from "./client.js";

export interface WebsiteSnapshotInput {
  companyId: string;
  url: string;
  finalUrl?: string | null;
  httpStatus?: number | null;
  https?: boolean | null;
  facts?: object | null;
  psi?: object | null;
  screenshotDesktop?: string | null;
  screenshotMobile?: string | null;
  contentHash?: string | null;
  textExcerpt?: string | null;
  error?: string | null;
  errorKind?: string | null;
}

export interface WebsiteSnapshot {
  id: string;
  company_id: string;
  fetched_at: Date;
  url: string;
  final_url: string | null;
  http_status: number | null;
  https: boolean | null;
  facts: Record<string, unknown> | null;
  psi: Record<string, unknown> | null;
  screenshot_desktop: string | null;
  screenshot_mobile: string | null;
  content_hash: string | null;
  text_excerpt: string | null;
  error: string | null;
  error_kind: string | null;
}

const json = (v: object | null | undefined) => (v ? JSON.stringify(v) : null);

export async function insertWebsiteSnapshot(db: DbClient, s: WebsiteSnapshotInput): Promise<WebsiteSnapshot> {
  const { rows } = await db.query<WebsiteSnapshot>(
    `insert into website_snapshots (
       company_id, url, final_url, http_status, https, facts, psi, screenshot_desktop, screenshot_mobile,
       content_hash, text_excerpt, error, error_kind
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      s.companyId,
      s.url,
      s.finalUrl ?? null,
      s.httpStatus ?? null,
      s.https ?? null,
      json(s.facts),
      json(s.psi),
      s.screenshotDesktop ?? null,
      s.screenshotMobile ?? null,
      s.contentHash ?? null,
      s.textExcerpt ?? null,
      s.error ?? null,
      s.errorKind ?? null,
    ],
  );
  return rows[0]!;
}

export async function latestWebsiteSnapshot(
  db: DbClient,
  companyId: string,
): Promise<WebsiteSnapshot | null> {
  const { rows } = await db.query<WebsiteSnapshot>(
    "select * from website_snapshots where company_id = $1 order by fetched_at desc limit 1",
    [companyId],
  );
  return rows[0] ?? null;
}
