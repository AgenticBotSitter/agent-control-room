import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WayfarerWorkspace } from "../app/components/wayfarer-workspace.tsx";
import { buildWayfarerWorkspaceViewV1, parseWayfarerWorkspaceViewV1,
  type WayfarerWorkspaceViewV1 } from "../src/project-adapters/wayfarer/v1/index.ts";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

function clone(): WayfarerWorkspaceViewV1 { return structuredClone(buildWayfarerWorkspaceViewV1()); }
function rehash(value: WayfarerWorkspaceViewV1) {
  const unsigned = { ...value } as Record<string, unknown>; delete unsigned.viewDigest;
  return { ...unsigned, viewDigest: sha256Digest(unsigned) };
}

test("CR9B-WF-060 workspace projects the exact six-stage media and review surface", () => {
  const view = buildWayfarerWorkspaceViewV1();
  assert.equal(view.stages.length, 6); assert.equal(view.artifacts.length, 10); assert.equal(view.reviews.length, 6);
  assert.equal(view.stores.length, 2); assert.equal(view.schedulingScenarios.length, 6);
  assert.deepEqual({ benchmark: view.unrealBenchmark.status, met: view.unrealBenchmark.metGateCount,
    total: view.unrealBenchmark.totalGateCount, blocked: view.unrealBenchmark.blockingGateIds.length },
  { benchmark: "disabled", met: 1, total: 13, blocked: 12 });
  assert.deepEqual({ executor: view.unrealExecutor.status, command: view.unrealExecutor.commandModel,
    process: view.unrealExecutor.processStarted, delivery: view.deliveryPreparation.status,
    boundaries: view.deliveryPreparation.boundaryCount, readinessRecords: view.deliveryPreparation.readinessRecordCount,
    readiness: view.deliveryPreparation.boundaries.map((boundary) => `${boundary.metGateCount}/${boundary.totalGateCount}`),
    missing: view.deliveryPreparation.boundaries.map((boundary) => boundary.blockingGateIds.length),
    deliveryBlockers: view.deliveryPreparation.blockingRequirements.length },
  { executor: "disabled_before_start", command: "none", process: false,
    delivery: "disabled_before_effect", boundaries: 2, readinessRecords: 2,
    readiness: ["1/10", "1/10"], missing: [9, 9], deliveryBlockers: 12 });
  assert.deepEqual(parseWayfarerWorkspaceViewV1(view), view);
  assert.deepEqual(view.stages.map((stage) => stage.position), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set(view.artifacts.map((artifact) => artifact.role)).size, 10);
});

test("CR9B-WF-060 synthetic evidence never becomes completion, approval, or execution authority", () => {
  const view = buildWayfarerWorkspaceViewV1();
  assert.equal(view.episode.completedSyntheticStages, 6); assert.equal(view.episode.authoritativeCompletedStages, 0);
  assert.equal(view.stages.every((stage) => stage.state === "synthetic_evidence_ready" && stage.completionState === "not_resolved"
    && stage.acceptedIndependentReviews === 0 && !stage.allowsNativeExecution), true);
  assert.equal(view.reviews.every((review) => review.state === "waiting_independent_evidence" && !review.canApprove
    && !review.canComplete && !review.grantsAuthority), true);
  assert.equal(!view.unrealEligible && !view.uploadEligible && !view.publicationEligible && view.presentationOnly
    && !view.createsJobs && !view.createsReservations && !view.dispatchesWork && !view.grantsApproval
    && !view.grantsExecutionAuthority, true);
});

test("CR9B-WF-060 storage cards expose bounded fake facts and no material or locator", () => {
  const view = buildWayfarerWorkspaceViewV1(), local = view.stores[0], r2 = view.stores[1];
  assert.equal(view.artifacts.every((artifact) => artifact.observedBytes === 0 && !artifact.locatorAvailable
    && !artifact.materialAvailable && !artifact.qualifiesCompletion && !artifact.grantsAuthority), true);
  assert.equal(local.state, "fake_metadata_only"); assert.equal(r2.state, "quarantine_present");
  assert.equal(view.stores.every((store) => !store.locatorAvailable && !store.bytesAvailable && !store.adapterConfigured
    && !store.liveAccessAllowed), true);
  assert.equal(view.artifacts.find((artifact) => artifact.role === "render_segment")?.storeId, local.storeId);
  assert.equal(view.artifacts.find((artifact) => artifact.role === "audio_candidate")?.storeId, r2.storeId);
});

test("CR9B-WF-060 rendered workspace is informative but has no command or approval controls", () => {
  const html = renderToStaticMarkup(<WayfarerWorkspace fixture={buildWayfarerWorkspaceViewV1()} />);
  for (const text of ["Episode control surface", "Unreal remains blocked", "Six-stage production pipeline",
    "Unreal scene/render readiness", "Disabled · no attempt", "1/13", "Maximum attempts", "Independent review queue",
    "Unreal executor", "Disabled before start", "Command model", "Upload and publication boundaries",
    "Private distribution upload", "Public episode publication", "Disabled · 1/10", "Missing gates", "Delivery attempts",
    "Terminal ambiguity", "No approval controls",
    "fake metadata only", "GPU and scratch simulations",
    "presentation-only"]) assert.match(html, new RegExp(text, "i"));
  assert.doesNotMatch(html, /<button\b|<form\b|Start render|Publish now|Run Unreal|r2:\/\/|s3:\/\/|signed URL|\/Users\//i);
});

test("CR9B-WF-060 stage, review, artifact, and store bindings fail closed even after outer re-signing", () => {
  const stageDrift = clone(); stageDrift.stages[0]!.label = "Changed stage";
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(stageDrift)), ProjectWorkspaceContractErrorV1);
  const reviewDrift = clone(); reviewDrift.reviews[0]!.targetDigest = reviewDrift.stages[1]!.stageDigest;
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(reviewDrift)), ProjectWorkspaceContractErrorV1);
  const storageDrift = clone(); storageDrift.artifacts.find((artifact) => artifact.role === "render_segment")!.storeId = storageDrift.stores[1].storeId;
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(storageDrift)), ProjectWorkspaceContractErrorV1);
  const benchmarkDrift = clone(); benchmarkDrift.unrealBenchmark.packDigest = sha256Digest({ pack: "other" });
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(benchmarkDrift)), ProjectWorkspaceContractErrorV1);
  const executorDrift = clone(); executorDrift.unrealExecutor.packetDigest = sha256Digest({ packet: "other" });
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(executorDrift)), ProjectWorkspaceContractErrorV1);
  const deliveryDrift = clone(); deliveryDrift.deliveryPreparation.boundaries.reverse();
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(deliveryDrift)), ProjectWorkspaceContractErrorV1);
  const readinessDrift = clone(); readinessDrift.deliveryPreparation.boundaries[0]!.blockingGateIds.reverse();
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(readinessDrift)), ProjectWorkspaceContractErrorV1);
  const stateDrift = clone(); stateDrift.stores.reverse();
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(stateDrift)), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-060 exact workspace parser rejects drift, extra fields, and secret-like material", () => {
  const view = clone();
  assert.throws(() => parseWayfarerWorkspaceViewV1({ ...view, viewDigest: sha256Digest({ drift: true }) }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerWorkspaceViewV1({ ...view, privatePath: "/private/media" }), ProjectWorkspaceContractErrorV1);
  const secret = clone(); secret.episode.title = "token=ghp_abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(() => parseWayfarerWorkspaceViewV1(rehash(secret)), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-060 labels remain escaped at the presentation boundary", () => {
  const value = clone(); value.artifacts[0]!.label = "<script>unsafe()</script>";
  const parsed = parseWayfarerWorkspaceViewV1(rehash(value));
  const html = renderToStaticMarkup(<WayfarerWorkspace fixture={parsed} />);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>unsafe/);
});

test("CR9B-WF-060 workspace parsing rejects accessors and Proxies without executing traps", () => {
  const view = buildWayfarerWorkspaceViewV1(); let calls = 0; const accessor = { ...view };
  Object.defineProperty(accessor, "viewId", { enumerable: true, get() { calls += 1; return view.viewId; } });
  assert.throws(() => parseWayfarerWorkspaceViewV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxied = observedProxy(view, "transparent");
  assert.throws(() => parseWayfarerWorkspaceViewV1(proxied.value), ProjectWorkspaceContractErrorV1);
  assert.equal(proxied.trapCount(), 0);
});
