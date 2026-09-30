// Recompute privateWebSchemaDigest from a live cluster installed the production
// way. One-shot, local, disposable: the cluster is created, read, and destroyed
// in this process, and it is the only PostgreSQL this touches.
//
//   PG_BIN=/opt/homebrew/opt/postgresql@17/bin node --import tsx scripts/operations-mode-digest.ts <port>
import { Client } from "pg";
import { withRealPostgres } from "../tests/support/attack-kit/index.ts";
import { readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight.ts";

// The reserved disposable-cluster lane for this script: 58710-58719.
const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 58710 + index));
const port = Number(process.argv[2] ?? PORTS[0]);
if (!PORTS.includes(port)) throw new Error("digest_port_outside_reserved_lane");

await withRealPostgres(async postgres => {
  const admin = new Client(postgres.admin({ database: postgres.database }));
  await admin.connect();
  const digest = await readPrivateWebSchemaDigest(admin);
  await admin.end();
  console.log(JSON.stringify({ port, schemaDigest: digest }));
}, { port, allowedPorts: PORTS, boundMs: 180_000 });
