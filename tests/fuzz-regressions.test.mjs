import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { regenerateCase, isF13ExoticCase } from "../scripts/fuzz/lib/harness.mjs";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import webpush from "web-push";
import { assertPortableInputSizeV1 } from "../src/security/inert-portable-input.ts";
import { upstreamObjectV1 } from "../src/security/upstream-object.ts";
import { hermesSessionJobStatusResponseSchemaV1, parseHermesSessionReplyV1 } from "../src/harness/hermes-gpt-v1/session-contract.ts";
import { readBoundedJson } from "../src/web/v1/http-common.ts";
import { publicStatusV1 } from "../src/updater/v1/contracts.mjs";
import { ownerPushPayloadV1 } from "../src/web-push/v1/policy.ts";
import { ideaTextSchemaV1 } from "../src/idea-lab/v1/schemas.ts";
import { compareReleaseVersionsV1, releaseKeyIdV1, captureReleaseTrustV1, connectorReleaseSignatureMaterialV1 } from "../scripts/release-signing.mjs";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process.ts";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session.ts";
import { sha256Digest } from "../src/security/index.ts";
import { targets as moduleTargets } from "../scripts/fuzz/targets/02-packs-modules.mjs";
import { targets as configTargets } from "../scripts/fuzz/targets/03-config-files.mjs";
import { targets as releaseTargets } from "../scripts/fuzz/targets/06-updater-signing.mjs";
import { target as fleetTarget } from "../scripts/fuzz/targets/07-fleet-gateway.mjs";
import { targets as voiceMcpTargets } from "../scripts/fuzz/targets/09-voice-loopback-mcp.mjs";

const target = (list, name) => list.find(t => t.name === name);
const validInput = async t => { const c = typeof t.corpus === "function" ? await t.corpus() : t.corpus; return t.corpusInput ? t.corpusInput(c[0]) : structuredClone(c[0]); };
const unsafe = (key, value = { return_code: "not-a-number", session_id: { x: 1 } }) => JSON.parse(JSON.stringify({ [key]: value }));
const upstreamFiles = ["src/harness/hermes-gpt-v1/session-contract.ts", "src/web/v1/access-verifier.ts", "src/web/v1/mac-local-remote-access.ts", "src/harness/codex-v1/completed-turn.ts", "src/harness/codex-v1/admission-contract.ts", "src/harness/codex-v1/result-sender.ts", "src/harness/claude-code-v1/terminal-result-staging.ts", "src/web/v1/hermes-021-local-executor.ts", "src/web/v1/claude-code-local-executor.ts", "src/web/v1/task-execution-planner.ts", "src/web/v1/access-key-cache.ts", "src/harness/v1/several-computer-proof-evidence.ts", "src/web/v1/hermes-021-private-installation-composition.ts"];

test("F1: all upstream passthrough sites use the guarded schema builder", () => {
  for (const file of upstreamFiles) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /upstreamObjectV1\(/, file);
    assert.doesNotMatch(source, /\.passthrough\(|\.loose\(/, file);
  }
});

test("F1: recursively reject prototype keys before copying and preserve safe future fields", () => {
  const schema = upstreamObjectV1({ value: z.number().optional() });
  for (const key of ["__proto__", "constructor", "prototype"]) {
    for (const value of [unsafe(key), { extra: [unsafe(key)] }, { value: 1, extra: unsafe(key, null) }]) assert.equal(schema.safeParse(value).success, false, key);
  }
  let deep = {}; for (let i = 0; i < 66; i++) deep = { extra: deep };
  assert.equal(schema.safeParse(deep).success, false);
  const parsed = schema.parse({ extra: { future: 1 } });
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(parsed.extra, { future: 1 });
});

test("F1: seed 20261002 Hermes prototype reproducer becomes unrecognized", () => {
  const wire = '{"success":true,"job":{"job_id":"0123456789abcdef0123456789abcdef","status":"completed","__proto__":{"return_code":"not-a-number","reconciliation":"injected","session_id":{"x":1}}}}';
  assert.equal(parseHermesSessionReplyV1(hermesSessionJobStatusResponseSchemaV1, JSON.parse(wire), "probe").outcome, "unrecognized");
});

// A worker deadline can interrupt synchronous parser work, unlike a node:test timer.
async function moduleInWorker(files) {
  const worker = new Worker(new URL("./support/fuzz-module-worker.mjs", import.meta.url), { workerData: files, execArgv: ["--import", "tsx"] });
  let timer;
  try {
    await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); timer = setTimeout(() => reject(new Error("module_worker_start_timeout")), 10000); });
    clearTimeout(timer);
    const result = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); timer = setTimeout(() => reject(new Error("markdown_exceeded_one_second")), 1000); });
    worker.postMessage("run");
    return await result;
  } finally { clearTimeout(timer); await worker.terminate(); }
}
const file = (text, path = "p.md") => ({ path, contentBase64: Buffer.from(text).toString("base64") });

test("F2: hostile markdown shapes and full-bundle work stay below one second", { timeout: 30000 }, async () => {
  const shapes = [n => "[a](".repeat(n), n => "| a |\n|---|\n" + "| ".repeat(n), n => "_".repeat(n) + "a", n => "*a*".repeat(n), n => ("- ".repeat(40) + "x\n").repeat(n), n => "[".repeat(n) + "a" + "](x)".repeat(n), n => "[a]: x\n".repeat(n) + "[a]".repeat(n)];
  for (const shape of shapes) {
    for (const n of [100, 8192, 131072, 524288]) {
      const text = shape(n).slice(0, n > 8192 ? n : 8192);
      const result = await moduleInWorker([file(text)]);
      assert.ok(result.ms < 1000, JSON.stringify(result));
      if (Buffer.byteLength(text) > 8192) assert.equal(result.error, "module_bundle_declarative_file_executable_content");
      else assert.equal(result.accepted, true, JSON.stringify(result));
    }
  }
  assert.ok((await moduleInWorker([file("[a](".repeat(2048)), file("_".repeat(8192), "q.md")])).ms < 1000);
  for (const index of [332, 617]) {
    const { input } = await regenerateCase(target(moduleTargets, "module-bundle"), 20261002, index);
    const result = await moduleInWorker(input.bundle.files);
    assert.equal(result.error, "module_bundle_declarative_file_executable_content");
    assert.ok(result.ms < 1000);
  }
  const many = Array.from({ length: 32 }, (_, i) => file("[a](".repeat(1024), `p${i}.md`));
  assert.equal((await moduleInWorker(many)).error, "module_bundle_declarative_file_executable_content");
  // An exact-size file remains usable; the next byte and multibyte UTF-8 are refused.
  assert.equal((await moduleInWorker([file("a".repeat(8192))])).accepted, true);
  assert.equal((await moduleInWorker([file("a".repeat(8193), "p.txt")])).error, "module_bundle_declarative_file_executable_content");
  assert.equal((await moduleInWorker([file("é".repeat(4097))])).error, "module_bundle_declarative_file_executable_content");
});

test("F2: bounded markdown still refuses executable links through nested AST nodes", async () => {
  for (const text of ["[a](javascript:alert)", "![a](data:text/html,abc)", "[a][ref]\n\n[ref]: vbscript:run"]) {
    assert.equal((await moduleInWorker([file(text)])).error, "module_bundle_declarative_file_executable_content");
  }
  assert.equal((await moduleInWorker([file("[a](https://example.invalid)")])).accepted, true);
});

test("F3: genuine signatures do not authorize array-typed connector fields or versions", async () => {
  const t = target(releaseTargets, "release:connector-advertisement"), input = await validInput(t);
  assert.equal(t.invoke(input).outcome, "accepted");
  for (const key of ["version", "sha256", "builtFrom", "minVersion", "signature"]) {
    assert.throws(() => t.invoke({ ...input, ad: { ...input.ad, [key]: [input.ad[key]] } }), /release_signing_refused/);
    assert.throws(() => connectorReleaseSignatureMaterialV1({ ...input.ad, [key]: [input.ad[key]] }), /release_signing_refused/);
  }
  for (const value of [["1.2.3"], null, {}, Symbol("version")]) assert.throws(() => compareReleaseVersionsV1(value, "1.2.3"), /release_signing_refused/);
});

test("F3: signed directory signature records require string fields", async () => {
  const t = target(releaseTargets, "release:signed-directory");
  await t.setup();
  try {
    const input = await validInput(t);
    assert.equal((await t.invoke(input)).outcome, "accepted");
    for (const key of ["version", "builtFrom", "sumsSha256", "signature"]) await assert.rejects(() => t.invoke({ ...input, record: { ...input.record, [key]: [input.record[key]] } }), /release_signing_refused/);
    await assert.rejects(() => t.invoke({ ...input, builtFrom: [input.builtFrom] }), /release_signing_refused/);
    assert.equal((await t.invoke(input)).outcome, "accepted");
  } finally { await t.teardown(); }
});

test("F4: public keys in trust and rotation must be canonical DER without trailing bytes", async () => {
  const { publicKey } = generateKeyPairSync("ed25519"), der = publicKey.export({ format: "der", type: "spki" });
  const spki = der.toString("base64url"), keyId = releaseKeyIdV1(spki);
  for (const tail of [Buffer.from([0]), Buffer.from("trailing")]) {
    const bad = Buffer.concat([der, tail]).toString("base64url");
    assert.throws(() => releaseKeyIdV1(bad), /release_signing_refused/);
    assert.throws(() => captureReleaseTrustV1({ schema: "control-room.release-trust/v1", epoch: 1, publicKey: bad, keyId, versionFloor: "1.0.0", revokedKeyIds: [] }), /release_signing_refused/);
  }
  const t = target(releaseTargets, "release:key-rotation"), input = await validInput(t);
  const bad = Buffer.concat([Buffer.from(input.rotation.toPublicKey, "base64url"), Buffer.from([0])]).toString("base64url");
  assert.throws(() => t.invoke({ ...input, rotation: { ...input.rotation, toPublicKey: bad } }), /release_signing_refused/);
});

const stream = text => new ReadableStream({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } });
test("F5: website refuses BOM JSON, including split bytes, and accepts ordinary JSON", async () => {
  assert.deepEqual(await readBoundedJson(stream('{"x":1}'), 100), { x: 1 });
  await assert.rejects(() => readBoundedJson(stream('\ufeff{"x":1}'), 100), /invalid_request/);
  const bytes = Buffer.from('\ufeff{"x":1}');
  await assert.rejects(() => readBoundedJson(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }), 100), /invalid_request/);
});

test("F5: fleet gateway refuses BOM before calling the recording store", async () => {
  await fleetTarget.setup();
  try {
    const body = Buffer.from('\ufeff' + JSON.stringify({ code: "crj_" + "A".repeat(43), workerKind: "codex", credentialDigest: `sha256:${"0".repeat(64)}`, platform: "darwin", architecture: "arm64", connectorVersion: "1.2.3", clientNonce: "n".repeat(16) }));
    const raw = Buffer.concat([Buffer.from(`POST /fleet/v1/enroll HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]);
    const result = await fleetTarget.invoke({ raw, halfClose: true });
    assert.equal(result.value.status, 400);
    assert.equal(result.value.calls.length, 0);
  } finally { await fleetTarget.teardown(); }
});

function pushApp(t) {
  let calls = 0;
  const origin = "http://127.0.0.1:3210", code = "fuzz-synthetic-owner-code-for-tests";
  const client = { query: async () => { calls++; return { rows: [] }; }, transaction: async () => { throw new Error("fake_db"); }, transactionWithPreCommitCheck: async () => { throw new Error("fake_db"); } };
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:fuzz", localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:fuzz", provider: "local", subject: "test-owner", ownerCodeDigest: sha256Digest({ ownerCode: code }), sessionSeconds: 300 }, database: { client, close: async () => {}, isAvailable: () => true }, clock: () => Date.parse("2026-10-02T00:00:00.000Z"), workerReadiness: { read: () => [] }, workBatchIntegrityKey: new Uint8Array(32).fill(1), fleet: { ownerAuthority: client }, ownerWebPush: { subject: "mailto:test@example.invalid", ...webpush.generateVAPIDKeys() }, ownerPushDispatch: false });
  t.after(() => app.close());
  return { app, origin, code, calls: () => calls };
}

test("F6: owner push POST and DELETE reject oversized, missing, stalled and dropped bodies; retry works", { timeout: 15000 }, async t => {
  const f = pushApp(t);
  const signed = await f.app.handle(new Request(f.origin + "/api/v1/local-owner-session", { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode: f.code }) }));
  const cookie = signed.headers.get("set-cookie").split(";")[0];
  const send = (method, body) => f.app.handle(new Request(f.origin + "/api/v1/owner-web-push", { method, headers: { origin: f.origin, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body, duplex: "half" }) }));
  for (const method of ["POST", "DELETE"]) {
    const big = JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/test", padding: "a".repeat(5000), keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) }, expirationTime: null });
    const burst = await Promise.all(Array.from({ length: 50 }, () => send(method, big)));
    assert.ok(burst.every(r => r.status === 400));
    assert.equal((await send(method, undefined)).status, 400);
    assert.equal((await send(method, new ReadableStream({ start(c) { c.error(new Error("dropped")); } }))).status, 400);
  }
  assert.equal(f.calls(), 0);
  const stalled = await Promise.all(["POST", "DELETE"].flatMap(method => Array.from({ length: 50 }, () => send(method, new ReadableStream()))));
  assert.ok(stalled.every(r => r.status === 400));
  assert.equal(f.calls(), 0);
  assert.equal((await send("DELETE", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/retry" }))).status, 204);
  assert.equal(f.calls(), 1);
});

test("F7: push kinds refuse inherited and unknown titles", () => {
  for (const kind of ["constructor", "__proto__", "toString", "unknown", null, ["test"]]) assert.throws(() => ownerPushPayloadV1(kind, "/needs-me", "needs:one"), /owner_push_kind_invalid/);
  assert.equal(typeof ownerPushPayloadV1("test", "/needs-me", "needs:one").title, "string");
});

test("F8: null updater status is idle; non-objects and non-string health timestamps have typed refusals", () => {
  assert.equal(publicStatusV1(null).state, "idle");
  assert.equal(publicStatusV1().state, "idle");
  for (const input of [[], "x", 1]) assert.throws(() => publicStatusV1(input), /updater_status_refused/);
  assert.throws(() => publicStatusV1({ lastHealthAt: Object.create(null) }), /updater_status_health_refused/);
});

test("F9: product and template display names refuse controls, including the original newline reproducer", async () => {
  const t = target(configTargets, "config:product-configuration"), valid = await validInput(t);
  for (const displayName of ["Conty3BB2T\n2rol Room", "a\u0003b", "a\u0085b", "name\t", "name\r"]) {
    assert.throws(() => t.invoke({ ...valid, displayName }));
    assert.throws(() => t.invoke({ ...valid, projectTemplates: valid.projectTemplates.map(p => ({ ...p, displayName })) }));
  }
  assert.equal(t.invoke(valid).outcome, "accepted");
});

test("F10: both panel text fields reject controls and hidden text at the real MCP boundary", async () => {
  const t = target(voiceMcpTargets, "mcp-bridge-replies"), input = await validInput(t);
  for (const field of ["safeOpinion", "suggestedExperiment"]) for (const text of ["Run\u0003a landing page test.", "Run\u202ea test.", "Run\u200ba test."]) {
    assert.equal(ideaTextSchemaV1.safeParse(text).success, false);
    const bad = structuredClone(input), event = bad.table["session.events.since"].events[2];
    event.finalText = JSON.stringify({ ...JSON.parse(event.finalText), [field]: text });
    const result = await t.invoke(bad);
    assert.equal(result.outcome, "refused");
    assert.equal(result.value.executeError, "invalid_input");
  }
  assert.equal((await t.invoke(input)).outcome, "accepted");
});

test("F11: connector exceptions, missing/duplicate submits and proxy replies become typed bridge errors", async () => {
  const t = target(voiceMcpTargets, "mcp-bridge-replies"), input = await validInput(t);
  for (const name of Object.keys(input.table)) for (const behavior of ["throw", "silent", "twice", "proxy"]) {
    const bad = structuredClone(input);
    if (behavior === "proxy") bad.table[name] = new Proxy(bad.table[name], {});
    else bad.behaviours[name] = behavior;
    const result = await t.invoke(bad);
    // Cleanup operations can fail after a successful panel execution.
    assert.ok(result.value.executeError === "integrity_failed" || result.value.cleanupError === "integrity_failed", `${name}:${behavior}`);
  }
  const burst = await Promise.all(Array.from({ length: 50 }, () => t.invoke({ ...structuredClone(input), behaviours: { open: "throw" } })));
  assert.ok(burst.every(r => r.value.executeError === "integrity_failed"));
  assert.equal((await t.invoke(input)).outcome, "accepted");
});

test("F12: malformed voice callbacks and huge result lengths are bounded; null policy inputs are safe", async () => {
  const t = target(voiceMcpTargets, "voice:transcripts");
  for (const event of [null, undefined, "x", {}, { results: null }, { results: { length: Infinity } }, { results: { length: "3" } }]) assert.deepEqual(t.invoke({ kind: "adapter", event }).value.captured, []);
  for (const length of [Infinity, NaN, -1, "3"]) assert.deepEqual(t.invoke({ kind: "adapter", event: { results: { length, 0: [{ transcript: "outside" }] } } }).value.captured, []);
  const results = { length: 4294967296, 0: [{ transcript: "a" }], 1: null, 2: [{}], 64: [{ transcript: "outside" }] };
  assert.equal((await moduleInWorker({ kind: "voice", input: { kind: "adapter", event: { results } } })).value.captured.length, 1);
  const array = Array.from({ length: 100 }, () => [{ transcript: "a" }]);
  assert.equal(t.invoke({ kind: "adapter", event: { results: array } }).value.captured.length, 64);
  for (const content of [null, {}, { text: null }]) assert.equal(t.invoke({ kind: "read", content }).value, false);
  for (const events of [null, [null, undefined, { eventId: 3 }, { eventId: "id", transcript: 1, isFinal: true }]]) assert.deepEqual(t.invoke({ kind: "dedupe", events }).value, []);
});

test("fuzz lane: invalid budgets and unknown targets fail instead of silently passing", () => {
  for (const args of [["--seed", "NaN"], ["--cases", "0"], ["--cases", "1000001"], ["--target", "missing-target", "--cases", "1"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/fuzz/run.mjs", ...args], { timeout: 10000, encoding: "utf8", env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fuzz_(options_invalid|target_unknown)/);
  }
});

test("portable UTF-8 fallback: exact byte ceilings hold without TextEncoder and Buffer", () => {
  const encoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder"), buffer = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  const cases = ["ascii", "é", "雪", "😀", "\ud800", "é雪😀"].map(text => ({ value: { text }, bytes: new TextEncoder().encode(JSON.stringify({ text })).length }));
  try {
    Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "Buffer", { configurable: true, value: undefined });
    for (const { value, bytes } of cases) {
      assert.doesNotThrow(() => assertPortableInputSizeV1("portable", value, bytes));
      assert.throws(() => assertPortableInputSizeV1("portable", value, bytes - 1), /portable_input_oversized/);
    }
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", encoder);
    Object.defineProperty(globalThis, "Buffer", buffer);
  }
});

test("fuzz lane: wire bytes and optional wrappers cannot suppress unexpected transport or MCP errors", () => {
  assert.equal(isF13ExoticCase("fleet-gateway-http", { raw: Buffer.from("request"), optional: undefined }), false);
  assert.equal(isF13ExoticCase("hermes-native-frame", Buffer.from("frame")), false);
  assert.equal(isF13ExoticCase("mcp-bridge-replies", { table: new Proxy({}, {}) }), false);
  assert.equal(isF13ExoticCase("release:connector-advertisement", { ad: { sha256: ["hex"] }, trust: {}, floor: undefined }), false);
  assert.equal(isF13ExoticCase("release:connector-advertisement", { ad: { sha256: Symbol("host-value") }, trust: {}, floor: undefined }), true);
  assert.equal(isF13ExoticCase("hermes-native-frame", { kind: Object.create(null) }), true);
  assert.equal(isF13ExoticCase("config:nightly-backup", { path: Object.create(null) }), true);
});
