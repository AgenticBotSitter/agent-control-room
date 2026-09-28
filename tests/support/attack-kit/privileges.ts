// Grant assertions against a real cluster.
//
// `has_table_privilege` answers "does this role hold the privilege", which is
// necessary but not sufficient: a role can hold a privilege and still be
// refused because a table does not exist, or because a policy rejects the row.
// These helpers execute the statement AS the role and read the server's own
// verdict, so a passing assertion means the server agreed, not that a catalog
// lookup looked right.

import type { ConnectionOptions, RealPostgres } from "./real-postgres";
import { AttackKitPortError } from "./real-postgres";
import { Client } from "pg";

/**
 * PostgreSQL's own "insufficient privilege" SQLSTATE.
 *
 * ONLY `42501` counts. `42000` (syntax_error_or_access_rule_violation) and
 * `0A000` (feature_not_supported) are broad classes that a typo, a missing
 * table, a revoked TEMP privilege on a *database* and an unimplemented feature
 * all land in, and accepting either as proof of denial makes a grant test pass
 * against a database where the role COULD have done the thing. An operation
 * that genuinely refuses with a different exact code must be listed here with
 * the version and statement it was observed on.
 */
const DENIED = new Set(["42501"]);

interface PgFailure {
  code?: string;
  message?: string;
}

const deniedCode = (error: unknown): string | null => {
  const failure = error as PgFailure;
  return typeof failure?.code === "string" ? failure.code : null;
};

/**
 * True ONLY when the failure is PostgreSQL's privilege refusal.
 *
 * A refusal for any other reason — a syntax error, a missing relation, a
 * feature that does not exist — is explicitly NOT a denial, because it carries
 * no information about the grant under test.
 */
export function isPrivilegeDenied(error: unknown): boolean {
  return DENIED.has(deniedCode(error) ?? "");
}

async function execute(options: ConnectionOptions, sql: string, params: readonly unknown[]): Promise<void> {
  const connection = new Client(options);
  await connection.connect();
  try {
    await connection.query(sql, params as never[]);
  } finally {
    await connection.end();
  }
}

export interface PrivilegeOptions {
  /** Assert on a database other than the migrated one. */
  database?: string;
  /** Statement parameters, for an INSERT or UPDATE with values. */
  params?: readonly unknown[];
  /** Wrap the statement so a mutation is rolled back afterwards. */
  rollback?: boolean;
}

export class PrivilegeAssertionError extends Error {
  constructor(readonly role: string, readonly sql: string, readonly expectation: "can" | "cannot", readonly detail: string) {
    super(`role_${expectation}_${expectation === "can" ? "failed" : "succeeded"}:${role}:${detail}`);
    this.name = "PrivilegeAssertionError";
  }
}

const firstLine = (value: unknown) => `${value}`.split("\n")[0]!.slice(0, 200);

/**
 * Assert that `role` CAN run `sql` on a real cluster.
 *
 * The statement is executed for real, in the role's own session, and the error
 * is rethrown with the server's message. A statement that succeeds when it
 * should not have is a defect in the grant, so nothing is swallowed.
 */
export async function roleCan(
  postgres: RealPostgres,
  role: string,
  sql: string,
  options: PrivilegeOptions = {},
): Promise<void> {
  const options_ = postgres.connection(role, { database: options.database });
  const rollback = options.rollback ?? /^\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE)\b/i.test(sql);
  try {
    await execute(options_, rollback ? `BEGIN; ${sql}; ROLLBACK;` : sql, options.params ?? []);
  } catch (error) {
    throw new PrivilegeAssertionError(role, sql, "can",
      `${deniedCode(error) ?? "unknown"}:${firstLine((error as Error).message)}`);
  }
}

/**
 * Assert that `role` CANNOT run `sql`, and that the refusal is a privilege
 * refusal rather than a typo, a missing table or a syntax error.
 *
 * The `isPrivilegeDenied` check is the part that makes this worth writing: a
 * statement that fails for the wrong reason proves nothing about grants, and a
 * test that accepted it would pass against a database where the role could do
 * the thing.
 */
export async function roleCannot(
  postgres: RealPostgres,
  role: string,
  sql: string,
  options: PrivilegeOptions = {},
): Promise<void> {
  const options_ = postgres.connection(role, { database: options.database });
  try {
    await execute(options_, sql, options.params ?? []);
  } catch (error) {
    if (!isPrivilegeDenied(error)) {
      throw new PrivilegeAssertionError(role, sql, "cannot",
        `refused_for_the_wrong_reason:${deniedCode(error) ?? "unknown"}:${firstLine((error as Error).message)}`);
    }
    return;
  }
  throw new PrivilegeAssertionError(role, sql, "cannot", "the_statement_was_accepted");
}

export interface PrivilegeMatrixRow {
  readonly role: string;
  readonly privilege: string;
  readonly object: string;
  readonly held: boolean;
}

/** The catalog's own view, for a table of what a role holds. */
export async function privilegeMatrix(
  postgres: RealPostgres,
  roles: readonly string[],
  privileges: readonly string[],
  object: string,
  options: { database?: string } = {},
): Promise<PrivilegeMatrixRow[]> {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(object)) throw new AttackKitPortError(`privilege_object_refused:${object}`);
  const rows: PrivilegeMatrixRow[] = [];
  for (const role of roles) {
    for (const privilege of privileges) {
      const result = await postgres.query(role, "SELECT has_table_privilege(current_user, $1, $2) AS held",
        [object, privilege], options);
      rows.push({ role, privilege, object, held: result.rows[0]?.held === true });
    }
  }
  return rows;
}
