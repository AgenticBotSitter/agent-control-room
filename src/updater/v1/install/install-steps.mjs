import { createHash } from "node:crypto";
import { join } from "node:path";
export { createStageOnePortsV1 } from "./stage-one-ports.mjs";

export const DATABASE_SERVICE_ROLES_V1 = Object.freeze(["postgresql17"]);
export const CORE_SERVICE_ROLES_V1 = Object.freeze(["supervisor", "fleet-gateway"]);
export const POST_HEALTH_SERVICE_ROLES_V1 = Object.freeze(["nightly-backup", "updater", "updater-guard"]);
// The deployer is peer-only (`cr root control_room_deployer`): it holds no password
// and the shared phase parser now refuses it outright, so asking for one here would
// refuse the install at step 0 instead of at the loader's own boundary. It is
// granted by the migrations, not by the installer's password list.
export const INSTALL_DATABASE_LOGINS_V1 = Object.freeze([
  "control_room_migrator", "control_room_app", "control_room_scheduler", "control_room_work_intake_agent",
  "control_room_web", "control_room_coordinator", "control_room_results", "control_room_publisher",
  "control_room_agent_reviewer_login", "control_room_queue_worker", "control_room_fleet", "control_room_fleet_owner",
]);

// The owner identity the first-owner step creates, chosen by the INSTALLER before the
// step (N1) because protected configuration is composed after it, from its result.
// These are the Mac-local values the release's own provisioner writes
// (`captureProvisionedMacLocalConfigurationV1`), so an installed Mac and a
// provisioned one name the same tenant, owner and workers.
export const FIRST_OWNER_OWNER_V1 = Object.freeze({
  tenantId: "tenant:mac-local", workspaceId: "workspace:mac-local", provider: "local-owner", subject: "owner:local",
  nodeBase: "mac-1",
  workers: Object.freeze({ hermes: "worker:hermes:mac-1", claude: "worker:claude:mac-1", codex: "worker:codex:mac-1" }),
  workIntakeProjectIds: Object.freeze([]),
});

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9._-]{1,80}$/u;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const ownerCodeDigest = value => sha256(JSON.stringify({ ownerCode: value }));
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function requireContext(context) {
  if (!exactKeys(context, ["root", "transactionId", "accounts", "invokingUser", "write", "undo", "ports",
    "options", "attended", "runtimeInventory"]) || typeof context.root !== "string"
    || !safeIdPattern.test(context.transactionId) || typeof context.write !== "function"
    || !Array.isArray(context.undo) || !context.ports || typeof context.ports !== "object") {
    refuse("install_steps_context_refused");
  }
  const required = ["vendorRuntime", "rollbackRuntime", "initializeDatabase", "installServices", "uninstallServices",
    "recoverServices", "killAccountProcesses", "retireDatabase", "firstOwner", "installGuard", "removeGuard",
    "composeProtectedConfig", "writeDatabaseLogins", "removeDatabaseLogins", "readTailscaleRpId", "captureTailscaleServe",
    "activateTailscaleServe", "inspectTailscaleServe", "restoreTailscaleServe", "recordTailscaleServe", "checkHealth",
    "seedKnownGood", "removeKnownGood", "remintOwnerCode", "rollbackOwnerCode", "startPostHealthServices"];
  if (required.some(name => typeof context.ports[name] !== "function") || typeof context.ports.randomBytes !== "function") {
    refuse("install_steps_ports_refused");
  }
  return context;
}

async function journalStep(write, action, effect) {
  await write("planned", action);
  const data = await effect();
  await write("done", action, data ?? {});
  return data;
}

function serviceInput(context, roles, protectedConfig = []) {
  return Object.freeze({ root: context.root, accounts: context.accounts, roles: Object.freeze([...roles]),
    protectedConfig, pgRuntime: join(context.root, "runtime", "pg-current", "bin", "postgres"),
    updaterVersion: context.attended.bundle.uver,
    ...(context.options.servicePolicy ? { servicePolicy: context.options.servicePolicy } : {}) });
}

function serviceReceipt(result, roles) {
  if (!result || !digestPattern.test(result.bundleDigest ?? "") || !result.receipt
    || !digestPattern.test(result.receipt.receiptDigest ?? "")
    || result.receipt.roles?.join("\0") !== roles.join("\0")) refuse("services_batch_uncertain");
  return result;
}

function databaseAccounts(accounts) {
  return Object.freeze(Object.fromEntries(["database", "service"].map(role => [role,
    Object.freeze({ name: accounts[role].name, uid: accounts[role].uid, gid: accounts[role].gid })])));
}

function makeCredentials(context) {
  const passwords = Object.fromEntries(INSTALL_DATABASE_LOGINS_V1.map(name => {
    const bytes = context.ports.randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 32) refuse("database_credentials_refused");
    return [name, bytes.toString("base64url")];
  }));
  return Object.freeze({
    logins: Object.freeze(INSTALL_DATABASE_LOGINS_V1.map(name => Object.freeze({ name, passwordStdin: true }))),
    passwords: Object.freeze(passwords),
  });
}

function databaseInput(context, phase, pgDataId, credentials) {
  return Object.freeze({ phase, root: context.root, pgDataId, runtime: "runtime/pg-current", socketDir: "pg/socket",
    accounts: databaseAccounts(context.accounts), logins: credentials.logins, passwords: credentials.passwords });
}

function serve443Entry(serve) {
  if (!serve || typeof serve !== "object" || Array.isArray(serve)
    || !serve.Web || typeof serve.Web !== "object" || Array.isArray(serve.Web)) {
    refuse("tailscale_exclusivity_refused");
  }
  const entries = Object.entries(serve.Web).filter(([key]) => key.endsWith(":443"));
  if (entries.length !== 1) refuse("tailscale_exclusivity_refused");
  return entries[0];
}

function extractRpId(serve) {
  return serve443Entry(serve)[0].slice(0, -4);
}

function keyReferences(root) {
  return Object.freeze({
    vapidPrivate: join(root, "updater-state", "vapid.json"),
    vapidPublic: join(root, "Protected", "service", "vapid-public.json"),
    healthProbeRoot: join(root, "updater-state", "health-probe.key"),
    healthProbeService: join(root, "Protected", "service", "health-probe.key"),
    webHmac: join(root, "Protected", "service", "web-hmac.key"),
    workIntake: join(root, "Protected", "service", "work-intake.json"),
  });
}

export function assertExclusiveServeV1(serve, webPort) {
  const entry = serve443Entry(serve), handlers = entry[1]?.Handlers;
  if (!handlers || typeof handlers !== "object"
    || Array.isArray(handlers) || Object.keys(handlers).length !== 1
    || handlers["/"]?.Proxy !== `http://127.0.0.1:${webPort}`) refuse("tailscale_exclusivity_refused");
  const funnel = serve.AllowFunnel;
  if (funnel !== undefined && (!funnel || typeof funnel !== "object" || Array.isArray(funnel)
    || funnel[entry[0]] === true)) refuse("tailscale_exclusivity_refused");
  return serve;
}

export function initialPasskeyUrlV1({ rpId, ownerCode, registrationSecret, ownerCodeConsumed = false }) {
  if (typeof rpId !== "string" || !/^[A-Za-z0-9.-]{1,253}$/u.test(rpId)
    || typeof registrationSecret !== "string" || !/^[A-Za-z0-9_-]{16,512}$/u.test(registrationSecret)
    || !ownerCodeConsumed && (typeof ownerCode !== "string" || !/^[A-Za-z0-9_-]{16,512}$/u.test(ownerCode))) {
    refuse("passkey_registration_url_refused");
  }
  const fragment = new URLSearchParams();
  if (!ownerCodeConsumed) fragment.set("code", ownerCode);
  fragment.set("reg", registrationSecret);
  return `https://${rpId}/setup#${fragment.toString()}`;
}

/** The verified stage-1 continuation. It owns order and receipts, not database authority. */
export async function continueInstallV1(rawContext) {
  const context = requireContext(rawContext), { root, ports, options, write, undo } = context;
  if (options.rehearsalMode === true && (typeof options.writeEvidence !== "function"
    || ["assertRuntimeTreeRootMetadata", "assertSeatbeltApplied", "assertRehearsalOwnerDenied"]
      .some(name => typeof ports[name] !== "function"))) {
    refuse("rehearsal_evidence_refused");
  }
  const credentials = makeCredentials(context);
  const pgDataId = `data-${context.transactionId.replace(/-/gu, "").slice(0, 24)}`;

  const runtime = await journalStep(write, "vendor-pg-runtime", async () => {
    const value = await ports.vendorRuntime({ root, inventory: context.runtimeInventory, tools: ["postgresql"], fresh: true,
      download: { uid: context.accounts.builder.uid, gid: context.accounts.builder.gid }, transactionId: context.transactionId });
    if (!value?.installed?.postgresql || value.links?.["pg-current"] === undefined) refuse("pg_runtime_vendor_refused");
    undo.push(() => ports.rollbackRuntime({ root, receipt: value })); return value;
  });
  if (options.rehearsalMode === true) {
    const metadata = await ports.assertRuntimeTreeRootMetadata({ root, tree: "postgresql" });
    if (!metadata || !Number.isSafeInteger(metadata.entries) || metadata.entries < 1) refuse("rehearsal_evidence_refused");
    await options.writeEvidence("runtime-root-metadata", { tree: "postgresql", passed: true, entries: metadata.entries });
  }

  const initialized = await journalStep(write, "init-database", async () => {
    undo.push(async () => {
      await ports.recoverServices({ root, roles: DATABASE_SERVICE_ROLES_V1 });
      await ports.killAccountProcesses({ uid: context.accounts.database.uid });
      // `accountUid` is the SAME account just swept, and it is load-bearing: the
      // postmaster that `retireDatabase` must not delete a running cluster for
      // belongs to D, not to the root this undo runs as. Without it the port
      // falls back to its own uid and every live postmaster reads as somebody
      // else's account — still a refusal, so safe, but for the wrong reason, and
      // the argv sweep that catches an orphaned `initdb` would miss D's.
      await ports.retireDatabase({ root, pgDataId, accountUid: context.accounts.database.uid });
    });
    const value = await ports.initializeDatabase(databaseInput(context, "init", pgDataId, credentials));
    if (!exactKeys(value, ["schema", "outcome", "pgDataId", "updaterSchemaDigest", "clusterShutDownClean"])
      || value.outcome !== "initialized" || value.pgDataId !== pgDataId
      || value.clusterShutDownClean !== true || !digestPattern.test(value.updaterSchemaDigest ?? "")) {
      refuse("database_phase_result_refused");
    }
    return value;
  });

  const databaseServices = await journalStep(write, "install-database-service", async () => {
    const value = serviceReceipt(await ports.installServices(serviceInput(context, DATABASE_SERVICE_ROLES_V1)),
      DATABASE_SERVICE_ROLES_V1);
    undo.push(() => ports.uninstallServices({ root, receipt: value.receipt,
      ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) })); return value;
  });
  if (options.rehearsalMode === true) {
    const seatbelt = await ports.assertSeatbeltApplied({ root, role: "postgres", servicePolicy: options.servicePolicy });
    if (seatbelt?.role !== "postgres" || seatbelt.applied !== true || seatbelt.skipped !== false) {
      refuse("rehearsal_evidence_refused");
    }
    await options.writeEvidence("seatbelt", seatbelt);
  }

  if (options.moveLiveDatabase === true) {
    if (options.rehearsalConfig !== undefined) refuse("rehearsal_move_live_database_refused");
    if (typeof ports.moveLiveDatabase !== "function") refuse("move_live_database_unavailable");
    await journalStep(write, "move-live-db", () => ports.moveLiveDatabase({ root, accounts: context.accounts,
      verifiedDump: true, scratchParent: join(root, "pg"), retainSource: true, spawnTrusted: options.spawnTrusted }));
  } else await journalStep(write, "fresh-database", async () => ({ selected: true }));

  const schema = await journalStep(write, "apply-release-schema", () => ports.initializeDatabase(
    databaseInput(context, "release", pgDataId, credentials)));
  if (!exactKeys(schema, ["schema", "outcome", "schemaDigest", "ledgerHead"])
    || schema.outcome !== "applied" || !digestPattern.test(schema.schemaDigest ?? "")
    || typeof schema.ledgerHead !== "string") refuse("database_phase_result_refused");

  // JOURNALLED, receipt only (rv-9b B1/B4). M4's `removeDatabaseLogins` refuses to
  // delete a login file it holds no receipt for, so recovery after a kill past this
  // point needs the receipt the in-process undo has; and the undo passes the
  // RECEIPT, not the writer's whole result. Never the `references`: they carry the
  // plaintext passwords for the composer.
  let loginReceipt;
  await journalStep(write, "write-database-logins", async () => {
    loginReceipt = await ports.writeDatabaseLogins({ root, accounts: context.accounts,
      passwords: credentials.passwords });
    undo.push(() => ports.removeDatabaseLogins({ root,
      ...(loginReceipt?.receipt === undefined ? {} : { receipt: loginReceipt.receipt }) }));
    return { receipt: loginReceipt?.receipt ?? null };
  });

  // Everything the release's transaction needs is passed HERE (N1): the data id the
  // port finds the socket and the database account from, and the owner values. The
  // port runs the release's `firstOwner.js` as a child and never reads protected
  // configuration, which `install-services` composes from this step's result.
  const owner = await journalStep(write, "first-owner", () => ports.firstOwner({ root, accounts: context.accounts,
    release: "current", schemaDigest: schema.schemaDigest, pgDataId, owner: FIRST_OWNER_OWNER_V1 }));
  if (!exactKeys(owner, ["tenantId", "workspaceId", "provider", "subject"])
    || Object.values(owner).some(value => typeof value !== "string" || value.length < 1 || value.length > 512)) {
    refuse("first_owner_result_refused");
  }

  const guard = await journalStep(write, "install-guard", async () => {
    const value = await ports.installGuard({ root, source: join(root, "updater", "current", "guard.sh"),
      target: join(root, "guard", "guard.sh"),
      ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) });
    if (!digestPattern.test(value?.digest ?? "")) refuse("guard_install_refused");
    undo.push(() => ports.removeGuard({ root, receipt: value })); return value;
  });

  const inactiveOwnerCode = ports.randomBytes(32).toString("base64url");
  let configuration, rpId;
  const coreServices = await journalStep(write, "install-services", async () => {
    rpId = options.rehearsalMode === true ? options.tailnetIdentity
      : await ports.readTailscaleRpId({ identity: context.invokingUser });
    if (typeof rpId !== "string" || !/^[A-Za-z0-9.-]{1,253}$/u.test(rpId)) refuse("tailscale_rp_id_refused");
    configuration = await ports.composeProtectedConfig({ root, accounts: context.accounts,
      installationId: options.installationId ?? context.transactionId, rpId, webPort: options.webPort,
      gatewayPort: options.gatewayPort, tenant: owner, ownerCodeDigest: ownerCodeDigest(inactiveOwnerCode),
      dbLogins: loginReceipt.references, keys: keyReferences(root),
      releaseTrust: options.releaseTrust });
    const value = serviceReceipt(await ports.installServices(serviceInput(context, CORE_SERVICE_ROLES_V1, configuration)),
      CORE_SERVICE_ROLES_V1);
    undo.push(() => ports.uninstallServices({ root, receipt: value.receipt,
      ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) })); return value;
  });
  if (options.rehearsalMode === true) {
    const seatbelt = await ports.assertSeatbeltApplied({ root, role: "supervisor", servicePolicy: options.servicePolicy });
    if (seatbelt?.role !== "supervisor" || seatbelt.applied !== true || seatbelt.skipped !== false) {
      refuse("rehearsal_evidence_refused");
    }
    await options.writeEvidence("seatbelt", seatbelt);
  }

  let recorded;
  if (options.rehearsalMode === true) {
    if (options.tailscale?.mode !== "skip" || options.tailscale?.mutationAllowed !== false
        || options.tailscale?.expectedStepOutcome !== "skipped (rehearsal)"
        || typeof options.writeEvidence !== "function") refuse("rehearsal_tailscale_policy_refused");
    for (const [action, step] of [["capture-tailscale", "capture"], ["activate-tailscale", "activate"],
      ["restore-tailscale", "restore"]]) {
      const data = await journalStep(write, action, async () => ({ outcome: "skipped (rehearsal)" }));
      await options.writeEvidence("tailscale-step", { step, outcome: data.outcome });
    }
    recorded = await journalStep(write, "record-serve", async () => ({ outcome: "skipped (rehearsal)" }));
  } else {
    const snapshot = await journalStep(write, "capture-tailscale", async () => {
      const value = await ports.captureTailscaleServe({ temporaryDirectory: join(root, "updater-state", "tmp"),
        identity: context.invokingUser });
      undo.push(() => ports.restoreTailscaleServe({ snapshot: value, temporaryDirectory: join(root, "updater-state", "tmp"),
        identity: context.invokingUser })); return value;
    });
    await journalStep(write, "activate-tailscale", () => ports.activateTailscaleServe({ webPort: options.webPort,
      identity: context.invokingUser }));
    const serve = assertExclusiveServeV1(await ports.inspectTailscaleServe({ identity: context.invokingUser }), options.webPort);
    recorded = await journalStep(write, "record-serve", () => ports.recordTailscaleServe({ root, serve,
      webPort: options.webPort }));
    if (extractRpId(serve) !== rpId) refuse("tailscale_rp_id_changed");
  }

  const health = await journalStep(write, "health-check", () => ports.checkHealth({ root,
    expectedRelease: context.attended.current, pgDataId, schemaDigest: schema.schemaDigest,
    updaterSchemaDigest: initialized.updaterSchemaDigest, webPort: options.webPort,
    gatewayPort: options.gatewayPort, samples: 3 }));
  if (!exactKeys(health, ["healthy", "samples", "schemaDigest"]) || health.healthy !== true || health.samples !== 3
    || health.schemaDigest !== schema.schemaDigest) refuse("health_check_refused");
  if (options.rehearsalMode === true) {
    await options.writeEvidence("health", { healthy: true, samples: health.samples, schemaDigest: health.schemaDigest });
    const ownerUid = context.invokingUser?.uid;
    if (!Number.isSafeInteger(ownerUid) || ownerUid < 501) refuse("rehearsal_evidence_refused");
    await options.writeEvidence("owner-uid", { uid: ownerUid });
    for (const operation of ["read", "write", "signal"]) {
      const denial = await ports.assertRehearsalOwnerDenied({ root, identity: context.invokingUser,
        operation, servicePolicy: options.servicePolicy });
      if (denial?.uid !== ownerUid || denial.operation !== operation || denial.denied !== true) {
        refuse("rehearsal_evidence_refused");
      }
      await options.writeEvidence("p0-denial", denial);
    }
  }

  const knownGood = await journalStep(write, "seed-known-good", async () => {
    const value = await ports.seedKnownGood({ root, releaseId: context.attended.release.releaseId, pgDataId,
      schemaDigest: schema.schemaDigest });
    if (!exactKeys(value, ["releaseId", "pgDataId", "schemaDigest"])
      || value.releaseId !== context.attended.release.releaseId || value.pgDataId !== pgDataId
      || value.schemaDigest !== schema.schemaDigest) refuse("known_good_seed_refused");
    undo.push(() => ports.removeKnownGood({ root, expected: value })); return value;
  });

  const ownerSession = await journalStep(write, "mint-owner-session", async () => {
    const value = await ports.remintOwnerCode({ root, accounts: context.accounts, configuration, rpId, maximumRemints: 2,
      ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) });
    if (!value || typeof value.ownerCode !== "string" || value.ownerCode.length < 16
      || !digestPattern.test(value.ownerCodeDigest ?? "") || !value.receipt) refuse("owner_code_refused");
    undo.push(() => ports.rollbackOwnerCode({ root, receipt: value.receipt,
      ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) })); return value;
  });

  const postHealth = await journalStep(write, "install-post-health-services", async () => {
    const value = serviceReceipt(await ports.startPostHealthServices(serviceInput(context, POST_HEALTH_SERVICE_ROLES_V1),
      { healthAccepted: true, knownGoodAccepted: true }), POST_HEALTH_SERVICE_ROLES_V1);
    undo.push(() => ports.uninstallServices({ root, receipt: value.receipt,
      ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) })); return value;
  });

  return Object.freeze({ pgDataId, schemaDigest: schema.schemaDigest, updaterSchemaDigest: initialized.updaterSchemaDigest,
    rpId, ownerCode: ownerSession.ownerCode, passkeyConfig: options.passkeyConfig ?? { rpId },
    serveReceipt: recorded, knownGood, receipts: Object.freeze({ database: databaseServices.receipt,
      core: coreServices.receipt, postHealth: postHealth.receipt, ownerSession: ownerSession.receipt }) });
}
