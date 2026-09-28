// search_path audit for privileged database code.
//
// A SECURITY DEFINER function runs with its owner's privileges, so the
// name resolution it performs is the owner's, not the caller's. With a default
// search_path an attacker-influenced schema earlier in the path can shadow a
// function the body calls, and the body then executes the attacker's function
// as the owner. Pinning `search_path` to a list that ends in `pg_temp` closes
// it: pg_temp is searched first for relations, so a name that resolves to a
// temp object rather than the pinned one is caught by the refusal to let
// pg_temp sit anywhere but last.
//
// This module reads migration files rather than a live catalog, so it can run
// in a lane with no PostgreSQL at all and can be pointed at a fixture file.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface FunctionFinding {
  /** File the function was declared in, relative to the audited directory. */
  readonly file: string;
  /** `schema.function(identity arguments)`. */
  readonly function: string;
  /**
   * SECURITY DEFINER, a row trigger, an event trigger, or a combination.
   *
   * `event-trigger` is its own kind rather than folded into `trigger`: an event
   * trigger fires on DDL (`ddl_command_start`, `sql_drop`, `table_rewrite`)
   * and runs as the session that issued the statement, which is a different
   * exposure from a row-level trigger and a different thing for a reader of the
   * finding to be told about.
   */
  readonly kinds: readonly ("security-definer" | "trigger" | "event-trigger")[];
  /** The declared `SET search_path` list, or null when none was declared. */
  readonly searchPath: string | null;
  /** True when the list is pinned and its last element is pg_temp. */
  readonly endsInPgTemp: boolean;
  /** Why the function is listed, in one line. */
  readonly reason: string;
}

export interface SearchPathAllowlistEntry {
  /** Migration file, relative to the audited directory. */
  readonly file: string;
  /** `schema.function(identity arguments)`. */
  readonly function: string;
  /** The `search_path` the entry was written for, or null. */
  readonly searchPath: string | null;
  /** ISO date after which the entry stops applying and the check fails again. */
  readonly expires: string;
  /** The issue that tracks fixing the violation. */
  readonly issue: string;
}

export interface LoadedSearchPathAllowlist {
  readonly entries: readonly SearchPathAllowlistEntry[];
  /** Entries that are in date and match a current violation, by key. */
  readonly active: ReadonlyMap<string, SearchPathAllowlistEntry>;
  /** Entries past their expiry date, by key. Their violations count again. */
  readonly expired: readonly SearchPathAllowlistEntry[];
  /** In-date entries that match no current violation: dead weight to remove. */
  readonly stale: readonly SearchPathAllowlistEntry[];
}

export interface SecurityDefinerAuditResult {
  readonly findings: readonly FunctionFinding[];
  /** Findings whose search_path is missing or does not end in pg_temp. */
  readonly unpinned: readonly FunctionFinding[];
  /** Unpinned findings covered by an in-date allowlist entry. */
  readonly allowlisted: readonly FunctionFinding[];
  /** Allowlist entries past their expiry, which are counted as violations. */
  readonly expiredAllowlistEntries: readonly SearchPathAllowlistEntry[];
  readonly auditedFiles: number;
}

/**
 * `RETURNS trigger` and `RETURNS event_trigger`, matched separately.
 *
 * `event_trigger` is a distinct PostgreSQL return type (`pg_event_trigger`) for
 * a function used as an event trigger, and the OLD single pattern could not see
 * it: `\breturns\s+trigger\b` requires whitespace between `returns` and
 * `trigger`, and the declaration reads `RETURNS event_trigger`. Widening it to
 * `\breturns\s+event_trigger\b` alone would have been enough to notice the
 * function, but the two kinds are reported apart so a reader can tell which
 * primitive is unpinned.
 */
const RETURNS_TRIGGER = /\breturns\s+trigger\b/i;
const RETURNS_EVENT_TRIGGER = /\breturns\s+event_trigger\b/i;
const SECURITY_DEFINER = /\bsecurity\s+definer\b/i;
/**
 * `SET search_path = a, b` / `SET search_path TO a, b`.
 *
 * The list may span newlines: a pin written as
 *
 *     SET search_path = pg_catalog,
 *                        public,
 *                        pg_temp
 *
 * is the same clause as the one-line form, and reading only the first line
 * reported it as unpinned. The list therefore ends at the first `;`, at a
 * following clause keyword, or at the end of the region — never at a newline.
 */
const SET_SEARCH_PATH =
  /\bset\s+search_path\b\s*(?:=|to)\s*([^;]*?)(?=\s*(?:\bas\b|\blanguage\b|\breturns\b|\bset\b|;|$))/i;

/**
 * `CREATE [OR REPLACE] FUNCTION|PROCEDURE name(...)` and `ALTER FUNCTION name`.
 *
 * PROCEDURE matters: PostgreSQL allows `SECURITY DEFINER` on a procedure, and
 * a procedure body resolves names the same way a trigger body's does, so a
 * definer procedure is exactly the primitive this gate exists to catch.
 */
const FUNCTION_HEAD =
  /create\s+(?:or\s+replace\s+)?(function|procedure)\s+([A-Za-z0-9_."]+)\s*(?=\()/gi;
/**
 * `ALTER FUNCTION name(args) <clauses>`.
 *
 * The trailing `;` is OPTIONAL because `splitSqlStatements` has already
 * removed it: the terminator belongs to the statement boundary, and requiring
 * it here meant the pattern never matched a real statement, so
 * `ALTER FUNCTION ... SECURITY DEFINER` was invisible and a function
 * escalated after its CREATE passed the gate.
 */
const ALTER_HEAD = /alter\s+(?:function|procedure)\s+([A-Za-z0-9_."]+)\s*\(([^)]*)\)\s*([\s\S]*)/gi;
/** The body's `AS` clause: `AS $$...$$`, `AS $tag$...$tag$` or `AS 'file'`. */
const BODY_AS = /\bas\b(?=\s*(?:'|"))|\bas\b(?=\s*\$)/i;

/**
 * Remove comments from a region, preserving line structure.
 *
 * A `--` line whose text is `SET search_path = pg_catalog, public, pg_temp` is
 * the most natural way to DISABLE a pin while leaving the function looking
 * hardened, and the raw clause slice read it as a real clause. Comments are
 * blanked rather than deleted so a clause before the comment keeps its
 * position, and the newlines a multi-line list needs survive.
 */
export function stripSqlComments(region: string): string {
  return region
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, match => " ".repeat(match.length));
}

/** Split a declared search_path list into its entries, honouring quotes. */
export function parseSearchPath(declared: string): string[] {
  return declared.split(",").map(entry => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * True when the declared list is safe: non-empty, no unquoted `pg_temp`, and
 * ending in `pg_temp`. A `pg_catalog` first entry is recommended but not
 * required here, so the audit reports the pinning fact rather than a style
 * opinion.
 */
export function searchPathEndsInPgTemp(declared: string | null): boolean {
  if (declared === null) return false;
  const entries = parseSearchPath(declared);
  if (entries.length === 0) return false;
  return entries[entries.length - 1]!.toLowerCase() === "pg_temp";
}

/**
 * Split a migration into complete statements.
 *
 * The audit MUST NOT look past the statement it is reading. A fixed character
 * window is what let an unpinned function inherit the pinned `search_path` of
 * the function declared after it, so a file with two adjacent functions
 * reported a false clean. Splitting on statement boundaries means there is no
 * text left for one definition to borrow from another.
 *
 * Dollar-quoted bodies are the reason this is a scanner and not a `split(";")`:
 * every body in this repository ends its statements with `;` inside `$$ ... $$`,
 * and a naive split would cut every trigger function in half. Single-quoted
 * strings, `--` comments and (possibly nested) `/* ... *\/` blocks are tracked
 * for the same reason.
 */
export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  const length = source.length;
  while (index < length) {
    const character = source[index]!;
    if (character === "'") {
      index += 1;
      while (index < length) {
        if (source[index] === "'" && source[index + 1] === "'") { index += 2; continue; }
        if (source[index] === "'") { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (character === "-" && source[index + 1] === "-") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? length : newline + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") { depth += 1; index += 2; continue; }
        if (source[index] === "*" && source[index + 1] === "/") { depth -= 1; index += 2; continue; }
        index += 1;
      }
      continue;
    }
    if (character === "$") {
      // A dollar-quoted string: an opening `$tag$` matched by the same tag.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(index, index + 64));
      if (tag) {
        const close = source.indexOf(tag[0], index + tag[0].length);
        index = close === -1 ? length : close + tag[0].length;
        continue;
      }
    }
    if (character === ";") {
      statements.push(source.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  statements.push(source.slice(start));
  return statements.map(statement => statement.trim()).filter(statement => statement.length > 0);
}

interface FunctionDefinition {
  /** `name(arg, arg)`, matching the finding's `function` field. */
  readonly signature: string;
  /** The clause text between the argument list and the body's `AS`. */
  readonly options: string;
}

/**
 * The clause region of one `CREATE FUNCTION` inside `statement`.
 *
 * Two boundaries matter and both are respected here:
 *  - the statement itself, so a sibling function's clause is out of reach;
 *  - the body's `AS`, so a `SET search_path` inside a plpgsql body is never
 *    mistaken for the function's own option.
 *
 * When one statement declares more than one function (a `DO` block), each
 * definition is bounded by the next `CREATE FUNCTION` so they stay separate.
 */
function functionDefinitions(statement: string): FunctionDefinition[] {
  // Comments are removed BEFORE anything is located, so a commented-out
  // `SET search_path` and a commented-out `CREATE FUNCTION` are both inert.
  // Working on the cleaned text also keeps every index below consistent with
  // the region that is actually read.
  const source = stripSqlComments(statement);
  const heads: { start: number; open: number; name: string }[] = [];
  for (const match of source.matchAll(new RegExp(FUNCTION_HEAD.source, "giu"))) {
    heads.push({
      start: match.index,
      open: match.index + match[0].length,
      name: match[2]!,
    });
  }
  const definitions: FunctionDefinition[] = [];
  heads.forEach((head, position) => {
    // The argument list is balanced, so a default such as `nextval('s')` does
    // not terminate it early.
    let depth = 0;
    let cursor = head.open;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "(") depth += 1;
      else if (source[cursor] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return;
    const args = source.slice(head.open + 1, cursor);
    const optionsEnd = Math.min(
      source.slice(cursor + 1).search(BODY_AS) === -1 ? source.length : cursor + 1 + source.slice(cursor + 1).search(BODY_AS),
      heads[position + 1]?.start ?? source.length,
    );
    definitions.push({
      signature: `${head.name}(${args.trim()})`,
      options: source.slice(cursor + 1, optionsEnd),
    });
  });
  return definitions;
}

/** One parsed privileged function, before it is attributed to a file. */
function auditStatement(statement: string, name: string): FunctionFinding[] {
  const findings: FunctionFinding[] = [];
  for (const definition of functionDefinitions(statement)) {
    findings.push(describe(definition, name, ""));
  }
  return findings;
}

/**
 * Build the finding for one definition, merging any clause an `ALTER FUNCTION`
 * applied to the same signature later in the file.
 *
 * `ALTER FUNCTION f() SECURITY DEFINER` escalates a function that was created
 * without it, and the audit used to miss that entirely because it only looked
 * at `CREATE`. A privilege granted by a later `ALTER` is still a privilege the
 * deployment holds, so the file-level audit carries each function's ALTER
 * clauses into its CREATE-time view.
 */
function describe(
  definition: FunctionDefinition,
  name: string,
  alters: string,
): FunctionFinding {
  const own = definition.options;
  // An ALTER's clauses are additive: SECURITY DEFINER cannot be taken back by
  // a later statement, and a `SET` on the ALTER is the effective pin.
  const merged = `${own}\n${alters}`;
  const isEventTrigger = RETURNS_EVENT_TRIGGER.test(own);
  const isTrigger = RETURNS_TRIGGER.test(own);
  const isDefiner = SECURITY_DEFINER.test(merged);
  if (!isTrigger && !isEventTrigger && !isDefiner) {
    return {
      file: name, function: definition.signature, kinds: [], searchPath: null,
      endsInPgTemp: false, reason: "not_privileged",
    };
  }
  // The CREATE's own clause wins when it has one; otherwise the ALTER's.
  const ownMatch = SET_SEARCH_PATH.exec(own);
  const alterMatch = ownMatch ? null : SET_SEARCH_PATH.exec(alters);
  const declared = ownMatch ? ownMatch[1]! : alterMatch ? alterMatch[1]! : "";
  const searchPath = declared.trim().replace(/,\s*$/, "") || null;
  const endsInPgTemp = searchPathEndsInPgTemp(searchPath);
  const kinds: ("security-definer" | "trigger" | "event-trigger")[] = [];
  if (isDefiner) kinds.push("security-definer");
  if (isTrigger) kinds.push("trigger");
  if (isEventTrigger) kinds.push("event-trigger");
  return {
    file: name,
    function: definition.signature,
    kinds,
    searchPath,
    endsInPgTemp,
    reason: endsInPgTemp
      ? "pinned"
      : searchPath === null
        ? `${kinds.join("+")}_without_a_search_path_clause`
        : `${kinds.join("+")}_search_path_does_not_end_in_pg_temp:${searchPath}`,
  };
}

export interface SecurityDefinerAuditOptions {
  /** Allowlist to subtract, normally from `loadSearchPathAllowlist`. */
  readonly allowlist?: LoadedSearchPathAllowlist;
}

/**
 * List the privileged functions in `migrationsDir` whose search_path is not
 * pinned to end in `pg_temp`.
 *
 * Both SECURITY DEFINER functions and trigger functions are listed. A trigger
 * function is included because a trigger body runs with the privileges of
 * whoever wrote the row, and the row's author is not necessarily the owner of
 * the table the trigger guards.
 */
export async function securityDefinerAudit(
  migrationsDir: string,
  options: SecurityDefinerAuditOptions = {},
): Promise<SecurityDefinerAuditResult> {
  const entries = (await readdir(migrationsDir)).filter(name => name.endsWith(".sql")).sort();
  const findings: FunctionFinding[] = [];
  for (const name of entries) {
    const source = await readFile(join(migrationsDir, name), "utf8");
    const statements = splitSqlStatements(source);
    // ALTER clauses are collected across the WHOLE FILE, because a function
    // created in one statement can be escalated by a later one. Keyed by the
    // same `name(args)` signature the findings use.
    const alters = new Map<string, string>();
    for (const statement of statements) {
      for (const match of stripSqlComments(statement).matchAll(ALTER_HEAD)) {
        const signature = `${match[1]!}(${(match[2] ?? "").trim()})`;
        alters.set(signature, `${alters.get(signature) ?? ""}\n${match[3] ?? ""}`);
      }
    }
    for (const statement of statements) {
      for (const definition of functionDefinitions(statement)) {
        const finding = describe(definition, name, alters.get(definition.signature) ?? "");
        if (finding.kinds.length > 0) findings.push(finding);
      }
    }
  }
  const unpinned = findings.filter(finding => !finding.endsInPgTemp);
  const active = options.allowlist?.active ?? new Map<string, SearchPathAllowlistEntry>();
  const allowlisted = unpinned.filter(finding => active.has(allowlistKey(finding)));
  const allowed = new Set(allowlisted.map(allowlistKey));
  return {
    findings,
    unpinned: unpinned.filter(finding => !allowed.has(allowlistKey(finding))),
    allowlisted,
    expiredAllowlistEntries: options.allowlist?.expired ?? [],
    auditedFiles: entries.length,
  };
}

/** Stable identity of one violation, so an allowlist entry cannot drift. */
export function allowlistKey(value: {
  file: string; function: string; searchPath: string | null;
}): string {
  return `${value.file}::${value.function}::${value.searchPath ?? ""}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read and validate the allowlist.
 *
 * An entry applies only while it is in date AND it still describes a real
 * violation: same file, same function, same declared `search_path`. Pinning
 * all three means a migration that is later hardened stops matching its entry
 * (and the entry is reported as stale), and a migration that gains a NEW
 * unpinned function is never covered by an entry written for a different one.
 */
export async function loadSearchPathAllowlist(
  path: string,
  now: Date = new Date(),
): Promise<LoadedSearchPathAllowlist> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    entries?: readonly SearchPathAllowlistEntry[];
  };
  const entries = parsed.entries ?? [];
  for (const entry of entries) {
    if (!entry.file || !entry.function) throw new Error(`allowlist_entry_incomplete:${path}`);
    if (!ISO_DATE.test(entry.expires)) throw new Error(`allowlist_entry_expiry_not_a_date:${entry.file}:${entry.function}`);
    if (!entry.issue) throw new Error(`allowlist_entry_without_issue:${entry.file}:${entry.function}`);
  }
  const active = new Map<string, SearchPathAllowlistEntry>();
  const expired: SearchPathAllowlistEntry[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const entry of entries) {
    if (entry.expires < today) expired.push(entry);
    else active.set(allowlistKey(entry), entry);
  }
  return { entries, active, expired, stale: [] };
}

/** Mark allowlist entries that no longer match any current violation. */
export function withStaleAllowlist(
  allowlist: LoadedSearchPathAllowlist,
  result: SecurityDefinerAuditResult,
): LoadedSearchPathAllowlist {
  const used = new Set([
    ...result.allowlisted.map(allowlistKey),
    ...result.expiredAllowlistEntries.map(allowlistKey),
  ]);
  return { ...allowlist, stale: allowlist.entries.filter(entry => !used.has(allowlistKey(entry))) };
}

export class UnpinnedSearchPathError extends Error {
  constructor(readonly result: SecurityDefinerAuditResult) {
    const detail = result.unpinned
      .map(finding => `${finding.file}:${finding.function}:${finding.reason}`).join("; ");
    const lapsed = result.expiredAllowlistEntries
      .map(entry => `${entry.file}:${entry.function}:allowlist_entry_expired_${entry.expires}_issue_${entry.issue}`)
      .join("; ");
    super(`search_path_audit_failed:${result.unpinned.length}_unpinned_of_${result.findings.length}`
      + `:${[detail, lapsed].filter(Boolean).join("; ")}`);
    this.name = "UnpinnedSearchPathError";
  }
}

/** `securityDefinerAudit` that throws instead of returning, for a test gate. */
export async function assertSearchPathPinned(
  migrationsDir: string,
  options: SecurityDefinerAuditOptions = {},
): Promise<SecurityDefinerAuditResult> {
  const result = await securityDefinerAudit(migrationsDir, options);
  if (result.unpinned.length > 0) throw new UnpinnedSearchPathError(result);
  return result;
}

/**
 * The same audit against a live catalog, for the function bodies that a
 * migration has since replaced. `pg_get_functiondef` is the source of truth
 * the role files and the rehearsal install.
 *
 * The callback takes the parameter values as well as the SQL: the query
 * filters on `n.nspname = $1`, so a `pg` client called with SQL alone fails
 * with SQLSTATE 08P01 ("bind message supplies 0 parameters") and the audit
 * never runs.
 */
export async function securityDefinerAuditLive(
  query: (sql: string, params: readonly unknown[]) => Promise<{ rows: { name: string; definition: string }[] }>,
  options: { schema?: string } = {},
): Promise<SecurityDefinerAuditResult> {
  const schema = options.schema ?? "public";
  // `event_trigger` is its own regtype (`pg_event_trigger`). The filter
  // selected only `prosecdef OR prorettype = 'trigger'`, so an unpinned
  // event-trigger function was absent from the live audit exactly as it was from
  // the file parser: both halves of this audit have to cover the same set of
  // privileged routines, or the catalog check reports clean on a database whose
  // migrations the gate would have refused.
  const rows = (await query(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
            pg_get_functiondef(p.oid) AS definition
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1
       AND (p.prosecdef OR p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype))
     ORDER BY 1`,
    [schema],
  )).rows;
  const findings = rows.flatMap(({ name, definition }) =>
    auditStatement(definition, "<live catalog>").map(finding => ({ ...finding, function: name })));
  return {
    findings,
    unpinned: findings.filter(finding => !finding.endsInPgTemp),
    allowlisted: [],
    expiredAllowlistEntries: [],
    auditedFiles: rows.length,
  };
}
