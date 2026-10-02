import pg from "pg";

/** Extensions einmal zentral anlegen, damit parallele Testdateien nicht darum konkurrieren. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("create extension if not exists pg_trgm with schema public");
  await client.end();
}
