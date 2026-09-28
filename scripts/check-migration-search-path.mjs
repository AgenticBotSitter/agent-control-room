#!/usr/bin/env node
// CI gate: every privileged function in db/migrations must pin `search_path`.
//
// A SECURITY DEFINER or trigger function resolves the names in its body with
// the OWNER's privileges. With a default `search_path`, any schema an attacker
// can write to and that sits earlier in the path can shadow a function the body
// calls, and the body then runs the attacker's function as the owner. Ending the
// list in `pg_temp` closes it: pg_temp is searched first for relations, so a
// name that resolves to a temp object is caught by refusing to let pg_temp sit
// anywhere but last.
//
// This reads files, not a live catalog, so it runs in the dependency-free Quick
// checks lane and needs no PostgreSQL.
//
// Shipped violations are NOT edited here. They are listed in
// tests/support/attack-kit/search-path-allowlist.json with an expiry date and a
// tracking issue (issue 421); each is re-checked every run, so a NEW unpinned
// function fails this check immediately.
//
// Usage: node scripts/check-migration-search-path.mjs [--dir <migrations>] [--json]

import { securityDefinerAudit, loadSearchPathAllowlist, withStaleAllowlist, UnpinnedSearchPathError } from "../tests/support/attack-kit/search-path-audit.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const migrationsDir = option("--dir", "db/migrations");
const allowlistPath = option("--allowlist", "tests/support/attack-kit/search-path-allowlist.json");
const asJson = args.includes("--json");

const allowlist = await loadSearchPathAllowlist(allowlistPath);
const result = await securityDefinerAudit(migrationsDir, { allowlist });
const withStale = withStaleAllowlist(allowlist, result);

if (asJson) {
  console.log(JSON.stringify({
    auditedFiles: result.auditedFiles,
    findings: result.findings.length,
    unpinned: result.unpinned.length,
    allowlisted: result.allowlisted.length,
    expired: result.expiredAllowlistEntries.length,
    stale: withStale.stale.length,
  }, null, 2));
}

// An expired entry is a failure in its own right: the function it named is
// still unpinned, so the waiver has run out.
if (result.expiredAllowlistEntries.length > 0) {
  for (const entry of result.expiredAllowlistEntries) {
    console.error(`search_path_allowlist_entry_expired:${entry.file}:${entry.function}`
      + `:expired=${entry.expires}:issue=${entry.issue}`);
  }
}

// A stale entry is not a failure — the function it named is fixed, which is the
// desired direction — but it must be removed, so it is reported as debt.
for (const entry of withStale.stale) {
  console.error(`search_path_allowlist_entry_stale:${entry.file}:${entry.function}`
    + `:expired=${entry.expires}:issue=${entry.issue}`);
}

if (result.unpinned.length > 0) {
  const error = new UnpinnedSearchPathError(result);
  console.error(error.message);
  for (const finding of result.unpinned) {
    console.error(`  ${finding.file}:${finding.function}:${finding.reason}`);
  }
  console.error("Pin it with SET search_path = pg_catalog, public, pg_temp (pg_temp last).");
  console.error("Existing violations are tracked by issue 421 and must not be added to the allowlist.");
  process.exitCode = 1;
}
