import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { SecurityStore, assertNoSecretMaterial, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { createAccessVerifier, type AccessTrust } from "./access-verifier";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";

const configurationSchema = z.object({
  databaseName: z.string().min(1).max(63), tenantId: localId, workspaceId: localId,
  identityId: localId, grantId: localId, displayName: z.string().trim().min(1).max(120),
  expectedOwnerSubjectDigest: digestSchema,
}).strict();
export type PrivateOwnerBootstrapConfiguration = z.infer<typeof configurationSchema>;

function verifyPinnedOwner(verify: ReturnType<typeof createAccessVerifier>, config: PrivateOwnerBootstrapConfiguration,
  request: Request, now: number) {
  const identity = verify(request, now);
  if (sha256Digest({ provider: identity.provider, subject: identity.subject }) !== config.expectedOwnerSubjectDigest)
    throw new Error("private_owner_bootstrap_failed");
  return identity;
}

/** Deployment-only bridge, not an HTTP route or credential intake mechanism.
 * Caller supplies a separately approved provisioning connection and independently
 * confirmed owner digest/trust. This does not discover an owner or prove attendance.
 * The borrowed client must provide bounded transactions and precommit checks;
 * the caller retains connection cleanup and uncertainty reconciliation duties. */
export function createPrivateOwnerBootstrap(input: PrivateOwnerBootstrapConfiguration,
  trust: AccessTrust, dependencies: { database: DatabaseClient; clock: () => number }) {
  let config: PrivateOwnerBootstrapConfiguration, verify: ReturnType<typeof createAccessVerifier>;
  try {
    config = configurationSchema.parse(input); assertNoSecretMaterial(config);
    verify = createAccessVerifier(trust);
  } catch { throw new Error("private_owner_bootstrap_config_invalid"); }
  const db = dependencies.database, clock = dependencies.clock;
  let attempted = false;
  return Object.freeze({ async bootstrap(assertion: string, signal?: AbortSignal) {
    const fail = () => { throw new Error("private_owner_bootstrap_failed"); };
    if (attempted) return fail(); attempted = true;
    try {
      if (typeof assertion !== "string" || !assertion || assertion.length > 16_384) return fail();
      const request = new Request("https://bootstrap.invalid", { headers: { "cf-access-jwt-assertion": assertion } });
      let highWater = -1;
      const current = () => {
        const now = clock();
        if (signal?.aborted || !Number.isSafeInteger(now) || now < 0 || now < highWater) return fail();
        highWater = now;
        const identity = verifyPinnedOwner(verify, config, request, now);
        return { identity, now };
      };
      current(); // Invalid or unconfirmed identity cannot touch the database.
      await db.transactionWithPreCommitCheck(async tx => {
        current();
        const target = (await tx.query<{ database_name: string }>("SELECT current_database() AS database_name")).rows;
        if (target.length !== 1 || target[0].database_name !== config.databaseName) return fail();
        const tenant = (await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [config.tenantId])).rows;
        const workspace = (await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [config.tenantId, config.workspaceId])).rows;
        if (tenant.length !== 1 || workspace.length !== 1) return fail();
        const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: work => work(tx),
          transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } };
        const { identity, now } = current();
        await new SecurityStore(joined).bootstrapOwner({ tenantId: config.tenantId,
          identityId: config.identityId, grantId: config.grantId, displayName: config.displayName,
          provider: identity.provider, subject: identity.subject, verifiedAt: new Date(now).toISOString(),
          expiresAt: identity.verificationExpiresAt, now: new Date(now).toISOString() });
      }, () => { current(); });
      return Object.freeze({ schema: "control-room.private-owner-bootstrap/v1", ownerCreated: true,
        applicationInstalled: false, productionReady: false, connectionCleanup: "caller_owned" });
    } catch { return fail(); }
  } });
}

export type PrivateOwnerBootstrapInput = { configuration: PrivateOwnerBootstrapConfiguration;
  trust: AccessTrust; database: PrivatePostgresConfiguration; assertion: string };

/** Explicit operator operation with owned, bounded connection cleanup. Never
 * called by website startup. The real factory contains no fixture override. */
export function createPrivateOwnerBootstrapCommand(dependencies: {
  openDatabase: typeof createPrivatePostgresDatabase; clock?: () => number;
}) {
  return async (input: PrivateOwnerBootstrapInput, signal?: AbortSignal) => {
    let pool: ReturnType<typeof createPrivatePostgresDatabase> | undefined;
    let passed = false;
    try {
      if (Object.keys(input).sort().join(',') !== 'assertion,configuration,database,trust') throw new Error();
      const config = configurationSchema.parse(input.configuration); assertNoSecretMaterial(config);
      const database = validatePrivatePostgresConfiguration(input.database), trust = structuredClone(input.trust);
      const assertion = input.assertion, sourceClock = dependencies.clock ?? Date.now;
      let highWater = -1;
      const clock = () => {
        const now = sourceClock();
        if (!Number.isSafeInteger(now) || now < 0 || now < highWater) throw new Error();
        highWater = now; return now;
      };
      if (database.database !== config.databaseName || signal?.aborted || typeof assertion !== 'string'
        || !assertion || assertion.length > 16_384) throw new Error();
      verifyPinnedOwner(createAccessVerifier(trust), config,
        new Request('https://bootstrap.invalid', { headers: { 'cf-access-jwt-assertion': assertion } }), clock());
      pool = dependencies.openDatabase(database);
      await createPrivateOwnerBootstrap(config, trust, { database: pool.client, clock }).bootstrap(assertion, signal);
      passed = true;
    } catch { passed = false; }
    if (pool) {
      try { await pool.close(); }
      catch { throw new Error('private_owner_bootstrap_cleanup_uncertain'); }
    }
    if (!passed) throw new Error('private_owner_bootstrap_failed');
    return Object.freeze({ schema: 'control-room.private-owner-bootstrap-command/v1', ownerCreated: true,
      databaseClosed: true, applicationInstalled: false, listenerStarted: false, productionReady: false });
  };
}
export const runPrivateOwnerBootstrap = createPrivateOwnerBootstrapCommand({ openDatabase: createPrivatePostgresDatabase });
