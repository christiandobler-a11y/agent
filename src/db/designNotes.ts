import type { DbClient } from "./client.js";

/** Vorbild-Notizen aus der Kalibrierung (Migration 014): Was Christian an einer Website gefällt. */

export interface DesignNote {
  id: string;
  company_id: string | null;
  branch_key: string | null;
  url: string | null;
  name: string;
  note: string;
  created_at: Date;
}

export async function addDesignNote(
  db: DbClient,
  n: {
    companyId: string | null;
    branchKey: string | null;
    url: string | null;
    name: string;
    note: string;
    by: string;
  },
): Promise<DesignNote> {
  const { rows } = await db.query<DesignNote>(
    `insert into design_notes (company_id, branch_key, url, name, note, created_by)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [n.companyId, n.branchKey, n.url, n.name, n.note.trim().slice(0, 2000), n.by],
  );
  return rows[0]!;
}

/** Notizen einer Branche (oder alle), neueste zuerst. */
export async function designNotes(
  db: DbClient,
  branchKey?: string | null,
  limit = 50,
): Promise<DesignNote[]> {
  const { rows } = await db.query<DesignNote>(
    `select * from design_notes where ($1::text is null or branch_key = $1)
      order by created_at desc limit $2`,
    [branchKey ?? null, limit],
  );
  return rows;
}
