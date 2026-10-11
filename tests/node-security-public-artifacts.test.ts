import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
        const invalid = shrink(next, 5);
        db.prepare("UPDATE server_trust_current SET bundle_json=?").run(JSON.stringify(invalid));
        await assert.rejects(repo.loadTrustBundle(), { code: "corrupt" });
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
