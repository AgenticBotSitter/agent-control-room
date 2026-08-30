import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  ABS_NEWS_PROJECT_ID_V1, ABS_NEWS_WORKSPACE_ID_V1, SqliteAbsNewsControlStoreV1,
  buildAbsNewsMaterializationReceiptV1, buildAbsNewsProposalReviewV1, buildAbsNewsSyntheticWorkspaceV1,
  buildAbsNewsWorkOrderProposalV1, persistAbsNewsMaterializationV1, projectAbsNewsMaterializationV1,
} from "../src/project-adapters/abs-news/v1/index.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const scope = { tenantId: "tenant.owner", workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1 };
const t0 = "2026-08-29T22:00:00.000Z", t1 = "2026-08-29T22:01:00.000Z", t2 = "2026-08-29T22:02:00.000Z", t3 = "2026-08-30T22:02:00.000Z";
const key = new Uint8Array(32).fill(41);

function proposal() {
  return buildAbsNewsWorkOrderProposalV1({ proposalId: "proposal.abs.materialize.1", ...scope, story: buildAbsNewsSyntheticWorkspaceV1().stories[0], actionId: "research_brief", requestedTitle: "Research the verified release", goal: "Produce a bounded source-backed report for owner review.", requestedPlatform: "any", requestedByActorDigest: sha256Digest({ actor: "owner" }), requestedAt: t0 });
}
function review(decision: "accepted" | "rejected" = "accepted") { return buildAbsNewsProposalReviewV1({ reviewId: `review.abs.${decision}.1`, proposal: proposal(), decision, safeReasonCode: decision === "accepted" ? "owner_accepts_exact_proposal" : "owner_declines_proposal", reviewerActorDigest: sha256Digest({ reviewer: "owner" }), reviewedAt: t1 }); }
async function database() { const db = new PGlite(); for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) await db.exec(await readFile(resolve("db/migrations", file), "utf8")); await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [scope.tenantId, "Owner"]); return db; }

test("CR9D-ABS-040 owner review stays separate from approval and projects into Action Inbox", () => {
  const pending = projectAbsNewsMaterializationV1({ proposal: proposal() });
  assert.deepEqual({ state: pending.actionInbox.state, kind: pending.actionInbox.kind, blocked: pending.actionInbox.blockedWorkItemIds }, { state: "open", kind: "review", blocked: [proposal().proposalId] });
  const accepted = review();
  assert.equal(accepted.grantsApproval, false);
  assert.equal(accepted.grantsDispatchAuthority, false);
  assert.equal(projectAbsNewsMaterializationV1({ proposal: proposal(), review: accepted }).actionInbox.state, "resolved");
  assert.throws(() => buildAbsNewsMaterializationReceiptV1({ proposal: proposal(), acceptedReview: review("rejected"), materializedAt: t2, authorityExpiresAt: t3 }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "unsupported_action");
});

test("CR9D-ABS-040 accepted proposal atomically creates only canonical proposed records and exact replay", async () => {
  const receipt = buildAbsNewsMaterializationReceiptV1({ proposal: proposal(), acceptedReview: review(), materializedAt: t2, authorityExpiresAt: t3 });
  assert.deepEqual({ request: receipt.request.state, workflow: receipt.workflow.state, job: receipt.job.state, attempts: receipt.createsAttempt, leases: receipt.createsLease, dispatch: receipt.dispatchState, network: receipt.job.authority.networkPolicy, effects: receipt.job.authority.effectPolicy }, { request: "draft", workflow: "proposed", job: "proposed", attempts: false, leases: false, dispatch: "not_requested", network: "none", effects: "none" });
  const db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    assert.equal((await persistAbsNewsMaterializationV1({ canonicalStore: canonical, receipt })).replayed, false);
    assert.equal((await persistAbsNewsMaterializationV1({ canonicalStore: new CanonicalStore(adaptPglite(db)), receipt })).replayed, true);
    const counts = await db.query<{ attempts: string; leases: string; outbox: string }>("SELECT (SELECT count(*) FROM control_attempts)::text attempts,(SELECT count(*) FROM control_leases)::text leases,(SELECT count(*) FROM control_outbox)::text outbox");
    assert.deepEqual(counts.rows[0], { attempts: "0", leases: "0", outbox: "0" });
    await assert.rejects(canonical.createProposedWorkBundle({ request: { ...receipt.request, title: "Changed" }, workflow: receipt.workflow, job: receipt.job }), /replay conflict/);
  } finally { await db.close(); }
});

test("CR9D-ABS-040 authenticated control ledger survives restart and rejects review/materialization drift", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abs-control-")), path = join(dir, "control.sqlite");
  try {
    let store = new SqliteAbsNewsControlStoreV1(path, scope, { integrityKey: key, mode: "create" });
    const accepted = review(), receipt = buildAbsNewsMaterializationReceiptV1({ proposal: proposal(), acceptedReview: accepted, materializedAt: t2, authorityExpiresAt: t3 });
    assert.equal(store.saveReview(accepted, proposal()).replayed, false);
    assert.equal(store.saveReview(accepted, proposal()).replayed, true);
    assert.equal(store.saveMaterialization(receipt).replayed, false);
    assert.throws(() => store.saveReview(review("rejected"), proposal()), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "replay_drift");
    const before = store.verifyIntegrity(); store.close();
    store = new SqliteAbsNewsControlStoreV1(path, scope, { integrityKey: key, mode: "open" });
    assert.equal(store.listReviews().length, 1); assert.equal(store.listMaterializations().length, 1); assert.deepEqual(store.verifyIntegrity(), before); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
