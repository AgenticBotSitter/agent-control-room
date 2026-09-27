import { PrivateDatabaseError } from "./bounded-database";

/** A log-safe description of a database refusal. PostgreSQL detail, query text,
 * parameters and connection metadata are deliberately excluded. */
export function sanitizedDatabaseFailureV1(error: unknown): string {
  if (error instanceof PrivateDatabaseError) return error.sqlState
    ? `code=${error.code} sqlstate=${error.sqlState}` : `code=${error.code}`;
  let message: unknown;
  try { message = error && typeof error === "object" ? Reflect.get(error, "message") : undefined; }
  catch { return "code=unknown"; }
  return typeof message === "string" && /^[a-z][a-z0-9_]{2,80}$/u.test(message)
    ? `code=${message}` : "code=unknown";
}
