// R7C-01(c), database-free: the connector must treat an `expired` claim refusal
// as "this one offer cannot be taken" and MOVE ON to the next one.
//
// The bug was a single line in `runWorker`'s claim loop. Its catch handled
// `conflict` and `not_found` (someone else got it, it is gone) and rethrew
// everything else; the outer catch then reported `unreachable`, logged
// "Could not take work (refused); trying again" and abandoned the pass. Since
// offers are ordered by priority and then oldest-first, a single unclaimable
// offer at the head of the list wedged the machine for the life of its
// process: every newer task behind it stayed unclaimed while the log insisted
// Control Room was unreachable.
//
// `expired` is in the connector's own fixed refusal vocabulary
// (`FLEET_REFUSAL_CODES`), so the gateway can and does answer it -- the
// connector simply had no branch for it. Three shapes are proved here, and the
// third is the one that is easiest to get wrong:
//
//   1. an expired offer at the HEAD of the list, with a good offer behind it
//      (the reported shape);
//   2. an expired offer ALONE (nothing is lost, and nothing is invented);
//   3. a code that is NOT in the fixed set still ends the pass -- this branch
//      must not have been widened into swallowing arbitrary errors.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as connector from "../scripts/fleet/connector.mjs";

const WORKER = { workerId: `fleet-worker:${"a".repeat(32)}`, displayName: "R7C", workerKind: "codex",
  projectIds: ["project:qa"], capabilities: ["writing"], credentialExpiresAt: "2099-01-01T00:00:00.000Z",
  workingAgreement: connector.WORKING_AGREEMENT, operationsMode: "running" };
const OFFER = { offerId: `fleet-offer:${"b".repeat(32)}`, projectId: "project:qa", jobId: "job:one",
  capability: "writing", title: "One", objective: "Do one." };
const LATER = { offerId: `fleet-offer:${"c".repeat(32)}`, projectId: "project:qa", jobId: "job:two",
  capability: "writing", title: "Two", objective: "Do two." };
const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const refused = (status, error) => new Response(JSON.stringify({ ok: false, error }), { status });

/** One `run` pass over a fixed offer list, where each claim is answered by
 * `onClaim`. Returns the logs and the claim attempts in order.
 *
 * The harness settings file is a REAL one, naming a deterministic fake adapter,
 * because this is about what the `run` loop does with offers it cannot take --
 * and a `run` loop whose harness is not enabled never reaches the claim loop at
 * all, which would make every assertion below vacuous.
 *
 * `client.work()` returns a BARE ARRAY of offers (`work: () => call("GET",
 * "/fleet/v1/work")`), not an envelope: the operations mode comes from the
 * heartbeat this pass has already made. A fixture that answers with an
 * envelope here fails as `offers.filter is not a function`, which is how that
 * was found. */
async function pass(t, offers, onClaim) {
  const root = await mkdtemp(join(tmpdir(), "r7c-connector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bot.json");
  await writeFile(path, JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER.workerId, secret: `crf_${"A".repeat(43)}`, credentialExpiresAt: WORKER.credentialExpiresAt,
    workerKind: "codex" }), { mode: 0o600 });
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, "export const createFleetHarnessAdapter = () => ({"
    + "execute: async () => ({ kind: 'completed', text: 'done', startedAt: new Date().toISOString(),"
    + " finishedAt: new Date().toISOString(), usage: null }) });", { mode: 0o600 });
  const harnessesPath = join(root, "harnesses.json");
  await writeFile(harnessesPath, JSON.stringify({ schema: "control-room.fleet-harnesses/v1",
    adapterModule: adapterPath, harnesses: { codex: { enabled: true, deadlineMs: 5_000 } } }), { mode: 0o600 });
  const logs = [], claimed = [];
  const fetcher = async (url, init) => {
    const path_ = new URL(String(url)).pathname;
    if (path_ === "/fleet/v1/heartbeat") return ok(WORKER);
    if (path_ === "/fleet/v1/work") return ok(offers);
    if (path_ === "/fleet/v1/claims" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      claimed.push(body.offerId);
      return onClaim(body.offerId);
    }
    if (path_.endsWith("/progress")) return ok({ eventId: `fleet-event:${"e".repeat(32)}`, replayed: false,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z" });
    if (path_.endsWith("/result")) return ok({ resultId: `fleet-result:${"f".repeat(32)}`, replayed: false,
      taskState: "waiting_approval", accepted: false });
    throw new Error(`unexpected request ${path_}`);
  };
  const result = await connector.runWorker({ configPath: path, harnessesPath, once: true, fetcher,
    log: (m) => logs.push(m) });
  return { result, logs, claimed };
}

test("R7C-01c: an expired offer at the head of the list is skipped, and the next one is claimed", async t => {
  const { result, logs, claimed } = await pass(t, [OFFER, LATER], (offerId) =>
    offerId === OFFER.offerId ? refused(410, "expired") : ok({ claimId: `fleet-claim:${"d".repeat(32)}`,
      offerId, projectId: LATER.projectId, jobId: LATER.jobId, title: LATER.title, instructions: LATER.objective,
      leaseState: "active", leaseExpiresAt: "2099-01-01T00:00:00.000Z", taskState: "leased",
      replayed: false, grantsApproval: false, grantsMerge: false }));
  // Both offers were tried: the loop did not stop at the first refusal.
  assert.deepEqual(claimed, [OFFER.offerId, LATER.offerId],
    "the pass keeps going past an offer nobody can take");
  assert.equal(result.state, "ran",
    `the machine runs the work it CAN take, rather than giving up the pass: ${JSON.stringify(result)}`);
  assert.equal(result.jobId, LATER.jobId, "and it is the newer task, not the expired one");
  assert.equal(result.outcome, "submitted", "so the offer behind the stale one is not merely listed");
  // The owner can see why, in the service log, rather than being told the
  // gateway was unreachable.
  assert.ok(logs.some(line => /can no longer be claimed/.test(line)),
    `the log says why an offered task was never taken: ${JSON.stringify(logs)}`);
  assert.ok(!logs.some(line => /Could not take work/.test(line)),
    `an expired offer is never reported as an outage: ${JSON.stringify(logs)}`);
});

test("R7C-01c: an expired offer alone ends the pass idle, having claimed nothing", async t => {
  const { result, logs, claimed } = await pass(t, [OFFER], () => refused(410, "expired"));
  assert.deepEqual(claimed, [OFFER.offerId], "the one offer was tried exactly once");
  assert.notEqual(result.state, "unreachable",
    `an expired offer is not an outage: ${JSON.stringify(result)}`);
  assert.ok(logs.some(line => /can no longer be claimed/.test(line)),
    `the reason is in the log: ${JSON.stringify(logs)}`);
});

test("R7C-01c: a code outside the fixed refusal set still ends the pass", async t => {
  // The catch must have grown ONE new branch, not a general swallow. A refusal
  // the connector does not recognise is a transport or client bug, and the
  // old behaviour (report it, back off, try the whole pass again) is right for
  // it: silently skipping such an offer would hide a real fault.
  const { result, logs } = await pass(t, [OFFER, LATER], () => refused(500, "refused"));
  assert.equal(result.state, "unreachable",
    `an unrecognised code is still reported honestly: ${JSON.stringify(result)}`);
  assert.ok(logs.some(line => /Could not take work \(refused\)/.test(line)),
    `and it is named in the log: ${JSON.stringify(logs)}`);
});

test("R7C-01c: the MCP claim tool reports `expired` as a code a bot can act on", async t => {
  // The fixed set is what the gateway's answer is matched against, and what
  // makes the refusal reachable at all as a code rather than prose. If `expired`
  // were missing from it, an MCP caller would get no `structuredContent`
  // refusal code and would have nothing to branch on -- the same hole this fix
  // closes, one layer up.
  const root = await mkdtemp(join(tmpdir(), "r7c-connector-code-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reply = { jsonrpc: "2.0", id: 1, result: { isError: true,
    content: [{ type: "text", text: "Control Room refused the request (expired)." }],
    structuredContent: { refusalCode: "expired" } } };
  const client = { me: async () => WORKER, mcpCall: async () => ({ recorded: true }),
    claim: async () => { const error = new Error("Control Room refused the request (expired)."); error.code = "expired";
      error.status = 410; throw error; } };
  const dispatch = connector.createMcpDispatcher({ client });
  const answer = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "claim", arguments: { offerId: OFFER.offerId, idempotencyKey: "r7c-mcp-claim-0001" } } });
  assert.equal(answer.result.isError, true, "the claim is refused");
  assert.equal(answer.result.structuredContent?.refusalCode, "expired",
    `the bot is handed the code, not only prose: ${JSON.stringify(answer)}`);
  // The reply is the connector's own envelope, echoed back unchanged apart from
  // the JSON-RPC id -- no argument was silently retried and no claim was made.
  assert.equal(answer.id, reply.id);
  assert.equal(answer.jsonrpc, reply.jsonrpc);
});