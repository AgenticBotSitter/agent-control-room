// R4U-09: worker panels hang on "Loading…" forever after one failed read, and
// keep an old all-clear when later reads fail.
//
// The defect is in runtime detection, not in a panel. `LocalRuntimeProvider`
// reads `/api/v1/local-workers` once on mount to decide whether this browser is
// on a Mac-local host. It settled on:
//
//   404               -> mode "hosted"
//   ok + parsable     -> mode "local"
//   anything else     -> NOTHING. `return` with no setState.
//
// So a 503, a 500, a network error, or an unparsable body left the mode at its
// initial "checking" FOREVER. Home gates its polling on
// `runtime.mode !== "checking"`, so the dashboard never started a single read,
// and both worker panels sat on "Loading saved worker signals…" indefinitely --
// measured at more than 30 seconds later in a real browser. Every other panel on
// that page showed a plain "unavailable" in the same measurements, so the two
// worker panels were the only ones with no failed state at all.
//
// The second half of the finding is the more dangerous direction. Once the mode
// HAS settled to hosted, the panels read `/api/v1/connections`; a later failure
// of that read must DROP the previous successful value rather than leave the old
// all-clear on screen, because "no worker route is reporting stuck, blocked or
// offline" after a read that never completed claims a check that did not
// happen. That case is asserted here too, in the third test, after an earlier
// successful read has actually painted an all-clear.
//
// These tests mount the REAL `PrivateHome` and the REAL `LocalRuntimeProvider`
// against a fetch that answers with the shape under test. No stubbed component,
// no injected state: the thing that hangs is the provider's own effect, and the
// thing that shows it is the page's own markup.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";

import { LocalRuntimeProvider } from "../private-app/app/local-runtime";
import { PrivateHome } from "../private-app/app/home-workspace";
import { buildIdeaLabHermes021ConnectionRosterV1, ideaLabHermes021BuiltInConnectionSourceV1,
  IDEA_LAB_HERMES_021_REVISION_V1, IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1 } from "../src/idea-lab/v1";
import { buildConnectionCenterProjectionV1 } from "../src/connection-center/v1";
import { sha256Digest } from "../src/security";

type FetchRoute = (path: string) => Response;

/** Mount the real Home inside the real provider against `route`.
 *
 * `connections` answers the hosted-mode `/api/v1/connections` route, which the
 * worker panels read once the runtime has settled to `hosted`. When it is
 * undefined that route 404s, which is the local-mode path the first two tests
 * use; `runtimeLocalWorkerReads` lets a test count the polls it triggered. */
async function mountHome(route: FetchRoute, connections?: FetchRoute) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>",
    { url: "https://control.invalid/", pretendToBeVisual: true });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let localWorkerReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/local-workers") {
      localWorkerReads += 1;
      return route(path);
    }
    if (path === "/api/v1/connections" && connections) return connections(path);
    // Everything else answers normally, so the only thing under test is the
    // runtime read's own settling behaviour.
    if (path === "/api/v1/projects") return Response.json({ projects: [], nextCursor: null, canCreate: true,
      sources: { ordinary: "included", ideas: "not_configured" } });
    if (path === "/api/v1/home/tasks") return Response.json({ active: [], recentResults: [],
      additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "not_configured",
      observedAt: "2026-09-29T07:00:00.000Z", startsWork: false });
    if (path === "/api/v1/needs-me/tasks") return Response.json({ items: [], nextCursor: null, examined: 0,
      observedAt: "2026-09-29T07:00:00.000Z", startsWork: false, planningSource: "not_configured",
      deliverySource: "not_configured", sources: { ordinary: "included", ideas: "not_configured" } });
    if (path === "/api/v1/operations-mode") return Response.json({
      schema: "control-room.installation-operations-mode-view/v1", mode: "running", reason: "",
      setByIdentityId: "", setAt: "", revision: 0, replayed: false, admitsNewWork: true,
      stopRequests: null, startsWork: false, grantsExecutionAuthority: false });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(createElement(LocalRuntimeProvider, null, createElement(PrivateHome))); });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    if (!/Loading saved/.test(dom.window.document.body.textContent ?? "")) break;
  }
  /** One real refresh through the page's own "Check saved dashboard again"
   * button -- the same `useVisiblePolling` entry point a focus or visibility
   * change uses, so no polling interval or fake timer is involved. */
  const refresh = async () => {
    const button = [...dom.window.document.querySelectorAll("button")]
      .find(node => node.textContent === "Check saved dashboard again");
    assert.ok(button, "the dashboard has no manual refresh control to drive the second read with");
    await React.act(async () => { (button as HTMLButtonElement).click(); });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    }
  };
  const restore = async () => {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { document: dom.window.document, localWorkerReads: () => localWorkerReads, refresh, restore };
}

/** Both worker panels' loading line, and the panels' own body text. */
function workerPanels(document: Document) {
  const text = document.body.textContent ?? "";
  return {
    loading: (text.match(/Loading saved worker signals…/gu) ?? []).length,
    unavailable: (text.match(/Worker (?:signals|status) are unavailable\./gu) ?? []).length,
    allClear: /No worker route is reporting stuck, blocked or offline\./u.test(text),
  };
}

/** A REAL hosted-mode connection projection, built by the production builders.
 *
 * A hand-written fixture is not possible here, and this is why: the browser
 * client re-hashes the projection (`invalid_connection_projection` -> the read
 * fails -> an "unavailable" that proves nothing), the roster builder re-hashes
 * every connection's `resultDigest`, and both pin exact literals. So the roster
 * and the projection are built by `buildIdeaLabHermes021ConnectionRosterV1` and
 * `buildConnectionCenterProjectionV1` -- the same functions the hosted route
 * calls -- from one enrolled connection with no telemetry signal: one enrolled
 * worker, one missing signal, and so NOT an all-clear. That gives the test a
 * real previous value for the failed refresh to drop. */
function hostedConnectionsEnvelope() {
  const evaluatedAt = "2026-10-02T09:00:00.000Z";
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
    sourceMode: "injected_signed_node_enrollment_only",
    enrollmentId: "enrollment:one", connectionId: "connection:one", tenantId: "tenant:web",
    nodeId: "node:one", runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    transport: "local_loopback", connectorRouteDigest: sha256Digest({ route: "connection:one" }),
    profileIdentityDigest: sha256Digest({ profile: "connection:one" }), sshHostKeyFingerprintDigest: null,
    issuerKeyDigest: sha256Digest({ issuer: "connection:one" }),
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    issuedAt: "2026-10-02T08:00:00.000Z", expiresAt: "2026-10-03T08:00:00.000Z", evaluatedAt,
    hermesModificationRequired: false, protectedValueMaterialRetained: false, nativeLocatorRetained: false,
    genericShellAvailable: false, privateContextRetained: false, routeEnrollmentAccepted: true,
    qualificationProfileEligible: true, nativeQualified: false, livePanelEligible: false,
    blockerCodes: ["native_qualification_missing", "owner_effect_window_missing",
      "admission_authority_not_configured", "live_driver_not_configured"],
    grantsApproval: false, grantsCommandAuthority: false, grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  } as const;
  return { projection: buildConnectionCenterProjectionV1(buildIdeaLabHermes021ConnectionRosterV1(
    { tenantId: "tenant:web", evaluatedAt, connections: [{ ...material, resultDigest: sha256Digest(material) }] })),
    telemetry: "configured" as const };
}

test("a failed local-worker read settles the runtime and the worker panels say why", async () => {
  // Every failure shape the round-4 browser run measured, one at a time: a 503
  // with a body, a 500, an empty unparsable 200, and a thrown network error.
  const failures: readonly (readonly [string, FetchRoute])[] = [
    ["503", () => new Response(JSON.stringify({ error: "service_unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } })],
    ["500", () => new Response(null, { status: 500 })],
    ["an unparsable 200", () => Response.json({ notTheShapeTheHostServes: true })],
    ["a thrown network error", () => { throw new TypeError("network error"); }],
  ];
  for (const [label, route] of failures) {
    const mounted = await mountHome(route);
    try {
      const panels = workerPanels(mounted.document);
      assert.equal(panels.loading, 0,
        `a ${label} left a worker panel on "Loading…" forever; the page never settled`);
      assert.ok(panels.unavailable >= 1,
        `a ${label} must put at least one worker panel in an explicit unavailable state, not silence`);
      assert.equal(panels.allClear, false,
        `a ${label} left an all-clear on screen, which claims a check that never completed`);
      assert.match(mounted.document.body.textContent ?? "", /No zero count or all-clear is inferred\./u,
        `a ${label} must state that no all-clear is inferred`);
    } finally { await mounted.restore(); }
  }
});

test("a successful local-worker read still settles, and still shows the local panels", async () => {
  // The positive half, so the fix cannot be "always render unavailable".
  const mounted = await mountHome(() => Response.json({ taskWorkersStarted: true,
    workers: [{ kind: "codex", state: "unavailable", proof: "not_proven" }], projectSections: [] }));
  try {
    const panels = workerPanels(mounted.document);
    assert.equal(panels.loading, 0, "a successful read must not leave a panel loading");
    assert.equal(panels.unavailable, 0, "a successful read must not claim unavailable");
    assert.match(mounted.document.body.textContent ?? "", /codex/,
      "the successful read's own worker must be named");
  } finally { await mounted.restore(); }
});

test("a LATER failed poll drops the earlier successful all-clear (hosted mode)", async () => {
  // The half of R4U-09 that was previously unasserted. Hosted mode, because that
  // is the mode where the worker panels re-read `/api/v1/connections`: the first
  // read succeeds and paints the real, honest worker state; a later refresh of
  // the same page fails, and the previous value must not survive as current.
  // Keeping it would be the specific lie the finding names -- an all-clear, or
  // a zero, standing next to a check that never completed.
  let connectionReads = 0;
  const healthy = Response.json(hostedConnectionsEnvelope());
  const mounted = await mountHome(
    // A 404 on /api/v1/local-workers is how this browser learns it is NOT a
    // Mac-local host, so the provider settles to hosted and the panels take the
    // hosted read path. Same provider, same effect, no injected state.
    () => new Response(null, { status: 404 }),
    () => { connectionReads += 1; return connectionReads === 1 ? healthy
      : new Response(null, { status: 503 }); });
  try {
    const first = workerPanels(mounted.document);
    assert.ok(connectionReads >= 1, "the hosted worker read never ran, so this test is not covering it");
    assert.equal(first.loading, 0, "the first successful read left a panel loading");
    assert.equal(first.unavailable, 0, "the first successful read claimed unavailable");
    // The real value is one enrolled worker with a missing signal: NOT an
    // all-clear, so the test does not depend on which sentence is shown. What it
    // requires is that the panel showed that value at all.
    assert.match(mounted.document.body.textContent ?? "", /1 missing|1 enrolled worker/u,
      "the successful read's own worker signal is not on screen, so there is nothing for the refresh to drop");
    const before = mounted.document.body.textContent ?? "";

    await mounted.refresh();

    const after = workerPanels(mounted.document);
    assert.ok(connectionReads >= 2, "the refresh did not issue a second worker read, so nothing was dropped");
    assert.equal(after.unavailable >= 1, true,
      "a failed refresh left the previous successful worker value on screen as though it were current");
    assert.doesNotMatch(mounted.document.body.textContent ?? "", /1 missing/u,
      `the stale value is still painted after a failed refresh: ${before} -> ${mounted.document.body.textContent}`);
    assert.match(mounted.document.body.textContent ?? "", /No zero count or all-clear is inferred\./u,
      "a failed refresh must state that no all-clear is inferred");
  } finally { await mounted.restore(); }
});
