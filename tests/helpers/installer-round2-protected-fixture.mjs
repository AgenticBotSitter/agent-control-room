import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { captureFleetGatewayConfigurationV1 } from "../../scripts/run-fleet-gateway.ts";
import { parseNightlyBackupConfigurationV1 } from "../../src/installer/v1/nightly-backup-configuration.ts";
import { captureLocalOwnerSessionProfileV1 } from "../../src/web/v1/local-owner-session.ts";
import { parsePasskeyConfigV1 } from "../../src/updater/v1/passkey.mjs";
import { CORE_SERVICE_ROLES_V1, composeServiceBundleV1 } from "../../src/updater/v1/services/bundle.mjs";
import { createInProcessServiceElevatedPortV1 } from "../../src/updater/v1/services/elevated.mjs";
import { installServicesV1 } from "../../src/updater/v1/services/installer.mjs";
import { composeProtectedConfigV1 as compose } from "../../src/updater/v1/services/protected-config.mjs";
import { createFleetReleaseTrustForTestV1 } from "../../tests/support/fleet-release.ts";
import { INSTALL_DATABASE_LOGINS_V1 } from "../../src/updater/v1/install/install-steps.mjs";
import { loadUpdaterConfigurationV1, startUpdaterV1 } from "../../src/updater/v1/updater.mjs";

import * as releaseParsers from "../../src/web/v1/mac-local-protected-loader.ts";
import { captureReleaseTrustV1 } from "../../scripts/release-signing.mjs";
const composeProtectedConfigV1 = input => compose(input, { ...releaseParsers, captureReleaseTrustV1 });
const secret = byte => Buffer.alloc(32, byte).toString("base64url");
const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const account = (name, id) => Object.freeze({ name, uid: id, gid: id, created: true });
const accounts = Object.freeze({ builder: account("_crbuild", 300), database: account("_crdb", 301),
  service: account("_controlroom", 302) });

async function fixture(t, name = "golden", short = false) {
  const base = await realpath(await mkdtemp(join(short ? "/private/tmp" : tmpdir(), `cr-${name}-`)));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "install");
  await mkdir(join(root, "Protected", "config"), { recursive: true, mode: 0o750 });
  await mkdir(join(root, "Protected", "service"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "Protected", "runtime-state"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "Protected", "config"), 0o750);
  await chmod(join(root, "Protected", "service"), 0o700);
  await chmod(join(root, "updater-state"), 0o700);
  // EXACTLY the installer's login list (`install-steps.mjs` `makeCredentials` →
  // `writeDatabaseLogins` → these references). It has no deployer: a fixture that
  // supplied one is how the composer came to require a password nobody generates.
  const loginNames = [...INSTALL_DATABASE_LOGINS_V1];
  const dbLogins = loginNames.map((login, index) => {
    const password = secret(index + 10);
    return Object.freeze({ name: login, password, passwordDigest: digest(password),
      fileRef: join(root, "Protected", "config", "database-passwords", `${login}.txt`) });
  });
  // `releaseTrust` is now a REQUIRED composer input, because the gateway's own parser
  // requires it: MEASURED, three updater tests answered `fleet_gateway_configuration_refused`
  // after the merge with cook/installer, all of which pass on that branch alone - the
  // installer was written before `captureFleetGatewayConfigurationV1` began demanding it.
  //
  // The fixture uses the RELEASE's own test helper rather than a literal, for the reason
  // the key-id derivation matters: a hand-written trust object has to keep matching
  // `captureReleaseTrustV1`'s exact key set and its key-id derivation from the public key,
  // and a fixture that keeps passing while the parser tightens asserts nothing.
  const { trust: releaseTrust } = createFleetReleaseTrustForTestV1();
  const input = Object.freeze({ root, accounts, installationId: "installation-one", rpId: "control.example.ts.net",
    webPort: 3210, gatewayPort: 8443, releaseTrust,
    tenant: Object.freeze({ tenantId: "tenant:one", workspaceId: "workspace:one", provider: "local-owner",
      subject: "owner:one" }), ownerCodeDigest: digest("owner-code"), dbLogins: Object.freeze(dbLogins),
    keys: Object.freeze({ vapidPrivate: join(root, "updater-state", "vapid.json"),
      vapidPublic: join(root, "Protected", "service", "vapid-public.json"),
      healthProbeRoot: join(root, "updater-state", "health-probe.key"),
      healthProbeService: join(root, "Protected", "service", "health-probe.key"),
      webHmac: Object.freeze({ fileRef: join(root, "Protected", "service", "web-hmac.key"), value: secret(40) }),
      workIntake: Object.freeze({ fileRef: join(root, "Protected", "service", "work-intake.json"),
        integrityKey: secret(41) }) }) });
  return { base, root, input, secrets: [...dbLogins.map(login => login.password), secret(40), secret(41)] };
}

const parsedResource = (resources, name) => JSON.parse(resources.find(resource => resource.path.endsWith(`/${name}`)).contents);
function serviceInput(root, protectedConfig) {
  return Object.freeze({ root, accounts, roles: CORE_SERVICE_ROLES_V1, protectedConfig,
    pgRuntime: join(root, "runtime", "pg-current", "bin", "postgres"), updaterVersion: "1.2.3-a1b2c3d4e5f6" });
}

function fakeElevatedRuntime(base) {
  const system = join(base, "system"), loaded = new Set();
  const pathFor = path => path.startsWith("/Library/") || path.startsWith("/etc/")
    ? join(system, path.replace(/^\/+/, "")) : path;
  return Object.freeze({ geteuid: () => 0, pathFor, lstat, mkdir, readFile, unlink, rmdir,
    enforceMetadata: false, open: async (path, flags, mode) => { const handle = await open(path, flags, mode);
      handle.chown = async () => {}; return handle; }, lchown: async () => {},
    isServiceLoaded: async label => loaded.has(label), verifyPostgresShutdown: async () => true,
    async execute(_file, args) {
      if (args[0] === "bootstrap") loaded.add(args.at(-1).split("/").at(-1).replace(/\.plist$/u, ""));
      if (args[0] === "bootout") loaded.delete(args[1].replace(/^system\//u, ""));
      return { stdout: "" };
    } });
}

export { fixture, serviceInput, fakeElevatedRuntime, composeProtectedConfigV1 };
