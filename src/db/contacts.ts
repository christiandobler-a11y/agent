import { withTransaction, type Db } from "./client.js";

export interface ContactInput {
  name: string | null;
  salutation?: "Herr" | "Frau" | null;
  role: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Kontakte aus dem Impressum ersetzen (idempotent: ein erneuter Crawl hinterlässt keine Dubletten).
 * Personenbezogene Daten: nur, was im Impressum veröffentlicht ist (ARCHITECTURE.md 12.3).
 */
export async function replaceImpressumContacts(
  db: Db,
  companyId: string,
  contacts: ContactInput[],
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query("delete from contacts where company_id = $1 and source = 'impressum'", [companyId]);
    for (const c of contacts) {
      if (!c.name && !c.email && !c.phone) continue;
      await tx.query(
        `insert into contacts (company_id, name, salutation, role, email, phone, source)
         values ($1, $2, $3, $4, $5, $6, 'impressum')`,
        [companyId, c.name, c.salutation ?? null, c.role, c.email, c.phone],
      );
    }
  });
}
