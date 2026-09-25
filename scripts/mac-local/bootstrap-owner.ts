// One-time, repeat-safe creation of the Mac-local owner. mac:up runs it after the database check.
// Usage: pnpm mac:bootstrap-owner ABSOLUTE_PROTECTED_ROOT
import { isAbsolute, resolve } from "node:path";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres";
import { bootstrapMacLocalOwnerV1, seedMacLocalAdapterRegistryV1, seedMacLocalNodeV1 } from "../../src/web/v1/mac-local-owner-bootstrap";

const root = process.argv[2];
if (!root || process.argv.length !== 3 || !isAbsolute(root) || resolve(root) !== root) {
  console.error("usage: pnpm mac:bootstrap-owner ABSOLUTE_PROTECTED_ROOT");
  process.exit(2);
}
const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
const database = createPrivatePostgresDatabase(configuration.database);
let ownerOk = false;
try {
  console.log(`owner ${await bootstrapMacLocalOwnerV1(database.client, configuration)}`);
  ownerOk = true;
} catch (error) {
  console.error(`owner bootstrap failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
}
if (ownerOk) {
  try {
    // Idempotent, but kept separate from bootstrapMacLocalOwnerV1: adapter_registry.id
    // is a global (not per-tenant) primary key for these three fixed adapter ids, so
    // this seed is meaningful only for the one real Mac-local tenant, not every
    // synthetic tenant that exercises the owner-bootstrap logic in tests.
    await database.client.transaction(tx => seedMacLocalAdapterRegistryV1(tx, configuration.localOwnerSession.tenantId));
    console.log("adapter registry seeded");
    console.log(`local node ${await seedMacLocalNodeV1(database.client, configuration)}`);
  } catch (error) {
    console.error(`adapter registry seed failed: ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  }
}
await database.close();
