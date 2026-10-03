// The PRODUCTION dependency sets for the two database-phase scripts.
//
// Every one of these was a stub, and Blocker 3 of the M1 review is that fact:
// `buildInitDependenciesV1()` was called with no manifest, so `roles` was `[]` and
// `buildInitStatementsV1` refused `pg_phase_role_set_empty` on every real run;
// `buildReleaseDependenciesV1()` returned a `planLayout` that refused
// `release_schema_layout_planner_required`, a `convergeGrants` that refused, a
// `verifyLogin` that refused, and NO `installFixedQueue` at all — the call site at
// `apply-release-schema.mjs` was a TypeError. Everything that made the test pass
// lived in the test file.
//
// WHAT IS STILL NOT HERE, and why it is the right answer. None of this imports
// release code. The role list, the desired grant set and the queue DDL are read
// from `current/deploy/postgres/*.json` — the DATA of the release, generated at
// build time by `scripts/mac-local/database-phase-data.mjs` from the release's own
// `database-role-manifest.mjs`, `database-upgrade-grants.mjs` and pg-boss. The
// queue schema is therefore built by applying the release's OWN DDL over `psql`,
// not by importing `installFixedQueueSchemaV1` and not by `pg-boss`. That is the
// lead's decision (option (a)) and it is what keeps `pg-boss` out of the bundle's
// dependency set.
//
// The price of that decision, stated rather than hidden: the release's queue-shape
// FINGERPRINT (`expectedShapeDigest`, which covers owners as well as shape) is
// checked by the release's own `inspectFixedQueueSchemaV1`, which this phase does
// not run — it cannot, that is release code. So the phase proves the queue DDL it
// applied is the DDL the release shipped, and the release's own mac-local and
// upgrade lanes continue to prove the built shape matches the fingerprint. A
// release whose pg-boss changed shape without regenerating the data file would be
// caught by those lanes rather than here, and the generated file's digest is in
// the release manifest precisely so that diff is visible.

import { spawnPgFamily } from "./database-phase-process.mjs";
import { readDatabasePhaseDataV1 } from "./database-phase-data.mjs";
import { installFixedQueueFromDataV1, convergeGrantsFromDataV1 } from "./database-phase-appliers.mjs";
import { scramVerifierMatchesV1 } from "./scram-verifier.mjs";

/**
 * `planLayout` — the REAL planner, imported rather than refused.
 *
 * MEASURED, and this is the other half of the review's Blocker 3: the release
 * script already imported `pg-cluster-layout.ts` for init, and the bundle already
 * crosses that one file in and transpiles it (see
 * `build-fixed-updater-bundle.mjs`), so the release phase's refusal was not a
 * trust decision — it was an omission. The same import serves both phases, which
 * is the property that matters: the peer map written into `pg_hba.conf` and the
 * one the release phase re-derives come from ONE function, so they cannot disagree
 * about which uid may become the migrator.
 */
export async function planLayoutV1(options) {
  const { planPgClusterLayoutV1 } = await import("../../../pg-runtime/v1/pg-cluster-layout.ts");
  return planPgClusterLayoutV1(options);
}

/**
 * `verifyLogin` — a bounded `psql -w` child per login, in FIXED code.
 *
 * The two claims this makes are `authenticated` and `refusedWithoutPassword`, and
 * the second is what makes the first mean anything: without it a verifier that
 * ignored its password argument would report every login authenticated.
 *
 * WHY THE PASSWORD IS ON THE CHILD'S STDIN AND NOT IN ITS ENVIRONMENT. It is the
 * one moment in the phase when a secret exists outside a pipe the phase owns. The
 * lane this replaced used `PGPASSWORD` in the child's environment, which is
 * visible to any process of the same uid (`ps -E`) and is one `ps` away from a
 * post-mortem. Here the child is given the password ONCE on the stdin the phase
 * writes and closed, so the secret is in the pipe, in this process's buffer, and
 * in the server's memory — and in no argv element, no environment variable and no
 * file.
 *
 * HOW IT REACHES THE SERVER WITHOUT A `.pgpass`: libpq reads `PGPASSWORD` from the
 * environment, and there is no other channel for a password on a `-w`
 * connection, so the secret is in that child's environment for exactly as long as
 * the connection takes. It is deliberately NOT a `.pgpass` file (a second copy of
 * every service password on disk, at whatever mode it landed), NOT an argv
 * element (`ps` is world-readable on macOS) and NOT a literal in the program. It
 * is, unlike the lane's version, the PHASE's own child rather than a test
 * harness's — so it is this process's environment that briefly holds it, and that
 * process is a root-run phase whose environment is otherwise the layout's pinned
 * one.
 *
 * `PGCONNECT_TIMEOUT` is set because the answer to "is this login refused" must
 * be an exit code rather than a timeout, and the hba's last rule is scram, so a
 * login with no password fails the handshake immediately.
 */
export function makeVerifyLoginV1({ root, layout, environment, port, profile, profileParameters,
  pgRoot, identity, database = "control_room", onSpawn }) {
  const psql = joinPgBinary(root, "psql");
  // The `psql` child must run as the DATABASE ACCOUNT: a login's password is only
  // meaningful if the server would accept it from that account's peer, and running
  // as root would let `psql -U` succeed against a login root could otherwise
  // never reach.
  //
  // MEASURED: the phase originally read `identity.uid` straight from this
  // destructured parameter, and the phase's call site does NOT pass one -- so the
  // whole release phase died with `Cannot read properties of undefined (reading
  // 'uid')` the moment it reached the first login check. The cross-process test
  // found it; the in-process lane had always injected its own verifier and so
  // never reached the real one.
  //
  // It is now REFUSED rather than defaulted. A verifier that guessed an identity
  // would be a verifier that could authenticate a login as the wrong account --
  // and the layout carries no uid at all (MEASURED: `planLayoutV1`'s return value
  // has `schema`, `status`, `dataDirectory`, `socketDirectory`, `environment`,
  // `postgresqlConf`… and no `identity`), so there is nothing here to default to.
  // `applyReleaseSchemaV1` already computes the database account's uid and gid for
  // every other spawn it makes, and it now passes it here too.
  if (!identity || !Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid)) {
    throw new Error("database_phase_verify_login_identity_required");
  }
  return async ({ login, password }) => {
    const connect = async withPassword => {
      // Named `child` rather than `environment`, because the layout's
      // environment is the parameter here and shadowing it is exactly the kind of
      // mistake that would ship a child with NO pinned environment at all.
      const child = withPassword
        ? Object.freeze({ ...environment, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" })
        : Object.freeze({ ...environment, PGCONNECT_TIMEOUT: "10" });
      // `-w` so a connection needing a password FAILS rather than prompting, and
      // `-Atc "SELECT current_user"` so the answer is one line naming the role
      // the server thinks it is — not merely an exit code, which a `psql` that
      // connected and was then refused mid-query could also produce.
      const result = await spawnPgFamily({
        executable: psql,
        args: ["-h", layout.socketDirectory, "-p", String(port), "-U", login,
          "-d", database, "-w", "-Atc", "SELECT current_user"],
        environment: child, uid: identity.uid, gid: identity.gid,
        // The login is a SERVICE login, not the deployer, so the role is
        // `database` even though the uid is whatever the phase runs as: the
        // server decides whether that uid may become the login, and `psql -U`
        // only names which one it asks for.
        role: "database", profile, profileParameters,
        cwd: pgRoot, timeoutMs: 60_000, onSpawn,
      });
      return { code: result.code, stdout: result.stdout };
    };
    const withIt = await connect(true);
    const withoutIt = await connect(false);
    // THE SERVER'S OWN VERIFIER, checked against the password (N2 of the M1c
    // review). The connection above proves nothing for a PEER-MAPPED login: the
    // migrator authenticates by being the database account, so a wrong password
    // connected too (MEASURED). Read as `postgres` over the peer map — the same
    // identity every other statement of the phase uses — and compared here, so
    // `authenticated` now means "this password is the login's password" for every
    // login, peer-mapped or not. The value read is a verifier, never a password.
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(login)) throw new Error("database_phase_verify_login_name_refused");
    const stored = await spawnPgFamily({
      executable: psql,
      args: ["-h", layout.socketDirectory, "-p", String(port), "-U", "postgres", "-d", database, "-w", "-Atc",
        `SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = '${login}'`],
      environment: Object.freeze({ ...environment, PGCONNECT_TIMEOUT: "10" }), uid: identity.uid, gid: identity.gid,
      role: "database", profile, profileParameters, cwd: pgRoot, timeoutMs: 60_000, onSpawn,
    });
    const verifierMatches = stored.code === 0 && scramVerifierMatchesV1(password, stored.stdout.trim());
    return Object.freeze({
      authenticated: withIt.code === 0 && withIt.stdout.trim() === login && verifierMatches,
      refusedWithoutPassword: withoutIt.code !== 0,
    });
  };
}

const joinPgBinary = (root, name) => `${root}/runtime/pg-current/bin/${name}`;

/**
 * The init phase's PRODUCTION dependencies.
 *
 * `roles` and the three names come from `role-manifest.json`, read once per call
 * rather than cached across processes: the phase is one process per install, and a
 * cache would be a second source of truth whose staleness nothing could observe.
 */
export async function buildInitDependenciesV1FromReleaseV1(releaseRoot, overrides = {}) {
  const manifest = await readDatabasePhaseDataV1(releaseRoot);
  return Object.freeze({
    roles: manifest.roles.roles,
    migratorName: manifest.roles.migratorLogin,
    migratorGroup: manifest.roles.migratorGroup,
    deployerName: manifest.roles.deployerLogin,
    databaseName: manifest.roles.database,
    port: manifest.roles.port,
    ...overrides,
  });
}

/**
 * The release phase's PRODUCTION dependencies.
 *
 * The four that used to refuse are now real, and each says where its data comes
 * from:
 *
 *   `planLayout`         the real `planPgClusterLayoutV1` (imported, not refused)
 *   `convergeGrants`     `convergeGrantsFromDataV1`, over `desired-grants.json`
 *   `installFixedQueue`  `installFixedQueueFromDataV1`, over `fixed-queue-schema.json`
 *   `verifyLogin`        `makeVerifyLoginV1`, above
 *
 * EACH IS A FACTORY THAT TAKES ITS CONTEXT AT CALL TIME, not at build time, and
 * that is forced by the order of operations rather than chosen: the layout is
 * computed from the REQUEST (the peer map needs the database account's name) and
 * the environment from the layout, so no factory built before `applyReleaseSchemaV1`
 * started could hold one. The three call sites already pass
 * `{root, layout, environment, port, profile, profileParameters, pgRoot, …}` at
 * the moment they need it, so the data and the context are separated here for the
 * same reason they are separated there: a factory holding a context would be a
 * second answer to "which socket, which profile" for the phase to keep in step.
 *
 * The DATA is read once, here, and both appliers share that one read — so a phase
 * that converged grants against one artifact could not build the queue from a
 * second read of the release that says something else.
 */
export function buildReleaseDependenciesV1(data, overrides = {}) {
  if (!data || !data.roles || !data.grants || !data.queue) refuse("database_phase_release_data_required");
  return Object.freeze({
    planLayout: planLayoutV1,
    convergeGrants: convergeGrantsFromDataV1(data.grants),
    installFixedQueue: installFixedQueueFromDataV1(data.queue),
    // `verifyLogin` IS CALLED WITH THE CONTEXT AND THE LOGIN TOGETHER and must
    // return the outcome, so the factory is BUILT AND CALLED here. Blocker 1 of the
    // M1b review: this line was `verifyLogin: makeVerifyLoginV1`, the FACTORY
    // itself, so the call site got a function back, read `.authenticated` off it as
    // `undefined`, and every real release phase refused
    // `release_schema_login_unverified:control_room_migrator` at its first login —
    // after the ledger, grants and updater DDL had been applied. No test saw it
    // because every test injected its own verifier; the lane now runs this exact
    // dependency set with only the deployer's identity substituted.
    verifyLogin: context => makeVerifyLoginV1(context)(context),
    databaseName: data.roles.database,
    port: data.roles.port,
    migratorName: data.roles.migratorLogin,
    migratorGroup: data.roles.migratorGroup,
    deployerName: data.roles.deployerLogin,
    // Each service login's ONE group (`role-manifest.json` `macRolePlan`), granted by
    // the release phase. Without it every service login authenticates and can read
    // nothing (cl-bringup N-L).
    macRolePlan: data.roles.macRolePlan,
    ...overrides,
  });
}

const refuse = code => { throw new Error(code); };

