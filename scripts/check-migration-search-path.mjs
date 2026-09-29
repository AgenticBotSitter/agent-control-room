#!/usr/bin/env node
// CI gate: every privileged routine the MIGRATIONS ACTUALLY PRODUCE must pin
// `search_path` to a list ending in `pg_temp`.
//
// A SECURITY DEFINER or trigger routine resolves the names in its body with
// the OWNER's privileges. With a default `search_path`, any schema an attacker
// can write to and that sits earlier in the path can shadow a function the body
// calls, and the body then runs the attacker's function as the owner. Ending the
// list in `pg_temp` closes it: pg_temp is searched first for relations, so a
// name that resolves to a temp object is caught by refusing to let pg_temp sit
// anywhere but last.
//
// THE ANSWER COMES FROM POSTGRESQL. The gate builds a disposable cluster from
// the real migration ledger and the real role files, then reads `pg_proc`. So
// this is PostgreSQL's own effective configuration: `prosecdef` and `prorettype`
// as they are after every statement, and `proconfig` after every
// `ALTER FUNCTION ... SET/RESET search_path`, across files, with real identifier
// parsing. Every hole a text model of SQL had — a cross-file ALTER, a later
// RESET, a nested-comment decoy, a quoted identifier, a `SET search_path = 'a,
// b'` single-string decoy, a `"PG_TEMP"` that is a different schema — is not
// closed here because it cannot arise: the catalog is the parser.
//
// Shipped violations are NOT edited by this PR. They are listed in
// tests/support/attack-kit/search-path-allowlist.json, keyed on the routine's
// CATALOG IDENTITY (`schema.name(identity arguments)`) with an added date, an
// expiry within 180 days of it, and a tracking issue. A new unpinned routine
// fails this check immediately; an entry past its expiry, an entry that no
// longer matches any violation, an entry with a bad date or an over-long
// horizon, and an audit that could not cover a schema all fail too.
//
// The static file audit (`securityDefinerAudit` in the kit) is a LOCAL HINT
// only. It is not wired to any CI job and this gate does not consult it: a
// regex model of PostgreSQL SQL cannot be made sound, and this gate exists
// because two fix rounds of one each closed a reported hole and exposed the
// next.
//
// Usage:
//   node --import tsx scripts/check-migration-search-path.mjs \
//     [--host <socket dir> --port <port> --user <superuser> --database <db>]
//     [--allowlist <path>] [--json]
//
// With no connection arguments the gate OWNS its cluster: it builds a
// disposable PostgreSQL 17 cluster from the real migration ledger and the real
// role files, audits it, and tears it down. That is the CI path, and it is the
// only path that can be trusted unconditionally — an externally supplied
// cluster might not have the migrations applied at all.
//
// With connection arguments the gate audits a cluster the caller already has,
// which is how the attack-test kit's own tests reuse one cluster for both the
// gate and the suite. A zero-row result is refused either way, so an
// un-migrated database cannot pass.
import { resolvePgBin, withRealPostgres } from "../tests/support/attack-kit/real-postgres.ts";

import {
  loadSearchPathAllowlist,
  securityDefinerAuditLive,
  staleAllowlistEntries,
  UnpinnedSearchPathError,
} from "../tests/support/attack-kit/search-path-audit.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const required = (name) => {
  const value = option(name, undefined);
  if (value === undefined) throw new Error(`search_path_gate_missing_argument:${name}`);
  return value;
};
const asJson = args.includes("--json");

const allowlistPath = option("--allowlist", "tests/support/attack-kit/search-path-allowlist.json");

const { Client } = await import("pg");
const allowlist = await loadSearchPathAllowlist(allowlistPath);

/** Audit a connected client. The client is closed by the caller. */
const audit = async (client) => {
  // A zero-row result is refused rather than reported clean: a cluster whose
  // migrations were never applied would otherwise be a vacuous pass.
  const result0 = await securityDefinerAuditLive(async (sql, params) => {
    const answer = await client.query(sql, [...params]);
    return { rows: answer.rows };
  }, { allowlist });
  if (result0.catalogRows === 0) {
    throw new Error(`search_path_gate_empty_catalog:${client.connectionParameters?.database}:no_routines_at_all`);
  }
  // `used` is what the audit actually covered with a waiver, as
  // identity + effective search_path. A waiver that no longer matches the
  // routine's current state is reported here as a STALE entry, so a state
  // change fails the gate twice: the routine counts as unpinned again, and the
  // waiver that used to describe it is reported as no longer describing it.
  const used = [
    ...result0.allowlisted.map(finding => ({ routine: finding.routine, searchPath: finding.searchPath })),
    ...result0.expiredAllowlistEntries.map(entry => ({ routine: entry.routine, searchPath: entry.searchPath })),
  ];
  return { ...result0, staleAllowlistEntries: staleAllowlistEntries(allowlist, used) };
};

const host = option("--host", undefined);
const external = host !== undefined;
let result;
if (external) {
  const port = Number(required("--port"));
  const user = required("--user");
  const database = required("--database");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`search_path_gate_bad_port:${port}`);
  const client = new Client({
    host, port, user, database,
    // The cluster is disposable and socket-local, and the audit reads only
    // pg_proc; no password is read from the environment or from argv.
    application_name: "search_path_gate",
  });
  await client.connect();
  try {
    result = await audit(client);
  } finally {
    await client.end();
  }
} else {
  // The gate owns the cluster: it is disposable, it is built from the real
  // ledger, and its teardown is the kit's — so a run that fails mid-audit
  // still leaves nothing holding a SysV segment.
  const pgBin = resolvePgBin();
  if (pgBin === null) {
    // Refuse rather than pass. A gate that quietly skips when PostgreSQL is
    // absent is a gate that is green on a machine that never looked.
    throw new Error("search_path_gate_requires_postgresql_17:no_usable_binaries_on_path_or_in_PG_BIN");
  }
  const outcome = await withRealPostgres(
    async (postgres) => {
      const client = new Client({
        // `admin()` is the superuser connection, which owns pg_proc reads. It
        // is not one of the NAMED application roles: this gate audits the
        // catalog as an operator, not as the app.
        ...postgres.admin(), application_name: "search_path_gate",
      });
      await client.connect();
      try {
        return await audit(client);
      } finally {
        await client.end();
      }
    },
    { port: 56179, allowedPorts: [56179], database: "control_room" },
  );
  if (outcome.cleanedUp !== true) {
    throw new Error(`search_path_gate_cluster_not_destroyed:${JSON.stringify(outcome.leftovers ?? [])}`);
  }
  result = outcome.value;
}

if (asJson) {
  console.log(JSON.stringify({
    auditedSchemas: result.auditedSchemas,
    unclassifiedSchemas: result.unclassifiedSchemas,
    catalogRows: result.catalogRows,
    findings: result.findings.length,
    unpinned: result.unpinned.length,
    allowlisted: result.allowlisted.length,
    expired: result.expiredAllowlistEntries.length,
    stale: result.staleAllowlistEntries.length,
  }, null, 2));
}

// An expired entry is a failure in its own right: the routine it named is still
// unpinned, so the waiver has run out.
for (const entry of result.expiredAllowlistEntries) {
  console.error(`search_path_allowlist_entry_expired:${entry.routine}`
    + `:expired=${entry.expires}:issue=${entry.issue}`);
}

// A stale entry is ALSO a failure. It used to print a console message and pass:
// an allowlist that no longer describes reality is no longer evidence of
// anything, and letting it survive means the next entry nobody checks is
// equally invisible. A waiver whose recorded search_path no longer matches the
// routine's effective one lands here too, which is why this is the second of
// the two failures a state change produces.
for (const entry of result.staleAllowlistEntries) {
  console.error(`search_path_allowlist_waiver_no_longer_matches:${entry.routine}`
    + `:recorded_search_path=${entry.searchPath ?? "<none>"}`
    + `:expires=${entry.expires}:issue=${entry.issue}`);
}

// A schema the audit could not classify is a failure: the gate must be able to
// say it did not look.
for (const schema of result.unclassifiedSchemas) {
  console.error(`search_path_gate_unclassified_schema:${schema}`);
}

if (result.unpinned.length > 0
  || result.expiredAllowlistEntries.length > 0
  || result.staleAllowlistEntries.length > 0
  || result.unclassifiedSchemas.length > 0) {
  console.error(new UnpinnedSearchPathError(result).message);
  for (const finding of result.unpinned) {
    console.error(`  ${finding.routine}:${finding.reason}`);
  }
  console.error("Pin it with SET search_path = pg_catalog, public, pg_temp (pg_temp last).");
  console.error("Existing violations are tracked by issue 421 and must not be added to the allowlist.");
  process.exitCode = 1;
}
