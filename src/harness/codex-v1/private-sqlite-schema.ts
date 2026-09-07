import type { DatabaseSync } from "node:sqlite";

export interface PrivateSqliteColumnV1 { name: string; type: string; notnull: number; pk: number }

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\s*([(),=])\s*/g, "$1").trim();
}

/** Rejects altered security-state schemas, including every trigger and view. */
export function assertPrivateSqliteSchemaV1(db: DatabaseSync, expectedObjects: readonly string[],
  expectedColumns: Readonly<Record<string, readonly PrivateSqliteColumnV1[]>>,
  expectedSql: Readonly<Record<string, string>>): void {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const objects = rows.map((row) => `${row.type}:${row.name}`).sort();
  const expected = [...expectedObjects].sort();
  if (objects.length !== expected.length || objects.some((value, index) => value !== expected[index])) {
    throw new Error("private SQLite schema objects invalid");
  }
  if (Object.keys(expectedSql).length !== rows.length || rows.some((row) => typeof row.sql !== "string"
    || expectedSql[row.name] === undefined || normalizeSql(row.sql) !== normalizeSql(expectedSql[row.name]))) {
    throw new Error("private SQLite schema definitions invalid");
  }
  for (const [table, columns] of Object.entries(expectedColumns)) {
    if (!/^[a-z][a-z0-9_]{2,79}$/.test(table)) throw new Error("private SQLite schema table invalid");
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>)
      .map(({ name, type, notnull, pk }) => ({ name, type: type.toUpperCase(), notnull, pk }));
    if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error("private SQLite schema columns invalid");
  }
}
