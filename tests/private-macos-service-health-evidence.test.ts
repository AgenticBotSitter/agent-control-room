import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPrivateMacosServiceHealthEvidenceVerifierV1,
  PRIVATE_MACOS_SERVICE_HEALTH_RESPONSE_V1 } from "../src/installer/v1/private-macos-service-health-evidence";
import { hmacSha256Tag, sha256Digest } from "../src/security/digest";

const digest = (value: unknown) => sha256Digest(value);
const key = new Uint8Array(32).fill(41);

function binding() {
  const ownerUid = 501;
  return { installationId: "install-local", installationPlanDigest: digest("plan"), installationPlanRevision: 8,
    ownerUid, ownerIdentityDigest: digest("owner"), publisher: "root" as const, publisherUid: 0,
    launchctlDomain: `gui/${ownerUid}`, launchctlTarget: `gui/${ownerUid}/xyz.agentcontrolroom.local`,
    serviceLabel: "xyz.agentcontrolroom.local", serviceIdentityDigest: digest("service"), releaseDigest: digest("release"),
    configurationDigest: digest("configuration"), serviceInstanceDigest: digest("instance"),
    databaseAuthorityDigest: digest("database"), protectedDataBindingDigest: digest("protected-data"),
    supervisorReadinessDigest: digest("supervisor"), readinessDigest: digest("readiness") };
}

function verifier() {
  return createPrivateMacosServiceHealthEvidenceVerifierV1({ binding: binding(), installationPrivateKey: key });
}

function response(challenge: ReturnType<ReturnType<typeof verifier>["issueChallenge"]>, changes: Record<string, unknown> = {}) {
  const unsigned = { schema: PRIVATE_MACOS_SERVICE_HEALTH_RESPONSE_V1, ...binding(), challengeDigest: challenge.challengeDigest,
    nonce: challenge.nonce, issuedAtUnixMs: challenge.issuedAtUnixMs, expiresAtUnixMs: challenge.expiresAtUnixMs,
    observedAtUnixMs: Date.now(), healthState: "healthy" as const, healthObservationDigest: digest("health"), ...changes };
  return { ...unsigned, authTag: hmacSha256Tag(key, { purpose: "private-macos-service-health-response-auth/v1", response: unsigned }) };
}

function challengeFor(v: ReturnType<typeof verifier>) {
  const now = Date.now();
  return v.issueChallenge({ issuedAtUnixMs: now, expiresAtUnixMs: now + 30_000 });
}

test("is inert at construction and returns only fresh, redacted journal-eligible health evidence", () => {
  const v = verifier();
  assert.deepEqual(JSON.stringify(v), "{}");
  const challenge = challengeFor(v), signed = response(challenge);
  const evidence = v.verifyResponse(challenge, signed);
  assert.equal(evidence.freshAuthenticatedHealth, true);
  assert.equal(evidence.eligibleForJournalSuccess, true);
  assert.equal(evidence.createsJournalRecord, false);
  assert.equal(evidence.startsService, false);
  assert.equal(evidence.grantsAgentReadiness, false);
  assert.equal("installationPrivateKey" in evidence, false);
  assert.doesNotMatch(JSON.stringify(evidence), /41,41,41|private.?key|secret/i);
  assert.deepEqual(v.verifyResponse({ ...challenge }, { ...signed }), evidence);
  v.close();
  assert.throws(() => v.verifyResponse(challenge, signed), /_refused/u);
  assert.throws(() => v.issueChallenge({ issuedAtUnixMs: Date.now(), expiresAtUnixMs: Date.now() + 1_000 }), /_refused/u);
  assert.doesNotThrow(() => v.close());
});

test("requires a fresh fixed launchctl target and a valid trusted owner or root publisher", () => {
  const now = Date.now();
  for (const changed of [
    { ...binding(), launchctlTarget: "gui/501/xyz.agentcontrolroom.other" },
    { ...binding(), launchctlDomain: "system" },
    { ...binding(), publisher: "owner" as const, publisherUid: 0 },
    { ...binding(), publisher: "root" as const, publisherUid: 501 },
    { ...binding(), ownerUid: 0 },
  ]) assert.throws(() => createPrivateMacosServiceHealthEvidenceVerifierV1({ binding: changed, installationPrivateKey: key }), /_refused/u);
  const v = verifier();
  assert.throws(() => v.issueChallenge({ issuedAtUnixMs: now - 120_001, expiresAtUnixMs: now + 1 }), /_refused/u);
  assert.throws(() => v.issueChallenge({ nonce: "caller-chosen", issuedAtUnixMs: now, expiresAtUnixMs: now + 1 }), /_refused/u);
});

test("refuses forged, stale, foreign, substituted, and non-healthy replies", () => {
  const cases: Array<Record<string, unknown>> = [
    { installationId: "install-other" }, { serviceInstanceDigest: digest("other-instance") },
    { releaseDigest: digest("other-release") }, { configurationDigest: digest("other-configuration") },
    { databaseAuthorityDigest: digest("other-database") }, { healthState: "unhealthy" },
  ];
  for (const changes of cases) {
    const v = verifier(), challenge = challengeFor(v), altered = response(challenge, changes);
    assert.throws(() => v.verifyResponse(challenge, altered), /_refused/u);
  }
  {
    const v = verifier(), challenge = challengeFor(v), forged = response(challenge);
    forged.authTag = `hmac-sha256:${"0".repeat(64)}`;
    assert.throws(() => v.verifyResponse(challenge, forged), /_refused/u);
  }
  {
    const v = verifier(), challenge = challengeFor(v);
    assert.throws(() => v.verifyResponse(challenge,
      response(challenge, { observedAtUnixMs: challenge.issuedAtUnixMs - 1 })), /_refused/u);
  }
});

test("permits only the exact signed response replay for the issued challenge", () => {
  const v = verifier(), challenge = challengeFor(v), first = response(challenge);
  v.verifyResponse(challenge, first);
  const changed = response(challenge, { healthObservationDigest: digest("new-health") });
  assert.throws(() => v.verifyResponse(challenge, changed), /_refused/u);
  assert.throws(() => v.issueChallenge({ issuedAtUnixMs: Date.now(), expiresAtUnixMs: Date.now() + 30_000 }), /_refused/u);
});

test("rejects accessors, non-ordinary prototypes, and extra fields without returning private material", () => {
  const badBinding = Object.create({ installationId: "install-local" });
  assert.throws(() => createPrivateMacosServiceHealthEvidenceVerifierV1({ binding: badBinding, installationPrivateKey: key }), /_refused/u);
  const v = verifier(), challenge = challengeFor(v), signed = response(challenge);
  const accessor = { ...signed };
  Object.defineProperty(accessor, "releaseDigest", { enumerable: true, get: () => digest("release") });
  for (const changed of [
    { ...signed, extra: "no" }, accessor,
    Object.assign(Object.create(null), signed),
    { ...challenge, extra: "no" },
  ]) assert.throws(() => v.verifyResponse(changed === accessor || "authTag" in changed ? challenge : changed, changed === accessor || "authTag" in changed ? changed : signed), /_refused/u);
});

test("bounds every refusal to one redacted error shape", () => {
  const secret = "private-health-key-must-not-escape";
  for (const operation of [
    () => createPrivateMacosServiceHealthEvidenceVerifierV1({ binding: binding(), installationPrivateKey: secret }),
    () => { const v = verifier(), challenge = challengeFor(v); return v.verifyResponse(challenge, { secret, authTag: secret }); },
  ]) assert.throws(operation, error => {
    assert.equal((error as Error).message, "private_macos_service_health_evidence_refused");
    assert.equal((error as Error).stack, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private-health-key-must-not-escape/u);
    return true;
  });
});

test("copies the injected key, supports explicit erasure, and imports no effect implementation", async () => {
  const supplied = new Uint8Array(key), v = createPrivateMacosServiceHealthEvidenceVerifierV1({ binding: binding(), installationPrivateKey: supplied });
  supplied.fill(0);
  const challenge = challengeFor(v);
  assert.equal(v.verifyResponse(challenge, response(challenge)).freshAuthenticatedHealth, true);
  v.close();
  assert.throws(() => v.verifyResponse(challenge, response(challenge)), /_refused/u);
  const source = await readFile(new URL("../src/installer/v1/private-macos-service-health-evidence.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gmu)].map(match => match[1]).sort();
  assert.deepEqual(imports, ["../../security/digest", "../../security/host-value", "node:crypto"]);
  for (const forbidden of ["node:child_process", "node:fs", "node:path", "launchctl ", "exec(", "spawn(",
    "process.env", "console.", "setInterval("]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("close erases the copied key without consulting a replaced Uint8Array fill method", () => {
  const original = Uint8Array.prototype.fill;
  let leaked: Uint8Array | undefined;
  Uint8Array.prototype.fill = function (...args: Parameters<Uint8Array["fill"]>) {
    leaked = this;
    return Reflect.apply(original, this, args);
  };
  try {
    const v = verifier(), challenge = challengeFor(v), signed = response(challenge);
    v.verifyResponse(challenge, signed);
    v.close();
    assert.equal(leaked, undefined);
    assert.throws(() => v.verifyResponse(challenge, signed), /_refused/u);
  } finally { Uint8Array.prototype.fill = original; }
});
