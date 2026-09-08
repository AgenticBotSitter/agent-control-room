import assert from "node:assert/strict";
import test from "node:test";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { createNativeOwnerReviewSession, type NativeOwnerReviewSessionPorts } from "../src/harness/v1/native-owner-review-session";
import { sha256Digest } from "../src/security";

const createSession: typeof createNativeOwnerReviewSession = process.env.CR_REUSE_COMPILED_OWNER_REVIEW === "1"
  ? (await import(new URL("../dist-vps/server/ownerReview.js", import.meta.url).href)).createNativeOwnerReviewSession
  : createNativeOwnerReviewSession;
assert.equal(typeof createSession, "function");
const signal = () => new AbortController().signal;
type Fixture = Awaited<ReturnType<typeof canonicalApprovalStorageFixture>>;
async function setup(f: Fixture, options: { secondFails?: boolean; asyncFence?: boolean } = {}) {
  const key = f.packet.approval.body.approvalKeyId;
  const target = { projectId: f.args[1], jobId: f.args[2], inputDigest: f.args[3] };
  let signatures = 0, loads = 0, consent: string | undefined, current = true;
  let loadSignal: AbortSignal | undefined;
  const ports: NativeOwnerReviewSessionPorts = {
    async load(expected, abort) {
      loads++; loadSignal = abort; assert.deepEqual(expected, target);
      const prepared = await f.coordinator.prepareNativeApproval(...f.args);
      return { input: { ...prepared, approvalKeyId: key, issuedAt: f.clock(),
        recoveryExpiresAt: prepared.start.deadline + 120_000, approvalNonce: "synthetic-review-approval", recoveryNonce: "synthetic-review-recovery" },
      assertCurrent: options.asyncFence ? async () => {} : () => { if (!current || abort.aborted) throw new Error("synthetic invalidated source"); } };
    },
    signer: { publicKeySpki: Buffer.from((await f.approvals.resolveApprovalKey(key))!).toString("base64url"), timeoutMs: 1000, clock: f.clock,
      assertOwnerConsentCurrent(digest) { if (consent !== digest) throw new Error("synthetic no consent"); f.approvals.assertAvailable(); },
      async sign(bytes, abort) {
        assert.equal(abort.aborted, false); signatures++;
        if (options.secondFails && signatures === 2) throw new Error("synthetic lost second output");
        return Buffer.from(f.sign(JSON.parse(Buffer.from(bytes).toString())).signature, "base64url");
      },
    },
  };
  const session = createSession(target, ports);
  return { target, ports, session, counts: () => ({ loads, signatures }), consent: (digest: string) => { consent = digest; },
    invalidate: () => { current = false; }, loadSignal: () => loadSignal };
}

test("owner session loads actual canonical review, signs exact consent once and stores without starting work", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); const x = await setup(f); t.after(() => x.session.close());
  assert.equal(x.session.snapshot().phase, "new"); assert.deepEqual(x.counts(), { loads: 0, signatures: 0 });
  const reviewed = await x.session.prepare(signal());
  assert.equal(x.session.snapshot().phase, "review"); assert.equal(x.loadSignal()?.aborted, false);
  assert.equal(reviewed.review.jobId, x.target.jobId); assert.equal(reviewed.review.inputDigest, x.target.inputDigest);
  assert.equal("enrollment" in reviewed, false); assert.equal("input" in reviewed, false); assert.equal(await f.count(), 0);
  assert.deepEqual(x.counts(), { loads: 1, signatures: 0 }); x.consent(reviewed.reviewDigest);
  const packet = await x.session.issue(reviewed.reviewDigest, signal());
  assert.equal(x.session.snapshot().phase, "issued"); assert.equal("review" in x.session.snapshot(), false);
  assert.equal(x.loadSignal()?.aborted, true); assert.deepEqual(x.counts(), { loads: 1, signatures: 2 });
  assert.equal(await f.count(), 0, "signing does not store or dispatch");
  const receipt = await f.save(packet); assert.equal(receipt.startsWork, false); assert.equal(receipt.packetDigest, sha256Digest(packet));
  assert.equal((await f.save(packet)).replayed, true); assert.equal(await f.count(), 1);
  await assert.rejects(x.session.issue(reviewed.reviewDigest, signal()));
  await assert.rejects(x.session.prepare(signal())); assert.deepEqual(x.counts(), { loads: 1, signatures: 2 });
});

test("review echo is not consent; changed source and partial signatures cannot retry", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  for (const mode of ["no-consent", "wrong-digest", "source-changed", "partial", "closed", "async-source"] as const) {
    const x = await setup(f, { secondFails: mode === "partial", asyncFence: mode === "async-source" }); t.after(() => x.session.close());
    if (mode === "async-source") { await assert.rejects(x.session.prepare(signal())); assert.equal(x.counts().signatures, 0); continue; }
    const review = await x.session.prepare(signal()); if (mode !== "no-consent") x.consent(review.reviewDigest);
    if (mode === "source-changed") x.invalidate(); if (mode === "closed") x.session.close();
    const digest = mode === "wrong-digest" ? sha256Digest("other review") : review.reviewDigest;
    await assert.rejects(x.session.issue(digest, signal()));
    await assert.rejects(x.session.issue(review.reviewDigest, signal()));
    assert.equal(x.counts().signatures, mode === "partial" ? 2 : 0);
    assert.equal(await f.count(), 0);
  }
});

test("canceled loading cannot publish a late review or call a signer", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); const x = await setup(f);
  const original = x.ports.load; let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  x.ports.load = async (...args) => { const prepared = await original(...args); entered();
    await new Promise<void>(resolve => { release = resolve; }); return prepared; };
  const session = createSession(x.target, x.ports); t.after(() => session.close());
  const pending = session.prepare(signal()); await started; session.close();
  await assert.rejects(pending); release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().phase, "closed"); assert.equal("review" in session.snapshot(), false);
  assert.equal(x.counts().signatures, 0); assert.equal(await f.count(), 0);
});

test("source invalidation at the issuer handoff cannot release a completed packet", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); const x = await setup(f);
  const sign = x.ports.signer.sign; let calls = 0;
  x.ports.signer.sign = async (...args) => {
    const bytes = await sign(...args); calls++;
    if (calls === 2) queueMicrotask(() => queueMicrotask(x.invalidate));
    return bytes;
  };
  const session = createSession(x.target, x.ports); t.after(() => session.close());
  const review = await session.prepare(signal()); x.consent(review.reviewDigest);
  await assert.rejects(session.issue(review.reviewDigest, signal()));
  assert.equal(session.snapshot().phase, "unavailable"); assert.equal(calls, 2);
  await assert.rejects(session.issue(review.reviewDigest, signal())); assert.equal(calls, 2);
  assert.equal(await f.count(), 0);
});

test("canonical preparation for another target never becomes the owner's displayed review", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); const x = await setup(f);
  const load = x.ports.load;
  const session = createSession({ ...x.target, projectId: "project:other" }, {
    ...x.ports, load: (_target, abort) => load(x.target, abort),
  });
  t.after(() => session.close()); await assert.rejects(session.prepare(signal()));
  assert.equal(session.snapshot().phase, "unavailable"); assert.equal("review" in session.snapshot(), false);
  assert.equal(x.counts().signatures, 0);
});

test("overdue preparation cannot publish before the timer callback gets a turn", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); const x = await setup(f);
  let monotonic = 0;
  const mocked = t.mock.method(performance, "now", () => monotonic);
  const load = x.ports.load;
  const session = createSession(x.target, { ...x.ports, async load(...args) {
    const prepared = await load(...args); monotonic = 5001; return prepared;
  } });
  t.after(() => session.close());
  await assert.rejects(session.prepare(signal())); mocked.mock.restore();
  assert.equal(session.snapshot().phase, "unavailable"); assert.equal(x.counts().signatures, 0);
  assert.equal("review" in session.snapshot(), false);
});
