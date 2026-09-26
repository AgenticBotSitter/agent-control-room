import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { PRIVATE_MACOS_SERVICE_LABEL_V1 } from "../src/installer/v1/private-macos-service-owner-runner";
import { createPrivateMacosServiceNativeHostV1,
  PRIVATE_MACOS_SERVICE_NATIVE_HOST_ACTIVATION_BLOCKERS_V1,
  PRIVATE_MACOS_SERVICE_NATIVE_HOST_CONFIGURATION_V1 } from
  "../src/installer/v1/private-macos-service-native-host";
import { PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1,
  type PrivateMacosServiceRuntimeHostRequestV1 } from
  "../src/installer/v1/private-macos-service-runtime-port";

const nativeTest = process.platform === "darwin" ? test : test.skip;
const run = promisify(execFile);
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const cleanSignal = () => new AbortController().signal;
const stagePrefix = "acr-service-native-";
let root = "", helper = "", fakeLaunchctl = "", realHelper = "", mappedParent = "", mappedPath = "", readyPath = "";

before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-service-host-test-");
  helper = join(root, "fixture"); fakeLaunchctl = join(root, "launchctl-fixture"); realHelper = join(root, "macos-service-v1");
  mappedParent = join(root, "mapped", "Library", "LaunchAgents");
  mappedPath = join(mappedParent, `${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`); readyPath = join(root, "fixture-ready");
  await mkdir(mappedParent, { recursive: true, mode: 0o700 });
  await chmod(join(root, "mapped"), 0o700); await chmod(join(root, "mapped", "Library"), 0o700); await chmod(mappedParent, 0o700);
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion",
    "-Wshadow", "-Wstrict-prototypes", `-DACR_FIXTURE_READY_PATH=\"${readyPath}\"`,
    "tests/helpers/macos-service-native-host-fixture.c", "-o", helper],
  { cwd: process.cwd(), timeout: 30_000 });
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "tests/helpers/macos-service-launchctl-fixture.c", "-o", fakeLaunchctl], { cwd: process.cwd(), timeout: 30_000 });
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion",
    "-Wshadow", "-Wstrict-prototypes", "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2",
    "-mmacosx-version-min=13.0", "-DACR_TEST_MODE", `-DACR_TEST_TARGET_PATH=\"${mappedPath}\"`,
    `-DACR_LAUNCHCTL_PATH=\"${fakeLaunchctl}\"`,
    "native/macos-service-v1.c", "-o", realHelper], { cwd: process.cwd(), timeout: 30_000 });
  await chmod(helper, 0o500);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function stagedEntries() {
  return new Set((await readdir("/private/tmp")).filter(name => name.startsWith(stagePrefix)));
}

function write64(buffer: Buffer, offset: number, value: bigint) { buffer.writeBigUInt64BE(value, offset); }
async function invokeRealHelper(path: string, parentDevice: bigint, parentInode: bigint,
  operation = 1, definition = Buffer.alloc(0)) {
  const header = Buffer.alloc(120), pathBytes = Buffer.from(path);
  header.write("ACRSVC1\n", "ascii"); header.writeUInt32BE(1, 8); header.writeUInt32BE(operation, 12);
  write64(header, 16, BigInt(process.geteuid!())); write64(header, 24, BigInt(Date.now() + 2_000));
  write64(header, 32, parentDevice); write64(header, 40, parentInode); header.writeUInt32BE(pathBytes.length, 48);
  header.writeUInt32BE(definition.length, 52);
  return new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }>>((resolve, reject) => {
    const child = spawn(realHelper, [], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => errors.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors) }));
    child.stdin.end(Buffer.concat([header, pathBytes, definition]));
  });
}

async function fixture(overrides: Readonly<{ helperPath?: string; serviceDefinitionDigest?: string;
  definitionParentIdentity?: Readonly<{ device: string; inode: string }> }> = {}) {
  const serviceIdentity = Object.freeze({ label: PRIVATE_MACOS_SERVICE_LABEL_V1 });
  const definitionParentIdentity = overrides.definitionParentIdentity ?? Object.freeze({ device: "41", inode: "43" });
  const helperPath = overrides.helperPath ?? helper;
  const configuration = {
    schema: PRIVATE_MACOS_SERVICE_NATIVE_HOST_CONFIGURATION_V1,
    helperPath, helperSha256: digest(await readFile(helperPath)), ownerUid: process.geteuid!(),
    ownerHome: "/Users/acr-native-host-fixture", releaseDigest: digest("release"),
    serviceDefinitionDigest: overrides.serviceDefinitionDigest ?? digest("definition"), definitionParentIdentity,
    definitionParentIdentityDigest: sha256Digest({
      purpose: "private-macos-service-native-definition-parent-identity/v1", ...definitionParentIdentity }),
    definitionIdentity: null, definitionIdentityDigest: null, serviceIdentity,
    serviceIdentityDigest: sha256Digest({ purpose: "macos-service-identity/v1", label: serviceIdentity.label }),
  } as const;
  return { configuration, host: createPrivateMacosServiceNativeHostV1(configuration) };
}

function request(configuration: Awaited<ReturnType<typeof fixture>>["configuration"],
  operation: PrivateMacosServiceRuntimeHostRequestV1["operation"], deadlineUnixMs = Date.now() + 2_000,
  signal = cleanSignal(), serviceDefinition?: string): PrivateMacosServiceRuntimeHostRequestV1 {
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1, operation,
    ownerUid: configuration.ownerUid, launchctlDomain: `gui/${configuration.ownerUid}`,
    launchctlTarget: `gui/${configuration.ownerUid}/${PRIVATE_MACOS_SERVICE_LABEL_V1}`,
    label: PRIVATE_MACOS_SERVICE_LABEL_V1,
    launchAgentPath: `${configuration.ownerHome}/Library/LaunchAgents/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`,
    requestDigest: digest(`request:${operation}`), lifecycleDigest: digest("lifecycle"),
    releaseDigest: configuration.releaseDigest, serviceDefinitionDigest: configuration.serviceDefinitionDigest,
    expectedDefinitionParentIdentityDigest: configuration.definitionParentIdentityDigest,
    expectedDefinitionIdentityDigest: null, expectedServiceIdentityDigest: configuration.serviceIdentityDigest,
    ...(serviceDefinition === undefined ? {} : { serviceDefinition }), deadlineUnixMs, signal });
}

async function readiness() {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const values = (await readFile(readyPath, "utf8")).trim().split(" ").map(Number);
      if (values.length === 3 && values.every(Number.isSafeInteger)) return Object.freeze({
        leader: values[0]!, descendant: values[1]!, group: values[2]!,
      });
    } catch { /* fixture has not acknowledged readiness yet */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("disposable_service_fixture_readiness_missing");
}
function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

nativeTest("configuration recomputes every supplied identity digest before staging", async () => {
  const before = await stagedEntries(), f = await fixture();
  assert.throws(() => createPrivateMacosServiceNativeHostV1({ ...f.configuration,
    definitionParentIdentityDigest: digest("claimed-parent") }), /_refused/);
  assert.throws(() => createPrivateMacosServiceNativeHostV1({ ...f.configuration,
    serviceIdentityDigest: digest("claimed-service") }), /_refused/);
  assert.throws(() => createPrivateMacosServiceNativeHostV1({ ...f.configuration,
    serviceIdentity: { label: "foreign.service" } }), /_refused/);
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("the real ACRSVC1 helper accepts only its fixed binary frame while using disposable launchctl", async () => {
  const scope = join(root, "real-helper-scope"), library = join(scope, "Library"), parent = join(library, "LaunchAgents");
  await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(scope, 0o700); await chmod(library, 0o700); await chmod(parent, 0o700);
  const identity = await lstat(parent, { bigint: true });
  const path = join(parent, `${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`);
  const accepted = await invokeRealHelper(path, identity.dev, identity.ino);
  assert.equal(accepted.code, 0); assert.equal(accepted.signal, null); assert.equal(accepted.stderr.length, 0);
  assert.equal(accepted.stdout.length, 96);
  assert.equal(accepted.stdout.subarray(0, 8).toString("ascii"), "ACRSVR1\n");
  assert.equal(accepted.stdout.readUInt32BE(12), 1);
  const substituted = await invokeRealHelper(path, identity.dev, identity.ino + BigInt(1));
  assert.equal(substituted.code, 1); assert.equal(substituted.stdout.length, 0);
  const definition = Buffer.from("<?xml version=\"1.0\"?><plist><dict/></plist>\n", "utf8");
  const published = await invokeRealHelper(path, identity.dev, identity.ino, 3, definition);
  assert.equal(published.code, 0); assert.equal(published.stderr.length, 0); assert.equal(published.stdout.readUInt32BE(12), 2);
  assert.deepEqual(await readFile(path), definition); assert.equal((await lstat(path)).mode & 0o7777, 0o600);
  assert.deepEqual((await readdir(parent)).sort(), [`${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`]);
});

nativeTest("reviewed deny-only ancestor ACLs work while grants and a final-parent ACL refuse", async t => {
  const aclPaths: string[] = [];
  t.after(async () => { for (const path of aclPaths.reverse()) await run("/bin/chmod", ["-N", path]); });
  const makeTarget = async (name: string) => {
    const scope = join(root, name), library = join(scope, "Library"), parent = join(library, "LaunchAgents");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(scope, 0o700); await chmod(library, 0o700); await chmod(parent, 0o700);
    const identity = await lstat(parent, { bigint: true });
    return { scope, parent, path: join(parent, `${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`), identity };
  };
  const standard = await makeTarget("acl-standard");
  await run("/bin/chmod", ["+a", "everyone deny delete", standard.scope]); aclPaths.push(standard.scope);
  assert.equal((await invokeRealHelper(standard.path, standard.identity.dev, standard.identity.ino)).code, 0);

  const grant = await makeTarget("acl-grant");
  await run("/bin/chmod", ["+a", "everyone allow read", grant.scope]); aclPaths.push(grant.scope);
  assert.equal((await invokeRealHelper(grant.path, grant.identity.dev, grant.identity.ino)).code, 1);

  const final = await makeTarget("acl-final");
  await run("/bin/chmod", ["+a", "everyone deny delete", final.parent]); aclPaths.push(final.parent);
  assert.equal((await invokeRealHelper(final.path, final.identity.dev, final.identity.ino)).code, 1);
});

nativeTest("the composed Node host publishes canonical contract bytes through the real helper", async () => {
  const definition = "<?xml version=\"1.0\"?><plist><dict><key>Label</key><string>fixture</string></dict></plist>\n";
  const parent = await lstat(mappedParent, { bigint: true });
  const definitionParentIdentity = Object.freeze({ device: `${parent.dev}`, inode: `${parent.ino}` });
  const f = await fixture({ helperPath: realHelper, serviceDefinitionDigest: sha256Digest(definition),
    definitionParentIdentity });
  const result = await f.host.perform(request(f.configuration, "install_service_definition", Date.now() + 2_000,
    cleanSignal(), definition));
  assert.equal(result.outcome, "succeeded"); assert.ok(result.definitionIdentityDigest);
  assert.deepEqual(await readFile(mappedPath), Buffer.from(definition));
  assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
});

nativeTest("release and authenticated application health stay blocked without their separate custody", async () => {
  const before = await stagedEntries(), f = await fixture();
  await assert.rejects(f.host.perform(request(f.configuration, "verify_release")), /_refused/);
  await assert.rejects(f.host.perform(request(f.configuration, "verify_service_health")), /_refused/);
  await assert.rejects(f.host.observeHealth(request(f.configuration, "verify_service_health")), /_uncertain/);
  assert.deepEqual(PRIVATE_MACOS_SERVICE_NATIVE_HOST_ACTIVATION_BLOCKERS_V1,
    ["release_custody_missing", "authenticated_application_health_verifier_missing"]);
  assert.deepEqual(await stagedEntries(), before, "blocked custody must not stage or invoke the helper");
  assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
});

nativeTest("the named helper is checked once, copied privately, reused, and removed by exact cleanup", async () => {
  const before = await stagedEntries(), f = await fixture();
  const first = await f.host.perform(request(f.configuration, "verify_supervisor_readiness"));
  assert.equal(first.outcome, "succeeded"); assert.equal(first.state, "not_installed");
  const moved = `${helper}-moved`; await rename(helper, moved);
  try {
    const second = await f.host.perform(request(f.configuration, "verify_supervisor_readiness"));
    assert.equal(second.outcome, "succeeded");
  } finally { await rename(moved, helper); }
  assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("leader close cannot hide a live descendant and the full fresh group is retired", async () => {
  const before = await stagedEntries(), f = await fixture(), started = Date.now();
  await assert.rejects(f.host.perform(request(f.configuration, "verify_service_definition")), /_uncertain/);
  assert.ok(Date.now() - started < 1_500, "descendant retirement stays inside the absolute cleanup budget");
  assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("cancellation retires a TERM-resistant leader and descendant before returning", async () => {
  const before = await stagedEntries(), f = await fixture(), controller = new AbortController();
  await rm(readyPath, { force: true });
  const active = f.host.perform(request(f.configuration, "inspect_service_status", Date.now() + 5_000, controller.signal));
  const owned = await readiness(); controller.abort();
  const started = Date.now(); await assert.rejects(active, /_uncertain/);
  assert.ok(Date.now() - started < 1_500, "cancellation cleanup is absolutely bounded");
  assert.equal(absent(owned.leader), true); assert.equal(absent(owned.descendant), true);
  assert.equal(absent(-owned.group), true);
  assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("deadline cleanup is bounded and malformed zero-reserved bytes never become a receipt", async () => {
  const before = await stagedEntries(), deadline = await fixture();
  await rm(readyPath, { force: true });
  const started = Date.now();
  const active = deadline.host.perform(request(deadline.configuration, "inspect_service_status", Date.now() + 250));
  const owned = await readiness(); await assert.rejects(active, /_uncertain/);
  assert.ok(Date.now() - started < 1_500, "deadline cleanup is absolutely bounded");
  assert.equal(absent(owned.leader), true); assert.equal(absent(owned.descendant), true);
  assert.equal(absent(-owned.group), true);
  await deadline.host.cleanup(cleanSignal());

  const malformed = await fixture();
  await assert.rejects(malformed.host.perform(request(malformed.configuration, "start_service")), /_uncertain/);
  const abortedCleanup = new AbortController(); abortedCleanup.abort();
  await assert.rejects(malformed.host.cleanup(abortedCleanup.signal), /_uncertain/);
  assert.deepEqual(await malformed.host.cleanup(cleanSignal()), { outcome: "confirmed" });
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("unresolved group custody survives the cleanup budget until later absence is independently proven", async () => {
  const before = await stagedEntries(), f = await fixture(), controller = new AbortController();
  await rm(readyPath, { force: true });
  const active = f.host.perform(request(f.configuration, "inspect_service_status", Date.now() + 5_000, controller.signal));
  const owned = await readiness(), originalKill = process.kill;
  let reportGroupAlive = true;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal === 0 && reportGroupAlive) return true;
    return originalKill(pid, signal as NodeJS.Signals | number);
  }) as typeof process.kill;
  try {
    controller.abort();
    await assert.rejects(active, /_uncertain/);
    await assert.rejects(f.host.perform(request(f.configuration, "verify_supervisor_readiness")), /_refused/,
      "unresolved custody permanently withholds new native work");
    await assert.rejects(f.host.cleanup(cleanSignal()), /_uncertain/,
      "cleanup cannot confirm while retained custody has no absence proof");
    reportGroupAlive = false;
    assert.equal(absent(owned.leader), true); assert.equal(absent(owned.descendant), true);
    assert.equal(absent(-owned.group), true);
    assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
  } finally { process.kill = originalKill; }
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("source substitution and pre-abort refuse without leaving identity-owned staging", async () => {
  const before = await stagedEntries(), f = await fixture();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.host.perform(request(f.configuration, "verify_supervisor_readiness", Date.now() + 1_000,
    cancelled.signal)), /_refused/);
  assert.deepEqual(await stagedEntries(), before);
  const wrong = createPrivateMacosServiceNativeHostV1({ ...f.configuration, helperSha256: digest("wrong") });
  await assert.rejects(wrong.perform(request(f.configuration, "verify_supervisor_readiness")), /_uncertain/);
  assert.deepEqual(await stagedEntries(), before);
});

nativeTest("failed partial staging remains in custody until exact later removal succeeds", async () => {
  const before = await stagedEntries();
  const largeHelper = join(root, "large-helper");
  await writeFile(largeHelper, Buffer.alloc(16 * 1024 * 1024, 0x5a));
  await chmod(largeHelper, 0o500);
  const f = await fixture({ helperPath: largeHelper });
  let stagedDirectory = "";
  const sabotage = async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const entries = await stagedEntries();
      const created = [...entries].find(entry => !before.has(entry));
      if (created) {
        stagedDirectory = join("/private/tmp", created);
        try {
          await writeFile(join(stagedDirectory, "foreign"), "test-owned", { flag: "wx" });
          return;
        } catch { /* retry while the exact staged directory exists */ }
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error("partial_staging_sabotage_window_missing");
  };
  const active = f.host.perform(request(f.configuration, "verify_supervisor_readiness", Date.now() + 5_000));
  const rejected = assert.rejects(active, /_uncertain/);
  await sabotage();
  await rejected;
  await assert.rejects(f.host.perform(request(f.configuration, "verify_supervisor_readiness")), /_refused/,
    "a failed partial stage terminalizes new native work");
  await assert.rejects(f.host.cleanup(cleanSignal()), /_uncertain/,
    "foreign staging content prevents a false cleanup confirmation");
  await rm(join(stagedDirectory, "foreign"));
  assert.deepEqual(await f.host.cleanup(cleanSignal()), { outcome: "confirmed" });
  assert.deepEqual(await stagedEntries(), before);
});
