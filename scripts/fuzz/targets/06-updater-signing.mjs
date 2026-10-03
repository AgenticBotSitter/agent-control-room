// Updater control requests, release trust/signatures (connector advertisements, key rotation and
// revocation, a signed release directory), the fleet connector manifest, the installer's
// first-owner request (setup), the installation topology plan, the passkey terminal code, and the
// owner-code body.
import { safeStringify } from "../lib/rng.mjs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseControlRequestV1 } from "../../../src/updater/v1/contracts.mjs";
import { captureReleaseTrustV1, releaseKeyIdV1, verifyConnectorReleaseAdvertisementV1, connectorReleaseSignatureMaterialV1, applyReleaseKeyRotationV1, applyReleaseKeyRevocationsV1, verifySignedReleaseV1, compareReleaseVersionsV1, RELEASE_TRUST_SCHEMA_V1, RELEASE_SUMS_SIGNATURE_SCHEMA_V1, RELEASE_KEY_ROTATION_SCHEMA_V1, RELEASE_KEY_REVOCATIONS_SCHEMA_V1 } from "../../../scripts/release-signing.mjs";
import { captureFleetConnectorReleaseManifestV1 } from "../../../src/fleet/v1/connector-release.ts";
import { parseFirstOwnerRequestV1 } from "../../../src/installer/v1/first-owner-entry.ts";
import { planInstallationTopologyV1, verifyInstallationTopologyPlanV1 } from "../../../src/harness/v1/installation-topology.ts";
import { readCodeV1 } from "../../../src/updater/v1/terminal/read-code.mjs";
import { readLocalOwnerCodeV1 } from "../../../src/web/v1/local-owner-session.ts";
import { WebAccessError } from "../../../src/web/v1/access-verifier.ts";

const keyA = generateKeyPairSync("ed25519"), keyB = generateKeyPairSync("ed25519"), keyC = generateKeyPairSync("ed25519");
const spki = k => k.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const trust = () => ({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: releaseKeyIdV1(spki(keyA)), publicKey: spki(keyA), versionFloor: "0.5.0", revokedKeyIds: [] });
const commit = "c".repeat(40);
const advertisement = () => {
  const unsigned = { version: "1.2.3", file: "connector-1.2.3.mjs", sha256: "a".repeat(64), size: 1234, builtFrom: commit, minVersion: "1.0.0", signature: "" };
  return { ...unsigned, signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), keyA.privateKey).toString("base64url") };
};
const rotation = () => {
  const unsigned = { schema: RELEASE_KEY_ROTATION_SCHEMA_V1, epoch: 2, fromKeyId: releaseKeyIdV1(spki(keyA)), toKeyId: releaseKeyIdV1(spki(keyB)), toPublicKey: spki(keyB), versionFloor: "0.6.0" };
  const material = Buffer.from(`${RELEASE_KEY_ROTATION_SCHEMA_V1}\n${unsigned.epoch}\n${unsigned.fromKeyId}\n${unsigned.toKeyId}\n${unsigned.toPublicKey}\n${unsigned.versionFloor}\n`);
  return { ...unsigned, signature: sign(null, material, keyA.privateKey).toString("base64url") };
};
const revocations = () => {
  const revoked = [releaseKeyIdV1(spki(keyC))].sort();
  const unsigned = { schema: RELEASE_KEY_REVOCATIONS_SCHEMA_V1, epoch: 2, signerKeyId: releaseKeyIdV1(spki(keyA)), revokedKeyIds: revoked };
  const material = Buffer.from(`${RELEASE_KEY_REVOCATIONS_SCHEMA_V1}\n2\n${unsigned.signerKeyId}\n${revoked.join(",")}\n`);
  return { ...unsigned, signature: sign(null, material, keyA.privateKey).toString("base64url") };
};
const manifest = () => ({ schema: "control-room.fleet-connector-release/v1", version: "1.2.3", file: "connector-1.2.3.mjs", sha256: "a".repeat(64), size: 1234, builtFrom: commit });
const firstOwner = () => ({ schema: "control-room.first-owner-request/v1", database: { host: "/Library/Application Support/Control Room/pg/socket", port: 5432, name: "control_room", user: "postgres" },
  owner: { tenantId: "tenant:1", workspaceId: "workspace:1", provider: "local-owner", subject: "owner", nodeBase: "node:mac", workers: { hermes: "worker:h", claude: "worker:c", codex: "worker:x" }, workIntakeProjectIds: ["project:a"] },
  createdAt: "2026-10-02T09:00:00.000Z", reviewKey: Buffer.alloc(32, 7).toString("base64url") });
const route = (kind, n) => ({ kind, workerId: `worker:${n}`, adapterId: "hermes-021-local", adapterRevision: "abcdef0123456789" });
const topology = () => ({ databaseAuthorityDigest: `sha256:${"1".repeat(64)}`, schedulerAuthorityDigest: `sha256:${"2".repeat(64)}`, currentRoutes: [route("local", 1)], requestedRoutes: [route("local", 1), route("remote", 2)] });
const control = () => ({ schema: "control-room.updater-control/v1", requestId: "req-1", verb: "pause", arguments: [] });

// A signed release directory on disk (scratchpad), mutated per case.
const releaseRoot = join(process.cwd(), ".qa", "fuzzfix", `release-${process.pid}`);
const sha = b => createHash("sha256").update(b).digest("hex");
function buildRelease() {
  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 }); chmodSync(releaseRoot, 0o700);
  const artifacts = [["connector-1.2.3.mjs", Buffer.from("export const x = 1;\n")], ["updater-1.2.3.mjs", Buffer.from("export const y = 2;\n")], ["web-manifest.json", Buffer.from("{}\n")]];
  for (const [file, bytes] of artifacts) writeFileSync(join(releaseRoot, file), bytes, { mode: 0o644 });
  const sums = Buffer.from(artifacts.map(([file, bytes]) => `${sha(bytes)}  ${file}\n`).join(""));
  const record = { schema: RELEASE_SUMS_SIGNATURE_SCHEMA_V1, version: "1.2.3", keyId: releaseKeyIdV1(spki(keyA)), builtFrom: commit, sumsSha256: sha(sums), signature: "" };
  record.signature = sign(null, Buffer.from(`${RELEASE_SUMS_SIGNATURE_SCHEMA_V1}\n1.2.3\n${commit}\n${record.sumsSha256}\n`), keyA.privateKey).toString("base64url");
  return { sums: sums.toString("utf8"), record, artifacts };
}
let release;
function writeRelease(sumsText, recordValue, artifactOverride) {
  writeFileSync(join(releaseRoot, "SHA256SUMS"), sumsText);
  writeFileSync(join(releaseRoot, "SHA256SUMS.sig"), typeof recordValue === "string" ? recordValue : safeStringify(recordValue) + "\n");
  if (artifactOverride) writeFileSync(join(releaseRoot, artifactOverride.file), artifactOverride.bytes);
  else for (const [file, bytes] of release.artifacts) writeFileSync(join(releaseRoot, file), bytes);
}
const fakeTerminal = line => ({ isTTY: true, write() {}, setRawMode() {}, readLine: async () => line });
const expected = e => e instanceof Error && (e.name === "ReleaseSigningRefusal" || /^updater_|^fleet_connector_release_refused|^first_owner_|^installation_topology_|^release_signing_refused/u.test(e.message) || /ZodError/u.test(e.name) || e instanceof WebAccessError);

export const targets = [
  {
    name: "updater:control-request",
    corpus: [JSON.stringify(control()), JSON.stringify({ ...control(), verb: "passkey-list", arguments: ["a", "b"] })],
    generate(rng, c) { const r = rng.float(); if (r < 0.5) return rng.mutateText(rng.pick(c), rng.int(1, 3)); if (r < 0.85) return safeStringify(rng.mutate(JSON.parse(rng.pick(c)), rng.int(1, 3))); return rng.pick([rng.nasty(9000), JSON.stringify({ ...control(), verb: rng.pick(["install", "sudo", "confirm", "owner-code", "pause "]) }), JSON.stringify({ ...control(), arguments: Array.from({ length: rng.int(0, 12) }, () => rng.nasty(300)) })]); },
    invoke(line) { return { outcome: "accepted", value: parseControlRequestV1(line) }; },
    expectedErrors: expected,
    oracle(line, result) { if (result.outcome !== "accepted") return undefined; const v = result.value; if (["install", "confirm", "owner-code", "passkey", "run-without-profiles", "serve-accept", "uninstall-fresh", "upgrade-attended"].includes(v.verb)) return `sudo-only verb ${v.verb} accepted on the control socket`; if (v.arguments.length > 8 || v.arguments.some(a => Buffer.byteLength(a) > 256)) return "argument bounds exceeded"; if (Buffer.byteLength(line) > 8192) return "oversize line accepted"; },
  },
  {
    name: "release:connector-advertisement",
    corpus: [advertisement()],
    corpusInput: ad => ({ ad, trust: trust(), floor: undefined }),
    generate(rng, c) { const r = rng.float(); if (r < 0.7) return { $label: "mutate", $input: { ad: rng.mutate(c[0], rng.int(1, 3)), trust: trust(), floor: undefined } }; if (r < 0.85) return { $label: "trust-mutate", $input: { ad: c[0], trust: rng.mutate(trust(), rng.int(1, 2)), floor: undefined } }; return { $label: "floor", $input: { ad: { ...c[0], version: rng.pick(["1.2.3", "0.4.9", "1.2.3-rc.1", "9".repeat(rng.int(1, 5000)) + ".0.0", "1.0.0", "01.2.3"]) }, trust: trust(), floor: rng.pick([undefined, "1.2.3", "1.2.4", "0.0.0", "1.2.3-rc.0", "x"]) } }; },
    invoke({ ad, trust, floor }) { return { outcome: "accepted", value: verifyConnectorReleaseAdvertisementV1(ad, trust, floor) }; },
    expectedErrors: expected,
    oracle({ ad, trust: t, floor }, result) {
      if (result.outcome !== "accepted") return undefined;
      const original = advertisement();
      for (const k of ["version", "file", "sha256", "size", "builtFrom", "minVersion"]) if (result.value[k] !== original[k]) return `accepted advertisement with changed ${k}`;
      if (result.value.signature !== original.signature) return "accepted a different signature over the same material";
      if (t.publicKey !== spki(keyA) || t.keyId !== releaseKeyIdV1(spki(keyA))) return "accepted under altered trust";
      if (floor !== undefined && compareReleaseVersionsV1(result.value.version, floor) < 0) return "accepted below the floor";
    },
  },
  {
    name: "release:key-rotation",
    corpus: [rotation()],
    corpusInput: rotation => ({ rotation, trust: trust() }),
    generate(rng, c) { return { $input: { rotation: rng.bool(0.8) ? rng.mutate(c[0], rng.int(1, 3)) : c[0], trust: rng.bool(0.8) ? trust() : rng.mutate(trust(), 1) } }; },
    invoke({ rotation, trust }) { return { outcome: "accepted", value: applyReleaseKeyRotationV1(rotation, trust) }; },
    expectedErrors: expected,
    oracle({ rotation: r, trust: t }, result) {
      if (result.outcome !== "accepted") return undefined;
      const original = rotation();
      if (r.toPublicKey !== original.toPublicKey || r.epoch !== 2 || r.fromKeyId !== original.fromKeyId) return "accepted rotation with changed material";
      if (!result.value.revokedKeyIds.includes(releaseKeyIdV1(spki(keyA)))) return "old key not revoked after rotation";
      if (compareReleaseVersionsV1(result.value.versionFloor, "0.5.0") < 0) return "floor lowered by rotation";
      if (JSON.stringify(t) !== JSON.stringify(trust())) return "accepted under altered trust";
    },
  },
  {
    name: "release:key-revocations",
    corpus: [revocations()],
    corpusInput: rev => ({ rev, trust: trust() }),
    generate(rng, c) { return { $input: { rev: rng.bool(0.85) ? rng.mutate(c[0], rng.int(1, 3)) : c[0], trust: trust() } }; },
    invoke({ rev, trust }) { return { outcome: "accepted", value: applyReleaseKeyRevocationsV1(rev, trust) }; },
    expectedErrors: expected,
    oracle({ rev }, result) { if (result.outcome !== "accepted") return undefined; const original = revocations(); if (JSON.stringify(rev.revokedKeyIds) !== JSON.stringify(original.revokedKeyIds) || rev.epoch !== 2) return "accepted revocations with changed material"; if (result.value.revokedKeyIds.includes(result.value.keyId)) return "current key revoked"; },
  },
  {
    name: "release:signed-directory",
    setup() { release = buildRelease(); },
    teardown() { rmSync(releaseRoot, { recursive: true, force: true }); },
    corpus: [{ sums: "pristine", record: "pristine" }],
    corpusInput: () => ({ sums: release.sums, record: release.record, artifact: undefined, installed: "1.0.0", builtFrom: commit, rollback: undefined }),
    generate(rng) {
      const r = rng.float();
      if (r < 0.4) return { $label: "sig-record", $input: { sums: release.sums, record: rng.mutate(release.record, rng.int(1, 3)), installed: "1.0.0", builtFrom: commit } };
      if (r < 0.6) return { $label: "sig-text", $input: { sums: release.sums, record: rng.mutateText(JSON.stringify(release.record), rng.int(1, 2)), installed: "1.0.0", builtFrom: commit } };
      if (r < 0.8) return { $label: "sums-text", $input: { sums: rng.mutateText(release.sums, rng.int(1, 2)), record: release.record, installed: "1.0.0", builtFrom: commit } };
      if (r < 0.9) { const [file] = rng.pick(release.artifacts); return { $label: "artifact", $input: { sums: release.sums, record: release.record, artifact: { file, bytes: Buffer.from(rng.nasty(40)) }, installed: "1.0.0", builtFrom: commit } }; }
      return { $label: "policy", $input: { sums: release.sums, record: release.record, installed: rng.pick(["1.0.0", "1.2.3", "1.2.4", "2.0.0", "1.2.3-rc.1"]), builtFrom: rng.bool(0.7) ? commit : "d".repeat(40), rollback: rng.pick([undefined, true, false, "true", 1]) } };
    },
    async invoke(input) {
      writeRelease(input.sums, input.record, input.artifact);
      const value = await verifySignedReleaseV1({ releaseDirectory: releaseRoot, trust: trust(), installedVersion: input.installed, expectedBuiltFrom: input.builtFrom, allowRollback: input.rollback });
      return { outcome: "accepted", value };
    },
    expectedErrors: expected,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      if (input.sums !== release.sums) return "accepted a modified SHA256SUMS";
      const recordText = typeof input.record === "string" ? input.record : JSON.stringify(input.record);
      let parsed; try { parsed = JSON.parse(recordText); } catch { return "accepted an unparseable signature record"; }
      for (const k of Object.keys(release.record)) if (parsed[k] !== release.record[k]) return `accepted a signature record with changed ${k}`;
      if (Object.keys(parsed).length !== Object.keys(release.record).length) return "accepted extra keys in signature record";
      if (input.artifact && !Buffer.from(input.artifact.bytes).equals(release.artifacts.find(([f]) => f === input.artifact.file)[1])) return "accepted a modified artifact";
      if (input.builtFrom !== commit) return "accepted wrong builtFrom";
      if (input.rollback !== true && compareReleaseVersionsV1("1.2.3", input.installed) <= 0) return "accepted a non-upgrade without rollback authority";
      if (input.rollback !== undefined && typeof input.rollback !== "boolean") return "accepted non-boolean rollback authority";
    },
  },
  {
    name: "fleet:connector-manifest",
    corpus: [manifest()],
    generate(rng, c) { return rng.bool(0.9) ? rng.mutate(c[0], rng.int(1, 3)) : rng.jsonValue(0, 3); },
    invoke(input) { return { outcome: "accepted", value: captureFleetConnectorReleaseManifestV1(input) }; },
    expectedErrors: expected,
    oracle(input, result) { if (result.outcome !== "accepted") return undefined; const v = result.value; if (v.file !== `connector-${v.version}.mjs` || !/^\d+\.\d+\.\d+$/u.test(v.version) || v.size < 1 || v.size > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(v.sha256)) return "manifest invariant broken"; if (Object.keys(input).length !== 6) return "extra keys accepted"; },
  },
  {
    name: "installer:first-owner-request",
    corpus: [firstOwner()],
    generate(rng, c) { return rng.bool(0.9) ? rng.mutate(c[0], rng.int(1, 4)) : rng.jsonValue(0, 4); },
    invoke(input) { return { outcome: "accepted", value: parseFirstOwnerRequestV1(input) }; },
    expectedErrors: expected,
    oracle(input, result) { if (result.outcome !== "accepted") return undefined; const v = result.value; if (!v.database.host.startsWith("/") || v.database.host.includes("\0") || v.database.user !== "postgres") return "non-socket database accepted"; if (v.owner.provider !== "local-owner") return "foreign provider accepted"; if (!/^[A-Za-z0-9_-]{43}$/u.test(v.reviewKey)) return "bad review key accepted"; if (Object.getPrototypeOf(v) !== Object.prototype) return "foreign prototype"; },
  },
  {
    name: "installer:topology-plan",
    corpus: [topology()],
    corpusInput: value => ({ kind: "plan", value }),
    generate(rng, c) { const r = rng.float(); if (r < 0.6) return { $label: "plan", $input: { kind: "plan", value: rng.mutate(c[0], rng.int(1, 3)) } }; if (r < 0.7) return { $label: "many-routes", $input: { kind: "plan", value: { ...c[0], requestedRoutes: Array.from({ length: rng.int(1, 120) }, (_, i) => route(rng.pick(["local", "remote"]), rng.bool(0.1) ? 1 : i)) } } }; const plan = planInstallationTopologyV1(c[0]); return { $label: "verify", $input: { kind: "verify", value: rng.bool(0.9) ? rng.mutate(JSON.parse(JSON.stringify(plan)), rng.int(1, 3)) : plan } }; },
    invoke({ kind, value }) { return { outcome: "accepted", value: kind === "plan" ? planInstallationTopologyV1(value) : verifyInstallationTopologyPlanV1(value) }; },
    expectedErrors: expected,
    oracle({ kind, value }, result) { if (result.outcome !== "accepted") return undefined; const v = result.value; if (v.enablesWorkers !== false) return "plan enables workers"; if (kind === "verify") { const { planDigest, ...rest } = value; if (planDigest !== result.value.planDigest) return "digest changed"; const lists = [v.retainedWorkerIds, v.reboundWorkerIds, v.addedLocalWorkerIds, v.addedRemoteWorkerIds, v.removedWorkerIds]; const all = lists.flat(); if (new Set(all).size !== all.length) return "overlapping worker lists accepted"; } if (kind === "plan") { const ids = value.requestedRoutes.map(r => r.workerId); if (new Set(ids).size !== ids.length) return "ambiguous routes accepted"; } },
  },
  {
    name: "owner:codes",
    corpus: ["ABC123", '{"ownerCode":"abcdefghijklmnopqrstuvwxyz0123"}'],
    corpusInput: v => v.startsWith("{") ? { kind: "owner", body: v, contentType: "application/json" } : { kind: "passkey", line: v },
    generate(rng) { if (rng.bool(0.4)) return { $label: "passkey-code", $input: { kind: "passkey", line: rng.pick([rng.nasty(12), rng.ascii(6), " abc123 \n", "ABC12", "ABC1234", "abc123\u0003", "ÀBC123", "ABC-23", "АВС123", 123456, null, "ABC123".normalize("NFD")]) } }; return { $label: "owner-code", $input: { kind: "owner", body: rng.bool(0.5) ? rng.mutateText('{"ownerCode":"abcdefghijklmnopqrstuvwxyz0123"}', rng.int(1, 3)) : safeStringify(rng.mutate({ ownerCode: "abcdefghijklmnopqrstuvwxyz0123" }, rng.int(1, 2))), contentType: rng.pick(["application/json", "application/json; charset=utf-8", "APPLICATION/JSON", "text/json", "application/json;", "", "application/x-www-form-urlencoded", "application/json\u0000"]) } }; },
    async invoke(input) {
      if (input.kind === "passkey") return { outcome: "accepted", value: await readCodeV1(fakeTerminal(input.line)) };
      const request = new Request("http://127.0.0.1:3310/api/v1/local-owner-session", { method: "POST", headers: input.contentType ? { "content-type": input.contentType } : {}, body: input.body });
      return { outcome: "accepted", value: await readLocalOwnerCodeV1(request) };
    },
    expectedErrors: e => expected(e) || (e instanceof TypeError && /header|Headers/u.test(e.message)),
    oracle(input, result) { if (result.outcome !== "accepted") return undefined; if (input.kind === "passkey" && !/^[A-Z0-9]{6}$/u.test(result.value)) return "non-canonical passkey code accepted"; if (input.kind === "owner") { if (typeof result.value !== "string") return "non-string owner code"; const parsed = JSON.parse(input.body); if (Object.keys(parsed).length !== 1) return "extra keys accepted"; if (Buffer.byteLength(input.body) > 512) return "oversize body accepted"; } },
  },
];
