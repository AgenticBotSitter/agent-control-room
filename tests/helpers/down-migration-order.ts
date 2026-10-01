/**
 * Derives, from the SQL on disk, the set of down migrations that must be
 * reversed BEFORE one given down migration can run.
 *
 * The ordering is not hand-maintained anywhere. It falls out of the same SQL
 * the test is about to execute:
 *
 *  - `owns` is what a migration's up file brings into being: tables, functions,
 *    indexes, triggers, policies, views, types, sequences and schemas.
 *  - `names` is everything a migration NAMES anywhere across its up and down
 *    files: the same verb set plus REFERENCES, ON, EXECUTE and bare calls,
 *    and every relation a view's query or a policy's expression reads.
 *
 * A down file for migration N cannot run before the down file for migration M
 * (M < N) when N names an object M owns. Dropping M first would remove an
 * object N's own down file still references, so PostgreSQL either refuses with
 * "cannot drop ... because other objects depend on it" or -- worse, for a
 * function -- silently drops a caller's trigger with it and the later down
 * file can no longer remove the table it created.
 *
 * Reading only the down files is not enough, and that is precisely the bug this
 * replaces. 0151 and 0153 build their append-only triggers on
 * `reject_pipeline_unattended_history_mutation()`, a function 0109 owns. No
 * down file mentions that function, so a down-only scan cannot see the edge.
 * The up files carry it, which is why both halves are read.
 *
 * This is a text derivation, so it is a lower bound on the real order, not a
 * replacement for it: the test still executes the downs against a real cluster
 * and fails loudly if the derived rung is incomplete.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const CREATE_PATTERNS: RegExp[] = [
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+|LOCAL\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+|FOREIGN\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."$]+)/gi,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."$]+)/gi,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."$]+)/gi,
  /\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([A-Za-z0-9_."$]+)/gi,
  /\bCREATE\s+POLICY\s+([A-Za-z0-9_."$]+)/gi,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TYPE|DOMAIN|SEQUENCE|SCHEMA)\s+([A-Za-z0-9_."$]+)/gi,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:RECURSIVE\s+|MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."$]+)/gi,
];

// A view's query, and a policy's USING / WITH CHECK expression, are stored as
// parsed trees that PostgreSQL records a dependency for on every relation they
// read -- unlike a PL/pgSQL body, which is plain text until it runs. So a FROM or
// JOIN inside one of these statements is a real edge: 0213's
// control_worker_text_copy_derivations joins 0104's work_batch_queue_admissions,
// and 0104's down fails with "cannot drop table ... because other objects depend
// on it" unless 0213's down has run first. The verb patterns below never see a
// FROM, so these statements are read separately.
const DEPENDENT_STATEMENTS = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP(?:ORARY)?\s+)?(?:RECURSIVE\s+|MATERIALIZED\s+)?VIEW|POLICY)\b[^;]*;/gi;
const RELATION_READS = /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?([A-Za-z0-9_."$]+)/gi;

const REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:ALTER|DROP|TRUNCATE|LOCK)\s+(?:TABLE\s+|FUNCTION\s+|INDEX\s+|TRIGGER\s+|POLICY\s+|TYPE\s+|DOMAIN\s+)?(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_."$]+)/gi,
  /\bREFERENCES\s+([A-Za-z0-9_."$]+)/gi,
  /\bON\s+(?:public\.)?([A-Za-z0-9_."$]+)/gi,
  /\bEXECUTE\s+'?([A-Za-z0-9_."$]+)/gi,
  /\b([A-Za-z0-9_$]+)\s*\(\)/g,
];

export const stripSqlComments = (sql: string) =>
  sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const normalise = (raw: string) => raw.replace(/^public\./i, "").toLowerCase();

function readNames(sql: string, into: Set<string>) {
  for (const pattern of REFERENCE_PATTERNS) for (const m of sql.matchAll(pattern)) into.add(normalise(m[1]!));
  for (const statement of sql.matchAll(DEPENDENT_STATEMENTS))
    for (const m of statement[0].matchAll(RELATION_READS)) into.add(normalise(m[1]!));
}

/** The four-digit ordering prefix every migration and down file is named with. */
export const migrationOrdinal = (file: string) => Number(file.slice(0, 4));

const bare = (name: string) => (name.endsWith("()") ? name.slice(0, -2) : name);

export type MigrationGraph = {
  /** Down file name -> down files that must run after it. */
  readonly before: ReadonlyMap<string, ReadonlySet<string>>;
  /** Down file name -> the earlier migrations whose objects make it wait. */
  readonly reasons: ReadonlyMap<string, readonly string[]>;
  /** Every down file, newest first. */
  readonly downFiles: readonly string[];
};

export async function readMigrationGraph(root = "."): Promise<MigrationGraph> {
  const migrationDir = join(root, "db", "migrations");
  const downDir = join(root, "db", "down");
  const ups = (await readdir(migrationDir)).filter(f => f.endsWith(".sql")).sort();
  const downs = (await readdir(downDir)).filter(f => f.endsWith(".sql")).sort();

  const owned = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();

  for (const file of ups) {
    const sql = stripSqlComments(await readFile(join(migrationDir, file), "utf8"));
    const created = new Set<string>();
    for (const pattern of CREATE_PATTERNS) for (const m of sql.matchAll(pattern)) created.add(normalise(m[1]!));
    owned.set(file, created);
  }
  for (const file of ups) {
    const sql = stripSqlComments(await readFile(join(migrationDir, file), "utf8"));
    const referenced = names.get(file) ?? new Set<string>();
    readNames(sql, referenced);
    names.set(file, referenced);
  }
  for (const file of downs) {
    const sql = stripSqlComments(await readFile(join(downDir, file), "utf8"));
    const referenced = new Set<string>();
    readNames(sql, referenced);
    // Merge into the up file's set under the same key so one migration's up and
    // down halves are read as a single statement of what it touches.
    const merged = names.get(file) ?? new Set<string>();
    for (const name of referenced) merged.add(name);
    names.set(file, merged);
  }

  const downFor = new Map<string, string>();
  for (const file of downs) downFor.set(file.slice(0, 4), file);

  const before = new Map<string, Set<string>>();
  const reasons = new Map<string, string[]>();
  for (const [later, referenced] of names) {
    const laterOrdinal = migrationOrdinal(later);
    for (const [owner, created] of owned) {
      if (migrationOrdinal(owner) >= laterOrdinal) continue;
      const hits = [...created].filter(name => referenced.has(name) || referenced.has(`${bare(name)}()`));
      if (hits.length === 0) continue;
      const ownerDown = downFor.get(owner.slice(0, 4));
      if (!ownerDown || ownerDown === later) continue;
      if (!before.has(ownerDown)) before.set(ownerDown, new Set());
      before.get(ownerDown)!.add(later);
      reasons.set(ownerDown, [...(reasons.get(ownerDown) ?? []), `${owner.slice(0, 4)}: ${hits.join(", ")}`]);
    }
  }

  return { before, reasons, downFiles: [...downs].sort((a, b) => migrationOrdinal(b) - migrationOrdinal(a)) };
}

export type DownRung = {
  /** Down files to execute before the target, newest first. */
  readonly files: readonly string[];
  /** Why each one has to come first. */
  readonly because: ReadonlyMap<string, readonly string[]>;
};

/**
 * The derived rung: every down file that has to run before `target`, newest
 * first, transitively. `target` itself is never included.
 *
 * `before` reads "earlier down file -> later down files that wait for it", so
 * the rung is the FORWARD closure of the target over that map: start at the
 * target, and every later file it points at has to be reversed before it too.
 */
export function downRungBefore(graph: MigrationGraph, target: string): DownRung {
  const files = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const later of graph.before.get(current) ?? []) {
      if (later === target || files.has(later)) continue;
      files.add(later);
      queue.push(later);
    }
  }
  const because = new Map<string, readonly string[]>();
  for (const file of files) because.set(file, graph.reasons.get(file) ?? []);
  return { files: [...files].sort((a, b) => migrationOrdinal(b) - migrationOrdinal(a)), because };
}
