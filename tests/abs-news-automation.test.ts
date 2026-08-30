import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ABS_NEWS_PROJECT_ID_V1, ABS_NEWS_WORKSPACE_ID_V1, SqliteAbsNewsControlStoreV1,
  buildAbsNewsAutomationDeclarationV1, buildAbsNewsSyntheticAutomationRunV1, parseAbsNewsAutomationDeclarationV1,
  projectAbsNewsAutomationV1, recoverAbsNewsAutomationRunV1, retryAbsNewsAutomationRunV1,
  transitionAbsNewsSyntheticAutomationRunV1,
} from "../src/project-adapters/abs-news/v1/index.ts";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const scope = { tenantId: "tenant.owner", workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1 };
const t0 = "2026-08-29T23:00:00.000Z", t1 = "2026-08-29T23:01:00.000Z", t2 = "2026-08-29T23:02:00.000Z", t3 = "2026-08-29T23:03:00.000Z";
const key = new Uint8Array(32).fill(47);
function declaration(sourceMode: "synthetic" | "configured_live" = "synthetic") { return buildAbsNewsAutomationDeclarationV1({ automationId: `automation.abs.${sourceMode}`, ...scope, automationKind: "collector", sourceMode, sourceId: `source.abs.${sourceMode}`, sourceKind: "rss", scheduleType: "interval", expression: "900", timezone: "UTC", idempotencyWindowSeconds: 900, maxItemsPerRun: 25, maxRuntimeSeconds: 60, maxAttempts: 2, retryableFailureCodes: ["temporary_source_failure"], declaredAt: t0 }); }

test("CR9D-ABS-050 schedules are exact, disabled by default, credential-free, and cannot activate themselves", () => {
  const value = declaration();
  assert.deepEqual({ state: value.state, schedule: value.schedule.state, activation: value.activationState, network: value.networkPolicy, destinations: value.allowedNetworkDestinations, credentials: value.credentialRefs, background: value.createsBackgroundProcess }, { state: "disabled", schedule: "disabled", activation: "owner_authority_required", network: "none", destinations: [], credentials: [], background: false });
  assert.throws(() => parseAbsNewsAutomationDeclarationV1({ ...value, state: "active" }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1);
  assert.throws(() => buildAbsNewsSyntheticAutomationRunV1({ declaration: declaration("configured_live"), occurrenceKey: "occurrence:live:1", scheduledFor: t1, createdAt: t1 }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "unsupported_action");
});

test("CR9D-ABS-050 synthetic run recovery is ambiguity-safe and retry is bounded", () => {
  const declared = declaration();
  const pending = buildAbsNewsSyntheticAutomationRunV1({ declaration: declared, occurrenceKey: "occurrence:abs:1", scheduledFor: t1, createdAt: t1 });
  const running = transitionAbsNewsSyntheticAutomationRunV1({ declaration: declared, run: pending, toState: "running", updatedAt: t2 });
  const ambiguous = recoverAbsNewsAutomationRunV1({ declaration: declared, run: running, recoveredAt: t3 });
  assert.deepEqual({ state: ambiguous.state, failure: ambiguous.safeFailureCode, retry: ambiguous.retryPermitted, network: ambiguous.networkUsed, activated: ambiguous.scheduleActivationObserved }, { state: "ambiguous", failure: "restart_unsettled_run", retry: false, network: false, activated: false });
  assert.throws(() => retryAbsNewsAutomationRunV1({ declaration: declared, failedRun: ambiguous, createdAt: t3 }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "unsupported_action");
  const failed = transitionAbsNewsSyntheticAutomationRunV1({ declaration: declared, run: running, toState: "failed", updatedAt: t3, safeFailureCode: "temporary_source_failure" });
  const retry = retryAbsNewsAutomationRunV1({ declaration: declared, failedRun: failed, createdAt: t3 });
  assert.equal(retry.attemptNumber, 2); assert.notEqual(retry.runId, failed.runId);
  const nonRetryable = transitionAbsNewsSyntheticAutomationRunV1({ declaration: declared, run: running, toState: "failed", updatedAt: t3, safeFailureCode: "invalid_source_contract" });
  assert.equal(nonRetryable.retryPermitted, false);
  assert.equal(projectAbsNewsAutomationV1(declared, ambiguous).attention?.kind, "ambiguity");
});

test("CR9D-ABS-050 durable ledger recovers unsettled runs once and detects deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abs-automation-")), path = join(dir, "control.sqlite");
  try {
    let store = new SqliteAbsNewsControlStoreV1(path, scope, { integrityKey: key, mode: "create" });
    const declared = declaration(); store.saveAutomation(declared);
    const pending = buildAbsNewsSyntheticAutomationRunV1({ declaration: declared, occurrenceKey: "occurrence:abs:store", scheduledFor: t1, createdAt: t1 });
    store.saveRun(pending); store.saveRun(transitionAbsNewsSyntheticAutomationRunV1({ declaration: declared, run: pending, toState: "running", updatedAt: t2 })); store.close();
    store = new SqliteAbsNewsControlStoreV1(path, scope, { integrityKey: key, mode: "open" });
    assert.equal(store.recoverUnsettled(t3)[0]?.state, "ambiguous"); assert.equal(store.recoverUnsettled(t3).length, 0); store.close();
    const attacker = new DatabaseSync(path); attacker.exec("DELETE FROM abs_news_control_records WHERE kind='run'"); attacker.close();
    assert.throws(() => new SqliteAbsNewsControlStoreV1(path, scope, { integrityKey: key, mode: "open" }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
    assert.ok(sha256Digest({ evidence: "tamper" }).startsWith("sha256:"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
