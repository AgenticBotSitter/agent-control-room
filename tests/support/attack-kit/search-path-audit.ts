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

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface FunctionFinding {
  /** File the function was declared in, relative to the audited directory. */
  readonly file: string;
  /** `schema.function(identity arguments)`. */
  readonly function: string;
  /** SECURITY DEFINER, a trigger function, or both. */
  readonly kinds: readonly ("security-definer" | "trigger")[];
  /** The declared `SET search_path` list, or null when none was declared. */
  readonly searchPath: string | null;
  /** True when the list is pinned and its last element is pg_temp. */
  readonly endsInPgTemp: boolean;
  /** Why the function is listed, in one line. */
  readonly reason: string;
}

export interface SecurityDefinerAuditResult {
  readonly findings: readonly FunctionFinding[];
  /** Findings whose search_path is missing or does not end in pg_temp. */
  readonly unpinned: readonly FunctionFinding[];
  readonly auditedFiles: number;
}

const CREATE_FUNCTION = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)\s*\(([^)]*)\)/gi;
const RETURNS_TRIGGER = /RETURNS\s+trigger\b/i;
const SECURITY_DEFINER = /SECURITY\s+DEFINER\b/i;
/** `SET search_path = a, b` / `SET search_path TO a, b`, in or after the options. */
const SET_SEARCH_PATH = /SET\s+search_path\s*(?:=|TO)\s*([^;]*?)(?=\s*(?:AS\b|LANGUAGE\b|RETURNS\b|;|\$\$))/i;

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

/** The function body region that a `SET` clause could appear in. */
function optionsWindow(source: string, from: number): string {
  return source.slice(from, from + 2_000);
}

function parseSearchPathFor(source: string, from: number): string | null {
  const window = optionsWindow(source, from);
  const match = SET_SEARCH_PATH.exec(window);
  return match ? match[1]!.trim() : null;
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
export async function securityDefinerAudit(migrationsDir: string): Promise<SecurityDefinerAuditResult> {
  const entries = (await readdir(migrationsDir)).filter(name => name.endsWith(".sql")).sort();
  const findings: FunctionFinding[] = [];
  for (const name of entries) {
    const source = await readFile(join(migrationsDir, name), "utf8");
    for (const match of source.matchAll(CREATE_FUNCTION)) {
      const at = match.index ?? 0;
      const window = optionsWindow(source, at);
      const isTrigger = RETURNS_TRIGGER.test(window);
      const isDefiner = SECURITY_DEFINER.test(window);
      if (!isTrigger && !isDefiner) continue;
      const searchPath = parseSearchPathFor(source, at);
      const endsInPgTemp = searchPathEndsInPgTemp(searchPath);
      const kinds: ("security-definer" | "trigger")[] = [];
      if (isDefiner) kinds.push("security-definer");
      if (isTrigger) kinds.push("trigger");
      findings.push({
        file: name,
        function: `${match[1]}(${match[2]!.trim()})`,
        kinds,
        searchPath,
        endsInPgTemp,
        reason: endsInPgTemp
          ? "pinned"
          : searchPath === null
            ? `${kinds.join("+")}_without_a_search_path_clause`
            : `${kinds.join("+")}_search_path_does_not_end_in_pg_temp:${searchPath}`,
      });
    }
  }
  return {
    findings,
    unpinned: findings.filter(finding => !finding.endsInPgTemp),
    auditedFiles: entries.length,
  };
}

export class UnpinnedSearchPathError extends Error {
  constructor(readonly result: SecurityDefinerAuditResult) {
    const detail = result.unpinned
      .map(finding => `${finding.file}:${finding.function}:${finding.reason}`)
      .join("; ");
    super(`search_path_audit_failed:${result.unpinned.length}_unpinned_of_${result.findings.length}:${detail}`);
    this.name = "UnpinnedSearchPathError";
  }
}

/** `securityDefinerAudit` that throws instead of returning, for a test gate. */
export async function assertSearchPathPinned(migrationsDir: string): Promise<SecurityDefinerAuditResult> {
  const result = await securityDefinerAudit(migrationsDir);
  if (result.unpinned.length > 0) throw new UnpinnedSearchPathError(result);
  return result;
}

/**
 * The same audit against a live catalog, for the function bodies that a
 * migration has since replaced. `pg_get_functiondef` is the source of truth
 * the role files and the rehearsal install.
 */
export async function securityDefinerAuditLive(
  query: (sql: string) => Promise<{ rows: { name: string; definition: string }[] }>,
  options: { schema?: string } = {},
): Promise<SecurityDefinerAuditResult> {
  const schema = options.schema ?? "public";
  const rows = (await query(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
            pg_get_functiondef(p.oid) AS definition
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND (p.prosecdef OR p.prorettype = 'trigger'::regtype)
     ORDER BY 1`,
  )).rows;
  const findings = rows.map(({ name, definition }) => {
    const match = SET_SEARCH_PATH.exec(definition);
    const searchPath = match ? match[1]!.trim().replace(/,\s*$/, "") : null;
    const endsInPgTemp = searchPathEndsInPgTemp(searchPath);
    return {
      file: "<live catalog>",
      function: name,
      kinds: (/security\s+definer/i.test(definition) ? ["security-definer" as const] : []),
      searchPath,
      endsInPgTemp,
      reason: endsInPgTemp ? "pinned" : `search_path_not_pinned:${searchPath ?? "none"}`,
    };
  });
  return { findings, unpinned: findings.filter(finding => !finding.endsInPgTemp), auditedFiles: rows.length };
}
