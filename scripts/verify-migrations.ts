import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const database = new PGlite();
const migrationsRoot = resolve("db/migrations");
const files = (await readdir(migrationsRoot)).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  const sql = await readFile(resolve(migrationsRoot, file), "utf8");
  await database.exec(sql);
  console.log(`applied ${file}`);
}

const result = await database.query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
);

console.log(`verified ${result.rows.length} PostgreSQL tables`);
await database.close();
