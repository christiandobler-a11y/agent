import type { DbClient } from "./client.js";

export interface TableStatus {
  name: string;
  rows: number;
  rls: boolean;
  /** Darf die Supabase-Rolle `anon` (öffentlicher API-Key) lesen? `null`, wenn es die Rolle nicht gibt. */
  anonCanRead: boolean | null;
}

export interface DbStatus {
  schema: string;
  migrations: { version: string; applied_at: Date }[];
  tables: TableStatus[];
}

/** Überblick über das aktuelle Schema: angewendete Migrationen, Tabellen, Zeilen, Zugriffsschutz. */
export async function dbStatus(db: DbClient): Promise<DbStatus> {
  const { rows: meta } = await db.query<{ schema: string; has_migrations: boolean; has_anon: boolean }>(
    `select current_schema() as schema,
            to_regclass('schema_migrations') is not null as has_migrations,
            exists (select 1 from pg_roles where rolname = 'anon') as has_anon`,
  );
  const { schema, has_migrations, has_anon } = meta[0]!;

  const migrations = has_migrations
    ? (
        await db.query<{ version: string; applied_at: Date }>(
          "select version, applied_at from schema_migrations order by version",
        )
      ).rows
    : [];

  const { rows: tables } = await db.query<{ name: string; rls: boolean; anon_can_read: boolean | null }>(
    `select c.relname as name, c.relrowsecurity as rls,
            case when $1 then has_table_privilege('anon', c.oid, 'select') end as anon_can_read
       from pg_class c
      where c.relnamespace = current_schema()::regnamespace and c.relkind = 'r'
      order by c.relname`,
    [has_anon],
  );

  const result: TableStatus[] = [];
  for (const t of tables) {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from "${t.name.replace(/"/g, '""')}"`,
    );
    result.push({ name: t.name, rows: rows[0]!.n, rls: t.rls, anonCanRead: t.anon_can_read });
  }
  return { schema, migrations, tables: result };
}
