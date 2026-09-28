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
// THE GATE IS CATALOG-BASED. `securityDefinerAuditLive` reads `pg_proc` from a
// real PostgreSQL cluster built from the real migration ledger, so the answer
// is PostgreSQL's own: `prosecdef`, `prorettype` and the effective
// `proconfig` after every CREATE and every later ALTER/RESET, with real
// identifier parsing. A regex model of PostgreSQL SQL cannot be made sound, and
// two fix rounds of one each closed a reported hole and exposed the next
// (cross-file ALTER, later SET/RESET, nested comments, quoted identifiers,
// `SECURITY DEFINER` after the body). So this module does not try.
//
// `securityDefinerAudit` (the file scanner below) remains ONLY as a fast local
// hint. It is not wired to any CI job and it is not a gate: it cannot be made
// sound, and a caller that treats its output as a verdict is reading a
// different, weaker check than the one that gates the merge.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Why a routine is privileged. `event-trigger` is its own kind: an event
 * trigger fires on DDL and runs as the session that issued the statement,
 * which is a different exposure from a row-level trigger. */
export type PrivilegedKind = "security-definer" | "trigger" | "event-trigger";

export interface FunctionFinding {
  /**
   * The routine's identity: `schema.name(identity arguments)` from a live
   * catalog, or the file-local `name(args)` the file scanner read.
   *
   * This is the allowlist key. For a catalog row it is exactly what
   * `pg_get_function_identity_arguments` reports, so an allowlist entry cannot
   * drift when a migration changes an argument name, a schema spelling, or a
   * type's typmod.
   */
  readonly routine: string;
  /** The file the declaration was read from; null for a catalog row. */
  readonly file: string | null;
  readonly kinds: readonly PrivilegedKind[];
  /** The effective `search_path` value, or null when none is set. */
  readonly searchPath: string | null;
  /** True when the list is pinned and its last element is the bare `pg_temp`. */
  readonly endsInPgTemp: boolean;
  /** Why the routine is listed, in one line. */
  readonly reason: string;
}

export interface SearchPathAllowlistEntry {
  /** Catalog identity: `schema.name(identity arguments)`. */
  readonly routine: string;
  /** The `search_path` the entry was written for, or null. */
  readonly searchPath: string | null;
  /** ISO date the entry was added. The expiry horizon is measured from it. */
  readonly added: string;
  /** ISO date after which the entry stops applying and the check fails again. */
  readonly expires: string;
  /** The issue that tracks fixing the violation. */
  readonly issue: string;
}

export interface LoadedSearchPathAllowlist {
  readonly entries: readonly SearchPathAllowlistEntry[];
  /** In-date entries, by routine identity. */
  readonly active: ReadonlyMap<string, SearchPathAllowlistEntry>;
  /** Entries past their expiry date. Their violations count again, and the
   * entry is itself a failure so a lapsed waiver cannot pass unnoticed. */
  readonly expired: readonly SearchPathAllowlistEntry[];
}

export interface SecurityDefinerAuditResult {
  readonly findings: readonly FunctionFinding[];
  /** Findings whose search_path is missing or does not end in pg_temp. */
  readonly unpinned: readonly FunctionFinding[];
  /** Unpinned findings covered by an in-date allowlist entry. */
  readonly allowlisted: readonly FunctionFinding[];
  /** Allowlist entries past their expiry, which are counted as violations. */
  readonly expiredAllowlistEntries: readonly SearchPathAllowlistEntry[];
  /** In-date entries that match no current violation: dead weight, and a
   * failure, so the list cannot quietly stop being a record of reality. */
  readonly staleAllowlistEntries: readonly SearchPathAllowlistEntry[];
  /** Schemas the audit covered, and any it refused to cover. */
  readonly auditedSchemas: readonly string[];
  readonly unclassifiedSchemas: readonly string[];
  /** Rows the catalog query returned, before privilege selection. */
  readonly catalogRows: number;
}

// ---------------------------------------------------------------------------
// The GUC list parser: how PostgreSQL splits a configuration value.
// ---------------------------------------------------------------------------

/** One element of a comma-separated configuration list. */
export interface GucElement {
  /** The value as PostgreSQL resolves it. Unquoted elements are downcased;
   * a quoted element is case-sensitive and may contain commas and spaces. */
  readonly value: string;
  /** True when the element was written inside double quotes in the raw value. */
  readonly quoted: boolean;
}

/**
 * Split a comma-separated configuration value exactly as PostgreSQL does.
 *
 * PostgreSQL stores a `SET search_path` value as the raw string, normalised
 * only in the ways the parser itself normalises it, and splits it later. So the
 * value `search_path="public, pg_temp"` in `pg_proc.proconfig` is ONE element
 * whose name is the schema literally called `public, pg_temp` — not a two
 * element list. Splitting it on every comma is what let a live audit report a
 * one-element decoy as pinned: `pg_temp` in that single element is searched
 * FIRST, which is the exact exposure the pin exists to close.
 *
 * The rules implemented here are PostgreSQL's, for GUC lists of identifiers:
 *
 *  - elements are separated by `,` and surrounded by optional whitespace;
 *  - a double-quoted element is taken whole, with `""` standing for one `"`;
 *  - an element that is not quoted is downcased, because an unquoted
 *    identifier is folded — so `PUBLIC` and `public` are the same schema;
 *  - an element that IS quoted keeps its case, so `"PG_TEMP"` names a
 *    different schema from `pg_temp` and must not satisfy the pin;
 *  - an empty element (a trailing or doubled comma) is skipped.
 *
 * Verified against PostgreSQL 17: `SET search_path = 'public, pg_temp'` stores
 * `search_path="public, pg_temp"`, `SET search_path = public, "PG_TEMP"` stores
 * `search_path=public, "PG_TEMP"`, and `SET search_path = pg_catalog, "pg_temp"`
 * stores the unquoted `search_path=pg_catalog, pg_temp` — PostgreSQL drops
 * redundant quoting from an identifier, which is why the pin check can require
 * the bare form without false positives.
 */
export function parseGucList(value: string): GucElement[] {
  const elements: GucElement[] = [];
  let index = 0;
  const length = value.length;
  while (index < length) {
    while (index < length && /\s/.test(value[index]!)) index += 1;
    if (index >= length) break;
    if (value[index] === '"') {
      index += 1;
      let quoted = "";
      while (index < length) {
        if (value[index] === '"') {
          if (value[index + 1] === '"') { quoted += '"'; index += 2; continue; }
          index += 1;
          break;
        }
        quoted += value[index]!;
        index += 1;
      }
      elements.push({ value: quoted, quoted: true });
      continue;
    }
    const start = index;
    while (index < length && value[index] !== ",") index += 1;
    const raw = value.slice(start, index).trim();
    if (raw !== "") elements.push({ value: raw.toLowerCase(), quoted: false });
    if (index < length && value[index] === ",") index += 1;
  }
  return elements;
}

/**
 * True when the declared list is safe: non-empty, and its LAST element is the
 * bare identifier `pg_temp`.
 *
 * "Bare" is checked on the raw element as well as the resolved value, and the
 * comparison is case-sensitive. `pg_temp` last is the only shape that closes
 * the exposure: PostgreSQL searches pg_temp first for relations, so any other
 * position — or a different schema that merely looks like it — leaves a temp
 * object able to shadow a name the body resolves.
 */
export function searchPathEndsInPgTemp(declared: string | null): boolean {
  if (declared === null) return false;
  const elements = parseGucList(declared);
  if (elements.length === 0) return false;
  const last = elements[elements.length - 1]!;
  return !last.quoted && last.value === "pg_temp";
}

/** The values of a declared list, for a caller that wants the entries. */
export function parseSearchPath(declared: string): string[] {
  return parseGucList(declared).map(element => element.value);
}

/**
 * The `search_path` element of a routine's `proconfig`, or null.
 *
 * `proconfig` is `text[]`, one `name=value` per element, and it is the
 * EFFECTIVE configuration: every `ALTER FUNCTION ... SET/RESET search_path`
 * already applied. A `RESET` removes the element entirely, which is exactly how
 * PostgreSQL represents "this routine no longer pins anything", so a null here
 * is a real answer rather than a missing measurement. `pg_get_functiondef`
 * cannot be used instead: it prints `SET search_path TO 'public, pg_temp'`, in
 * which a one-element decoy and a two-element list are the same text.
 */
export function proconfigSearchPath(proconfig: readonly string[] | null): string | null {
  for (const entry of proconfig ?? []) {
    const equals = entry.indexOf("=");
    if (equals === -1) continue;
    // A GUC name is case-insensitive, and PostgreSQL preserves the spelling
    // the author used, so `SET SEARCH_PATH` must be found too.
    if (entry.slice(0, equals).trim().toLowerCase() !== "search_path") continue;
    const value = entry.slice(equals + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The live, catalog-based audit. This is the gate.
// ---------------------------------------------------------------------------

/**
 * Every non-system schema, with the privilege flags needed to select the
 * privileged routines in the reader rather than in the query.
 *
 * Selecting privilege in the reader is deliberate. The set of privileged
 * routines is the gate's core promise, and when it lives in a SQL predicate a
 * typo or a dropped cast fails only against a live database. Here it is three
 * ordinary JS branches that a test can delete one at a time and watch a named
 * test fail. `pg_temp`-only roles, `information_schema` and every `pg_*`
 * schema are excluded because the audit is about the application's own code.
 */
const CATALOG_QUERY = `SELECT n.nspname AS schema,
       p.proname AS name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prosecdef AS security_definer,
       p.prorettype::regtype::text AS return_type,
       p.proconfig AS proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
 ORDER BY 1, 2, 3`;

interface CatalogRow {
  readonly schema: string;
  readonly name: string;
  readonly identity_arguments: string;
  readonly security_definer: boolean;
  readonly return_type: string;
  readonly proconfig: string[] | null;
}

export interface CatalogAuditOptions {
  /** Restrict the audit to these schemas. Every non-system schema otherwise. */
  readonly schemas?: readonly string[];
  /** Allowlist to subtract, normally from `loadSearchPathAllowlist`. */
  readonly allowlist?: LoadedSearchPathAllowlist;
  /** Stale entries, when the caller computed them against a file-audit result. */
  readonly staleAllowlistEntries?: readonly SearchPathAllowlistEntry[];
}

/** True for a routine that runs with privileges its caller may not hold, or
 * that is invoked by the server on the caller's behalf. */
function privilegedKinds(row: CatalogRow): PrivilegedKind[] {
  const kinds: PrivilegedKind[] = [];
  if (row.security_definer === true) kinds.push("security-definer");
  if (row.return_type === "trigger") kinds.push("trigger");
  if (row.return_type === "event_trigger") kinds.push("event-trigger");
  return kinds;
}

const describeKinds = (kinds: readonly PrivilegedKind[]): string =>
  kinds.length > 0 ? kinds.join("+") : "routine";

/**
 * The audit the CI gate runs, against a real catalog.
 *
 * The query takes NO parameters and contains no placeholder, so it cannot be
 * called in a way that leaves `$1` unbound — the defect that made the previous
 * live audit fail with SQLSTATE 08P01 against a real `pg` client.
 */
export async function securityDefinerAuditLive(
  query: (sql: string, params: readonly unknown[]) => Promise<{ rows: CatalogRow[] }>,
  options: CatalogAuditOptions = {},
): Promise<SecurityDefinerAuditResult> {
  const rows = (await query(CATALOG_QUERY, [])).rows;
  const present = [...new Set(rows.map(row => row.schema))].sort();
  const wanted = options.schemas === undefined ? null : new Set(options.schemas);
  const schemas = wanted === null ? present : present.filter(schema => wanted.has(schema));
  const selected = rows.filter(row => wanted === null || wanted.has(row.schema));

  const findings: FunctionFinding[] = [];
  for (const row of selected) {
    const kinds = privilegedKinds(row);
    if (kinds.length === 0) continue;
    const searchPath = proconfigSearchPath(row.proconfig);
    const endsInPgTemp = searchPathEndsInPgTemp(searchPath);
    findings.push({
      routine: `${row.schema}.${row.name}(${row.identity_arguments})`,
      file: null,
      kinds,
      searchPath,
      endsInPgTemp,
      reason: endsInPgTemp
        ? "pinned"
        : searchPath === null
          ? `${describeKinds(kinds)}_without_a_search_path_clause`
          : `${describeKinds(kinds)}_search_path_does_not_end_in_pg_temp:${searchPath}`,
    });
  }

  const unpinned = findings.filter(finding => !finding.endsInPgTemp);
  const active = options.allowlist?.active ?? new Map<string, SearchPathAllowlistEntry>();
  const allowlisted = unpinned.filter(finding => active.has(finding.routine));
  const waived = new Set(allowlisted.map(finding => finding.routine));
  // A schema present in the catalog but outside the requested set is REFUSED,
  // not skipped. A narrowed audit that quietly leaves a schema out is the same
  // false clean as a parser that cannot read a definition: the gate has to be
  // able to say "I did not look at that".
  const unclassifiedSchemas = wanted === null ? [] : present.filter(schema => !wanted.has(schema));
  return {
    findings,
    unpinned: unpinned.filter(finding => !waived.has(finding.routine)),
    allowlisted,
    expiredAllowlistEntries: options.allowlist?.expired ?? [],
    staleAllowlistEntries: options.staleAllowlistEntries ?? [],
    auditedSchemas: schemas,
    unclassifiedSchemas,
    catalogRows: rows.length,
  };
}

// ---------------------------------------------------------------------------
// The allowlist.
// ---------------------------------------------------------------------------

/** Stable identity of one violation, so an allowlist entry cannot drift. */
export function allowlistKey(value: { routine: string }): string {
  return value.routine;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Longest an entry may outlive the date it was added. */
export const ALLOWLIST_MAX_DAYS = 180;

/**
 * Parse a real calendar date, or null.
 *
 * `^\d{4}-\d{2}-\d{2}$` alone accepted `9999-99-99`: month 99 and day 99 roll
 * forward in `Date`, so the pattern was the only check and a self-waiver that
 * never expires was accepted. The round trip below rejects any date whose
 * components do not survive construction.
 */
export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

export class SearchPathAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchPathAllowlistError";
  }
}

/**
 * Read and validate the allowlist.
 *
 * An entry is a WAIVER, so every field is a bound rather than a comment:
 *
 *  - `routine` is a catalog identity, so an entry cannot be re-pointed at a
 *    different function by renaming an argument or a schema;
 *  - `added` and `expires` must be real dates, and the waiver may not outlive
 *    `added` by more than `ALLOWLIST_MAX_DAYS` days, so an entry cannot be
 *    written to suppress a violation forever;
 *  - `expires` may not precede `added`;
 *  - `issue` must name the work that removes it.
 *
 * An entry past its expiry is returned in `expired` rather than in `active`, so
 * the violation it named counts again AND the lapsed entry is itself reported
 * as a failure.
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
    if (!entry.routine || !entry.issue) {
      throw new SearchPathAllowlistError(`allowlist_entry_incomplete:${path}:${entry.routine ?? "?"}`);
    }
    if (!entry.routine.includes(".") || !entry.routine.includes("(")) {
      throw new SearchPathAllowlistError(
        `allowlist_entry_not_a_catalog_identity:${entry.routine}:expected_schema_dot_name_parens`);
    }
    const added = parseIsoDate(entry.added ?? "");
    if (added === null) throw new SearchPathAllowlistError(`allowlist_entry_added_not_a_date:${entry.routine}`);
    const expires = parseIsoDate(entry.expires ?? "");
    if (expires === null) throw new SearchPathAllowlistError(`allowlist_entry_expiry_not_a_date:${entry.routine}`);
    const horizonDays = (expires.getTime() - added.getTime()) / DAY_MS;
    if (horizonDays < 0) {
      throw new SearchPathAllowlistError(`allowlist_entry_expires_before_it_was_added:${entry.routine}`);
    }
    if (horizonDays > ALLOWLIST_MAX_DAYS) {
      throw new SearchPathAllowlistError(
        `allowlist_entry_horizon_too_long:${entry.routine}:added=${entry.added}:expires=${entry.expires}`
        + `:max_days=${ALLOWLIST_MAX_DAYS}`);
    }
  }
  const active = new Map<string, SearchPathAllowlistEntry>();
  const expired: SearchPathAllowlistEntry[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const entry of entries) {
    if (entry.expires < today) expired.push(entry);
    else active.set(allowlistKey(entry), entry);
  }
  return { entries, active, expired };
}

/** In-date entries that match no current violation: dead weight to remove. */
export function staleAllowlistEntries(
  allowlist: LoadedSearchPathAllowlist,
  used: readonly string[],
): SearchPathAllowlistEntry[] {
  const covered = new Set(used.map(routine => allowlistKey({ routine })));
  return allowlist.entries.filter(entry => !covered.has(allowlistKey(entry)));
}

export class UnpinnedSearchPathError extends Error {
  constructor(readonly result: SecurityDefinerAuditResult) {
    const detail = result.unpinned
      .map(finding => `${finding.routine}:${finding.reason}`).join("; ");
    const lapsed = result.expiredAllowlistEntries
      .map(entry => `${entry.routine}:allowlist_entry_expired_${entry.expires}_issue_${entry.issue}`)
      .join("; ");
    const stale = result.staleAllowlistEntries
      .map(entry => `${entry.routine}:allowlist_entry_stale_expires_${entry.expires}_issue_${entry.issue}`)
      .join("; ");
    super(`search_path_audit_failed:${result.unpinned.length}_unpinned_of_${result.findings.length}`
      + `:${[detail, lapsed, stale].filter(Boolean).join("; ")}`);
    this.name = "UnpinnedSearchPathError";
  }
}

/** The catalog audit, throwing instead of returning, for a test gate. */
export async function assertSearchPathPinned(
  query: (sql: string, params: readonly unknown[]) => Promise<{ rows: CatalogRow[] }>,
  options: CatalogAuditOptions = {},
): Promise<SecurityDefinerAuditResult> {
  const result = await securityDefinerAuditLive(query, options);
  if (result.unpinned.length > 0
    || result.expiredAllowlistEntries.length > 0
    || result.staleAllowlistEntries.length > 0
    || result.unclassifiedSchemas.length > 0) {
    throw new UnpinnedSearchPathError(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The file scanner. A LOCAL HINT ONLY — not a gate, and not in any CI job.
// ---------------------------------------------------------------------------

/**
 * Why this exists at all, stated so a caller cannot mistake it for the gate:
 * it is a ~40-line scanner that reads migration text. It cannot be made sound.
 * Two fix rounds of one each closed a reported hole and exposed the next, and
 * the remaining holes are not the kind a fix closes — they are the consequence
 * of deciding a real parser's answer with regular expressions. Use
 * `securityDefinerAuditLive` for anything you intend to rely on; use this for
 * "is there obviously a violation here, before I spend a cluster on it".
 */
const RETURNS_TRIGGER = /\breturns\s+trigger\b/i;
const RETURNS_EVENT_TRIGGER = /\breturns\s+event_trigger\b/i;
const SECURITY_DEFINER = /\bsecurity\s+definer\b/i;
const SET_SEARCH_PATH =
  /\bset\s+search_path\b\s*(?:=|to)\s*([^;]*?)(?=\s*(?:\bas\b|\blanguage\b|\breturns\b|\bset\b|;|$))/i;
const FUNCTION_HEAD =
  /create\s+(?:or\s+replace\s+)?(function|procedure)\s+([A-Za-z0-9_."]+)\s*(?=\()/gi;
const ALTER_HEAD = /alter\s+(?:function|procedure)\s+([A-Za-z0-9_."]+)\s*\(([^)]*)\)\s*([\s\S]*)/gi;
const BODY_AS = /\bas\b(?=\s*(?:'|"))|\bas\b(?=\s*\$)/i;

/** Remove comments from a region, preserving line structure. */
export function stripSqlComments(region: string): string {
  return region
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, match => " ".repeat(match.length));
}

/** Split a migration into complete statements, tracking quotes and comments. */
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
  readonly signature: string;
  readonly options: string;
}

function functionDefinitions(statement: string): FunctionDefinition[] {
  const source = stripSqlComments(statement);
  const heads: { start: number; open: number; name: string }[] = [];
  for (const match of source.matchAll(new RegExp(FUNCTION_HEAD.source, "giu"))) {
    heads.push({ start: match.index, open: match.index + match[0].length, name: match[2]! });
  }
  const definitions: FunctionDefinition[] = [];
  heads.forEach((head, position) => {
    let depth = 0;
    let cursor = head.open;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (character === "'") {
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === "'" && source[cursor + 1] === "'") { cursor += 2; continue; }
          if (source[cursor] === "'") { cursor += 1; break; }
          cursor += 1;
        }
        continue;
      }
      if (character === "$") {
        const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(cursor, cursor + 64));
        if (tag) {
          const close = source.indexOf(tag[0], cursor + tag[0].length);
          cursor = close === -1 ? source.length : close + tag[0].length;
          continue;
        }
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      const restStart = head.open;
      const restEnd = Math.min(
        source.slice(restStart).search(BODY_AS) === -1
          ? source.length
          : restStart + source.slice(restStart).search(BODY_AS),
        heads[position + 1]?.start ?? source.length,
      );
      definitions.push({ signature: `${head.name}(<unreadable>)`, options: source.slice(restStart, restEnd) });
      return;
    }
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

function describeFileDefinition(definition: FunctionDefinition, file: string): FunctionFinding {
  const options = definition.options;
  const isEventTrigger = RETURNS_EVENT_TRIGGER.test(options);
  const isTrigger = RETURNS_TRIGGER.test(options);
  const isDefiner = SECURITY_DEFINER.test(options);
  const kinds: PrivilegedKind[] = [];
  if (isDefiner) kinds.push("security-definer");
  if (isTrigger) kinds.push("trigger");
  if (isEventTrigger) kinds.push("event-trigger");
  const declared = SET_SEARCH_PATH.exec(options)?.[1]?.trim().replace(/,\s*$/, "") ?? "";
  const searchPath = declared === "" ? null : declared;
  const endsInPgTemp = searchPathEndsInPgTemp(searchPath);
  return {
    routine: definition.signature,
    file,
    kinds,
    searchPath,
    endsInPgTemp,
    reason: kinds.length === 0
      ? "not_privileged"
      : endsInPgTemp
        ? "pinned"
        : searchPath === null
          ? `${kinds.join("+")}_without_a_search_path_clause`
          : `${kinds.join("+")}_search_path_does_not_end_in_pg_temp:${searchPath}`,
  };
}

export interface SecurityDefinerAuditOptions {
  /** Retained for call compatibility. The file hint does not consult the
   * allowlist, whose keys are catalog identities this scanner cannot produce. */
  readonly allowlist?: LoadedSearchPathAllowlist;
}

/**
 * A LOCAL HINT: list the privileged routines the migration FILES appear to
 * declare. Not a gate, not sound, and wired to no CI job.
 *
 * The result is honest about itself — `auditedFiles` counts files read — but a
 * clean result here is NOT evidence that the migrations are safe. Only the
 * catalog audit answers that.
 */
export async function securityDefinerAudit(
  migrationsDir: string,
  _options: SecurityDefinerAuditOptions = {},
): Promise<SecurityDefinerAuditResult> {
  const entries = (await readdir(migrationsDir)).filter(name => name.endsWith(".sql")).sort();
  const findings: FunctionFinding[] = [];
  for (const name of entries) {
    const source = await readFile(join(migrationsDir, name), "utf8");
    for (const statement of splitSqlStatements(source)) {
      for (const definition of functionDefinitions(statement)) {
        findings.push(describeFileDefinition(definition, name));
      }
    }
  }
  const privileged = findings.filter(finding => finding.kinds.length > 0);
  return {
    findings: privileged,
    unpinned: privileged.filter(finding => !finding.endsInPgTemp),
    allowlisted: [],
    expiredAllowlistEntries: [],
    staleAllowlistEntries: [],
    auditedSchemas: [],
    unclassifiedSchemas: [],
    catalogRows: 0,
    auditedFiles: entries.length,
  } as SecurityDefinerAuditResult & { auditedFiles: number };
}
