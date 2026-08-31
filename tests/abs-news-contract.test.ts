import assert from "node:assert/strict";
import test from "node:test";
import {
  ABS_NEWS_ACTION_CATALOG_DIGEST_V1,
  ABS_NEWS_ACTION_CATALOG_V1,
  ABS_NEWS_PROJECT_ID_V1,
  ABS_NEWS_WORKSPACE_ID_V1,
  buildAbsNewsStoryV1,
  buildAbsNewsSyntheticWorkspaceV1,
  buildAbsNewsWorkOrderProposalV1,
  parseAbsNewsStoryV1,
  parseAbsNewsWorkOrderProposalV1,
} from "../src/project-adapters/abs-news/v1/index.ts";
import { ProjectWorkspaceContractErrorV1, parseProjectWorkspaceSnapshotV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const now = "2026-08-29T20:00:00.000Z";
const actorDigest = sha256Digest({ actor: "owner" });

function expectCode(action: () => unknown, code: ProjectWorkspaceContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === code);
}

function verifiedStory() {
  return buildAbsNewsSyntheticWorkspaceV1().stories[0]!;
}

function proposal(overrides: Record<string, unknown> = {}) {
  return buildAbsNewsWorkOrderProposalV1({
    proposalId: "proposal.abs.research.1",
    tenantId: "tenant.owner",
    workspaceId: ABS_NEWS_WORKSPACE_ID_V1,
    projectId: ABS_NEWS_PROJECT_ID_V1,
    story: verifiedStory(),
    actionId: "research_brief",
    requestedTitle: "Research the synthetic runtime release",
    goal: "Produce a source-backed research brief with conclusions and open questions.",
    requestedPlatform: "any",
    requestedByActorDigest: actorDigest,
    requestedAt: now,
    ...overrides,
  });
}

test("CR9D ABS fixture provides a project workspace, verified queues, source health, and the complete action catalog", () => {
  const fixture = buildAbsNewsSyntheticWorkspaceV1();
  assert.deepEqual(parseProjectWorkspaceSnapshotV1(fixture.workspace), fixture.workspace);
  assert.equal(fixture.workspace.sections.length, 18);
  assert.deepEqual(fixture.workspace.sections.slice(9).map((section) => section.label), ["Daily Brief", "AI and Tech News", "Newsletters", "Companies and People", "Saved Ideas", "Research Queue", "Drafts", "Published", "Audience"]);
  assert.equal(fixture.stories.filter((story) => story.queue === "important_now").length, 2);
  assert.equal(fixture.actionCatalog.length, 8);
  assert.equal(fixture.actionCatalogDigest, ABS_NEWS_ACTION_CATALOG_DIGEST_V1);
  assert.deepEqual(fixture.actionCatalog.map((action) => action.actionId), ABS_NEWS_ACTION_CATALOG_V1.map((action) => action.actionId));
  assert.equal(fixture.workspace.sourceStatuses.find((source) => source.sourceId === "source.abs.live-collection")?.state, "disabled");
});

test("CR9D ABS stories are exact, digest-bound, sanitized, and do not authorize a fetch", () => {
  const story = verifiedStory();
  assert.deepEqual(parseAbsNewsStoryV1(story), story);
  assert.equal(story.canonicalHost, "example.com");
  assert.equal(story.grantsNetworkAuthority, false);
  assert.equal(story.containsRawNewsletterBody, false);
  expectCode(() => parseAbsNewsStoryV1({ ...story, title: "Changed" }), "digest_mismatch");
  expectCode(() => parseAbsNewsStoryV1({ ...story, grantsNetworkAuthority: true }), "invalid_input");
});

test("CR9D ABS canonical URLs reject credentials, tracking queries, fragments, loopback, ports, and IP literals", () => {
  const base = verifiedStory();
  const unsafe = [
    "https://user:pass@example.com/story",
    "https://example.com/story?utm_source=mail",
    "https://example.com/story#section",
    "https://localhost/story",
    "https://example.com:8443/story",
    "https://127.0.0.1/story",
  ];
  for (const canonicalUrl of unsafe) expectCode(() => buildAbsNewsStoryV1({ ...base, canonicalUrl, storyDigest: undefined, canonicalHost: undefined, contractVersion: undefined, containsRawNewsletterBody: undefined, grantsNetworkAuthority: undefined, grantsCommandAuthority: undefined, grantsExecutionAuthority: undefined }), "invalid_input");
});

test("CR9D ABS article actions create only exact reviewable work-order proposals", () => {
  const value = proposal();
  assert.deepEqual(parseAbsNewsWorkOrderProposalV1(value), value);
  assert.deepEqual({ status: value.status, review: value.requiresOwnerReview, createsWorkItem: value.createsWorkItem, dispatch: value.dispatchState, approval: value.grantsApproval, network: value.grantsNetworkAuthority, command: value.grantsCommandAuthority, lease: value.grantsLeaseAuthority, execution: value.grantsExecutionAuthority }, { status: "draft", review: true, createsWorkItem: false, dispatch: "not_requested", approval: false, network: false, command: false, lease: false, execution: false });
  assert.equal(value.storyDigest, verifiedStory().storyDigest);
  assert.equal(value.actionCatalogDigest, ABS_NEWS_ACTION_CATALOG_DIGEST_V1);
  assert.equal(value.sourceEvidenceDigests.length, 2);
});

test("CR9D ABS proposal idempotency is stable for exact intent and changes with material intent", () => {
  const first = proposal(), replay = proposal({ proposalId: "proposal.abs.research.replay" });
  assert.equal(first.proposalIdempotencyKey, replay.proposalIdempotencyKey);
  assert.notEqual(first.proposalDigest, replay.proposalDigest);
  const changed = proposal({ goal: "Produce a different exact deliverable." });
  assert.notEqual(first.proposalIdempotencyKey, changed.proposalIdempotencyKey);
});

test("CR9D ABS review-only discoveries cannot enter the work-order proposal boundary", () => {
  const reviewOnly = buildAbsNewsSyntheticWorkspaceV1().stories.find((story) => story.verificationState === "review_only")!;
  expectCode(() => proposal({ story: reviewOnly }), "unsupported_action");
});

test("CR9D ABS proposals fail closed on scope and platform mismatch", () => {
  expectCode(() => proposal({ projectId: "project.other" }), "scope_mismatch");
  expectCode(() => proposal({ actionId: "tool_evaluation", requestedPlatform: "any" }), "unsupported_action");
  expectCode(() => proposal({ actionId: "monitor_updates", requestedPlatform: "macos" }), "unsupported_action");
});

test("CR9D ABS proposal catalog and digest cannot be rewritten by a caller", () => {
  const value = proposal();
  expectCode(() => parseAbsNewsWorkOrderProposalV1({ ...value, actionCatalogDigest: sha256Digest({ forged: true }) }), "digest_mismatch");
  expectCode(() => parseAbsNewsWorkOrderProposalV1({ ...value, grantsExecutionAuthority: true }), "invalid_input");
  expectCode(() => parseAbsNewsWorkOrderProposalV1({ ...value, routeProfileId: "route.forged" }), "digest_mismatch");
});

test("CR9D ABS exact boundary rejects accessors and proxies without executing traps", () => {
  let getterCalls = 0;
  const input: Record<string, unknown> = { proposalId: "proposal.abs.proxy", tenantId: "tenant.owner", workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, story: verifiedStory(), actionId: "research_brief", requestedTitle: "Research", goal: "Produce a safe report.", requestedPlatform: "any", requestedByActorDigest: actorDigest, requestedAt: now };
  Object.defineProperty(input, "goal", { enumerable: true, get() { getterCalls += 1; return "unsafe"; } });
  expectCode(() => buildAbsNewsWorkOrderProposalV1(input), "invalid_input");
  assert.equal(getterCalls, 0);
  const proxied = observedProxy({ ...input, goal: "Produce a safe report." }, "transparent");
  expectCode(() => buildAbsNewsWorkOrderProposalV1(proxied.value), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
});
