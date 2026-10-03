// Derive privateWebSchemaDigest from a REAL PostgreSQL 17 cluster, not PGlite.
//
// The cook helper (~/work/acr-private/bin/cook-digest.mts) applies every
// migration to a fresh PGlite and prints the digest. That is the documented
// method for the PGlite-backed check, but this stream's brief requires the digest
// to be re-derived on real PostgreSQL, and for correctness rather than ceremony:
// the digest is the promise the private-web login verifies at STARTUP against the
// cluster it is about to use, and PGlite is PostgreSQL compiled to WASM whose
// `pg_get_*` output is not guaranteed byte-identical to a native server's. A
// digest derived there is evidence about a different engine than the one an
// installed Mac will refuse to start against.
//
// The cluster is the test kit's own, which applies migrations through the
// PRODUCTION applier (`applyMigrations`) as the `control_room_migrator` login, so
// the schema shape is produced the same way an install produces it. The digest is
// then read by the production reader, so there is no second copy of the digest
// query in this file to drift from the one that verifies it.
//
// usage: node --import tsx scripts/cook-digest-real-pg.mts <port>
import { Client } from "pg";
import { readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight.ts";
import { withRealPostgres } from "../tests/support/attack-kit/index.ts";

const port = Number(process.argv[2] ?? 59740);

await withRealPostgres(async postgres => {
  const options = postgres.admin({ database: postgres.database });
  const admin = new Client({ ...options, password: options.password });
  // Without a listener, a connection the cluster terminates during teardown
  // surfaces as an uncaughtException and buries the digest.
  admin.on("error", () => {});
  await admin.connect();
  try {
    const session = { query: async <T,>(sql: string, params?: unknown[]) =>
      ({ rows: (await admin.query(sql, params as unknown[])).rows as T[] }) };
    console.log(await readPrivateWebSchemaDigest(session));
  } finally { await admin.end(); }
}, { port, allowedPorts: [port] });
