import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { loopProviderDataSchemaV1, loopProviderSnapshotSchemaV1, loopProviderRouteSchemaV1,
  loopProviderRouteResolutionSchemaV1, parseLoopProviderSnapshotV1, serializeLoopProviderSnapshotV1,
  classifyLoopProviderIssuesV1, LoopProviderSnapshotRefusalV1,
  type LoopProviderDataV1, type LoopProviderSnapshotV1 } from "../src/web/v1/improve-control-room-loop-adapter";

const provider = (changes: Partial<LoopProviderDataV1> = {}): LoopProviderDataV1 => ({
  provider_id: "provider-one", display_name: "Synthetic provider", base_url: "https://example.com/api",
  billing_kind: "token", secret_ref: { kind: "launcher", launcher: "synthetic" },
  models: [{ roster_name: "roster-one", launcher: "synthetic", served_model_id: "served/model:one+v1" }],
  credit_amount_nano_usd: null, credit_expires_on: null, credit_note: "",
  price_source_url: null, price_source_format: null, ...changes,
});
const document = (providers = [provider()], version = 1, tenantId = "tenant:one"): LoopProviderSnapshotV1 => ({
  schema: "control-room.loop-provider-snapshot/v1", tenantId, version, providers,
});
function issues(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, "invalid synthetic document must refuse");
  if (result.success) throw new Error("expected validation refusal");
  return result.error.issues;
}
const classification = (value: unknown) => classifyLoopProviderIssuesV1(issues(loopProviderDataSchemaV1, value));
const neutral = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof Error && error.message === "invalid_request");

// These tests use only in-memory synthetic data. Importing the schemas performs no I/O.
test("F10c data edits add replace remove without schema or tooling changes", () => {
  const first = document();
  const second = document([provider(), provider({ provider_id: "provider-two" })], 2);
  const third = document([provider({ display_name: "Replacement", base_url: "https://another.example/api" })], 3);
  const fourth = document([], 4);
  for (const [index, value] of [first, second, third, fourth].entries()) {
    const parsed = parseLoopProviderSnapshotV1(serializeLoopProviderSnapshotV1(value, "tenant:one"), "tenant:one");
    assert.equal(parsed.version, index + 1);
    assert.deepEqual(parsed, value);
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.providers));
    if (parsed.providers[0]) assert.ok(Object.isFrozen(parsed.providers[0].models[0]) && Object.isFrozen(parsed.providers[0].secret_ref));
  }
});

test("F10c tenant equality precedes use and shared provider IDs stay isolated", () => {
  const a = parseLoopProviderSnapshotV1(JSON.stringify(document()), "tenant:one");
  const b = parseLoopProviderSnapshotV1(JSON.stringify(document([provider({ models: [
    { roster_name: "roster-two", launcher: "synthetic", served_model_id: "served/two" }], credit_note: "Tenant two only" })], 1, "tenant:two")), "tenant:two");
  assert.equal(a.providers[0]!.provider_id, b.providers[0]!.provider_id);
  assert.equal(a.providers[0]!.models[0]!.roster_name, "roster-one");
  assert.equal(b.providers[0]!.models[0]!.roster_name, "roster-two");
  assert.throws(() => parseLoopProviderSnapshotV1(JSON.stringify(b), "tenant:one"), /^Error: loop_adapter_unavailable$/);
  assert.throws(() => serializeLoopProviderSnapshotV1(b, "tenant:one"), /^Error: loop_adapter_unavailable$/);
  neutral(() => parseLoopProviderSnapshotV1(JSON.stringify({ ...b, version: -1 }), "tenant:one"));
});

test("F10c literal schema and state version are independent axes", () => {
  for (const version of [0, 1, 2, 123456, Number.MAX_SAFE_INTEGER])
    assert.equal(parseLoopProviderSnapshotV1(JSON.stringify(document([], version)), "tenant:one").version, version);
  for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) neutral(() => parseLoopProviderSnapshotV1(JSON.stringify(document([], version)), "tenant:one"));
  neutral(() => parseLoopProviderSnapshotV1(JSON.stringify(document([provider()], 0)), "tenant:one"));
  for (const schema of ["control-room.loop-provider-snapshot/v2", 1, null])
    neutral(() => parseLoopProviderSnapshotV1(JSON.stringify({ ...document(), schema }), "tenant:one"));
  neutral(() => parseLoopProviderSnapshotV1(JSON.stringify({ ...document(), schemaVersion: 1 }), "tenant:one"));
  neutral(() => parseLoopProviderSnapshotV1(JSON.stringify({ ...document(), tenantId: ".." }), ".."));
});

test("F10c 32 providers accepted 33 refused on write and read before storage", () => {
  const providers = Array.from({ length: 32 }, (_, index) => provider({ provider_id: `provider-${index}` }));
  const good = document(providers);
  assert.equal(parseLoopProviderSnapshotV1(serializeLoopProviderSnapshotV1(good, "tenant:one"), "tenant:one").providers.length, 32);
  const bad = document([...providers, provider({ provider_id: "provider-32" })]);
  assert.equal(loopProviderSnapshotSchemaV1.safeParse(bad).success, false);
  let stored = false;
  const named = (error: unknown) => error instanceof LoopProviderSnapshotRefusalV1 && error.reason === "provider_limit" && error.message === "invalid_request";
  assert.throws(() => { serializeLoopProviderSnapshotV1(bad, "tenant:one"); stored = true; }, named);
  assert.equal(stored, false);
  assert.throws(() => parseLoopProviderSnapshotV1(JSON.stringify(bad), "tenant:one"), named);
});

test("F10c exactly 64 KiB accepted one byte over refused on write and read", () => {
  const p = provider(), value = document([p]);
  for (let index = 1; ; index++) {
    const model = { roster_name: `model-${index}-` + "x".repeat(150), launcher: "synthetic", served_model_id: "s".repeat(180) };
    p.models.push(model);
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) { p.models.pop(); break; }
  }
  p.credit_note = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(value)));
  const text = serializeLoopProviderSnapshotV1(value, "tenant:one");
  assert.equal(Buffer.byteLength(text), 65536);
  assert.equal(parseLoopProviderSnapshotV1(text, "tenant:one").providers.length, 1);
  const named = (error: unknown) => error instanceof LoopProviderSnapshotRefusalV1 && error.reason === "snapshot_size" && error.message === "invalid_request";
  assert.throws(() => parseLoopProviderSnapshotV1(text + " ", "tenant:one"), named);
  p.credit_note += "x";
  let stored = false;
  assert.throws(() => { serializeLoopProviderSnapshotV1(value, "tenant:one"); stored = true; }, named);
  assert.equal(stored, false);
  // UTF-8 bytes, not JS string length, own the ceiling.
  p.credit_note = p.credit_note.slice(0, -1) + "é";
  assert.throws(() => serializeLoopProviderSnapshotV1(value, "tenant:one"), named);
});

test("F10c required strict structure bounds and no coercion", () => {
  for (const key of Object.keys(provider())) {
    const value: Record<string, unknown> = { ...provider() }; delete value[key];
    assert.equal(classification(value), "invalid_request", `required ${key}`);
  }
  for (const changes of [{ provider_id: "aa" }, { provider_id: "UPPER" }, { provider_id: "a".repeat(65) },
    { display_name: "" }, { display_name: "x".repeat(181) }, { display_name: "control\u007f" },
    { credit_note: "x".repeat(1001) }, { credit_note: "control\n" }, { billing_kind: "free" },
    { credit_amount_nano_usd: 1 }, { models: [] }, { extra: true }, { tenantId: "tenant:one" }])
    assert.equal(classification({ ...provider(), ...changes }), "invalid_request");
  const model = provider().models[0]!;
  assert.ok(loopProviderDataSchemaV1.safeParse(provider({ models: Array.from({ length: 256 }, (_, i) => ({ ...model, roster_name: `model-${i}` })) })).success);
  assert.equal(classification(provider({ models: Array.from({ length: 257 }, (_, i) => ({ ...model, roster_name: `model-${i}` })) })), "invalid_request");
  for (const served_model_id of ["", "bad model", "../bad", "s".repeat(181)])
    assert.equal(classification(provider({ models: [{ ...model, served_model_id }] })), "invalid_request");
  assert.ok(loopProviderDataSchemaV1.safeParse(provider({ provider_id: "a".repeat(64), display_name: "x".repeat(180), credit_note: "x".repeat(1000) })).success);
});

test("F10c calendar dates canonical credit and nullable source coupling", () => {
  for (const credit_amount_nano_usd of ["0", "1", "9".repeat(30)]) assert.ok(loopProviderDataSchemaV1.safeParse(provider({ credit_amount_nano_usd })).success);
  for (const credit_amount_nano_usd of ["00", "01", "-1", "+1", "1.0", "1e3", "9".repeat(31)]) assert.equal(classification(provider({ credit_amount_nano_usd })), "invalid_request");
  for (const credit_expires_on of ["2024-02-29", "2000-02-29", "2026-12-31"]) assert.ok(loopProviderDataSchemaV1.safeParse(provider({ credit_expires_on })).success);
  for (const credit_expires_on of ["2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-1-01"]) assert.equal(classification(provider({ credit_expires_on })), "invalid_request");
  assert.equal(classification(provider({ price_source_url: "https://example.com/prices" })), "invalid_request");
  assert.equal(classification(provider({ price_source_format: "control-room.provider-prices/v1" })), "invalid_request");
  assert.equal(classification({ ...provider(), price_source_format: "other" }), "invalid_request");
});

test("F10c secret references match launcher or provider and stay strict", () => {
  for (const secret_ref of [{ kind: "launcher", launcher: "synthetic" },
    { kind: "macos_keychain", service: "control-room.provider", account: "provider-one" },
    { kind: "bitwarden", item: "opaque-item-id" }]) assert.ok(loopProviderDataSchemaV1.safeParse({ ...provider(), secret_ref }).success);
  for (const secret_ref of [{ kind: "macos_keychain", service: "other", account: "provider-one" },
    { kind: "macos_keychain", service: "control-room.provider", account: "provider-two" },
    { kind: "bitwarden", item: "" }, { kind: "bitwarden", item: "bad\n" },
    { kind: "launcher", launcher: "synthetic", value: "unknown" }]) assert.equal(classification({ ...provider(), secret_ref }), "invalid_request");
  assert.equal(classification(provider({ secret_ref: { kind: "launcher", launcher: "other" } })), "roster_mismatch");
});

test("F10c HTTPS normalized hosts refuse IP and local aliases with stable URL codes", () => {
  const hosts = ["[::1]", "[::ffff:127.0.0.1]", "127.0.0.1", "127.1", "2130706433", "0177.0.0.1", "0x7f000001",
    "LOCALHOST.", "sub.LOCALHOST...", "LOCAL.", "sub.local.", "HOME.ARPA.", "sub.home.arpa."];
  for (const base_url of [...hosts.map(host => `https://${host}/`), "http://example.com", "https://example.com:444", "https://example.com?",
    "https://example.com#", "https:example.com", "https:///example.com", "https://user@example.com", "https://@example.com", " https://example.com", "https://example.com/" + "x".repeat(300), "invalid"])
    assert.equal(classification(provider({ base_url })), "base_url", "URL semantic refusal");
  assert.ok(loopProviderDataSchemaV1.safeParse(provider({ base_url: "https://EXAMPLE.COM.:443/api", price_source_url: "https://example.com/prices", price_source_format: "control-room.provider-prices/v1" })).success);
  for (const price_source_url of ["https://other.example/prices", "http://example.com", "https://127.1", "https://example.com/" + "x".repeat(300)])
    assert.equal(classification(provider({ price_source_url, price_source_format: "control-room.provider-prices/v1" })), "price_source_url");
});

test("F10c all semantic issue paths and deterministic 400 versus 422 priority", () => {
  const model = provider().models[0]!;
  const cases: [LoopProviderDataV1, string, (string | number)[]][] = [
    [provider({ base_url: "invalid" }), "base_url", ["base_url"]],
    [provider({ price_source_url: "https://other.example", price_source_format: "control-room.provider-prices/v1" }), "price_source_url", ["price_source_url"]],
    [provider({ models: [model, model] }), "roster_mismatch", ["models", 1, "roster_name"]],
    [provider({ models: [model, { ...model, roster_name: "other", launcher: "other" }] }), "roster_mismatch", ["models", 1, "launcher"]],
    [provider({ secret_ref: { kind: "launcher", launcher: "other" } }), "roster_mismatch", ["secret_ref", "launcher"]],
  ];
  for (const [value, code, path] of cases) {
    const direct = issues(loopProviderDataSchemaV1, value).find(issue => issue.code === "custom" && issue.params?.providerRefusal === code)!;
    assert.deepEqual(direct.path, path);
    assert.equal(direct.message, "provider_refused");
    const nested = issues(loopProviderSnapshotSchemaV1, document([value])).find(issue => issue.code === "custom" && issue.params?.providerRefusal === code)!;
    assert.deepEqual(nested.path, ["providers", 0, ...path]);
    assert.equal(classification(value), code);
  }
  const mixed = provider({ base_url: "invalid", price_source_url: "https://other.example", price_source_format: "control-room.provider-prices/v1", models: [model, model] });
  assert.equal(classification(mixed), "base_url");
  assert.equal(classification({ ...mixed, base_url: "https://example.com" }), "price_source_url");
  assert.equal(classification({ ...mixed, credit_amount_nano_usd: "00" }), "invalid_request");
  assert.equal(classification({ ...mixed, unknown: true }), "invalid_request");
  assert.equal(classification({ ...mixed, credit_note: "Bearer " + "synthetic".repeat(3) }), "invalid_request");
});

test("F10c decoded secret values and credential-bearing URLs refuse neutrally", () => {
  const syntheticSecret = "Bearer " + "synthetic".repeat(3);
  for (const value of [{ ...provider(), credential: "synthetic-only" }, provider({ credit_note: syntheticSecret }),
    provider({ secret_ref: { kind: "bitwarden", item: syntheticSecret } }),
    provider({ base_url: "https://synthetic:synthetic@example.com" })]) {
    assert.equal(classification(value), "invalid_request");
    neutral(() => parseLoopProviderSnapshotV1(JSON.stringify(document([value])), "tenant:one"));
    neutral(() => serializeLoopProviderSnapshotV1(document([value]), "tenant:one"));
    assert.ok(issues(loopProviderDataSchemaV1, value).every(issue => issue.message === "invalid_request"));
  }
  const escaped = JSON.stringify(document([provider({ credit_note: syntheticSecret })])).replace("Bearer", "\\u0042earer");
  neutral(() => parseLoopProviderSnapshotV1(escaped, "tenant:one"));
});

test("F10c duplicate provider IDs refuse but cross-provider roster names are allowed", () => {
  neutral(() => parseLoopProviderSnapshotV1(JSON.stringify(document([provider(), provider()])), "tenant:one"));
  assert.ok(loopProviderSnapshotSchemaV1.safeParse(document([provider(), provider({ provider_id: "provider-two" })])).success);
  const text = JSON.stringify(document());
  neutral(() => parseLoopProviderSnapshotV1(text.replace('"version":1', '"version":1,"version":2'), "tenant:one"));
  neutral(() => parseLoopProviderSnapshotV1(text.replace('"version":1', '"version":1,"\\u0076ersion":2'), "tenant:one"));
  for (const invalid of ["null", "[]", "{", text + "x"]) neutral(() => parseLoopProviderSnapshotV1(invalid, "tenant:one"));
});

test("F10c strict route DTOs use roster name and reject leaked metadata", () => {
  const route = { providerId: "provider-one", model: "roster-one" };
  assert.deepEqual(loopProviderRouteSchemaV1.parse(route), route);
  for (const value of [null, {}, { ...route, model: "" }, { ...route, served_model_id: "served/one" }, { ...route, model: "bad\n" }])
    assert.equal(loopProviderRouteSchemaV1.safeParse(value).success, false);
  const result = { ...route, additionalRoutes: Array.from({ length: 256 }, () => route) };
  assert.ok(loopProviderRouteResolutionSchemaV1.safeParse(result).success);
  assert.equal(loopProviderRouteResolutionSchemaV1.safeParse({ ...result, additionalRoutes: [...result.additionalRoutes, route] }).success, false);
  for (const extra of [{ billing_kind: "token" }, { base_url: "https://example.com" }, { secret_ref: { kind: "bitwarden", item: "opaque" } }, { paidExecutionReady: true }])
    assert.equal(loopProviderRouteResolutionSchemaV1.safeParse({ ...result, ...extra }).success, false);
});
