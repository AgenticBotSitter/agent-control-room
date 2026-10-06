import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const UPDATER_CONFIGURATION_SCHEMA_V1 = "control-room.updater-configuration/v1";
export const SUPERVISOR_CONFIGURATION_SCHEMA_V1 = "control-room.supervisor-configuration/v1";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const accountPattern = /^_[a-z][a-z0-9_]{1,30}$/u;
const safeIdPattern = /^[A-Za-z0-9._-]{1,80}$/u;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
const rpIdPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
// The logins the composed files name. NOT the deployer: it is peer-only
// (`cr root control_room_deployer`), the installer generates no password for it
// (`INSTALL_DATABASE_LOGINS_V1`), and `updater.json` names it without one.
// MEASURED (cl-bringup): with the deployer required here, every real install
// refused `protected_configuration_input_refused` at `install-services`, because
// the composer's tests handed it a deployer password the installer never makes.
const requiredDatabaseLogins = Object.freeze([
  "control_room_fleet", "control_room_fleet_owner", "control_room_migrator",
  "control_room_web", "control_room_work_intake_agent", "control_room_coordinator",
  "control_room_results", "control_room_publisher", "control_room_agent_reviewer_login", "control_room_queue_worker",
]);

// The fixed updater cannot import release code, so this pin is a LITERAL rather than
// an import of `deploy/postgres/migration-ledger.json`.
//
// It is now the ledger's real digest, and it was not before. MEASURED: the pin shipped
// with the installer stream carrying `393289da…`, which matched no ledger in this tree
// - not `cook/m1`'s 149 entries and not `cook/v1`'s 151. So every
// `parseNightlyBackupConfigurationV1` call answered `nightly_backup_configuration_refused`
// and `release parsers accept every protected golden` failed, and the only thing that
// made it visible was the merge bringing a test that parses the file back.
//
// The comment above this constant used to promise "a release-side golden test below
// this module deliberately catches ledger drift". There was no such test, which is
// how a pin can be wrong for as long as the module is young. `tests/updater-ledger-pin.test.mjs`
// is that test, and it reads the ledger as DATA rather than importing this value.
//
// UPDATED FOR 0250, and the second time this pin has been stale, which is worth
// stating plainly rather than quietly re-pinning. Migration 0250
// (`db/migrations/0250_supervisor_offline_attention.sql`) took the ledger from
// 157 to 158 entries in 8db512539, and this literal was not moved with it. The
// golden test above caught it on the first full run of `test:updater` after that
// commit -- the same mechanism that caught `393289da…` the first time. Two
// migrations, two missed pins: the honest reading is that re-pinning is a step
// in the migration checklist, not something this constant can enforce for
// itself. Until it is, the digest moves and this literal has to be moved with it.
// cook/9int7 moved it again: 0243 (planall), 0246 (misc3all), 0250 (mnotify2),
// 0255 and 0256 (filesall) met on one tree, 162 ledger entries, re-pinned to
// `scripts/generate-migration-ledger.mjs`'s digest for that ledger.
// cook/9int8 moved it again: perf1's 0270 and 0271 (two SELECT grants), 164 entries.
// cook/9int9 moved it again for ledgeruniq's 0291
// (`db/migrations/0291_migration_ledger_position_unique.sql`), which makes `ledger_order`
// UNIQUE -- 165 entries on that tree -- and again for mr5o's 0290 (control_task_handoffs),
// 166 entries. cook/10int10 moved it again for perf2's 0272/0273 (two read indexes), 168 entries, and for r5bk's 0285 (queue backup read), 169 entries; r6proj's production_table_grants.sql change moved it again.
// cook/11int11 moved it again for r7lfix's 0298 (owner run allowance receipt read), 170 entries.
// Every migration added above this
// line moves this pin, and `tests/updater-ledger-pin.test.mjs` is what refuses a run
// that forgot: a stale pin answers `nightly_backup_configuration_refused` at parse time.
export const RELEASE_MIGRATION_LEDGER_DIGEST_V1 =
  `sha256:c5b27220129a5201f7baeadf48f00d3134726ebe056cb456095b7a88ad4cca03`;

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const safeAbsolutePath = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && normalize(value) === value && resolve(value) === value && value !== "/"
  && !value.endsWith("/") && !/[\u0000-\u001f\u007f]/u.test(value);
const within = (root, value) => {
  const path = relative(root, value);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const sha256 = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function captureAccount(value) {
  if (!exactKeys(value, ["name", "uid", "gid", "created"]) || typeof value.name !== "string" || !accountPattern.test(value.name)
    || !Number.isSafeInteger(value.uid) || value.uid < 1 || value.uid > 0x7fffffff
    || !Number.isSafeInteger(value.gid) || value.gid < 1 || value.gid > 0x7fffffff
    || typeof value.created !== "boolean") refuse("protected_configuration_input_refused");
  return Object.freeze({ name: value.name, uid: value.uid, gid: value.gid, created: value.created });
}

function captureAccounts(value) {
  if (!exactKeys(value, ["builder", "database", "service"])) refuse("protected_configuration_input_refused");
  const captured = Object.freeze({ builder: captureAccount(value.builder), database: captureAccount(value.database),
    service: captureAccount(value.service) });
  if (new Set(Object.values(captured).map(account => account.name)).size !== 3) {
    refuse("protected_configuration_input_refused");
  }
  return captured;
}

function captureTenant(value) {
  if (!exactKeys(value, ["tenantId", "workspaceId", "provider", "subject"])
    || Object.values(value).some(item => typeof item !== "string")) {
    refuse("protected_configuration_input_refused");
  }
  return Object.freeze({ tenantId: value.tenantId, workspaceId: value.workspaceId,
    provider: value.provider, subject: value.subject });
}

function captureDatabaseLogins(value, root) {
  if (!Array.isArray(value) || value.length < requiredDatabaseLogins.length || value.length > 32) {
    refuse("protected_configuration_input_refused");
  }
  const captured = value.map(entry => {
    if (!exactKeys(entry, ["name", "password", "passwordDigest", "fileRef"])
      || typeof entry.name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(entry.name)
      || typeof entry.password !== "string" || !secretPattern.test(entry.password)
      || entry.passwordDigest !== sha256(entry.password) || !digestPattern.test(entry.passwordDigest)
      || !safeAbsolutePath(entry.fileRef) || !within(root, entry.fileRef)
      || entry.fileRef !== join(root, "Protected", "config", "database-passwords", `${entry.name}.txt`)) {
      refuse("protected_configuration_input_refused");
    }
    return Object.freeze({ name: entry.name, password: entry.password,
      passwordDigest: entry.passwordDigest, fileRef: entry.fileRef });
  });
  const byName = new Map(captured.map(entry => [entry.name, entry]));
  if (byName.size !== captured.length || requiredDatabaseLogins.some(name => !byName.has(name))) {
    refuse("protected_configuration_input_refused");
  }
  return byName;
}

function captureKeys(value, root) {
  if (!exactKeys(value, ["vapidPrivate", "vapidPublic", "healthProbeRoot", "healthProbeService", "webHmac", "workIntake"])) {
    refuse("protected_configuration_input_refused");
  }
  const expected = {
    vapidPrivate: join(root, "updater-state", "vapid.json"),
    vapidPublic: join(root, "Protected", "service", "vapid-public.json"),
    healthProbeRoot: join(root, "updater-state", "health-probe.key"),
    healthProbeService: join(root, "Protected", "service", "health-probe.key"),
  };
  for (const [name, path] of Object.entries(expected)) {
    if (value[name] !== path) refuse("protected_configuration_input_refused");
  }
  if (!exactKeys(value.webHmac, ["fileRef", "value"]) || value.webHmac.fileRef !== join(root, "Protected", "service", "web-hmac.key")
    || typeof value.webHmac.value !== "string" || !secretPattern.test(value.webHmac.value)
    || !exactKeys(value.workIntake, ["fileRef", "integrityKey"]) || value.workIntake.fileRef !== join(root, "Protected", "service", "work-intake.json")
    || typeof value.workIntake.integrityKey !== "string" || !secretPattern.test(value.workIntake.integrityKey)) refuse("protected_configuration_input_refused");
  return Object.freeze({ ...expected,
    webHmac: Object.freeze({ fileRef: value.webHmac.fileRef, value: value.webHmac.value }),
    workIntake: Object.freeze({ fileRef: value.workIntake.fileRef, integrityKey: value.workIntake.integrityKey }) });
}

// The installed cluster is socket-only (`listen_addresses = ''`), so every service
// reaches it through the install's own socket directory, never TCP. MEASURED
// (cl-bringup N-F): with `127.0.0.1:5432` here no service could ever connect.
function database(root, login) {
  return Object.freeze({ host: join(root, "pg", "socket"), port: 5432, database: "control_room",
    username: login.name, password: login.password, majorVersion: 17 });
}

function resource(path, value, accountName, groupName, fileMode = "0600") {
  return Object.freeze({ path, contents: json(value), accountName, groupName, fileMode });
}

/** Pure fixed-updater composition. The caller captures secrets before entering this function;
 * this module deliberately performs no reads, writes, imports from the release, or other I/O. */
export function composeProtectedConfigV1(input, releaseParsers) {
  if (typeof releaseParsers?.captureMacLocalProtectedConfigurationV1 !== "function"
    || typeof releaseParsers?.captureMacLocalDatabaseRolesV1 !== "function"
    || typeof releaseParsers?.captureReleaseTrustV1 !== "function") refuse("protected_configuration_input_refused");
  if (!exactKeys(input, ["root", "accounts", "installationId", "rpId", "webPort", "gatewayPort", "tenant",
    "ownerCodeDigest", "dbLogins", "keys", "releaseTrust"]) || !safeAbsolutePath(input.root)
    || typeof input.installationId !== "string" || !safeIdPattern.test(input.installationId)
    || typeof input.rpId !== "string" || !rpIdPattern.test(input.rpId)
    || !Number.isSafeInteger(input.webPort) || input.webPort < 1024 || input.webPort > 65535
    || !Number.isSafeInteger(input.gatewayPort) || input.gatewayPort < 1024 || input.gatewayPort > 65535
    || input.webPort === input.gatewayPort || typeof input.ownerCodeDigest !== "string" || !digestPattern.test(input.ownerCodeDigest)) {
    refuse("protected_configuration_input_refused");
  }
  const root = input.root, accounts = captureAccounts(input.accounts), tenant = captureTenant(input.tenant);
  const logins = captureDatabaseLogins(input.dbLogins, root), keys = captureKeys(input.keys, root);
  const configRoot = join(root, "Protected", "config"), service = accounts.service.name;
  const login = name => logins.get(name);

  const passkey = Object.freeze({ installationId: input.installationId, rpId: input.rpId,
    expectedOrigin: `https://${input.rpId}` });
  const localOwnerSession = Object.freeze({ schema: "control-room.local-owner-session/v1",
    origin: `http://127.0.0.1:${input.webPort}`, tenantId: tenant.tenantId, provider: tenant.provider,
    subject: tenant.subject, ownerCodeDigest: input.ownerCodeDigest, sessionSeconds: 3_600,
    remoteOrigins: Object.freeze([`https://${input.rpId}`]) });
  const releaseTrust = releaseParsers.captureReleaseTrustV1(input.releaseTrust);
  const databaseRoles = releaseParsers.captureMacLocalDatabaseRolesV1({
    schema: "control-room.mac-local-database-roles/v1", web: database(root, login("control_room_web")),
    coordinator: database(root, login("control_room_coordinator")), results: database(root, login("control_room_results")),
    publisher: database(root, login("control_room_publisher")), agentReviewer: database(root, login("control_room_agent_reviewer_login")),
    queueWorker: database(root, login("control_room_queue_worker")), fleetGateway: database(root, login("control_room_fleet")),
    fleetOwner: database(root, login("control_room_fleet_owner")),
  }, { installRoot: root });
  const { remoteOrigins: _derivedOrigins, ...webSession } = localOwnerSession;
  const macLocal = { schema: "control-room.mac-local-protected-configuration/v1", port: input.webPort,
    workspaceId: tenant.workspaceId, localOwnerSession: webSession, database: databaseRoles.web,
    enablement: { schema: "control-room.owner-trusted-local-enablement/v1", mode: "mac-local", nodeId: "mac-1", workers: [] },
    workIntakeProjectIds: [], remoteAccess: { schema: "control-room.mac-local-remote-access/v1", tailscale: { origin: `https://${input.rpId}` } } };
  // Validate plain file material; captured sessions contain derived fields that
  // must not be written back into the protected JSON.
  releaseParsers.captureMacLocalProtectedConfigurationV1(macLocal, { installRoot: root });
  const fleetGateway = Object.freeze({ schema: "control-room.fleet-gateway/v1", tenantId: tenant.tenantId,
    port: input.gatewayPort, database: database(root, login("control_room_fleet")),
    workIntake: Object.freeze({ database: database(root, login("control_room_work_intake_agent")),
      integrityKey: keys.workIntake.integrityKey }), harnessIntegrityKey: keys.webHmac.value,
    healthProbeKeyFile: keys.healthProbeService, releaseTrust,
    trustedProxyAddresses: Object.freeze([]), trustedClientHeader: "none" });
  const supervisor = Object.freeze({ schema: SUPERVISOR_CONFIGURATION_SCHEMA_V1,
    protectedRoot: join(root, "Protected"), workspaceId: tenant.workspaceId, webPort: input.webPort,
    databaseLogin: Object.freeze({ name: "control_room_web", passwordFile: login("control_room_web").fileRef,
      passwordDigest: login("control_room_web").passwordDigest }),
    keys: Object.freeze({ vapidPrivate: keys.vapidPrivate, vapidPublic: keys.vapidPublic,
      healthProbeRoot: keys.healthProbeRoot, healthProbeService: keys.healthProbeService,
      webHmac: keys.webHmac.fileRef, workIntake: keys.workIntake.fileRef }) });
  const backup = Object.freeze({ schema: "control-room.nightly-backup/v1",
    database: Object.freeze({ host: join(root, "pg", "socket"), port: 5432, name: "control_room",
      login: "control_room_migrator", passwordFile: login("control_room_migrator").fileRef }),
    outputRoot: join(root, "backups", "nightly"),
    lockFile: join(root, "Protected", "runtime-state", "nightly-backup", "run.lock"),
    pgBin: join(root, "runtime", "pg-current", "bin"), ledgerDigest: RELEASE_MIGRATION_LEDGER_DIGEST_V1,
    requiredTables: Object.freeze(["tenants", "workspaces", "projects", "control_web_task_commands",
      "control_harness_runs", "control_harness_run_events"]), retention: Object.freeze({ dailyBackups: 14 }) });
  const updater = Object.freeze({ schema: UPDATER_CONFIGURATION_SCHEMA_V1,
    database: Object.freeze({ host: join(root, "pg", "socket"), port: 5432,
      name: "control_room", user: "control_room_deployer" }) });

  return Object.freeze([
    resource(join(configRoot, "host.json"), passkey, "root", service, "0640"),
    resource(join(configRoot, "local-owner-session.json"), localOwnerSession, "root", service, "0640"),
    resource(join(configRoot, "fleet-gateway.json"), fleetGateway, "root", service, "0640"),
    resource(join(configRoot, "supervisor.json"), supervisor, "root", service, "0640"),
    resource(join(configRoot, "backup.json"), backup, "root", service, "0640"),
    resource(join(configRoot, "mac-local.json"), macLocal, "root", service, "0640"),
    resource(join(configRoot, "database-roles.json"), databaseRoles, "root", service, "0640"),
    resource(join(configRoot, "release-trust.json"), releaseTrust, "root", service, "0640"),
    resource(join(root, "updater-state", "updater.json"), updater, "root", "wheel"),
  ]);
}
