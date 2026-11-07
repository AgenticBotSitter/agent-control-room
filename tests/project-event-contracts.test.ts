import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectEventPageV1,
  buildProjectEventV1,
  decodeProjectEventCursorV1,
  encodeProjectEventCursorV1,
  encodeProjectEventOriginCursorV1,
  parseProjectEventInputV1,
  parseProjectEventPageV1,
  parseProjectEventV1,
  PROJECT_EVENT_INPUT_V1,
  PROJECT_EVENT_PAGE_V1,
  PROJECT_EVENT_V1,
  ProjectEventErrorV1,
  type ProjectEventInputV1,
} from "../src/project-events/v1";
import { sha256Digest } from "../src/security";

const recordedAt = "2026-09-04T12:00:00.000Z";
const scope = { tenantId: "tenant:contracts", workspaceId: "workspace:contracts", projectId: "project:contracts" };

function input(index: number, over: Partial<ProjectEventInputV1> = {}): ProjectEventInputV1 {
  return {
    schemaVersion: PROJECT_EVENT_INPUT_V1,
    ...scope,
    eventId: `event:contracts:${index}`,
    eventKind: "work",
    source: {
      kind: "job",
      sourceId: `source:contracts:${index}`,
      sourceVersion: `v${index}`,
      sourceEventKeyDigest: sha256Digest({ index }),
    },
    subject: { kind: "work_item", subjectId: `work:contracts:${index}` },
    safeSummary: `Contract event ${index}`,
    tone: "neutral",
    occurredAt: recordedAt,
    presentationOnly: true,
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
    ...over,
  };
}

function safeCode(error: unknown): string | undefined {
  return error instanceof ProjectEventErrorV1 ? error.safeCode : undefined;
}

test("project event input parsing refuses malformed payloads", () => {
  const base = input(1);
  const cases: [string, unknown][] = [
    ["missing event id", (() => { const { eventId, ...rest } = base; return rest; })()],
    ["wrong schema version", { ...base, schemaVersion: PROJECT_EVENT_V1 }],
    ["granted approval", { ...base, grantsApproval: true }],
    ["granted command authority", { ...base, grantsCommandAuthority: true }],
    ["unknown field", { ...base, unexpected: "field" }],
    ["unparsable timestamp", { ...base, occurredAt: "not-a-timestamp" }],
    ["non-canonical timestamp", { ...base, occurredAt: "2026-09-04T12:00:00.000+00:00" }],
    ["empty summary", { ...base, safeSummary: "" }],
    ["malformed source digest", { ...base, source: { ...base.source, sourceEventKeyDigest: "sha256:not-a-digest" } }],
    ["unsafe deep link", { ...base, deepLinkPath: "/../etc/passwd" }],
    ["not an object", "event"],
    ["null", null],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => parseProjectEventInputV1(value),
      (error: unknown) => safeCode(error) === "invalid_input", label);
  }
  assert.deepEqual(parseProjectEventInputV1(base), base);
});

test("project event parsing refuses a digest-mismatched event", () => {
  const event = buildProjectEventV1(input(1), 1, null, recordedAt);

  assert.throws(() => parseProjectEventV1({ ...event, safeSummary: "A tampered summary" }),
    (error: unknown) => safeCode(error) === "integrity_failed");
  // Change sequence and previousEventDigest together: projectEventSchemaV1
  // superRefine requires (sequence === 1) to agree with (previousEventDigest
  // === null), so changing sequence alone trips the schema (invalid_input)
  // before the digest is ever checked. With both changed the schema passes and
  // the HMAC digest mismatch is what must be detected (integrity_failed).
  assert.throws(() => parseProjectEventV1({ ...event, sequence: 2, previousEventDigest: `sha256:${"a".repeat(64)}` }),
    (error: unknown) => safeCode(error) === "integrity_failed");
  assert.throws(() => parseProjectEventV1({ ...event, previousEventDigest: `sha256:${"a".repeat(64)}` }),
    (error: unknown) => safeCode(error) === "invalid_input");
  assert.throws(() => parseProjectEventV1({ ...event, eventDigest: "not-a-digest" }),
    (error: unknown) => safeCode(error) === "invalid_input");
  assert.throws(() => parseProjectEventV1({ ...event, grantsApproval: true }),
    (error: unknown) => safeCode(error) === "invalid_input");

  assert.deepEqual(parseProjectEventV1(event), event);
});

test("a built project event carries a self-consistent event digest", () => {
  const first = buildProjectEventV1(input(1), 1, null, recordedAt);
  assert.equal(first.schemaVersion, PROJECT_EVENT_V1);
  assert.equal(first.sequence, 1);
  assert.equal(first.previousEventDigest, null);
  assert.equal(first.eventDigest, sha256Digest({
    ...input(1), schemaVersion: PROJECT_EVENT_V1, sequence: 1, previousEventDigest: null, recordedAt,
  }));
  assert.deepEqual(parseProjectEventV1(first), first);

  const second = buildProjectEventV1(input(2), 2, first.eventDigest, recordedAt);
  assert.equal(second.previousEventDigest, first.eventDigest);
  assert.equal(second.eventDigest, sha256Digest({
    ...input(2), schemaVersion: PROJECT_EVENT_V1, sequence: 2, previousEventDigest: first.eventDigest, recordedAt,
  }));
  assert.deepEqual(parseProjectEventV1(second), second);
});

test("project event cursors round-trip and refuse anything malformed", () => {
  const event = buildProjectEventV1(input(1), 1, null, recordedAt);
  const cursor = encodeProjectEventCursorV1(event);
  assert.deepEqual(decodeProjectEventCursorV1(cursor), {
    projectId: event.projectId, sequence: event.sequence, eventDigest: event.eventDigest,
  });

  const origin = encodeProjectEventOriginCursorV1(event.projectId);
  assert.deepEqual(decodeProjectEventCursorV1(origin), {
    projectId: event.projectId, sequence: 0, eventDigest: null,
  });

  const invalid: unknown[] = [
    "", "short", "not base64url +", "A".repeat(501), "malformed-cursor-value",
    Buffer.from(JSON.stringify({ projectId: scope.projectId, sequence: 0, eventDigest: `sha256:${"a".repeat(64)}` }))
      .toString("base64url"),
    Buffer.from(JSON.stringify({ projectId: scope.projectId, sequence: 1 })).toString("base64url"),
    Buffer.from("not json at all").toString("base64url"),
    42, null, undefined, {},
  ];
  for (const value of invalid) assert.equal(decodeProjectEventCursorV1(value), undefined, String(value));
});

test("a built project event page carries a self-consistent page digest", () => {
  const event = buildProjectEventV1(input(1), 1, null, recordedAt);
  const nextCursor = encodeProjectEventCursorV1(event);
  const page = buildProjectEventPageV1({
    ...scope, mode: "snapshot", events: [event], nextCursor, hasMore: false, truncatedBefore: false,
  });

  assert.equal(page.contractVersion, PROJECT_EVENT_PAGE_V1);
  assert.equal(page.presentationOnly, true);
  assert.equal(page.grantsApproval, false);
  assert.equal(page.grantsCommandAuthority, false);
  assert.equal(page.grantsExecutionAuthority, false);
  assert.equal(page.pageDigest, sha256Digest({
    contractVersion: PROJECT_EVENT_PAGE_V1, ...scope, mode: "snapshot", events: [event], nextCursor,
    hasMore: false, truncatedBefore: false, presentationOnly: true, grantsApproval: false,
    grantsCommandAuthority: false, grantsExecutionAuthority: false,
  }));
  assert.deepEqual(parseProjectEventPageV1(page), page);
});

test("project event page parsing refuses a tampered page digest or event", () => {
  const event = buildProjectEventV1(input(1), 1, null, recordedAt);
  const nextCursor = encodeProjectEventCursorV1(event);
  const page = buildProjectEventPageV1({
    ...scope, mode: "snapshot", events: [event], nextCursor, hasMore: false, truncatedBefore: false,
  });

  assert.throws(() => parseProjectEventPageV1({ ...page, pageDigest: `sha256:${"a".repeat(64)}` }),
    (error: unknown) => safeCode(error) === "integrity_failed");
  assert.throws(() => parseProjectEventPageV1({ ...page, events: [{ ...event, safeSummary: "A tampered summary" }] }),
    (error: unknown) => safeCode(error) === "integrity_failed");
  assert.throws(() => parseProjectEventPageV1({ ...page, mode: "unknown" }),
    (error: unknown) => safeCode(error) === "invalid_input");
  assert.throws(() => parseProjectEventPageV1({ ...page, events: Array.from({ length: 101 }, () => event) }),
    (error: unknown) => safeCode(error) === "invalid_input");
  assert.throws(() => parseProjectEventPageV1({ ...page, pageDigest: "not-a-digest" }),
    (error: unknown) => safeCode(error) === "invalid_input");
});
