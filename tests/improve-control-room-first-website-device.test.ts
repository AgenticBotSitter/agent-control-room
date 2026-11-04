import assert from "node:assert/strict";
import test from "node:test";
import { B5RefusalV1, firstWebsiteConfigSchemaV1 } from "./helpers/improve-control-room-first-website";

test("F03b device actor is the owner", () => {
  const schema = firstWebsiteConfigSchemaV1.shape.device;
  const device = { origin: "http://127.0.0.1:60460", transportQualification: "/private/tmp/qualification.json", actor: "owner" };
  assert.equal(schema.safeParse(device).success, true, "owner must be accepted");
  assert.equal(schema.safeParse({ ...device, actor: "reviewer" }).success, false);
});

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createB5DeviceMailboxV1, b5DeviceHashV1, b5DeviceRequestSchemaV1, b5DeviceReceiptSchemaV1,
  writeB5DeviceReceiptV1, writeB5DeviceRequestV1, waitB5DeviceJsonV1,
  assertB5EvidenceSecretFreeV1, redactB5EvidenceV1, retainB5TransportQualificationV1, parseB5DeviceJsonV1, validateB5DeviceOriginV1, validateB5TransportV1, b5MappingDigestV1,
  b5DeviceRemoteOriginsV1, createB5DeviceCleanupV1, assertB5DeviceSignalCleanupV1, type B5TransportQualificationV1,
  type B5DeviceMailboxV1, type B5DeviceRequestV1 } from "../scripts/workflow-journeys/first-website-device";

const local = "http://127.0.0.1:60460", remote = "https://fixture.ts.net:60462";
const now = Date.parse("2026-11-01T18:00:00.000Z"), time = (offset = 0) => new Date(now + offset).toISOString();
function qualification(): B5TransportQualificationV1 {
  const beforeStatus = { TCP: { "443": { HTTPS: true } }, Web: { "fixture.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:65000" } } } } };
  const installedStatus = { TCP: { ...beforeStatus.TCP, "60462": { HTTPS: true } },
    Web: { ...beforeStatus.Web, "fixture.ts.net:60462": { Handlers: { "/": { Proxy: local } } } } };
  return { schemaVersion: 1, kind: "tailscale-serve", origin: remote, backend: local, actor: "owner", ownerAuthorized: true,
    authorizedAt: time(-1000), expiresAt: time(60_000), ownerLogin: "owner@example.invalid", identityPolicy: "exact-owner-login",
    captureMode: "native-capture-server-correlation", inventory: { phone: { model: "fixture-model", os: "fixture-os", browser: "fixture-browser", browserVersion: "fixture-version" },
      desktop: { browser: "fixture-browser", browserVersion: "fixture-version" }, captureMethod: "native-screenshot", fileTransferRoute: "fixture transfer; not device qualification" },
    beforeStatus, installedStatus, beforeDigest: b5MappingDigestV1(beforeStatus), installedDigest: b5MappingDigestV1(installedStatus) };
}
async function scratch(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/f03b-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function correlated(mailbox: B5DeviceMailboxV1, request: B5DeviceRequestV1, token = "a".repeat(43)) {
  const url = local + mailbox.projectPath;
  const first = await mailbox.handle(new Request(url, { headers: { cookie: `control_room_local_owner=${token}` } }), async () => new Response("actual product fixture"));
  assert.match(first.headers.get("set-cookie")!, /b5_correlation=/u);
  await mailbox.handle(new Request(url, { headers: { cookie: `control_room_local_owner=${token}; b5_correlation=${request.sessionNonce}` } }), async () => new Response("actual product fixture"));
  return mailbox.observation()!;
}
async function ready(t: { after(fn: () => Promise<void>): void }, phase: B5DeviceRequestV1["phase"] = "connect") {
  const root = await scratch(t), mailbox = await createB5DeviceMailboxV1(root, local, { real: false, projectId: "project:fixture", now: () => now });
  const request = await mailbox.request(phase, "phone", time(10_000));
  const capture = Buffer.from("honestly fixture capture bytes");
  await writeFile(join(mailbox.root, "captures/phone.png"), capture, { mode: 0o600 });
  const observation = await correlated(mailbox, request);
  const receipt = { ...request, observedAt: time(), real: false, browser: "fixture browser", actions: [phase === "close" ? "closed" : "connected"],
    captures: [{ path: "captures/phone.png", sha256: b5DeviceHashV1(capture), device: "phone", sequence: request.sequence, sessionNonce: request.sessionNonce, capturedAt: time() }], observation,
    ...(phase === "close" ? { closeAttestation: { actor: "owner", closedAt: time(), allProofTabsClosed: true } } : {}) };
  return { root, mailbox, request, receipt };
}

test("B5 inbox receipt writer publishes exclusively for the real reader; request writer refuses inbox misuse", async t => {
  const { mailbox, request, receipt } = await ready(t);
  t.after(() => mailbox.close());
  const file = join(mailbox.root, "inbox", `${request.sequence}.json`);
  await assert.rejects(writeB5DeviceRequestV1(file, receipt), { code: "B5_DEVICE_PATH" });
  assert.deepEqual(await readdir(join(mailbox.root, "inbox")), []);
  await writeB5DeviceReceiptV1(file, receipt);
  const stat = await lstat(file);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid?.());
  const delivered = await waitB5DeviceJsonV1(file, mailbox.root, new AbortController().signal, Date.now() + 1000);
  assert.deepEqual(delivered, receipt);
  await mailbox.accept(delivered);
  assert.deepEqual(await mailbox.readReceipt(request.sequence), receipt);
  const saved = await readFile(file, "utf8");
  await assert.rejects(writeB5DeviceReceiptV1(file, { ...receipt, browser: "changed" }), { code: "B5_DEVICE_DUPLICATE" });
  await assert.rejects(writeB5DeviceRequestV1(file, receipt), { code: "B5_DEVICE_PATH" });
  assert.equal(await readFile(file, "utf8"), saved);
  assert.deepEqual(await readdir(join(mailbox.root, "inbox")), [`${request.sequence}.json`]);
  console.log("RESULT: PASS B5 inbox receipt accepted by real reader and mailbox; mode=0600 exclusive-create; request-writer misuse refused");
});

test("B5 inbox receipt writer refuses wrong paths and unsafe directory custody", async t => {
  const { root, mailbox, receipt } = await ready(t);
  t.after(() => mailbox.close());
  for (const file of [join(mailbox.root, "1.json"), join(mailbox.root, "receipts/1.json"),
    join(mailbox.root, "inbox/0.json"), join(mailbox.root, "inbox/01.json"), join(mailbox.root, "inbox/2.json"),
    join(mailbox.root, "inbox/install-request.json"), join(root, "inbox/1.json"), "device/inbox/1.json"]) {
    await assert.rejects(writeB5DeviceReceiptV1(file, receipt), { code: "B5_DEVICE_PATH" });
  }
  const inbox = join(mailbox.root, "inbox"), file = join(inbox, "1.json");
  for (const directory of [mailbox.root, inbox]) {
    await chmod(directory, 0o755);
    await assert.rejects(writeB5DeviceReceiptV1(file, receipt), { code: "B5_DEVICE_CUSTODY" });
    await chmod(directory, 0o700);
  }
  await rm(inbox, { recursive: true });
  await symlink(join(mailbox.root, "receipts"), inbox);
  await assert.rejects(writeB5DeviceReceiptV1(file, receipt), { code: "B5_DEVICE_PATH" });
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
  console.log("RESULT: PASS B5 inbox receipt path, sequence, root/inbox custody and symlink refusals");
});

test("F03b strict JSON and schemas refuse unknown, duplicate, truncated and oversized inputs", () => {
  for (const bytes of ['{"a":1,"a":2}', '{"a":', '{"a":NaN}']) assert.throws(() => parseB5DeviceJsonV1(bytes), { code: "B5_DEVICE_JSON" });
  assert.throws(() => parseB5DeviceJsonV1(' '.repeat(65537)), { code: "B5_DEVICE_SIZE" });
  assert.deepEqual(parseB5DeviceJsonV1('{"a":1}'), { a: 1 });
  assert.equal(b5DeviceRequestSchemaV1.safeParse({}).success, false);
  assert.equal(b5DeviceReceiptSchemaV1.safeParse({ command: "Start" }).success, false);
});

test("F03b transport pins origin, inventory, owner login, authorization and exclusive mapping", () => {
  const q = qualification(); assert.equal(validateB5TransportV1(q, remote, now).actor, "owner");
  for (const origin of ["https://fixture.ts.net", remote + "/", remote + "/x", remote + "?x=1", remote + "#x", "https://fixture.invalid:60462", "https://u@fixture.ts.net:60462", "http://fixture.ts.net:60462", local]) {
    assert.throws(() => validateB5DeviceOriginV1(origin), { code: "B5_DEVICE_ORIGIN" });
  }
  const { inventory: _inventory, ...absent } = q;
  assert.throws(() => validateB5TransportV1(absent, remote, now), { code: "B5_DEVICE_INVENTORY_REQUIRED" });
  for (const patch of [{ ownerLogin: undefined }, { actor: "reviewer" }, { ownerAuthorized: false }, { inventory: {} }]) {
    assert.throws(() => validateB5TransportV1({ ...q, ...patch }, remote, now), { code: "B5_DEVICE_QUALIFICATION" });
  }
  assert.throws(() => validateB5TransportV1(q, remote, now + 60_000), { code: "B5_DEVICE_EXPIRED" });
  assert.throws(() => validateB5TransportV1({ ...q, installedDigest: q.beforeDigest }, remote, now), { code: "B5_DEVICE_MAPPING_DIGEST" });
  const drift = { ...q.installedStatus, unrelated: "changed" };
  assert.throws(() => validateB5TransportV1({ ...q, installedStatus: drift, installedDigest: b5MappingDigestV1(drift) }, remote, now), { code: "B5_DEVICE_MAPPING_DRIFT" });
});

test("F03b remote gate uses existing Tailscale owner/Funnel checks", () => {
  const q = { ...qualification(), expiresAt: new Date(Date.now() + 10_000).toISOString() };
  const [gate] = b5DeviceRemoteOriginsV1(q);
  assert.equal(gate!.origin, remote);
  assert.doesNotThrow(() => gate!.admit(new Headers({ "tailscale-user-login": q.ownerLogin })));
  for (const headers of [{}, { "tailscale-user-login": "other@example.invalid" }, { "tailscale-user-login": q.ownerLogin, "tailscale-funnel-request": "true" }]) {
    assert.throws(() => gate!.admit(new Headers(headers as Record<string, string>)), /remote_access_refused/u);
  }
});

test("F03b mailbox publishes private atomic requests and immutable receipts", async t => {
  const { root, mailbox, request, receipt } = await ready(t);
  assert.match(request.sessionNonce, /^[a-f0-9]{32}$/u); assert.equal(request.sequence, 1);
  for (const directory of [root, mailbox.root, join(mailbox.root, "receipts"), join(mailbox.root, "captures")]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(mailbox.root, "request.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "request.json"), "utf8")), request);
  await mailbox.accept(receipt);
  const saved = await readFile(join(mailbox.root, "receipts/1.json"), "utf8");
  assert.equal((await lstat(join(mailbox.root, "receipts/1.json"))).mode & 0o777, 0o600);
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_DUPLICATE" });
  assert.equal(await readFile(join(mailbox.root, "receipts/1.json"), "utf8"), saved);
  const second = await mailbox.request("prepare", "desktop", time(20_000));
  assert.equal(second.sequence, 2); assert.notEqual(second.sessionNonce, request.sessionNonce);
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_STALE" });
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), ["1.json"]);
  mailbox.close(); await assert.rejects(mailbox.request("connect", "phone", time(20_000)), { code: "B5_DEVICE_CLOSED" });
  await assert.rejects(createB5DeviceMailboxV1(root, local, { real: false, projectId: "p" }), { code: "B5_DEVICE_EXISTS" });
});

for (const [patch, code] of [
  [{ origin: "https://wrong.invalid" }, "B5_DEVICE_ORIGIN"], [{ sessionNonce: "b".repeat(32) }, "B5_DEVICE_NONCE"],
  [{ device: "desktop" }, "B5_DEVICE_DEVICE"], [{ sequence: 2 }, "B5_DEVICE_STALE"],
  [{ expiresAt: time(-1) }, "B5_DEVICE_REQUEST_CHANGED"], [{ observedAt: time(1) }, "B5_DEVICE_EXPIRED"],
  [{ real: true }, "B5_DEVICE_REAL"], [{ actions: ["started"] }, "B5_DEVICE_ACTIONS"], [{ command: "start" }, "B5_DEVICE_SCHEMA"],
] as const) test(`F03b receipt refusal ${code} ${Object.keys(patch)[0]}`, async t => {
  const { mailbox, receipt } = await ready(t);
  await assert.rejects(mailbox.accept({ ...receipt, ...patch }), { code });
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), [], "refusal leaves no accepted receipt");
});

test("F03b expired challenge and incorrect correlation refuse without receipt effects", async t => {
  const root = await scratch(t); let clock = now;
  const mailbox = await createB5DeviceMailboxV1(root, local, { real: false, projectId: "p", now: () => clock });
  await assert.rejects(mailbox.request("connect", "phone", time()), { code: "B5_DEVICE_EXPIRED" });
  const request = await mailbox.request("connect", "phone", time(10));
  const { receipt } = await ready(t);
  const value = { ...receipt, ...request };
  await assert.rejects(mailbox.accept(value), { code: "B5_DEVICE_CORRELATION" });
  clock += 10;
  await assert.rejects(mailbox.accept(value), { code: "B5_DEVICE_EXPIRED" });
});

test("F03b capture mutation, path escape, symlink, changed request and large JSON refuse", async t => {
  const { mailbox, receipt } = await ready(t);
  await writeFile(join(mailbox.root, "captures/phone.png"), "changed");
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_CAPTURE_CHANGED" });
  for (const path of ["../outside.png", "/absolute.png", "captures/../phone.png"]) {
    await assert.rejects(mailbox.accept({ ...receipt, captures: [{ ...receipt.captures[0], path }] }), { code: "B5_DEVICE_PATH" });
  }
  await symlink("phone.png", join(mailbox.root, "captures/link.png"));
  await assert.rejects(mailbox.accept({ ...receipt, captures: [{ ...receipt.captures[0], path: "captures/link.png" }] }), { code: "B5_DEVICE_PATH" });
  await writeFile(join(mailbox.root, "request.json"), ' '.repeat(65537));
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_SIZE" });
  await writeFile(join(mailbox.root, "request.json"), JSON.stringify({ ...receipt, phase: "prepare" }));
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_SCHEMA" });
});

test("F03b retained reads recheck capture bytes and close attestation timing", async t => {
  const { mailbox, receipt } = await ready(t, "close");
  await assert.rejects(mailbox.accept({ ...receipt, closeAttestation: undefined }), { code: "B5_DEVICE_CLOSE" });
  await assert.rejects(mailbox.accept({ ...receipt, closeAttestation: { ...receipt.closeAttestation, closedAt: time(-1) } }), { code: "B5_DEVICE_CLOSE" });
  await mailbox.accept(receipt); await mailbox.readReceipt(1);
  await writeFile(join(mailbox.root, "captures/phone.png"), "changed after acceptance");
  await assert.rejects(mailbox.readReceipt(1), { code: "B5_DEVICE_CAPTURE_CHANGED" });
});

test("F03b 24 callers released at an explicit barrier accept exactly one receipt", async t => {
  const { mailbox, receipt } = await ready(t);
  let release!: () => void; const barrier = new Promise<void>(yes => { release = yes; });
  let arrived = 0;
  const callers = Array.from({ length: 24 }, async () => { arrived++; await barrier; return mailbox.accept(structuredClone(receipt)); });
  assert.equal(arrived, 24); release();
  const results = await Promise.allSettled(callers);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const refusals = results.filter(r => r.status === "rejected"); assert.equal(refusals.length, 23);
  for (const refusal of refusals) assert.match(refusal.reason.code, /^B5_DEVICE_(SEQUENCE_RACE|DUPLICATE)$/u);
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), ["1.json"]);
  console.log("RESULT: PASS F03b receipt barrier callers=24 accepted=1 refused=23 (fixtures)");
});

test("F03b cookie correlation binds device, session and exact authenticated read", async t => {
  const { mailbox } = await ready(t);
  const request = await mailbox.request("connect", "desktop", time(1000));
  await assert.rejects(correlated(mailbox, request), { code: "B5_DEVICE_SESSION" });
  await correlated(mailbox, request, "b".repeat(43));
  assert.equal(mailbox.observation()!.device, "desktop");
  const next = await mailbox.request("connect", "phone", time(1000));
  for (const [path, status] of [[mailbox.projectPath, 401], ["/projects", 200], [mailbox.projectPath + "?challenge=" + next.sessionNonce, 200]] as const) {
    const response = await mailbox.handle(new Request(local + path, { headers: { cookie: "control_room_local_owner=" + "a".repeat(43) } }), async () => new Response(null, { status }));
    assert.equal(response.headers.get("set-cookie"), null); assert.equal(mailbox.observation(), undefined);
  }
});

test("B5 baseline/rehearsal fresh sign-in cannot replace an in-progress challenged session", async t => {
  const { mailbox, request, receipt } = await ready(t);
  t.after(() => mailbox.close());
  const before = await readFile(join(mailbox.root, "observations/1.json"), "utf8");
  const fresh = await mailbox.handle(new Request(local + "/api/v1/local-owner-session", { method: "POST" }),
    async () => new Response(null, { status: 201, headers: { "set-cookie": `control_room_local_owner=${"b".repeat(43)}; HttpOnly; Path=/; Max-Age=300` } }));
  assert.equal(fresh.status, 201);
  await assert.rejects(correlated(mailbox, request, "b".repeat(43)), { code: "B5_DEVICE_SESSION" });
  assert.deepEqual(mailbox.observation(), receipt.observation);
  assert.equal(await readFile(join(mailbox.root, "observations/1.json"), "utf8"), before);
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
  console.log("RESULT: PASS baseline/rehearsal fresh sign-in=201 new session read=B5_DEVICE_SESSION original observation immutable receipt wait unchanged");
});

function removal(q: B5TransportQualificationV1, request: { removalNonce: string; requestedAt: string }) {
  return { schemaVersion: 1, actor: "owner", removalNonce: request.removalNonce, observedAt: time(), installSettled: true, installCancelled: false,
    off: { command: "tailscale serve --https=60462 off", port: 60462, exitCode: 0 }, status: { command: "tailscale serve status --json", exitCode: 0, afterStatus: q.beforeStatus, afterDigest: q.beforeDigest },
    beforeDigest: q.beforeDigest, installedDigest: q.installedDigest };
}
for (const reason of ["success", "deadline", "owner Stop", "failed cold readCard", "verifier refusal", "interrupt", "acquisition failure"]) {
  test(`F03b single outer cleanup after ${reason} closes before owner removal`, async () => {
    const q = qualification(), events: string[] = [], abort = new AbortController();
    let release!: () => void, closeEntered!: () => void;
    const barrier = new Promise<void>(yes => { release = yes; }), entered = new Promise<void>(yes => { closeEntered = yes; });
    const cleanup = createB5DeviceCleanupV1(q, { now: () => now, async closeHost(signal) {
      assert.equal(signal.aborted, false); events.push("close"); closeEntered(); await barrier;
    }, async requestRemoval(request, signal) {
      assert.equal(signal.aborted, false); events.push("remove"); return removal(q, request);
    } });
    let cleanupPromise: ReturnType<typeof cleanup> | undefined, acquired = false;
    const run = async () => {
      try {
        // Fail acquisition after installation was attempted. All later cases
        // acquire successfully and then exit by their actual failure mechanism.
        if (reason === "acquisition failure") throw new Error(reason);
        acquired = true;
        if (reason === "deadline") {
          const deadline = setTimeout(() => abort.abort(new Error(reason)), 0);
          try { await new Promise<void>(yes => abort.signal.addEventListener("abort", () => yes(), { once: true })); }
          finally { clearTimeout(deadline); }
          abort.signal.throwIfAborted();
        }
        if (reason === "owner Stop" || reason === "interrupt") { abort.abort(new Error(reason)); abort.signal.throwIfAborted(); }
        if (reason === "failed cold readCard") {
          const readCard = async () => { events.push("readCard"); throw new Error(reason); };
          await readCard();
        }
        if (reason === "verifier refusal") { events.push("verify"); b5DeviceReceiptSchemaV1.parse({}); }
        return "success";
      } finally { cleanupPromise = cleanup(); assert.equal(cleanup(), cleanupPromise); await cleanupPromise; }
    };
    const outcome = run().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered;
    assert.equal(acquired, reason !== "acquisition failure");
    assert.equal(events.at(-1), "close"); assert.equal(events.includes("remove"), false); release();
    const settled = await outcome;
    if (reason === "success") assert.equal(settled.value, "success"); else assert.ok(settled.error);
    const result = await cleanupPromise!;
    assert.equal(result.disposition, "mapping-removed"); assert.equal(result.hostStopped, true); assert.deepEqual(result.failures, []);
    assert.deepEqual(events.slice(-2), ["close", "remove"]);
  });
}

test("F03b cleanup records outstanding on absent/late/failed/drifting removal and still contains failed host close", async () => {
  const q = qualification();
  for (const kind of ["absent", "late", "command", "status", "drift", "unsettled", "nonce", "old", "digest", "retained-port"] as const) {
    let requested = 0;
    const cleanup = createB5DeviceCleanupV1(q, { now: () => now, removalMs: 10, async closeHost() {}, async requestRemoval(request, signal) {
      requested++;
      if (kind === "absent" || kind === "late") return new Promise(resolve => { signal.addEventListener("abort", () => resolve(kind === "late" ? removal(q, request) : undefined), { once: true }); });
      const receipt = removal(q, request);
      if (kind === "command") receipt.off.exitCode = 1;
      if (kind === "status") receipt.status.exitCode = 1;
      if (kind === "unsettled") receipt.installSettled = false;
      if (kind === "nonce") receipt.removalNonce = "b".repeat(32);
      if (kind === "old") receipt.observedAt = time(-1);
      if (kind === "digest") receipt.status.afterDigest = "sha256:" + "0".repeat(64);
      if (kind === "drift" || kind === "retained-port") {
        receipt.status.afterStatus = kind === "drift" ? { unrelated: "changed" } : q.installedStatus;
        receipt.status.afterDigest = b5MappingDigestV1(receipt.status.afterStatus);
      }
      return receipt;
    } });
    const result = await cleanup(); assert.equal(result.disposition, "mapping-outstanding", kind); assert.equal(result.failures.length, 1, kind); assert.equal(requested, 1);
    if (["command", "status", "drift", "digest", "retained-port"].includes(kind)) {
      assert.match(result.removalReceiptDigest ?? "", /^sha256:[a-f0-9]{64}$/u, "F04a failed cleanup retains available receipt digest");
      assert.match(result.afterDigest ?? "", /^sha256:[a-f0-9]{64}$/u, "F04a failed cleanup retains available actual after-status digest");
    }
  }
  let requested = 0;
  const failed = await createB5DeviceCleanupV1(q, { now: () => now, async closeHost() { throw Error("failure"); },
    async requestRemoval(request) { requested++; return removal(q, request); } })();
  assert.equal(failed.hostStopped, false); assert.deepEqual(failed.failures, ["B5_DEVICE_HOST_CLEANUP"]); assert.equal(requested, 1);
});

import { after } from "node:test";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalNodeHandler } from "../src/web/v1/private-node-handler";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { privateOwnerBootstrapFixture, closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject } from "./helpers/private-owner-bootstrap-conformance";
import { nodeExchange } from "./helpers/web-node";

after(closePrivateOwnerBootstrapConformanceDatabase);

for (const real of [false, true]) test(`F03b exact port remote composition proves product cookie route, auth, CSRF, expiry and Funnel refusal (real=${real})`, async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: `b5-device-${real}` }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion });
  const clock = { now: conformanceNow }, ownerCode = "fixture-disposable-owner-code-long-enough";
  const q = { ...qualification(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const app = createMacLocalWebProcessV1({ origin: local, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: local, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 300, remoteOrigins: [remote] },
    database: { client: fixture.client, close: async () => {}, isAvailable: () => true }, clock: () => clock.now });
  t.after(() => app.close());
  let mailbox: B5DeviceMailboxV1 | undefined;
  const handler = createMacLocalNodeHandler({ origin: local, application: app, remoteOrigins: b5DeviceRemoteOriginsV1(q),
    assets: { count: 0, digest: "fixture", respond: () => undefined },
    handler: request => mailbox ? mailbox.handle(request, () => app.handle(request, () => new Response("product render fixture"))) : app.handle(request, () => new Response("product render fixture")) });
  t.after(() => handler.close());
  const go = async (path: string, headers: string[] = [], method = "GET", body?: string) => {
    const ex = nodeExchange({ path, method, body, headers: ["X-Forwarded-Proto", "https", "Tailscale-User-Login", q.ownerLogin, ...headers] });
    ex.input.rawHeaders[1] = new URL(remote).host;
    const done = new Promise<void>((yes, no) => { ex.output.once("finish", yes); ex.output.once("error", no); });
    await handler.handle(ex.input, ex.output); await done;
    return { status: ex.output.statusCode, headers: ex.headers, body: ex.body() };
  };
  const signInBody = JSON.stringify({ ownerCode });
  const signedIn = await go("/api/v1/local-owner-session", ["Origin", remote, "Content-Type", "application/json", "Content-Length", String(Buffer.byteLength(signInBody))], "POST", signInBody);
  assert.equal(signedIn.status, 201); const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(signedIn.headers.get("set-cookie")!, /Secure/u);
  const createBody = JSON.stringify({ title: "Disposable fixture project", summary: "Device correlation fixture" });
  const created = await go("/api/v1/projects", ["Origin", remote, "Cookie", cookie, "Content-Type", "application/json", "Content-Length", String(Buffer.byteLength(createBody)), "Idempotency-Key", "b5-device-project-0001"], "POST", createBody);
  assert.equal(created.status, 201, created.body);
  const project = JSON.parse(created.body).project;
  assert.ok(project.projectId);
  mailbox = await createB5DeviceMailboxV1(await scratch(t), remote, { real, projectId: project.projectId, inventory: q.inventory, now: () => clock.now });
  t.after(() => mailbox!.close());
  const request = await mailbox.request("connect", "phone", new Date(clock.now + 600_000).toISOString());
  assert.equal((await go(mailbox.projectPath)).status, 303); assert.equal(mailbox.observation(), undefined);
  const first = await go(mailbox.projectPath, ["Cookie", cookie]); assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie")!, new RegExp(`b5_correlation=${request.sessionNonce}`));
  const second = await go(mailbox.projectPath, ["Cookie", `${cookie}; b5_correlation=${request.sessionNonce}`]);
  assert.equal(second.status, 200); assert.equal(mailbox.observation()!.sessionNonce, request.sessionNonce);
  assert.equal((await go(mailbox.projectPath + "?challenge=" + request.sessionNonce, ["Cookie", cookie])).status, 400, "the real product refuses invented query fields");
  assert.equal((await go("/api/v1/projects", ["Cookie", cookie, "Tailscale-Funnel-Request", "true"])).status, 403);
  assert.equal((await go("/api/v1/projects", ["Cookie", cookie, "Origin", "https://wrong.invalid"], "POST")).status, 403);
  const observationBytes = await readFile(join(mailbox.root, "observations/1.json"), "utf8");
  assert.equal(Date.parse(JSON.parse(signedIn.body).expiresAt), clock.now + 300_000);
  clock.now += 300_000;
  assert.equal((await go("/api/v1/projects", ["Cookie", cookie])).status, 401);
  const fresh = await go("/api/v1/local-owner-session", ["Origin", remote, "Content-Type", "application/json", "Content-Length", String(Buffer.byteLength(signInBody))], "POST", signInBody);
  assert.equal(fresh.status, 201);
  const freshCookie = fresh.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(freshCookie, cookie);
  assert.equal(Date.parse(JSON.parse(fresh.body).expiresAt), clock.now + 300_000);
  assert.equal((await go("/api/v1/projects", ["Cookie", freshCookie])).status, 200, "fresh session itself authenticates");
  if (real) {
    const restarted = mailbox.currentRequest()!;
    assert.equal(restarted.sequence, request.sequence + 1);
    assert.notEqual(restarted.sessionNonce, request.sessionNonce);
    assert.equal((await go(mailbox.projectPath, ["Cookie", cookie])).status, 303, "expired project reads redirect to sign-in");
    assert.equal((await go(mailbox.projectPath, ["Cookie", freshCookie])).status, 200);
    assert.equal((await go(mailbox.projectPath, ["Cookie", `${freshCookie}; b5_correlation=${restarted.sessionNonce}`])).status, 200);
    assert.equal(mailbox.observation()!.sequence, restarted.sequence);
    const abandoned = JSON.parse(await readFile(join(mailbox.root, "abandoned/1.json"), "utf8"));
    assert.equal(abandoned.counted, false);
    assert.deepEqual(abandoned.observation, JSON.parse(observationBytes));
  } else {
    assert.equal((await go(mailbox.projectPath, ["Cookie", freshCookie])).status, 503,
      "rehearsal retains the different-session refusal");
    assert.equal(mailbox.currentRequest()!.sequence, request.sequence);
  }
  assert.equal(await readFile(join(mailbox.root, "observations/1.json"), "utf8"), observationBytes);
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
  const safe = JSON.stringify(mailbox.observation());
  assert.doesNotMatch(safe, new RegExp(ownerCode + "|" + cookie.split("=")[1]! + "|" + q.ownerLogin));
  console.log(`RESULT: PASS F03b in-memory product real=${real} expired=401 fresh-signin=201 fresh-auth=200 preaction=${real ? "republished" : "refused"} unchanged-300s-session immutable-observation`);
});

test("F03b capture attestation refuses swapped device/challenge/sequence and stale capture time", async t => {
  const { mailbox, receipt } = await ready(t);
  for (const patch of [{ device: "desktop" }, { sessionNonce: "b".repeat(32) }, { sequence: 2 }, { capturedAt: time(-1) }, { capturedAt: time(1) }]) {
    await assert.rejects(mailbox.accept({ ...receipt, captures: [{ ...receipt.captures[0], ...patch }] }), { code: "B5_DEVICE_CORRELATION" });
  }
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
});

test("F03b request and receipt tampering, unsafe custody and oversized captures refuse", async t => {
  const { mailbox, receipt, request } = await ready(t);
  await writeFile(join(mailbox.root, "request.json"), JSON.stringify({ ...request, device: "desktop" }));
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_REQUEST_CHANGED" });
  await writeFile(join(mailbox.root, "request.json"), JSON.stringify(request));
  await chmod(join(mailbox.root, "captures/phone.png"), 0o644);
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_CUSTODY" });
  await chmod(join(mailbox.root, "captures/phone.png"), 0o600);
  await writeFile(join(mailbox.root, "captures/phone.png"), Buffer.alloc((1 << 20) + 1));
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_SIZE" });
  await writeFile(join(mailbox.root, "captures/phone.png"), "honestly fixture capture bytes");
  await mailbox.accept(receipt);
  await writeFile(join(mailbox.root, "receipts/1.json"), JSON.stringify({ ...receipt, browser: "changed browser" }));
  await assert.rejects(mailbox.readReceipt(1), { code: "B5_DEVICE_RECEIPT_CHANGED" });
});

test("F03b mailbox close drains an already-started receipt and refuses new work", async t => {
  const { mailbox, receipt } = await ready(t); let settled = false;
  const accepted = mailbox.accept(receipt).finally(() => { settled = true; });
  const closing = mailbox.close(); assert.equal(mailbox.close(), closing);
  await assert.rejects(mailbox.request("connect", "phone", time(1000)), { code: "B5_DEVICE_CLOSED" });
  await closing; assert.equal(settled, true); await accepted;
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), ["1.json"]);
});


test("F04a caller PG stop never calls outer cleanup, is memoized and awaits stop", async () => {
  const { createPostgresTeardown } = await import("./support/attack-kit/real-postgres");
  const target = new (await import("node:events")).EventEmitter();
  const protect = () => {};
  target.on("SIGINT", protect); target.on("SIGTERM", protect);
  let release!: () => void, stops = 0, callbacks = 0;
  const barrier = new Promise<void>(yes => { release = yes; });
  let teardown!: () => Promise<void>;
  const cleanup = async () => { callbacks++; await Promise.resolve(); await teardown(); };
  teardown = createPostgresTeardown(async () => { stops++; await barrier; }, { signalOwner: "caller", cleanup }, target as never);
  const work = teardown();
  assert.equal(callbacks, 0, "plain stop must not recurse into outer cleanup");
  assert.ok(Array.from({ length: 24 }, () => teardown()).every(p => p === work));
  let completed = false; void work.then(() => { completed = true; });
  await new Promise<void>(yes => setImmediate(yes)); assert.equal(completed, false);
  release(); await work; assert.equal(stops, 1); assert.equal(callbacks, 0);
  assert.equal(target.listenerCount("SIGINT"), 1); assert.equal(target.listenerCount("SIGTERM"), 1);
  assert.equal(target.listenerCount("exit"), 0, "successful stop removes the fallback exit hook");
  console.log("RESULT: PASS F04a caller stop no-cycle memoized=24 awaits-stop caller-listeners-retained");
});

test("F03b helper refuses caller ownership without cleanup before acquisition", async () => {
  const { withRealPostgres, createPostgresTeardown } = await import("./support/attack-kit/real-postgres");
  assert.throws(() => createPostgresTeardown(async () => {}, { signalOwner: "caller" }),
    /attack_kit_caller_cleanup_required/u, "caller cleanup guard refuses before acquisition");
  await assert.rejects(withRealPostgres(async () => {}, { port: 60470, allowedPorts: [60470], signalOwner: "caller" }),
    /attack_kit_caller_cleanup_required/u);
});

test("F04a caller ownership refuses either missing process signal listener before acquisition", async () => {
  const { createPostgresTeardown, withRealPostgres } = await import("./support/attack-kit/real-postgres");
  const target = new (await import("node:events")).EventEmitter();
  const options = { signalOwner: "caller" as const, cleanup: async () => {} };
  assert.throws(() => createPostgresTeardown(async () => {}, options, target as never), /attack_kit_caller_signal_listeners_required/u);
  target.on("SIGTERM", () => {});
  assert.throws(() => createPostgresTeardown(async () => {}, options, target as never), /attack_kit_caller_signal_listeners_required/u);
  target.removeAllListeners(); target.on("SIGINT", () => {});
  assert.throws(() => createPostgresTeardown(async () => {}, options, target as never), /attack_kit_caller_signal_listeners_required/u);
  if (!process.listenerCount("SIGINT") || !process.listenerCount("SIGTERM"))
    await assert.rejects(withRealPostgres(async () => { assert.fail("must refuse before acquisition"); },
      { port: 60470, allowedPorts: [60470], ...options }), /attack_kit_caller_signal_listeners_required/u);
  console.log("RESULT: PASS F04a LOW-2 missing SIGINT or SIGTERM refuses before acquisition");
});

test("F03b helper default signal protection unchanged", async () => {
  const pg = await import("./support/attack-kit/real-postgres");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const events: string[] = [], target = new (await import("node:events")).EventEmitter();
    Object.assign(target, { exit(code: number) { events.push(`exit-${code}`); } });
    const teardown = pg.createPostgresTeardown(async () => { events.push("pg-stop"); }, {}, target as never);
    assert.equal(target.listenerCount(signal), 1);
    target.emit(signal, signal); await new Promise<void>(yes => setImmediate(yes));
    assert.deepEqual(events, ["pg-stop", signal === "SIGINT" ? "exit-130" : "exit-143"]);
    await teardown(); assert.equal(target.listenerCount("SIGINT"), 0); assert.equal(target.listenerCount("SIGTERM"), 0);
  }
  console.log("RESULT: PASS helper default signal exit codes unchanged");
});

test("F04a outer cleanup owns host then bounded receipt then awaited PG stop", async () => {
  const { createPostgresTeardown } = await import("./support/attack-kit/real-postgres");
  const target = new (await import("node:events")).EventEmitter();
  target.on("SIGINT", () => {}); target.on("SIGTERM", () => {});
  const events: string[] = [];
  let work: Promise<unknown> | undefined;
  const removalCleanup = createB5DeviceCleanupV1(qualification(), {
    now: () => now, removalMs: 5,
    async closeHost() { events.push("host-close"); },
    async requestRemoval() { events.push("owner-removal-request"); return new Promise(() => {}); },
  });
  const cleanup = () => work ??= (async () => { try { return await removalCleanup(); } finally { await stop(); } })();
  const stop = createPostgresTeardown(async () => { await Promise.resolve(); events.push("pg-stop"); }, { signalOwner: "caller", cleanup }, target as never);
  await cleanup();
  assert.deepEqual(events, ["host-close", "owner-removal-request", "pg-stop"]);
  assert.equal((await removalCleanup()).disposition, "mapping-outstanding");
  console.log("RESULT: PASS F04a bounded missing receipt still awaits PG stop without cycle");
});

test("F03b remote preflight retains its fence unless the caller supplies the cleanup handle", async t => {
  const { preflightFirstWebsiteV1, B5_REQUEST_TEXT, b5Bytes } = await import("./helpers/improve-control-room-first-website");
  const { createHook } = await import("node:async_hooks");
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/acr-b5-seam-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "config"); await mkdir(directory, { mode: 0o700 });
  const file = (name: string) => join(directory, name);
  const q = { ...qualification(), authorizedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const files = { "first-website-host.mjs": "// inert fixture", "contract.json": "{}", "qualification.json": "{}",
    "settings.json": "{}", "availability.json": "{}", "authorization.json": "{}", "transport.json": JSON.stringify(q),
    "fault.md": "fixture builder input", "review.md": "fixture reviewer input" };
  for (const [name, contents] of Object.entries(files)) await writeFile(file(name), contents, { mode: 0o600 });
  const digest = b5Bytes("fixture");
  const config = { schemaVersion: 1,
    product: { root: join(root, "product"), baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), assetsDigest: digest },
    a2: { contractFile: file("contract.json"), toolingRevision: digest, schemaDigest: digest, qualificationEvidence: file("qualification.json") },
    assembly: { module: file("first-website-host.mjs"), digest: b5Bytes(files["first-website-host.mjs"]) },
    scratchRoot: root, ports: { product: 60460, preview: 60461, postgresBase: 60470 },
    device: { origin: remote, transportQualification: file("transport.json"), actor: "owner" },
    settingsFile: file("settings.json"), availabilityFile: file("availability.json"), authorizationEvidence: file("authorization.json"),
    requestText: B5_REQUEST_TEXT, faultInputFile: file("fault.md"), reviewInputFile: file("review.md") };
  await writeFile(file("b5.json"), JSON.stringify(config), { mode: 0o600 });
  const input = { configFile: file("b5.json"), evidenceDir: join(root, "evidence"), cliFile: join(root, "product/scripts/cli.ts") };
  const acquired: string[] = [];
  const hook = createHook({ init(_id, type) { if (["PROCESSWRAP", "TCPSERVERWRAP", "TCPWRAP"].includes(type)) acquired.push(type); } });
  hook.enable();
  try {
    await assert.rejects(preflightFirstWebsiteV1(input), { code: "B5_DEVICE_SIGNAL_CLEANUP_UNQUALIFIED" });
    await assert.rejects(preflightFirstWebsiteV1({ ...input, signalOwner: { cleanup: async () => {} } as never }),
      { code: "B5_DEVICE_SIGNAL_CLEANUP_UNQUALIFIED" });
    // A supplied owner clears only this fence: deliberately invalid settings
    // still refuse at the next independent guard, before any subprocess/probe.
    await assert.rejects(preflightFirstWebsiteV1({ ...input, signalOwner: {
      registerCloseHost() { assert.fail("preflight must not acquire a host"); },
      async cleanup() { assert.fail("preflight must not start cleanup"); },
    } }), { code: "B5_RISK_CATEGORIES" });
  } finally { hook.disable(); }
  assert.deepEqual(acquired, []);
  console.log("RESULT: PASS remote preflight clears signal fence only with callable cleanup/close handle; acquisitions=0");
});

test("F04a repeated correlated document reads return code-only refusals without throwing", async t => {
  const { mailbox, request } = await ready(t);
  const before = mailbox.observation();
  const reload = () => mailbox.handle(new Request(local + mailbox.projectPath, { headers: {
    cookie: `control_room_local_owner=${"a".repeat(43)}; b5_correlation=${request.sessionNonce}`,
  } }), async () => new Response("actual product fixture"));
  for (const parallel of [false, true]) {
    const results = await Promise.allSettled(parallel ? [reload(), reload()] : [reload()]);
    for (const result of results) {
      assert.equal(result.status, "fulfilled", "duplicate correlation must stay a Response on the product path");
      if (result.status !== "fulfilled") continue;
      assert.equal(result.value.status, 409);
      assert.match(await result.value.text(), /^B5_DEVICE_(?:DUPLICATE|SEQUENCE_RACE)$/u);
      assert.equal(result.value.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(mailbox.observation(), before, "a reload must not replace the evidence observation");
  }
});

test("F04a caller-only PG exit hook never enters outer cleanup and remains until verified stop", async () => {
  const { createPostgresTeardown } = await import("./support/attack-kit/real-postgres");
  const target = new (await import("node:events")).EventEmitter();
  target.on('SIGINT', () => {}); target.on('SIGTERM', () => {});
  const events: string[] = [];
  const stop = createPostgresTeardown(async () => { events.push('pg-stop'); }, {
    signalOwner: 'caller', cleanup: async () => { assert.fail('exit must never call outer cleanup'); },
  }, target as never, { exitStop: () => { events.push('sync-pg-stop'); } });
  assert.equal(target.listenerCount('exit'), 1);
  target.emit('exit', 143); assert.deepEqual(events, ['sync-pg-stop']);
  await stop(); assert.deepEqual(events, ['sync-pg-stop','pg-stop']);
  assert.equal(target.listenerCount('exit'), 0);
  const wedged = new (await import("node:events")).EventEmitter();
  wedged.on('SIGINT', () => {}); wedged.on('SIGTERM', () => {});
  let fallback = 0;
  const bounded = createPostgresTeardown(async () => new Promise(() => {}), { signalOwner: 'caller', cleanup: async () => {} },
    wedged as never, { boundMs: 5, exitStop: () => { fallback++; } });
  await assert.rejects(bounded(), /attack_kit_caller_stop_timeout/u);
  assert.equal(fallback, 1); assert.equal(wedged.listenerCount('exit'), 1, 'unverified stop keeps exit protection');
  console.log('RESULT: PASS F04a exit PG-only synchronous fallback; bounded stop failure retains protection');
});

test("F04a default helper begins its stop synchronously as before caller mode", async () => {
  const {createPostgresTeardown}=await import('./support/attack-kit/real-postgres');
  const target=new (await import('node:events')).EventEmitter();let called=false;
  const teardown=createPostgresTeardown(async()=>{called=true;},{},target as never);
  const work=teardown();assert.equal(called,true,'default helper must retain immediate stop initiation');
  await work;assert.equal(target.listenerCount('SIGINT'),0);assert.equal(target.listenerCount('SIGTERM'),0);
  console.log('RESULT: PASS F04a default helper stop initiation and signal listener removal unchanged');
});

test("F04a fix controller drives every phase through the frozen mailbox without extra lead acknowledgements", async t => {
  const { runFirstWebsiteDevicePhaseV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  const root = await scratch(t), phaseNow = Date.now();
  const phaseTime = () => new Date(phaseNow).toISOString();
  const mailbox = await createB5DeviceMailboxV1(root, local, { real: false, projectId: "project:fixture", now: () => phaseNow });
  t.after(() => mailbox.close());
  const policy = { normalizer: "b5-unicode-v1" as const, sentinel: `b5-private-${(await import("node:crypto")).randomBytes(24).toString("hex")}`,
    distinctiveInstructions: ["Keep the synthetic violet harbor quietly unannounced"] };
  const actions = { connect: ["connected"], prepare: ["prepared"], "bindings-ready": ["bindings-ready-observed"],
    "confirm-start": ["confirmed", "started"], question: ["answered"], plan: ["plan-read", "plan-approved"],
    spec: ["spec-read", "spec-approved"], close: ["closed"], repair: ["repair-observed"], finish: ["finished"], retained: ["retained-read"] };
  const phases: [B5DeviceRequestV1["phase"], "phone" | "desktop"][] = [
    ["connect", "phone"], ["connect", "desktop"], ["prepare", "phone"], ["bindings-ready", "phone"], ["confirm-start", "phone"],
    ["close", "phone"], ["close", "desktop"], ["question", "phone"], ["plan", "phone"], ["spec", "phone"],
    ["close", "phone"], ["close", "desktop"], ["repair", "phone"], ["finish", "phone"], ["finish", "desktop"], ["retained", "phone"],
  ];
  // Only the external owner is simulated. Publication, authenticated read
  // correlation, capture custody and immutable receipt acceptance are real.
  let sequence = 0, readyPublished = false;
  const observe = async () => {
    let request: B5DeviceRequestV1 | undefined;
    const limit = Date.now() + 5000;
    while (Date.now() < limit) {
      const saved = await readFile(join(mailbox.root, "request.json"), "utf8").catch(() => "null");
      const candidate = JSON.parse(saved) as B5DeviceRequestV1 | null;
      if (candidate && candidate.sequence === sequence + 1) { request = candidate; break; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(request, "controller must publish the next mailbox request");
    assert.equal(request.sequence, ++sequence);
    assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "request.json"), "utf8")), request);
    if (request.phase === "confirm-start") assert.equal(readyPublished, true);
    const observation = await correlated(mailbox, request, (request.device === "phone" ? "a" : "b").repeat(43));
    const bytes = Buffer.from(`fixture capture ${request.sequence}`), path = `captures/frame-${request.sequence}.png`;
    await writeFile(join(mailbox.root, path), bytes, { mode: 0o600 });
    const receipt = { ...request, observedAt: phaseTime(), real: false, browser: "fixture browser", actions: actions[request.phase], observation,
      captures: [{ path, sha256: b5DeviceHashV1(bytes), device: request.device, sequence: request.sequence, sessionNonce: request.sessionNonce, capturedAt: phaseTime() }],
      ...(request.phase === "close" ? { closeAttestation: { actor: "owner", closedAt: phaseTime(), allProofTabsClosed: true } } : {}) };
    await writeB5DeviceReceiptV1(join(mailbox.root, "inbox", `${request.sequence}.json`), receipt);
  };
  const failures: string[] = [];
  for (const [phase, device] of phases) {
    try {
      const binding = sequence >= 3 ? { requestId: "request:fixture", runLinkId: "link:fixture", inputVersion: 1 } : undefined;
      const [result] = await Promise.all([runFirstWebsiteDevicePhaseV1({ mailbox, phase, device, binding, policy, signal: new AbortController().signal, expiresAt: new Date(phaseNow + 60000).toISOString(),
        onPublished() { if (phase === "bindings-ready") readyPublished = true; } }), observe()]);
      assert.equal(result.receipt.phase, phase); assert.equal(result.receipt.device, device);
      assert.deepEqual(result.receipt.binding, binding);
      assert.deepEqual(await mailbox.readReceipt(sequence), result.receipt);
    } catch (error) { failures.push(`${phase}/${device}: ${(error as { code?: string }).code ?? String(error)}`); }
  }
  assert.deepEqual(failures, [], "every controller phase must complete using only the frozen mailbox contract");
  assert.equal(readyPublished, true); assert.equal(sequence, 16);
  assert.deepEqual((await readdir(mailbox.root)).filter(name => name.startsWith("visual-")), []);
  assert.deepEqual((await readdir(join(mailbox.root, "inbox"))).sort(), Array.from({ length: 16 }, (_, i) => `${i + 1}.json`).sort());
  console.log("RESULT: PASS F04a fix controller phases=16 through bindings-ready/confirm/question/plan/spec/finish/retained; real mailbox fixture observations; extra-lead-acks=0");
});


test('B5 real mailbox observes accepted owner HTTP actions and retains only correlated digests', async t => {
  const root=await scratch(t),q=qualification();
  const mailbox=await createB5DeviceMailboxV1(root,remote,{real:true,projectId:'unit-project',inventory:q.inventory,now:()=>now});
  t.after(()=>mailbox.close());
  const r=await mailbox.request('prepare','phone',time(10000));
  const ownerCookie='control_room_local_owner='+ 's'.repeat(43);
  for(const cookie of [ownerCookie,ownerCookie+'; b5_correlation='+r.sessionNonce])
    await mailbox.handle(new Request(remote+mailbox.projectPath,{headers:{cookie}}),async()=>new Response('product document'));
  const path='/api/v1/projects/unit-project/improvements/loop/intake';
  const responseBody=JSON.stringify({schemaVersion:1,requestId:'unit-request',localVersion:1,commandId:'unit-command',state:'accepted',replayed:false,engineRevision:1,error:null});
  const action=(cookie:string,state='accepted')=>mailbox.handle(new Request(remote+path,{method:'POST',headers:{cookie},body:'synthetic private request body'}),async()=>new Response(responseBody.replace('accepted',state),{status:201,headers:{'content-type':'application/json'}}));
  await action('control_room_local_owner='+ 't'.repeat(43)); // wrong disposable session is never evidence
  await action(ownerCookie,'uncertain'); // HTTP success alone is insufficient
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await writeFile(join(mailbox.root,'captures/unit.png'),png,{mode:0o600});
  const receipt={...r,real:true,browser:'fixture-browser/fixture-version',observedAt:time(),actions:['prepared'],observation:mailbox.observation()!,
    captures:[{path:'captures/unit.png',sha256:b5DeviceHashV1(png),device:'phone',sequence:r.sequence,sessionNonce:r.sessionNonce,capturedAt:time()}]};
  await assert.rejects(mailbox.accept(receipt),{code:'B5_DEVICE_SERVICE_MISSING'});
  await action(ownerCookie);
  await mailbox.accept(receipt);
  const evidence=await mailbox.readServiceEvidence(r.sequence);
  assert.deepEqual(evidence.events,[{name:'intake',method:'POST',path,status:201,at:time(),responseDigest:b5DeviceHashV1(responseBody)}]);
  const saved=await readFile(join(mailbox.root,'service',r.sequence+'.json'),'utf8');
  assert.ok(!saved.includes(ownerCookie) && !saved.includes('synthetic private request body') && !saved.includes('unit-command'));
  assert.deepEqual(JSON.parse(saved),evidence);
  await writeFile(join(mailbox.root,'service',r.sequence+'.json'),saved+' ');
  await assert.rejects(mailbox.readServiceEvidence(r.sequence),{code:'B5_DEVICE_SERVICE_CHANGED'});
  console.log('RESULT: PASS real mailbox correlates owner HTTP success and exact response digest; wrong session and uncertain success excluded; no bodies or secrets retained; tamper refuses');
});

test('B5 desktop close requires owner attestation without unchecked close evidence', {timeout:10000}, async t => {
  const root=await scratch(t),q=qualification();q.inventory.desktop={browser:'chromium',browserVersion:'unit'};
  const mailbox=await createB5DeviceMailboxV1(root,remote,{real:true,projectId:'unit-project',inventory:q.inventory});
  const C=await import('../scripts/workflow-journeys/first-website-controller');
  const owner=C.createFirstWebsiteControllerOwnerV1();
  t.after(async()=>{await owner.cleanup();owner.dispose();await mailbox.close();});
  // In-process browser double: no browser process, socket or network is opened.
  const {chromium}=await import('@playwright/test'),originalLaunch=chromium.launch;
  let closed=0,projectReads=0;
  const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},
    async goto(url:string){if(url===remote+mailbox.projectPath) {
      const r=JSON.parse(await readFile(join(mailbox.root,'request.json'),'utf8')) as B5DeviceRequestV1;
      await mailbox.handle(new Request(url,{headers:{cookie:'control_room_local_owner='+ 'z'.repeat(43)+(++projectReads > 1 ? '; b5_correlation='+r.sessionNonce : '')}}),async()=>new Response('unit product document'));
    }},getByLabel(){return {async fill(){}};},getByRole(){return {async click(){}};},async waitForURL(){},
    async screenshot(){return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');}};
  const browser={browserType:()=>({name:()=> 'chromium'}),version:()=> 'unit',async newContext(){return {async newPage(){return page;}};},async close(){closed++;}};
  chromium.launch=async()=>browser as unknown as Awaited<ReturnType<typeof originalLaunch>>;
  try {
    let release!:()=>void;const captured=new Promise<void>(yes=>{release=yes;});
    const phase=C.runFirstWebsiteDevicePhaseV1({mailbox,phase:'close',device:'desktop',expiresAt:new Date(Date.now()+5000).toISOString(),signal:owner.signal,
      binding:{requestId:'unit-request',runLinkId:'unit-link',inputVersion:1},policy:{normalizer:'b5-unicode-v1',sentinel:'UNIT_PRIVATE_CANARY_FOR_CLOSE_6789012345',distinctiveInstructions:['unit distinctive instruction']},
      capture:async request=>{
        const result=await C.captureFirstWebsiteDesktopV1({request,qualification:q,owner,signal:owner.signal,
          host:{proof:{device:mailbox,withOwnerCode:async (use:(code:string)=>Promise<unknown>)=>use('unit disposable code')}} as never});
        assert.equal(result,undefined);release();return result;
      }});
    await Promise.race([captured,phase.then(()=>assert.fail('owner attestation was not supplied'))]);
    assert.equal(closed,1);assert.deepEqual(await readdir(join(mailbox.root,'receipts')),[]);
    assert.deepEqual((await readdir(mailbox.root)).filter(name=>name.startsWith('desktop-capture-')),[]);
    const request=JSON.parse(await readFile(join(mailbox.root,'request.json'),'utf8'));
    const frame=await readFile(join(mailbox.root,'captures/1-desktop.png'));
    const captures=[{path:'captures/1-desktop.png',sha256:b5DeviceHashV1(frame),device:'desktop',sessionNonce:request.sessionNonce,sequence:request.sequence,capturedAt:new Date().toISOString()}];
    const at=new Date().toISOString();
    await writeB5DeviceReceiptV1(join(mailbox.root,'inbox/1.json'),{...request,real:true,browser:'chromium/unit',observation:mailbox.observation(),
      captures,observedAt:at,actions:['closed'],closeAttestation:{actor:'owner',allProofTabsClosed:true,closedAt:at}});
    assert.equal((await phase).receipt.closeAttestation?.allProofTabsClosed,true);
    assert.equal(closed,1);
  } finally {chromium.launch=originalLaunch;}
  console.log('RESULT: PASS simulated desktop browser closes once; no unchecked close evidence file; existing owner inbox attestation completes phase');
});

for (const [name,value] of [
  ['private hostname','https://fixture.ts.net:60462'],
  ['owner login','owner@example.invalid'],
  ['hostname key',{'fixture.ts.net:443':{}}],
  ['login key',{'owner@example.invalid':'unrelated'}],
  ['owner field',{ownerLogin:'redacted'}],
] as const) test(`B5 evidence secret guard refuses ${name} anywhere`,()=>{
  assert.throws(()=>assertB5EvidenceSecretFreeV1({nested:[value]}),{code:'B5_EVIDENCE_SECRET'});
});
test('B5 retained transport projects identifying fields without weakening private admission',()=>{
  const q=qualification(),retained=retainB5TransportQualificationV1(q,b5DeviceHashV1(JSON.stringify(q)));
  assertB5EvidenceSecretFreeV1(retained);
  assert.equal(retained.origin,'https://private-tailnet-1.invalid:60462');
  assert.ok(!('ownerLogin' in retained));
  assert.doesNotMatch(JSON.stringify(retained),/fixture\.ts\.net|owner@example\.invalid/iu);
  assert.deepEqual(retained.beforeStatus,redactB5EvidenceV1(q.beforeStatus,q));
  assert.equal(retained.beforeDigest,q.beforeDigest);
  assert.equal(validateB5TransportV1(q,remote,now).ownerLogin,'owner@example.invalid');
  console.log('RESULT: PASS retained transport labels hide host/login, retain mapping commitments, and preserve exact private admission');
});

test("B5 real-mode controller device gate survives days before fresh sign-in and accepts its receipt", async t => {
  const C = await import("../scripts/workflow-journeys/first-website-controller");
  const root = await scratch(t), q = qualification();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const mailbox = await createB5DeviceMailboxV1(root, remote, { real: true, projectId: "unit-project", inventory: q.inventory });
  const owner = C.createFirstWebsiteControllerOwnerV1();
  try {
    const started = Date.now(), longWait = 3 * 24 * 3600_000;
    owner.startDeadline(600_000, { ownerGates: true });
    const accept: B5DeviceMailboxV1["accept"] = async value => {
      assert.equal(owner.timing().waitingForOwner, false, "verification consumes active work");
      t.mock.timers.tick(5); return mailbox.accept(value);
    };
    const result = await C.runFirstWebsiteDevicePhaseV1({ mailbox: { ...mailbox, accept }, phase: "connect", device: "phone", signal: owner.signal,
      expiresAt: new Date(started + longWait + 60_000).toISOString(),
      policy: { normalizer: "b5-unicode-v1", sentinel: "UNIT_PRIVATE_GATE_CANARY_1234567890", distinctiveInstructions: ["unit gate instruction"] },
      onPublished() { assert.equal(owner.timing().waitingForOwner, false); },
      capture: async () => {
        assert.equal(owner.timing().waitingForOwner, false); t.mock.timers.tick(15); return undefined;
      },
      waitForOwner: wait => owner.waitForOwner(async () => {
        t.mock.timers.tick(longWait); assert.equal(owner.signal.aborted, false);
        const request = b5DeviceRequestSchemaV1.parse(JSON.parse(await readFile(join(mailbox.root, "request.json"), "utf8")));
        // Only the product's successful authenticated project response may
        // establish evidence. No browser, remote transport or login is launched.
        const token = "u".repeat(43);
        for (const cookie of [`control_room_local_owner=${token}`, `control_room_local_owner=${token}; b5_correlation=${request.sessionNonce}`])
          await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie } }), async () => new Response("unit authenticated project"));
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
        await writeFile(join(mailbox.root, "captures/late.png"), png, { mode: 0o600 });
        const at = new Date().toISOString();
        await writeB5DeviceReceiptV1(join(mailbox.root, "inbox", `${request.sequence}.json`), { ...request, real: true,
          browser: "fixture-browser/fixture-version", observedAt: at, actions: ["connected"], observation: mailbox.observation(),
          captures: [{ path: "captures/late.png", sha256: b5DeviceHashV1(png), device: "phone", sequence: request.sequence, sessionNonce: request.sessionNonce, capturedAt: at }] });
        return wait();
      }),
    });
    assert.equal(result.receipt.phase, "connect");
    assert.deepEqual(owner.timing(), { gateWaitMs: longWait, waitingForOwner: false });
    assert.equal(owner.workAt(), started + 300_000 + longWait);
    t.mock.timers.tick(299_979); assert.equal(owner.signal.aborted, false, "publication/capture/verification left exactly 299980ms active work");
    const cleanup = await owner.cleanup();
    assert.equal(cleanup.hostStopped && cleanup.postgresStopped, true); assert.deepEqual(cleanup.failures, []);
  } finally { await owner.cleanup(); owner.dispose(); await mailbox.close(); t.mock.timers.reset(); }
  console.log("RESULT: PASS B5 real-mode device handshake wait=3days fresh initial challenge receipt=accepted capture/verification=20ms active cleanup=complete");
});


test("B5 diagnostic challenge reset cannot count an earlier session's accepted Confirm", async t => {
  const q = qualification(), mailbox = await createB5DeviceMailboxV1(await scratch(t), remote,
    { real: true, projectId: "unit-project", inventory: q.inventory, now: () => now });
  t.after(() => mailbox.close());
  const binding = { requestId: "unit-request", runLinkId: "unit-link", inputVersion: 1 };
  const original = await mailbox.request("confirm-start", "phone", time(600_000), binding);
  const oldCookie = `control_room_local_owner=${"s".repeat(43)}`, freshCookie = `control_room_local_owner=${"t".repeat(43)}`;
  const observe = async (r: B5DeviceRequestV1, cookie: string) => {
    for (const value of [cookie, `${cookie}; b5_correlation=${r.sessionNonce}`])
      await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: value } }), async () => new Response("synthetic authenticated project"));
    return mailbox.observation()!;
  };
  const action = (name: "confirm" | "start", cookie: string) => mailbox.handle(new Request(remote +
    `/api/v1/projects/unit-project/improvements/loop/unit-request/${name}`, { method: "POST", headers: { cookie } }),
    async () => Response.json({ schemaVersion: 1, requestId: binding.requestId, localVersion: 1,
      commandId: "unit-command", state: "accepted", replayed: false, engineRevision: 1, error: null }, { status: 201 }));
  const oldObservation = await observe(original, oldCookie);
  await action("confirm", oldCookie);
  // Diagnostic only: explicitly publish a fresh attempt using the existing API.
  // This does not implement automatic restart or retain an abandoned audit.
  const restarted = await mailbox.request("confirm-start", "phone", original.expiresAt, binding);
  assert.notEqual(restarted.sessionNonce, original.sessionNonce);
  const observation = await observe(restarted, freshCookie);
  await assert.rejects(mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: oldCookie } }),
    async () => new Response("synthetic authenticated project")), { code: "B5_DEVICE_SESSION" });
  await action("start", freshCookie);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const path = "captures/restarted.png";
  await writeFile(join(mailbox.root, path), png, { mode: 0o600 });
  const receipt = { ...restarted, real: true, browser: "fixture-browser/fixture-version", observedAt: time(),
    actions: ["confirmed", "started"], observation,
    captures: [{ path, sha256: b5DeviceHashV1(png), device: "phone", sequence: restarted.sequence, sessionNonce: restarted.sessionNonce, capturedAt: time() }] };
  await assert.rejects(mailbox.accept({ ...receipt, ...original, observation: oldObservation }), { code: "B5_DEVICE_STALE" });
  await assert.rejects(mailbox.accept({ ...receipt, observation: oldObservation }), { code: "B5_DEVICE_CORRELATION" });
  await assert.rejects(mailbox.accept(receipt), { code: "B5_DEVICE_SERVICE_MISSING" });
  assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
  assert.deepEqual(await readdir(join(mailbox.root, "service")), []);
  assert.equal(await readFile(join(mailbox.root, "observations/1.json"), "utf8"), JSON.stringify(oldObservation) + "\n");
  console.log("RESULT: PASS diagnostic reset old-session receipt=STALE mixed-session observation=CORRELATION old Confirm plus fresh Start=SERVICE_MISSING; no accepted receipt");
});

async function restartFixture(t: { after(fn: () => Promise<void>): void }) {
  const clock = { now: Date.now() }, q = qualification();
  const mailbox = await createB5DeviceMailboxV1(await scratch(t), remote,
    { real: true, projectId: "unit-project", inventory: q.inventory, now: () => clock.now });
  t.after(() => mailbox.close());
  const observe = async (request: B5DeviceRequestV1, token: string) => {
    for (const cookie of [`control_room_local_owner=${token}`, `control_room_local_owner=${token}; b5_correlation=${request.sessionNonce}`])
      await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie } }), async () => new Response("synthetic authenticated project"));
    return mailbox.observation()!;
  };
  const signIn = (token: string) => mailbox.handle(new Request(remote + "/api/v1/local-owner-session", { method: "POST" }),
    async () => new Response(null, { status: 201, headers: { "set-cookie": `control_room_local_owner=${token}; HttpOnly; Path=/; Max-Age=300; Secure` } }));
  const action = (request: B5DeviceRequestV1, token: string, name: string, render?: () => Promise<Response>) =>
    mailbox.handle(new Request(remote + `/api/v1/projects/unit-project/improvements/loop/${name === "intake" ? "intake" : "unit-request/" + name}`, {
      method: "POST", headers: { cookie: `control_room_local_owner=${token}` } }), render ?? (async () => Response.json({ schemaVersion: 1,
      requestId: request.binding?.requestId ?? "unit-request", localVersion: 1, commandId: "unit-command", state: "accepted", replayed: false,
      engineRevision: 1, error: null }, { status: 201 })));
  const receipt = async (request: B5DeviceRequestV1, actions: string[]) => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const path = `captures/attempt-${request.sequence}.png`, at = new Date(clock.now).toISOString();
    await writeFile(join(mailbox.root, path), png, { mode: 0o600 });
    return { ...request, real: true, browser: "fixture-browser/fixture-version", observedAt: at, actions, observation: mailbox.observation(),
      captures: [{ path, sha256: b5DeviceHashV1(png), device: request.device, sequence: request.sequence, sessionNonce: request.sessionNonce, capturedAt: at }] };
  };
  return { mailbox, clock, observe, signIn, action, receipt };
}

for (const [phase, commands, actions] of [
  ["prepare", ["intake"], ["prepared"]],
  ["confirm-start", ["confirm", "start"], ["confirmed", "started"]],
  ["question", ["answer"], ["answered"]],
  ["plan", ["approve"], ["plan-read", "plan-approved"]],
  ["spec", ["approve"], ["spec-read", "spec-approved"]],
] as const) test(`B5 pre-action ${phase} expires repeatedly, republishes, completes and continues`, async t => {
  const C = await import("../scripts/workflow-journeys/first-website-controller");
  const f = await restartFixture(t), { mailbox } = f, owner = C.createFirstWebsiteControllerOwnerV1();
  const policy = { normalizer: "b5-unicode-v1" as const, sentinel: "UNIT_PRIVATE_GATE_CANARY_1234567890", distinctiveInstructions: ["unit gate instruction"] };
  const binding = { requestId: "unit-request", runLinkId: "unit-run", inputVersion: 1 };
  let published!: () => void;
  const ready = new Promise<void>(yes => { published = yes; });
  owner.startDeadline(600_000, { ownerGates: true });
  const pending = C.runFirstWebsiteDevicePhaseV1({ mailbox, phase, device: "phone", binding,
    expiresAt: new Date(f.clock.now + 3600_000).toISOString(), signal: owner.signal, policy,
    waitForOwner: wait => owner.waitForOwner(() => { published(); return wait(); }) });
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try {
    await ready;
    const original = mailbox.currentRequest()!;
    let current = original, token = "a".repeat(43);
    await f.observe(current, token);
    const oldReceipt = await f.receipt(current, [...actions]);
    for (const letter of ["b", "c"]) {
      const old = current, oldObservation = mailbox.observation();
      f.clock.now += 301_000;
      assert.equal((await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: `control_room_local_owner=${token}` } }),
        async () => new Response(null, { status: 401 }))).status, 401);
      const bytes = await readFile(join(mailbox.root, `observations/${old.sequence}.json`), "utf8");
      token = letter.repeat(43);
      await f.signIn(token);
      current = mailbox.currentRequest()!;
      assert.deepEqual({ ...current, sequence: old.sequence, sessionNonce: old.sessionNonce }, old);
      assert.notEqual(current.sessionNonce, old.sessionNonce);
      assert.equal(current.sequence, old.sequence + 1);
      assert.equal(mailbox.observation(), undefined);
      const audit = JSON.parse(await readFile(join(mailbox.root, `abandoned/${old.sequence}.json`), "utf8"));
      assert.equal(audit.counted, false); assert.deepEqual(audit.observation, oldObservation); assert.deepEqual(audit.events, []);
      assert.equal((await lstat(join(mailbox.root, `abandoned/${old.sequence}.json`))).mode & 0o777, 0o600);
      assert.equal(await readFile(join(mailbox.root, `observations/${old.sequence}.json`), "utf8"), bytes);
      // The issued session is pinned even before its first project read.
      await assert.rejects(mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: `control_room_local_owner=${"a".repeat(43)}` } }),
        async () => new Response("old authenticated session")), { code: "B5_DEVICE_SESSION" });
      await assert.rejects(mailbox.accept(oldReceipt), { code: "B5_DEVICE_STALE" });
      await f.observe(current, token);
    }
    const auditBytes = await readFile(join(mailbox.root, "abandoned/1.json"), "utf8");
    for (const command of commands) await f.action(current, token, command);
    const receipt = await f.receipt(current, [...actions]);
    await assert.rejects(mailbox.accept({ ...receipt, observation: oldReceipt.observation }), { code: "B5_DEVICE_CORRELATION" });
    // A stale inbox file must not fail the controller or supply accepted evidence.
    await writeB5DeviceReceiptV1(join(mailbox.root, "inbox", `${original.sequence}.json`), oldReceipt);
    await writeB5DeviceReceiptV1(join(mailbox.root, "inbox", `${current.sequence}.json`), receipt);
    const completed = await outcome;
    assert.equal(completed.error, undefined); assert.equal(completed.value!.receipt.sequence, current.sequence);
    assert.equal((await mailbox.readServiceEvidence(current.sequence)).events.length, commands.length);
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), [`${current.sequence}.json`]);
    assert.equal(await readFile(join(mailbox.root, "abandoned/1.json"), "utf8"), auditBytes);
    assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), ["1.json", "2.json"]);
    const next = await C.runFirstWebsiteDevicePhaseV1({ mailbox, phase: "bindings-ready", device: "phone", binding,
      expiresAt: current.expiresAt, signal: owner.signal, policy, capture: async request => {
        await f.observe(request, token);
        return { receipt: b5DeviceReceiptSchemaV1.parse(await f.receipt(request, ["bindings-ready-observed"])) };
      } });
    assert.equal(next.receipt.sequence, current.sequence + 1);
  } finally { owner.abort(new B5RefusalV1("fixture complete")); await outcome; await owner.cleanup(); owner.dispose(); }
});

test("B5 sign-in waits for an in-flight accepted Confirm before deciding against restart", async t => {
  const f = await restartFixture(t), { mailbox } = f;
  const request = await mailbox.request("confirm-start", "phone", new Date(f.clock.now + 3600_000).toISOString(),
    { requestId: "unit-request", runLinkId: "unit-run", inputVersion: 1 });
  await f.observe(request, "a".repeat(43));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(yes => { entered = yes; }), barrier = new Promise<void>(yes => { release = yes; });
  const command = f.action(request, "a".repeat(43), "confirm", async () => {
    entered(); await barrier;
    return Response.json({ schemaVersion: 1, requestId: "unit-request", localVersion: 1, commandId: "unit-command", state: "accepted",
      replayed: false, engineRevision: 1, error: null }, { status: 201 });
  });
  await started;
  // A slow mutation cannot put Stop or ordinary polling behind sign-in ordering.
  for (const [path, method] of [["unit-request/stop", "POST"], ["unit-request/status", "GET"]] as const) {
    const response = await mailbox.handle(new Request(remote + "/api/v1/projects/unit-project/improvements/loop/" + path,
      { method }), async () => new Response(null, { status: 200 }));
    assert.equal(response.status, 200);
  }
  let signedIn = false;
  const fresh = f.signIn("b".repeat(43)).then(r => { signedIn = true; return r; });
  await Promise.resolve(); assert.equal(signedIn, false);
  release(); await command; await fresh;
  assert.equal(mailbox.currentRequest()!.sequence, request.sequence);
  assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), []);
  assert.equal(JSON.parse(await readFile(join(mailbox.root, "session-wait.json"), "utf8")).reason,
    "sign-in expired after you acted; press Stop and the lead restarts the run");
});

test("B5 failed or malformed sign-in cannot reset a challenge; pre-observation accepted command prevents restart", async t => {
  const f = await restartFixture(t), { mailbox } = f;
  const request = await mailbox.request("confirm-start", "phone", new Date(f.clock.now + 3600_000).toISOString(),
    { requestId: "unit-request", runLinkId: "unit-run", inputVersion: 1 });
  await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: `control_room_local_owner=${"a".repeat(43)}` } }),
    async () => new Response("synthetic authenticated project"));
  for (const [status, cookie] of [[401, `control_room_local_owner=${"b".repeat(43)}; Path=/`], [201, "unrelated=ignored"], [200, ""]] as const) {
    await mailbox.handle(new Request(remote + "/api/v1/local-owner-session", { method: "POST" }),
      async () => new Response(null, { status, headers: { "set-cookie": cookie } }));
    assert.equal(mailbox.currentRequest()!.sequence, request.sequence);
  }
  await f.action(request, "a".repeat(43), "confirm");
  await f.signIn("b".repeat(43));
  assert.equal(mailbox.currentRequest()!.sequence, request.sequence);
  assert.equal(mailbox.observation(), undefined);
  assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), []);
  assert.match(await readFile(join(mailbox.root, "session-wait.json"), "utf8"), /sign-in expired after you acted/u);
});

for (const kind of ["before-observation", "uncertain-response", "rejected-command", "challenge-only"] as const)
  test(`B5 pre-action restart admission handles ${kind}`, async t => {
    const f = await restartFixture(t), { mailbox } = f;
    const request = await mailbox.request("confirm-start", "phone", new Date(f.clock.now + 3600_000).toISOString(),
      { requestId: "unit-request", runLinkId: "unit-run", inputVersion: 1 });
    if (kind !== "before-observation") await mailbox.handle(new Request(remote + mailbox.projectPath,
      { headers: { cookie: `control_room_local_owner=${"a".repeat(43)}` } }), async () => new Response("synthetic authenticated project"));
    if (kind === "before-observation") await f.action(request, "a".repeat(43), "confirm");
    if (kind === "uncertain-response") await f.action(request, "a".repeat(43), "confirm", async () => Response.json({ unknown: true }, { status: 201 }));
    if (kind === "rejected-command") await f.action(request, "a".repeat(43), "confirm", async () => new Response(null, { status: 409 }));
    await f.signIn("b".repeat(43));
    const restarts = kind === "rejected-command" || kind === "challenge-only";
    assert.equal(mailbox.currentRequest()!.sequence, request.sequence + Number(restarts));
    assert.equal(mailbox.observation(), undefined);
    if (restarts) {
      const audit = JSON.parse(await readFile(join(mailbox.root, "abandoned/1.json"), "utf8"));
      assert.equal(audit.counted, false); assert.equal(audit.observation, undefined);
      await f.observe(mailbox.currentRequest()!, "b".repeat(43));
    } else {
      assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), []);
      assert.match(await readFile(join(mailbox.root, "session-wait.json"), "utf8"), /sign-in expired after you acted/u);
    }
  });

// Pins the existing pre-action heuristic: only a first 4xx owner-command
// response clears "possibly acted"; it is not a new receipt contract.
const restartMatrixWait = "sign-in expired after you acted; press Stop and the lead restarts the run";
async function restartMatrixSetup(t: { after(fn: () => Promise<void>): void }) {
  const f = await restartFixture(t), { mailbox } = f;
  const request = await mailbox.request("confirm-start", "phone", new Date(f.clock.now + 3600_000).toISOString(),
    { requestId: "unit-request", runLinkId: "unit-run", inputVersion: 1 });
  const original = await f.observe(request, "a".repeat(43));
  assert.equal(original.sequence, request.sequence);
  const observationBytes = await readFile(join(mailbox.root, "observations/1.json"), "utf8");
  assert.equal(observationBytes, JSON.stringify(original) + "\n");
  return { f, mailbox, request, original, observationBytes };
}
async function restartMatrixExists(path: string) {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}

for (const outcome of [399, 400, 401, 403, 409, 422, 499, 500, "throw"] as const)
  test(`B5 restart outcome matrix first command ${outcome}`, async t => {
    const { f, mailbox, request, original, observationBytes } = await restartMatrixSetup(t);
    const rendered = outcome === "throw" ? undefined : new Response(null, { status: outcome });
    const thrown = new Error("synthetic render failure");
    const command = f.action(request, "a".repeat(43), "confirm", async () => { if (!rendered) throw thrown; return rendered; });
    if (rendered) assert.equal(await command, rendered, `B5_MATRIX_IDENTITY status=${outcome} response identity`);
    else await assert.rejects(command, (error: unknown) => error === thrown);
    const restarts = typeof outcome === "number" && outcome >= 400 && outcome < 500;
    const signed = await f.signIn("b".repeat(43));
    assert.equal(signed.status, 201);
    const current = mailbox.currentRequest()!;
    if (restarts) {
      assert.equal(current.sequence, request.sequence + 1, `B5_MATRIX_RESTART status=${outcome} must republish after a first 4xx`);
      assert.deepEqual({ ...current, sequence: request.sequence, sessionNonce: request.sessionNonce }, request);
      assert.notEqual(current.sessionNonce, request.sessionNonce);
      assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "request.json"), "utf8")), current);
      assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), ["1.json"]);
      const audit = JSON.parse(await readFile(join(mailbox.root, "abandoned/1.json"), "utf8"));
      assert.deepEqual(Object.keys(audit).sort(), ["abandonedAt", "counted", "events", "observation", "reason", "request", "schemaVersion"]);
      assert.deepEqual({ ...audit, abandonedAt: undefined }, { schemaVersion: 1, request, observation: original, events: [],
        abandonedAt: undefined, reason: "session-replaced-before-owner-command", counted: false });
      assert.equal(mailbox.observation(), undefined);
      assert.equal(await restartMatrixExists(join(mailbox.root, "session-wait.json")), false);
      // The republished request continues with the fresh session only.
      const next = await f.observe(current, "b".repeat(43));
      assert.equal(next.sequence, request.sequence + 1);
      assert.deepEqual(await readdir(join(mailbox.root, "observations")), ["1.json", "2.json"]);
    } else {
      assert.equal(current.sequence, request.sequence, `B5_MATRIX_NO_RESTART outcome=${outcome} must retain uncertainty`);
      assert.deepEqual(current, request);
      assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "request.json"), "utf8")), request);
      assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), []);
      assert.deepEqual(mailbox.observation(), original);
      assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "session-wait.json"), "utf8")), { sequence: request.sequence, reason: restartMatrixWait });
      assert.deepEqual(await readdir(join(mailbox.root, "observations")), ["1.json"]);
    }
    assert.equal(await readFile(join(mailbox.root, "observations/1.json"), "utf8"), observationBytes);
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
    assert.deepEqual(await readdir(join(mailbox.root, "service")), []);
    console.log(`RESULT: PASS restart outcome matrix first=${outcome} restart=${restarts} sequence=${current.sequence}`);
  });

for (const second of [400, 409] as const)
  test(`B5 restart outcome matrix prior accepted command then ${second} keeps the action authoritative`, async t => {
    const { f, mailbox, request, original, observationBytes } = await restartMatrixSetup(t);
    const confirmed = await f.action(request, "a".repeat(43), "confirm");
    assert.equal(confirmed.status, 201);
    const rejected = new Response(null, { status: second });
    assert.equal(await f.action(request, "a".repeat(43), "start", async () => rejected), rejected);
    await f.signIn("b".repeat(43));
    assert.equal(mailbox.currentRequest()!.sequence, request.sequence, `B5_MATRIX_PRIOR_ACTION second=${second} must block restart`);
    assert.deepEqual(mailbox.currentRequest(), request);
    assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), []);
    assert.deepEqual(mailbox.observation(), original);
    assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "session-wait.json"), "utf8")), { sequence: request.sequence, reason: restartMatrixWait });
    assert.equal(await readFile(join(mailbox.root, "observations/1.json"), "utf8"), observationBytes);
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
    // The rejected Start supplied no event: a receipt still lacks it.
    await assert.rejects(mailbox.accept(await f.receipt(request, ["confirmed", "started"])), { code: "B5_DEVICE_SERVICE_MISSING" });
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
    assert.deepEqual(await readdir(join(mailbox.root, "service")), []);
    // The earlier accepted Confirm remains the sequence's first service event.
    await f.action(request, "a".repeat(43), "start");
    const accepted = await mailbox.accept(await f.receipt(request, ["confirmed", "started"]));
    assert.equal(accepted.sequence, request.sequence);
    assert.deepEqual((await mailbox.readServiceEvidence(request.sequence)).events.map(e => [e.name, e.status]), [["confirm", 201], ["start", 201]]);
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), ["1.json"]);
    console.log(`RESULT: PASS restart outcome matrix prior accepted Confirm then ${second}: restart blocked, Confirm authoritative`);
  });

test("B5 receipt acceptance and pre-action sign-in serialize without a partial reset", async t => {
  const f = await restartFixture(t), { mailbox } = f;
  const request = await mailbox.request("connect", "phone", new Date(f.clock.now + 3600_000).toISOString());
  await f.observe(request, "a".repeat(43));
  const receipt = await f.receipt(request, ["connected"]);
  const results = await Promise.allSettled([f.signIn("b".repeat(43)), mailbox.accept(receipt)]);
  assert.equal(results[0]!.status, "fulfilled");
  const accepted = results[1]!;
  if (accepted.status === "fulfilled") {
    assert.equal(mailbox.currentRequest()!.sequence, request.sequence);
    assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), []);
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), ["1.json"]);
  } else {
    assert.equal(accepted.reason.code, "B5_DEVICE_STALE");
    assert.equal(mailbox.currentRequest()!.sequence, request.sequence + 1);
    assert.deepEqual(await readdir(join(mailbox.root, "abandoned")), ["1.json"]);
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
  }
});

test("B5 controller follows replacement after reading an old receipt", async t => {
  const C = await import("../scripts/workflow-journeys/first-website-controller");
  const f = await restartFixture(t);
  let captures = 0;
  const result = await C.runFirstWebsiteDevicePhaseV1({ mailbox: f.mailbox, phase: "connect", device: "phone",
    expiresAt: new Date(f.clock.now + 3600_000).toISOString(), signal: new AbortController().signal,
    policy: { normalizer: "b5-unicode-v1", sentinel: "UNIT_PRIVATE_GATE_CANARY_1234567890", distinctiveInstructions: ["unit gate instruction"] },
    capture: async request => {
      await f.observe(request, (++captures === 1 ? "a" : "b").repeat(43));
      const receipt = b5DeviceReceiptSchemaV1.parse(await f.receipt(request, ["connected"]));
      if (captures === 1) await f.signIn("b".repeat(43));
      return { receipt };
    } });
  assert.equal(captures, 2);
  assert.equal(result.receipt.sequence, 2);
  assert.deepEqual(await readdir(join(f.mailbox.root, "receipts")), ["2.json"]);
});


for (const acted of [false, true]) for (const termination of ["Stop", "external abort"] as const) test(`B5 ${acted ? "post-action wait" : "pre-action restart"} remains interruptible by ${termination}`, async t => {
  const C = await import("../scripts/workflow-journeys/first-website-controller");
  const { B5RefusalV1 } = await import("./helpers/improve-control-room-first-website");
  const mailbox = await createB5DeviceMailboxV1(await scratch(t), remote,
    { real: true, projectId: "unit-project", inventory: qualification().inventory, now: () => Date.now() });
  const external = new AbortController(), owner = C.createFirstWebsiteControllerOwnerV1(external.signal), events: string[] = [];
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  try {
    owner.startDeadline(600_000, { ownerGates: true });
    owner.registerStopWork(async () => { events.push("stop"); });
    owner.registerCloseHost(async () => { events.push("host"); await mailbox.close(); });
    owner.registerStopPostgres(async () => { events.push("postgres"); });
    let entered!: () => void, settled = false;
    const waiting = new Promise<void>(yes => { entered = yes; });
    const phase = C.runFirstWebsiteDevicePhaseV1({ mailbox, phase: "confirm-start", device: "phone", signal: owner.signal,
      binding: { requestId: "unit-request", runLinkId: "unit-run", inputVersion: 1 },
      expiresAt: time(24 * 3600_000),
      policy: { normalizer: "b5-unicode-v1", sentinel: "UNIT_PRIVATE_GATE_CANARY_1234567890", distinctiveInstructions: ["unit gate instruction text"] },
      waitForOwner: wait => owner.waitForOwner(() => { entered(); return wait(); }) });
    const outcome = phase.then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { value: undefined, error }; });
    await waiting;
    const request = b5DeviceRequestSchemaV1.parse(JSON.parse(await readFile(join(mailbox.root, "request.json"), "utf8")));
    const oldCookie = `control_room_local_owner=${"u".repeat(43)}`;
    for (const cookie of [oldCookie, `${oldCookie}; b5_correlation=${request.sessionNonce}`])
      await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie } }), async () => new Response("synthetic authenticated project"));
    const original = mailbox.observation();
    if (acted) await mailbox.handle(new Request(remote + "/api/v1/projects/unit-project/improvements/loop/unit-request/confirm", {
      method: "POST", headers: { cookie: oldCookie } }), async () => Response.json({ schemaVersion: 1, requestId: "unit-request", localVersion: 1,
        commandId: "unit-command", state: "accepted", replayed: false, engineRevision: 1, error: null }, { status: 201 }));
    t.mock.timers.tick(301_000);
    const expired = await mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: oldCookie } }),
      async () => new Response(null, { status: 401 }));
    assert.equal(expired.status, 401);
    const freshCookie = `control_room_local_owner=${"v".repeat(43)}`;
    const fresh = await mailbox.handle(new Request(remote + "/api/v1/local-owner-session", { method: "POST" }),
      async () => new Response(null, { status: 201, headers: { "set-cookie": freshCookie + "; HttpOnly; Path=/; Max-Age=300" } }));
    assert.equal(fresh.status, 201);
    if (acted) {
      await assert.rejects(mailbox.handle(new Request(remote + mailbox.projectPath, { headers: { cookie: freshCookie } }),
        async () => new Response("synthetic authenticated project")), { code: "B5_DEVICE_SESSION" });
      assert.deepEqual(mailbox.observation(), original);
      assert.equal(mailbox.currentRequest()!.sequence, request.sequence);
      assert.equal(JSON.parse(await readFile(join(mailbox.root, "session-wait.json"), "utf8")).reason,
        "sign-in expired after you acted; press Stop and the lead restarts the run");
    } else {
      assert.equal(mailbox.currentRequest()!.sequence, request.sequence + 1);
      assert.equal(mailbox.observation(), undefined);
      assert.deepEqual(JSON.parse(await readFile(join(mailbox.root, "abandoned/1.json"), "utf8")).observation, original);
    }
    assert.equal(settled, false, "both branches retain an interruptible owner wait");
    assert.deepEqual(owner.timing(), { gateWaitMs: 301_000, waitingForOwner: true });
    const reason = new B5RefusalV1(termination === "Stop" ? "B5_OWNER_STOP" : "B5_ABORTED");
    if (termination === "Stop") owner.abort(reason); else external.abort(reason);
    assert.equal((await outcome).error, reason);
    const cleanup = await owner.cleanup();
    assert.deepEqual(events, ["stop", "host", "postgres"]); assert.deepEqual(cleanup.failures, []);
    assert.deepEqual(owner.timing(), { gateWaitMs: 301_000, waitingForOwner: false });
    assert.deepEqual(await readdir(join(mailbox.root, "receipts")), []);
  } finally { await owner.cleanup(); owner.dispose(); await mailbox.close(); t.mock.timers.reset(); }
  console.log(`RESULT: PASS ${acted ? "post-action wait" : "pre-action restart"} controller=waiting owner-wait=301000ms ${termination}=clean-stop no accepted receipt`);
});

test("B5 transport accepts an explicit four-day run approval and enforces its exact expiry without a duration cap", () => {
  for (const days of [4, 5]) {
    const expires = days * 24 * 3600_000;
    const packet = { ...qualification(), authorizedAt: time(), expiresAt: time(expires) };
    assert.equal(validateB5TransportV1(packet, remote, now).expiresAt, packet.expiresAt);
    assert.equal(validateB5TransportV1(packet, remote, now + expires - 1).expiresAt, packet.expiresAt);
    assert.throws(() => validateB5TransportV1(packet, remote, now + expires), { code: "B5_DEVICE_EXPIRED" });
    assert.throws(() => validateB5TransportV1(packet, remote, now - 1), { code: "B5_DEVICE_EXPIRED" });
  }
  console.log("RESULT: PASS B5 transport run approval accepts 4d; 5d confirms no duration cap; before authorization and exact expiry refuse");
});
