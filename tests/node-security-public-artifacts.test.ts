import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SqliteNodeSecurityStateRepository, type SecurityStateFaultPoint } from "../src/node-policy/v1/persistent-security-state";
import { PinnedOwnerTrust } from "../src/node-policy/v1/owner-pins";
import { ownerSignedTrustBundleSchema, signedNodeAuthorityCeilingSchema } from "../src/node-policy/v1/schemas";
import { containsSecretMaterial } from "../src/security/redaction";
import type { OwnerSignedTrustBundleV1, SignedNodeAuthorityCeilingV1, ServerTrustBundleBodyV1, NodeAuthorityCeilingV1 } from "../src/node-policy/v1/types";

// Synthetic Ed25519 seeds, not credentials or recorded private material. These
// counters reproduce the independently captured public collisions in CR-E084.
function pair(counter: number) {
  const seed = createHash("sha256").update(`synthetic-public-collision:${counter}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}
function spki(key: KeyObject): string { return key.export({ format: "der", type: "spki" }).toString("base64url"); }
// Independent canonical encoder and signer: no production digest/sign helpers.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function signed<T extends { bodyDigest: string }>(body: T, privateKey: KeyObject) {
  const { bodyDigest: _digest, ...material } = body;
  const complete = { ...body, bodyDigest: `sha256:${createHash("sha256").update(canonical(material)).digest("hex")}` };
  return { body: complete, signatureAlgorithm: "Ed25519" as const, signature: sign(null, Buffer.from(canonical(complete)), privateKey).toString("base64url") };
}
const binding = { tenantId: "tenant:probe", nodeId: "node:probe", nodeClass: "personal-compute" };
const at = "2026-09-04T12:00:09.000Z";
const root = pair(4);
function pin(counter = 4) {
  const publicSpki = spki(pair(counter).publicKey);
  return { keyId: "owner-key:test", algorithm: "ed25519" as const, spki: publicSpki, fingerprint: `sha256:${createHash("sha256").update(Buffer.from(publicSpki, "base64url")).digest("hex")}` };
}
function pins(counter = 4, shrinkCounter = counter) {
  const owner = pin(counter);
  return new PinnedOwnerTrust({ ceilingProvisioningKey: owner, serverTrustRootKey: owner, trustShrinkKeys: [pin(shrinkCounter)] });
}
function bundle(counter = 76641, signingCounter = 4, changes: Partial<ServerTrustBundleBodyV1> = {}): OwnerSignedTrustBundleV1 {
  return signed({ schema: "control-room.server-trust-bundle/v1", tenantId: binding.tenantId, nodeClass: binding.nodeClass,
    epoch: 1, issuedAt: at, ownerRootKeyId: "owner-key:test",
    keys: [{ keyId: "server-key:test", algorithm: "ed25519", spki: spki(pair(counter).publicKey), state: "active" }],
    bodyDigest: "", ...changes } as ServerTrustBundleBodyV1, pair(signingCounter).privateKey);
}
function ceiling(signingCounter = 4, changes: Partial<NodeAuthorityCeilingV1> = {}): SignedNodeAuthorityCeilingV1 {
  return signed({ schema: "control-room.node-authority-ceiling/v1", tenantId: binding.tenantId, nodeId: binding.nodeId,
    version: 1, issuedAt: at, issuerKeyId: "owner-key:test", projectIds: ["project:probe"], executorIds: ["executor:probe"],
    operationIds: ["operation:probe"], credentialRefs: [], filesystemRoots: [], networkDestinations: [], maxRisk: "low",
    externalEffects: "none", maxDurationSeconds: 60, maxConcurrentEffects: 0, bodyDigest: "", ...changes } as NodeAuthorityCeilingV1, pair(signingCounter).privateKey);
}
function shrink(artifact: OwnerSignedTrustBundleV1, signingCounter = 4, keyId = "owner-key:test") {
  const material = { schema: "control-room.trust-bundle-shrink-authorization/v1", keyId, bundleBodyDigest: artifact.body.bodyDigest };
  return { ...artifact, shrinkAuthorization: { keyId, bundleBodyDigest: artifact.body.bodyDigest, signatureAlgorithm: "Ed25519" as const,
    signature: sign(null, Buffer.from(canonical(material)), pair(signingCounter).privateKey).toString("base64url") } };
}
const collisionSpki = "MCowBQYDK2VwAyEA-Sk-E-gyubEdUAlJhnFtExcsQGbKAwdlF68nlrispus";
const collisionBundleSignature = "SK-ZMxF840YqnVDgpuEH5HX3OsSv_SnPtKri_vcs8vU0WmBLGLUy6jqYEFbiNJ2b6gTqmCkn2jabcSbxbZXDBA";
const collisionCeilingSignature = "SK-klgk0vdjgGwVKn-9nfH9TWJUzwn5lvQVwcWhykmHCWQgaLZieeSVBCIpg8dEp6VxDDTtbafRr0bhy11SqCw";
function paths(directory: string) { return { artifactDatabasePath: join(directory, "artifacts.db"), highWaterDatabasePath: join(directory, "water.db") }; }
function open(directory: string, counter = 4, fault: (point: SecurityStateFaultPoint) => void = () => undefined, shrinkCounter = counter) {
  return new SqliteNodeSecurityStateRepository(paths(directory), binding, pins(counter, shrinkCounter), { now: () => at }, fault);
}
const scratchRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
async function fixture<T>(run: (repository: SqliteNodeSecurityStateRepository, directory: string) => Promise<T>, counter = 4, shrinkCounter = counter) {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "e084-public-"));
  let repository: SqliteNodeSecurityStateRepository | undefined;
  try {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const path of Object.values(paths(directory))) await assert.rejects(stat(path), { code: "ENOENT" });
    repository = open(directory, counter, undefined, shrinkCounter);
    await assert.rejects(repository.loadTrustBundle(), { code: "missing" });
    await assert.rejects(repository.loadCeiling(), { code: "missing" });
    return await run(repository, directory);
  } finally {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false, "fixture cleanup reached");
  }
}
function snapshot(directory: string) {
  const artifact = new DatabaseSync(paths(directory).artifactDatabasePath, { readOnly: true });
  const water = new DatabaseSync(paths(directory).highWaterDatabasePath, { readOnly: true });
  try { return ["node_ceiling_current", "server_trust_current", "server_trust_key_history"].map(table => artifact.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    .concat(["ceiling_high_water", "trust_high_water"].map(table => water.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  } finally { artifact.close(); water.close(); }
}
function assertIndependentSignature(artifact: OwnerSignedTrustBundleV1 | SignedNodeAuthorityCeilingV1, counter = 4) {
  assert.equal(verify(null, Buffer.from(canonical(artifact.body)), pair(counter).publicKey, Buffer.from(artifact.signature, "base64url")), true);
}
async function roundTrip(repo: SqliteNodeSecurityStateRepository, artifact: OwnerSignedTrustBundleV1) {
  assert.equal(await repo.provisionInitialTrustBundle(artifact), "provisioned");
  assert.deepEqual(await repo.loadTrustBundle(), artifact);
  assert.equal(await repo.currentEpoch(), artifact.body.epoch);
  assert.equal(repo.currentServerTrustRevision(), `${artifact.body.epoch}:${artifact.body.bodyDigest}`);
  for (const key of artifact.body.keys) assert.deepEqual(Buffer.from((await repo.resolveServerKey(key.keyId))!), Buffer.from(key.spki, "base64url"));
  assert.equal(await repo.resolveServerKey("server-key:absent"), undefined);
}
async function refusesUnchanged(repo: SqliteNodeSecurityStateRepository, directory: string, operation: () => Promise<unknown>) {
  const before = snapshot(directory);
  await assert.rejects(operation(), { code: "invalid_bundle" });
  assert.deepEqual(snapshot(directory), before, "refusal must not prepare or write any state");
}
function alias(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) + 1];
}


// Frozen production writer from cf91e3140bc11c772aaac5cde5c3588bdac6da06.
// Keep earlier-state creation independent of the candidate's stricter admission.
// This gzip fixture contains the complete earlier module, not synthetic rows.
// Its unchanged imports resolve to the same production dependencies used then.
const legacyWriterGzip = [
  "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",
].join("");
const legacyWriterSha256 = "7143128a8cdc507de866d0655ea693fb6fdba6d44243597db7b5434aec81c154";
async function legacyState(
  trust: OwnerSignedTrustBundleV1,
  authority: SignedNodeAuthorityCeilingV1,
  readPins: PinnedOwnerTrust = pins(),
) {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "e084-legacy-"));
  let writer: SqliteNodeSecurityStateRepository | undefined;
  let reader: SqliteNodeSecurityStateRepository | undefined;
  try {
    for (const path of Object.values(paths(directory))) await assert.rejects(stat(path), { code: "ENOENT" });
    const source = gunzipSync(Buffer.from(legacyWriterGzip, "base64")).toString("utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), legacyWriterSha256, "independently captured base writer bytes");
    const originalModule = fileURLToPath(new URL("../src/node-policy/v1/persistent-security-state.ts", import.meta.url));
    const relocated = source.replace(/from "(\.[^"]+)"/g, (_match, specifier: string) => {
      const local = relative(directory, join(dirname(originalModule), specifier)).split("\\").join("/");
      return `from "${local.startsWith(".") ? local : `./${local}`}"`;
    });
    const writerPath = join(directory, "legacy-writer.ts");
    await writeFile(writerPath, relocated);
    const LegacyRepository = (await import(pathToFileURL(writerPath).href)).SqliteNodeSecurityStateRepository;
    writer = new LegacyRepository(paths(directory), binding, pins(), { now: () => at });
    await assert.rejects(writer!.loadTrustBundle(), { code: "missing" });
    assert.equal(await writer!.provisionInitialTrustBundle(trust), "provisioned", "base product writes historical trust state");
    assert.equal(await writer!.provisionInitialCeiling(authority), "provisioned", "base product writes historical ceiling state");
    assert.deepEqual(await writer!.loadTrustBundle(), trust, "base read-back preserves historical bytes");
    writer!.close(); writer = undefined;
    const before = snapshot(directory);
    reader = new SqliteNodeSecurityStateRepository(paths(directory), binding, readPins, { now: () => at });
    assert.deepEqual(await reader.loadTrustBundle(), trust, "base-written trust state stays readable");
    assert.deepEqual(await reader.loadCeiling(), authority, "base-written ceiling state stays readable");
    assert.equal(reader.currentServerTrustRevision(), `${trust.body.epoch}:${trust.body.bodyDigest}`);
    assert.equal(reader.currentPolicyRevision(), `${authority.body.version}:${authority.body.bodyDigest}:${trust.body.epoch}:${trust.body.bodyDigest}`);
    assert.deepEqual(await reader.resolveServerKey(trust.body.keys[0].keyId), new Uint8Array(Buffer.from(trust.body.keys[0].spki, "base64url")));
    assert.deepEqual(snapshot(directory), before, "compatibility read never rewrites historical state");
    const db = new DatabaseSync(paths(directory).artifactDatabasePath);
    try {
      const badTrust = { ...trust, signature: "A".repeat(86) };
      db.prepare("UPDATE server_trust_current SET bundle_json=?").run(JSON.stringify(badTrust));
      await assert.rejects(reader.loadTrustBundle(), { code: "corrupt" }, "stored owner-signature tamper remains refused");
      assert.throws(() => reader!.currentServerTrustRevision(), { code: "corrupt" });
      db.prepare("UPDATE server_trust_current SET bundle_json=?").run(JSON.stringify(trust));
      db.prepare("UPDATE node_ceiling_current SET artifact_json=?").run(JSON.stringify({ ...authority, signature: "A".repeat(86) }));
      await assert.rejects(reader.loadCeiling(), { code: "corrupt" }, "stored ceiling-signature tamper remains refused");
      assert.throws(() => reader!.currentPolicyRevision(), { code: "corrupt" });
    } finally { db.close(); }
  } finally {
    writer?.close(); reader?.close();
    await rm(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false, "historical fixture cleanup reached");
  }
}

// Workers are direct children with piped stdin; a parent exit closes the pipe.
// No worker detaches. The parent collects output on close and retires every child.
async function worker() {
  const directory = process.env.E084_DIRECTORY!;
  const mode = process.env.E084_WORKER!;
  // Arm release before publishing any readiness file. The parent may send
  // immediately; a resumed pipe with no data listener would lose that message.
  // Fault workers keep fd 0 untouched so the synchronous wait below receives
  // kernel EOF if their parent exits. A blocked event loop cannot run on("end").
  const released = mode === "fault" ? Promise.resolve() : new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  if (mode !== "fault") {
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  }
  if (mode === "held") {
    const db = new DatabaseSync(paths(directory).highWaterDatabasePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      await writeFile(join(directory, "held"), "locked");
      await released;
      db.exec("ROLLBACK");
    } finally { db.close(); }
  } else {
    const repo = open(directory, 4, point => {
      if (point === process.env.E084_FAULT) {
        writeFileSync(join(directory, "fault"), point);
        // Remain at this point until SIGKILL, or exit on parent-pipe EOF.
        readFileSync(0);
        process.exit(0);
      }
    });
    try {
      if (mode === "contend" || mode === "update") {
        await writeFile(join(directory, `ready-${process.env.E084_INDEX}`), "ready");
        await released;
      }
      if (mode === "update") {
        const first = bundle();
        const keys = Number(process.env.E084_INDEX!.slice(2)) % 2 === 0 ? first.body.keys :
          [{ ...first.body.keys[0], keyId: "server-key:extra", spki: spki(pair(5).publicKey) }, first.body.keys[0]];
        await repo.applyOwnerSignedBundle(bundle(76641, 4, { epoch: 2, keys }));
        console.log(JSON.stringify({ result: "applied" }));
      } else {
        const result = process.env.E084_KIND === "ceiling" ? await repo.provisionInitialCeiling(ceiling()) : await repo.provisionInitialTrustBundle(bundle());
        console.log(JSON.stringify({ result }));
      }
    } catch (error) { console.log(JSON.stringify({ error: (error as { code?: string }).code ?? "unknown" })); }
    finally { repo.close(); }
  }
  process.stdin.pause();
  process.exit(0);
}
function child(directory: string, mode: string, extra: Record<string, string> = {}) {
  const processChild = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    env: { ...process.env, E084_DIRECTORY: directory, E084_WORKER: mode, ...extra }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  processChild.stdout.on("data", data => { stdout += data; });
  processChild.stderr.on("data", data => { stderr += data; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { processChild, closed };
}
async function retire(children: ChildProcess[]) {
  for (const processChild of children) if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL");
  await Promise.all(children.map(processChild => processChild.exitCode !== null || processChild.signalCode !== null ? Promise.resolve() : new Promise(resolve => processChild.once("close", resolve))));
}
async function observed(path: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, "observable worker barrier deadline");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

if (process.env.E084_WORKER) {
  await worker();
} else {
  test("public SPKI provision/read", async () => fixture(async repo => {
    const artifact = bundle(76640);
    assert.equal(artifact.body.keys[0].spki, collisionSpki);
    assert.deepEqual(containsSecretMaterial(artifact), ["$.body.keys[0].spki"]);
    assertIndependentSignature(artifact);
    const proof = Buffer.from("independent Ed25519 public/private round trip");
    assert.equal(verify(null, proof, pair(76640).publicKey, sign(null, proof, pair(76640).privateKey)), true);
    await roundTrip(repo, artifact);
  }));
  test("public bundle-signature provision/read", async () => fixture(async repo => {
    const artifact = bundle(76641, 40771);
    assert.equal(artifact.signature, collisionBundleSignature);
    assert.deepEqual(containsSecretMaterial(artifact), ["$.signature"]);
    assertIndependentSignature(artifact, 40771);
    await roundTrip(repo, artifact);
  }, 40771));
  test("public ceiling-signature provision/read", async () => fixture(async repo => {
    const artifact = ceiling(18118);
    assert.equal(artifact.signature, collisionCeilingSignature);
    assert.deepEqual(containsSecretMaterial(artifact), ["$.signature"]);
    assertIndependentSignature(artifact, 18118);
    assert.equal(await repo.provisionInitialCeiling(artifact), "provisioned");
    assert.deepEqual(await repo.loadCeiling(), artifact);
    await roundTrip(repo, bundle(76641, 18118));
    assert.equal(repo.currentPolicyRevision(), `1:${artifact.body.bodyDigest}:${repo.currentServerTrustRevision()}`);
  }, 18118));
  test("shrink-signature authorized transition", async () => fixture(async (repo, directory) => {
    const first = bundle(); await roundTrip(repo, first);
    const keys = [{ ...first.body.keys[0], state: "retired" as const }, { ...first.body.keys[0], keyId: "server-key:two", spki: spki(pair(5).publicKey) }];
    const next = bundle(76641, 4, { epoch: 2, keys });
    await refusesUnchanged(repo, directory, () => repo.applyOwnerSignedBundle(next));
    const authorized = shrink(next, 10764);
    assert.equal(authorized.shrinkAuthorization.signature, "SK-foUa6UeE-k_21H9AlHWUm9U3a3Rc5finWabi6qfu07h69frre4J3cA2H1ygWYC6kPTI1_Q6hzwIRm4ATqCQ");
    assert.ok(containsSecretMaterial(authorized).includes("$.shrinkAuthorization.signature"));
    assert.equal(verify(null, Buffer.from(canonical({ schema: "control-room.trust-bundle-shrink-authorization/v1", keyId: "owner-key:test", bundleBodyDigest: next.body.bodyDigest })), pair(10764).publicKey, Buffer.from(authorized.shrinkAuthorization.signature, "base64url")), true);
    await repo.applyOwnerSignedBundle(authorized);
    assert.deepEqual(await repo.loadTrustBundle(), authorized);
    assert.equal(await repo.resolveServerKey("server-key:test"), undefined);
    for (const state of ["active", "revoked"] as const) {
      const revival = bundle(76641, 4, { epoch: 3, keys: [{ ...keys[0], state }, keys[1]] });
      if (state === "active") await refusesUnchanged(repo, directory, () => repo.applyOwnerSignedBundle(revival));
      else {
        await repo.applyOwnerSignedBundle(revival);
        await refusesUnchanged(repo, directory, () => repo.applyOwnerSignedBundle(bundle(76641, 4, { epoch: 4, keys: [{ ...keys[0], state: "retired" }, keys[1]] })));
      }
    }
    await refusesUnchanged(repo, directory, () => repo.applyOwnerSignedBundle(bundle(76641, 4, { epoch: 4, keys: [keys[1]] })));
    await refusesUnchanged(repo, directory, () => repo.applyOwnerSignedBundle(bundle(76641, 4, { epoch: 4, keys: [{ ...keys[0], keyId: "server-key:renamed", state: "revoked" }, keys[1]] })));
  }, 4, 10764));

  test("base-written public aliases stay readable", async () => {
    const first = bundle();
    const aliasKey = bundle(76641, 4, { keys: [{ ...first.body.keys[0], spki: alias(first.body.keys[0].spki) }] });
    assert.deepEqual(Buffer.from(aliasKey.body.keys[0].spki, "base64url"), Buffer.from(first.body.keys[0].spki, "base64url"));
    for (const [trust, authority] of [
      [aliasKey, ceiling()],
      [{ ...first, signature: alias(first.signature) }, ceiling()],
      [first, { ...ceiling(), signature: alias(ceiling().signature) }],
    ] as const) await legacyState(trust, authority);
  });
  test("base-written optional shrink stays readable", async () => {
    const valid = shrink(bundle());
    for (const trust of [
      shrink(bundle(), 5),
      shrink(bundle(), 4, "owner-key:unknown"),
      { ...valid, shrinkAuthorization: { ...valid.shrinkAuthorization, signature: alias(valid.shrinkAuthorization.signature) } },
    ]) await legacyState(trust, ceiling());
  });
  test("stored trust survives shrink-pin rotation", async () => fixture(async (repo, directory) => {
    const trust = shrink(bundle());
    await roundTrip(repo, trust);
    await repo.provisionInitialCeiling(ceiling());
    const before = snapshot(directory);
    const rotated = open(directory, 4, undefined, 5);
    try {
      assert.deepEqual(await rotated.loadTrustBundle(), trust, "previously accepted trust survives changed shrink pin");
      assert.equal(rotated.currentServerTrustRevision(), `1:${trust.body.bodyDigest}`);
      assert.equal(rotated.currentPolicyRevision(), `1:${ceiling().body.bodyDigest}:1:${trust.body.bodyDigest}`);
      const next = shrink(bundle(76641, 4, { epoch: 2 }));
      await refusesUnchanged(rotated, directory, () => rotated.applyOwnerSignedBundle(next));
      await rotated.applyOwnerSignedBundle(shrink(bundle(76641, 4, { epoch: 2 }), 5));
      assert.equal((await rotated.loadTrustBundle()).body.epoch, 2);
    } finally { rotated.close(); }
    assert.equal(before[1].length, 1, "original complete trust state exists before rotation");
  }));
  test("shrink metadata secret refusal", async () => {
    const token = "sk-0123456789abcdefghijklmnop"; // Labelled synthetic metadata.
    const tokenPin = { ...pin(), keyId: token };
    const owner = pin();
    const configured = new PinnedOwnerTrust({ ceilingProvisioningKey: owner, serverTrustRootKey: owner, trustShrinkKeys: [tokenPin] });
    for (const replace of [false, true]) await fixture(async (unused, directory) => {
      const repo = new SqliteNodeSecurityStateRepository(paths(directory), binding, configured, { now: () => at });
      try {
        if (replace) await roundTrip(repo, bundle());
        const candidate = shrink(bundle(76641, 4, { epoch: replace ? 2 : 1 }), 4, token);
        assert.equal(ownerSignedTrustBundleSchema.safeParse(candidate).success, true);
        assertIndependentSignature(candidate);
        assert.equal(verify(null, Buffer.from(canonical({ schema: "control-room.trust-bundle-shrink-authorization/v1", keyId: token, bundleBodyDigest: candidate.body.bodyDigest })), root.publicKey, Buffer.from(candidate.shrinkAuthorization.signature, "base64url")), true, "secret-shaped shrink keyId has valid pinned authorization");
        assert.ok(containsSecretMaterial(candidate).includes("$.shrinkAuthorization.keyId"));
        await refusesUnchanged(repo, directory, () => replace ? repo.applyOwnerSignedBundle(candidate) : repo.provisionInitialTrustBundle(candidate));
      } finally { repo.close(); }
    });
  });

  test("generated-key property", async () => {
    let completed = 0;
    try {
      for (const counter of [...Array.from({ length: 1024 }, (_, index) => 1000 + index), 76640]) {
        const artifact = bundle(counter);
        assertIndependentSignature(artifact);
        const der = Buffer.from(artifact.body.keys[0].spki, "base64url"), publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
        assert.equal(publicKey.asymmetricKeyType, "ed25519");
        assert.deepEqual(publicKey.export({ format: "der", type: "spki" }), der);
        await fixture(async repo => roundTrip(repo, artifact));
        completed++;
      }
    } finally {
      console.log(`completed key round trips=${completed}; seed=synthetic-public-collision:1000..2023,76640`);
    }
    assert.equal(completed, 1025, "completed deterministic key round trips");
    for (const count of [0, 1, 64, 65]) await fixture(async (repo, directory) => {
      const keys = Array.from({ length: count }, (_, index) => ({ keyId: `server-key:${String(index).padStart(3, "0")}`, algorithm: "ed25519" as const, state: "active" as const, spki: spki(pair(index + 2000).publicKey) }));
      const artifact = bundle(76641, 4, { keys });
      if (count === 0 || count === 65) await refusesUnchanged(repo, directory, () => repo.provisionInitialTrustBundle(artifact));
      else await roundTrip(repo, artifact);
    });
  });
  // These are labelled synthetic token-shaped inputs, not usable secrets.
  const tokens = ["sk-0123456789abcdefghijklmnop", "sk-ant-0123456789abcdefghijklmnop", "ghp_0123456789abcdefghijklmnop", "github_pat_0123456789abcdefghijklmnop", "xoxb-0123456789abcdefghijklmnop", "npm_0123456789abcdefghijklmnop", "AKIA0123456789ABCDEF", "api_key:synthetic123456789012345", "eyJsynthetic123456.abcdefghijklmno.abcdefghijklmn"];
  for (const replace of [false, true]) {
    test(replace ? "bundle replacement secret refusal" : "bundle provision secret refusal", async () => fixture(async (repo, directory) => {
      const first = bundle(); if (replace) await roundTrip(repo, first);
      for (const token of tokens) {
        const candidate = bundle(76641, 4, { epoch: replace ? 2 : 1,
          keys: replace ? [first.body.keys[0], { ...first.body.keys[0], keyId: `z:${token}`, spki: spki(pair(5).publicKey) }] : [{ ...first.body.keys[0], keyId: token }] });
        assert.equal(ownerSignedTrustBundleSchema.safeParse(candidate).success, true, "schema-valid synthetic secret metadata control");
        assertIndependentSignature(candidate);
        assert.ok(containsSecretMaterial(candidate).some(path => path.endsWith(".keyId")), "metadata scanner reached");
        const before = snapshot(directory);
        await assert.rejects(replace ? repo.applyOwnerSignedBundle(candidate) : repo.provisionInitialTrustBundle(candidate), { code: "invalid_bundle" });
        assert.deepEqual(snapshot(directory), before, "bundle metadata refusal leaves state unchanged");
      }
    }));
    test(replace ? "ceiling replacement secret refusal" : "ceiling provision secret refusal", async () => fixture(async (repo, directory) => {
      if (replace) await repo.provisionInitialCeiling(ceiling());
      const textTokens = [...tokens, "Bearer synthetic123456789012345", "api_key=synthetic123456789012345", "eyJsynthetic123456.abcdefghijklmno.abcdefghijklmn", "-----BEGIN PRIVATE KEY-----"];
      for (const token of textTokens) {
        const candidate = ceiling(4, { version: replace ? 2 : 1, filesystemRoots: [`/synthetic/${token}`] });
        assert.equal(signedNodeAuthorityCeilingSchema.safeParse(candidate).success, true, "schema-valid synthetic secret metadata control");
        assertIndependentSignature(candidate);
        assert.ok(containsSecretMaterial(candidate).some(path => path.includes("filesystemRoots")), "metadata scanner reached");
        const before = snapshot(directory);
        await assert.rejects(replace ? repo.adoptCeiling(candidate) : repo.provisionInitialCeiling(candidate), { code: "invalid_bundle" });
        assert.deepEqual(snapshot(directory), before, "ceiling metadata refusal leaves state unchanged");
      }
    }));
  }
  test("malformed/noncanonical/wrong-algorithm SPKI", async () => {
    const privateDer = root.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
    const publicSpki = spki(pair(76641).publicKey);
    const values = [Buffer.alloc(44).toString("base64url"), privateDer, spki(generateKeyPairSync("x25519").publicKey), alias(publicSpki), Buffer.concat([Buffer.from(publicSpki, "base64url"), Buffer.from([0])]).toString("base64url")];
    assert.deepEqual(Buffer.from(alias(publicSpki), "base64url"), Buffer.from(publicSpki, "base64url"), "padding-bit alias decodes to same public DER");
    for (const value of values) await fixture(async (repo, directory) => {
      const artifact = bundle(76641, 4, { keys: [{ ...bundle().body.keys[0], spki: value }] });
      assert.equal(ownerSignedTrustBundleSchema.safeParse(artifact).success, true);
      await refusesUnchanged(repo, directory, () => repo.provisionInitialTrustBundle(artifact));
    });
  });
  test("malformed/noncanonical/tampered signature", async () => {
    for (const kind of ["bundle", "ceiling"] as const) await fixture(async (repo, directory) => {
      const good = kind === "bundle" ? bundle() : ceiling();
      const noncanonical = alias(good.signature);
      assert.equal(verify(null, Buffer.from(canonical(good.body)), root.publicKey, Buffer.from(noncanonical, "base64url")), true, "canonicality vector independently verifies");
      assert.equal(verify(null, Buffer.from(canonical(good.body)), root.publicKey, Buffer.from(good.signature, "base64url").subarray(0, 63)), false, "Node enforces Ed25519 signature length");
      for (const signature of [noncanonical, "A".repeat(86), Buffer.from(good.signature, "base64url").subarray(0, 63).toString("base64url"), root.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")]) {
        const bad = { ...good, signature };
        await refusesUnchanged(repo, directory, () => kind === "bundle" ? repo.provisionInitialTrustBundle(bad as OwnerSignedTrustBundleV1) : repo.provisionInitialCeiling(bad as SignedNodeAuthorityCeilingV1));
      }
    });
  });
  test("unknown-pin/foreign-binding/strict-extra-field refusal", async () => fixture(async (repo, directory) => {
    const bundles = [bundle(76641, 4, { tenantId: "tenant:foreign" }), bundle(76641, 4, { nodeClass: "foreign-compute" }), bundle(76641, 4, { ownerRootKeyId: "owner-key:unknown" }), { ...bundle(), extra: "public" }, { ...bundle(), privateKey: "synthetic" }, { ...bundle(), body: { ...bundle().body, bodyDigest: "sha256:" + "0".repeat(64) } }];
    for (const candidate of bundles) await refusesUnchanged(repo, directory, () => repo.provisionInitialTrustBundle(candidate));
    for (const candidate of [ceiling(4, { tenantId: "tenant:foreign" }), ceiling(4, { nodeId: "node:foreign" }), ceiling(4, { issuerKeyId: "owner-key:unknown" }), { ...ceiling(), extra: "public" }]) await refusesUnchanged(repo, directory, () => repo.provisionInitialCeiling(candidate));
    await repo.provisionInitialTrustBundle(bundle()); await repo.provisionInitialCeiling(ceiling());
    const db = new DatabaseSync(paths(directory).artifactDatabasePath);
    try {
      const bad = bundle(76641, 4, { tenantId: "tenant:foreign" });
      db.prepare("UPDATE server_trust_current SET bundle_json=?").run(JSON.stringify(bad));
      await assert.rejects(repo.loadTrustBundle(), { code: "corrupt" });
      assert.throws(() => repo.currentServerTrustRevision(), { code: "corrupt" });
      db.prepare("UPDATE server_trust_current SET bundle_json=?").run(JSON.stringify(bundle()));
      db.prepare("UPDATE node_ceiling_current SET artifact_json=?").run(JSON.stringify(ceiling(4, { nodeId: "node:foreign" })));
      await assert.rejects(repo.loadCeiling(), { code: "corrupt" });
    } finally { db.close(); }
  }));
  test("invalid optional shrink refusal", async () => {
    for (const replace of [false, true]) await fixture(async (repo, directory) => {
      if (replace) await roundTrip(repo, bundle());
      const next = bundle(76641, 4, { epoch: replace ? 2 : 1 });
      const valid = shrink(next);
      for (const candidate of [shrink(next, 4, "owner-key:unknown"), shrink(next, 5), { ...valid, shrinkAuthorization: { ...valid.shrinkAuthorization, signature: alias(valid.shrinkAuthorization.signature) } }, { ...valid, shrinkAuthorization: { ...valid.shrinkAuthorization, bundleBodyDigest: "sha256:" + "0".repeat(64) } }]) {
        await refusesUnchanged(repo, directory, () => replace ? repo.applyOwnerSignedBundle(candidate) : repo.provisionInitialTrustBundle(candidate));
      }
      if (replace) await repo.applyOwnerSignedBundle(valid); else await roundTrip(repo, valid);
      const db = new DatabaseSync(paths(directory).artifactDatabasePath);
      try {
        const invalid = { ...next, signature: "A".repeat(86) };
        db.prepare("UPDATE server_trust_current SET bundle_json=?").run(JSON.stringify(invalid));
        await assert.rejects(repo.loadTrustBundle(), { code: "corrupt" }, "stored owner signature remains authenticated");
      } finally { db.close(); }
    });
  });
  test("no-prepare-on-refusal/retry", async () => {
    for (const kind of ["bundle", "ceiling"] as const) for (const replace of [false, true]) await fixture(async (repo, directory) => {
      if (replace) { if (kind === "bundle") await roundTrip(repo, bundle()); else await repo.provisionInitialCeiling(ceiling()); }
      const good = kind === "bundle" ? bundle(76641, 4, { epoch: replace ? 2 : 1 }) : ceiling(4, { version: replace ? 2 : 1 });
      const bad = kind === "bundle" ? bundle(76641, 4, { epoch: replace ? 2 : 1, keys: replace ? [bundle().body.keys[0], { ...bundle().body.keys[0], keyId: "z:sk-0123456789abcdefghijklmnop", spki: spki(pair(5).publicKey) }] : [{ ...bundle().body.keys[0], keyId: "sk-0123456789abcdefghijklmnop" }] }) : ceiling(4, { version: replace ? 2 : 1, projectIds: ["sk-0123456789abcdefghijklmnop"] });
      const adopt = (artifact: typeof good) => kind === "bundle" ? replace ? repo.applyOwnerSignedBundle(artifact as OwnerSignedTrustBundleV1) : repo.provisionInitialTrustBundle(artifact as OwnerSignedTrustBundleV1) : replace ? repo.adoptCeiling(artifact as SignedNodeAuthorityCeilingV1) : repo.provisionInitialCeiling(artifact as SignedNodeAuthorityCeilingV1);
      for (let retry = 0; retry < 2; retry++) await refusesUnchanged(repo, directory, () => adopt(bad));
      await adopt(good);
      assert.deepEqual(kind === "bundle" ? await repo.loadTrustBundle() : await repo.loadCeiling(), good);
    });
  });
  test("crash-and-recovery", { timeout: 180_000 }, async () => {
    for (const kind of ["trust", "ceiling"] as const) for (const phase of ["prepare", "artifact", "commit"] as const) await fixture(async (repo, directory) => {
      const processChild = child(directory, "fault", { E084_KIND: kind === "trust" ? "bundle" : "ceiling", E084_FAULT: `${kind}_after_${phase}` });
      try {
        await observed(join(directory, "fault"));
        processChild.processChild.kill("SIGKILL");
        const closed = await processChild.closed;
        assert.equal(closed.signal, "SIGKILL");
        const recovery = open(directory);
        try {
          const artifact = kind === "trust" ? bundle() : ceiling();
          const outcome = kind === "trust" ? await recovery.provisionInitialTrustBundle(artifact as OwnerSignedTrustBundleV1) : await recovery.provisionInitialCeiling(artifact as SignedNodeAuthorityCeilingV1);
          assert.equal(outcome, phase === "commit" ? "duplicate" : "recovered");
          assert.deepEqual(kind === "trust" ? await recovery.loadTrustBundle() : await recovery.loadCeiling(), artifact);
          assert.equal(kind === "trust" ? await recovery.provisionInitialTrustBundle(artifact as OwnerSignedTrustBundleV1) : await recovery.provisionInitialCeiling(artifact as SignedNodeAuthorityCeilingV1), "duplicate");
          console.log(`recovered ${kind}_after_${phase}; cleanup reached`);
        } finally { recovery.close(); }
      } finally { await retire([processChild.processChild]); }
    });
  });
  test("cross-process contention/load", { timeout: 240_000 }, async () => fixture(async (repo, directory) => {
    const children = Array.from({ length: 40 }, (_, index) => child(directory, "contend", { E084_INDEX: String(index) }));
    try {
      await Promise.all(children.map((_, index) => observed(join(directory, `ready-${index}`))));
      for (const contender of children) contender.processChild.stdin.write("go");
      const results = await Promise.all(children.map(contender => contender.closed));
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      const outcomes = results.map(result => JSON.parse(result.stdout.trim()));
      console.log(`initial provision outcomes=${JSON.stringify(outcomes)}`);
      assert.equal(outcomes.filter(outcome => outcome.result === "provisioned" || outcome.result === "recovered").length, 1, "exactly one successful provision or recovery winner");
      for (const outcome of outcomes) assert.ok(["provisioned", "duplicate", "recovered"].includes(outcome.result) || ["corrupt", "rollback_detected", "invalid_configuration"].includes(outcome.error), `explicit contender outcome ${JSON.stringify(outcome)}`);
      assert.deepEqual(await repo.loadTrustBundle(), bundle());
      assert.equal(await repo.provisionInitialTrustBundle(bundle()), "duplicate");
      const counts: Record<string, number> = {}; for (const outcome of outcomes) { const name = outcome.result ?? outcome.error; counts[name] = (counts[name] ?? 0) + 1; }
      console.log(`40-process barrier outcomes=${JSON.stringify(counts)}; SQLite storage refusals include busy/PK, not separately exposed by product`);
    } finally { await retire(children.map(contender => contender.processChild)); }
    const updates = Array.from({ length: 40 }, (_, index) => child(directory, "update", { E084_INDEX: `u-${index}` }));
    try {
      await Promise.all(updates.map((_, index) => observed(join(directory, `ready-u-${index}`))));
      for (const contender of updates) contender.processChild.stdin.write("go");
      const results = await Promise.all(updates.map(contender => contender.closed));
      const counts: Record<string, number> = {};
      for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
        const outcome = JSON.parse(result.stdout.trim());
        assert.ok(outcome.result === "applied" || ["corrupt", "rollback_detected", "recovery_required", "invalid_bundle"].includes(outcome.error), `explicit update outcome ${JSON.stringify(outcome)}`);
        const name = outcome.result ?? outcome.error; counts[name] = (counts[name] ?? 0) + 1;
      }
      assert.ok(counts.applied > 0, "an update contender reached the winning branch");
      const current = await repo.loadTrustBundle();
      assert.equal(current.body.epoch, 2);
      const first = bundle();
      const alternatives = [bundle(76641, 4, { epoch: 2 }), bundle(76641, 4, { epoch: 2, keys: [{ ...first.body.keys[0], keyId: "server-key:extra", spki: spki(pair(5).publicKey) }, first.body.keys[0]] })];
      assert.ok(alternatives.some(artifact => canonical(artifact) === canonical(current)), "COMPLETE artifact is exactly one independent contender");
      assert.equal(repo.currentServerTrustRevision(), `2:${current.body.bodyDigest}`);
      console.log(`40-process overlapping/contradictory update outcomes=${JSON.stringify(counts)}; COMPLETE history verified by real reader`);
    } finally { await retire(updates.map(contender => contender.processChild)); }
    const retryArtifact = bundle(76641, 4, { epoch: 3, keys: (await repo.loadTrustBundle()).body.keys });
    const held = child(directory, "held");
    try {
      await observed(join(directory, "held"));
      const before = snapshot(directory), started = Date.now();
      await assert.rejects(repo.applyOwnerSignedBundle(retryArtifact), { code: "corrupt" });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 4500 && elapsed < 30_000, `measured 5000ms busy timeout: ${elapsed}ms`);
      assert.deepEqual(snapshot(directory), before);
      held.processChild.stdin.write("release");
      assert.equal((await held.closed).code, 0);
      await repo.applyOwnerSignedBundle(retryArtifact);
      assert.equal(await repo.currentEpoch(), 3);
      console.log(`held write timeout=${elapsed}ms; released connection; valid retry recovered`);
    } finally { await retire([held.processChild]); }
  }));
}
