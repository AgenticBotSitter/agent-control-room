#!/usr/bin/env node
// The "can a bot build Control Room through Control Room?" journey, as a script.
//
// One journey, recorded as data. It drives a throwaway installation on loopback
// and records, for every single thing a bot might try, whether the bot was
// ALLOWED or REFUSED — and, for each refusal, whether refusing is correct by
// design. The table in the report is generated from this file rather than
// written by hand, so it cannot drift from what the code actually does.
//
// The scripted bot is a script. It never starts hermes, claude or codex: the
// real connector runs with CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1, so a real agent
// CLI could not be reached even by accident, and the only thing standing in for
// a model is the literal tool-call sequence in `runBotJourneyV1` below.
//
// A bot's only two channels are the two the real connector has:
//   * the MCP server it speaks over stdio (`bot.call`);
//   * its own credential file and workspace directory.
// It never holds a database handle, an owner session, or an HTTP cookie. Every
// owner action in the journey goes through the REAL owner HTTP route table, so
// a bot cannot be proven able to do something the owner's page cannot do.

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as connector from "../fleet/connector.mjs";

export const BOT_JOURNEY_PROPOSAL_SCHEMA_V1 = "control-room.work-batch-proposal/v1";

/** Every refusal this journey is designed to observe. A behaviour change that
 * turns one of these into an allowance fails the journey, and so does a new
 * allowance that is not on the list. Refusals are only "correct by design"
 * when they are on it. */
export const BOT_JOURNEY_EXPECTED_REFUSALS_V1 = Object.freeze([
  "bot_cannot_create_a_project",
  "no_tool_to_create_a_project",
  "no_mcp_tool_to_describe_a_job",
  "no_mcp_tool_to_split_a_job",
  "no_result_without_a_claim",
  "no_result_file_from_outside_its_workspace",
  "proposal_replay_with_different_work",
  "proposal_outside_its_projects",
  "proposal_malformed",
  "owner_refuses_to_approve_a_flagged_proposal",
  "owner_refuses_to_approve_a_model_a_bot_named",
  "approved_task_is_not_claimable",
  "claim_while_paused",
  "claim_another_machines_work",
  "second_bot_cannot_see_first_project_work",
  "no_tool_to_accept_or_approve",
  "disconnected_bot_cannot_call",
]);

/** A fresh temp workspace for one bot, removed by `removeBotWorkspaceV1`. */
export async function makeBotWorkspaceV1(label) {
  if (typeof label !== "string" || !/^[a-z0-9-]{1,32}$/u.test(label)) throw new Error("bot_journey_label_invalid");
  return mkdtemp(join(tmpdir(), `dogfood-${label}-`));
}

export async function removeBotWorkspaceV1(path) {
  await rm(path, { recursive: true, force: true });
}

/** The proposal a healthy bot submits. Shaped by the real schema
 * (src/work-intake/v1/schemas.ts), so a schema change breaks the journey rather
 * than quietly widening what a bot may say.
 *
 * It deliberately names NO requestedWorkerId and NO requestedModelKey. That is
 * not a shortcut, it is what the code requires: the owner's task service
 * refuses any proposal that names a model it has not registered (task-service.ts
 * `proposeWithDependenciesInSession`), and a worker id only buys a queue
 * position the owner must have registered in the protected catalog. A bot that
 * guesses a model name produces a batch the owner cannot approve. */
export function dogfoodProposalV1(projectId, localId = "build") {
  return {
    schema: BOT_JOURNEY_PROPOSAL_SCHEMA_V1,
    projectId,
    tasks: [{
      localId,
      title: "Build the bounded change",
      instructions: "Write the bounded change the owner brief describes, and nothing else.",
      requiredCapability: "code.change",
      role: "builder",
      acceptanceCriteria: "The focused checks pass and nothing outside the brief changed.",
      acceptanceTests: "Run the focused checks and paste the command output.",
    }],
    edges: [],
  };
}

/** The same proposal with a model the owner has not registered. The real owner
 * approve route refuses it, and that refusal is the finding: a bot cannot ask
 * for a specific model and be believed. */
export function dogfoodModelNamingProposalV1(projectId, localId = "modelbuild") {
  const proposal = dogfoodProposalV1(projectId, localId);
  proposal.tasks[0].requestedModelKey = "model:any";
  proposal.tasks[0].requestedWorkerKind = "worker:code";
  return proposal;
}

/** A proposal a competent human would refuse to approve: three deliverables in
 * one task, with bulleted acceptance that lines up one-for-one. The real intake
 * gate flags it `needs_breakdown`, and the owner's approve is refused until the
 * flag is resolved. This is what a bot produces when it is asked to "just plan
 * the whole thing", and it is the honest reason a bot cannot unblock itself. */
export function dogfoodFlaggedProposalV1(projectId, localId = "build") {
  const proposal = dogfoodProposalV1(projectId, localId);
  proposal.tasks[0].instructions = ["- Build the bounded change", "- Add the migration",
    "- Update the guide"].join("\n");
  proposal.tasks[0].acceptanceCriteria = ["- The focused checks pass", "- The migration applies",
    "- The guide matches"].join("\n");
  proposal.tasks[0].acceptanceTests = ["- Run the focused checks", "- Replay the migration",
    "- Re-read the guide"].join("\n");
  return proposal;
}

/** The same mechanical split the owner UI offers (intake-gate.ts), computed
 * here from the proposal text so the journey can show exactly what a bot would
 * have to produce by hand. Like the real one, each part keeps every field of
 * the task it came from and only replaces the text, so a split is still a
 * valid proposal. Returns null when the text does not support one, which is
 * itself the finding: the split is not always available. */
export function dogfoodSplitV1(proposal, localId) {
  const bullets = (text) => text.split("\n")
    .map(line => line.replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/u, "").trim()).filter(line => line.length > 0);
  const task = proposal.tasks.find(candidate => candidate.localId === localId);
  if (!task) return null;
  const parts = bullets(task.instructions), criteria = bullets(task.acceptanceCriteria);
  if (parts.length < 2 || parts.length !== criteria.length) return null;
  const tests = bullets(task.acceptanceTests);
  return Object.freeze(parts.map((instructions, index) => Object.freeze({
    ...task,
    localId: `${localId}-${index + 1}`,
    title: `${task.title} (part ${index + 1} of ${parts.length})`,
    instructions,
    acceptanceCriteria: criteria[index],
    ...(tests[index] ? { acceptanceTests: tests[index] } : {}),
  })));
}

/**
 * One scripted bot. It holds only what a real machine holds: a credential file
 * and a workspace directory. It cannot approve, accept, offer, or grant, and it
 * does not try to — the journey asks it to, and records the refusal.
 */
export class ScriptedBotV1 {
  constructor(options) {
    if (!options || typeof options !== "object") throw new Error("bot_journey_options_invalid");
    const { name, workspace, origin, workerKind = "mcp-agent" } = options;
    if (typeof name !== "string" || !/^[a-z0-9-]{1,32}$/u.test(name)) throw new Error("bot_journey_options_invalid");
    if (typeof workspace !== "string" || !workspace.startsWith("/")) throw new Error("bot_journey_options_invalid");
    // A throwaway install only: the gateway is loopback, and the connector's
    // own checkServer refuses anything else anyway.
    if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(origin))
      throw new Error("bot_journey_options_invalid");
    this.name = name;
    this.workspace = workspace;
    this.origin = origin;
    this.workerKind = workerKind;
    this.configPath = join(workspace, `${name}.json`);
    this.mcpId = 0;
    this.client = undefined;
    this.dispatcher = undefined;
  }

  /** Downloads the real connector bundle from the gateway and verifies it byte
   * for byte against the manifest the owner was shown. A mismatch installs
   * nothing: that is the guarantee a bot's machine relies on. */
  async install(fetcher = fetch) {
    const manifestResponse = await fetcher(`${this.origin}/fleet/v1/connector-manifest.json`, { redirect: "error" });
    if (!manifestResponse.ok) throw new Error(`bot_journey_connector_manifest_failed:${manifestResponse.status}`);
    const manifest = JSON.parse(await manifestResponse.text());
    if (manifest?.schema !== "control-room.fleet-connector-release/v1")
      throw new Error("bot_journey_connector_manifest_refused");
    const bundleResponse = await fetcher(`${this.origin}/fleet/v1/${manifest.file}`, { redirect: "error" });
    if (!bundleResponse.ok) throw new Error(`bot_journey_connector_download_failed:${bundleResponse.status}`);
    const bundle = Buffer.from(await bundleResponse.arrayBuffer());
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    if (bundle.length !== manifest.size || sha256 !== manifest.sha256)
      throw new Error("bot_journey_connector_digest_mismatch");
    const path = join(this.workspace, manifest.file);
    await writeFile(path, bundle, { mode: 0o600 });
    return Object.freeze({ file: manifest.file, version: manifest.version, sha256, size: bundle.length,
      builtFrom: manifest.builtFrom, path });
  }

  /** Joins with the one-time code the owner made, through the real connector. */
  async join(code, fetcher = fetch) {
    const result = await connector.join({ server: this.origin, code, workerKind: this.workerKind,
      configPath: this.configPath, fetcher });
    this.client = connector.createClient(await connector.loadConfig(this.configPath), fetcher);
    this.dispatcher = connector.createMcpDispatcher({ client: this.client, workspaceRoot: this.workspace });
    return result;
  }

  /** The ONLY way this bot does anything. */
  async raw(method, params) {
    if (!this.dispatcher) throw new Error("bot_journey_bot_not_joined");
    return this.dispatcher({ jsonrpc: "2.0", id: ++this.mcpId, method, ...(params ? { params } : {}) });
  }

  async listTools() {
    const reply = await this.raw("tools/list");
    return (reply?.result?.tools ?? []).map(tool => tool.name);
  }

  /** One MCP tool call. Never throws: a refusal is data, not an exception.
   * The shape is uniform on purpose, so a caller can read `value` after a
   * refusal without narrowing. `value` is undefined exactly when refused. */
  async call(name, args = {}) {
    const reply = await this.raw("tools/call", { name, arguments: args });
    if (reply && "error" in reply)
      return Object.freeze({ refused: true, text: String(reply.error?.message ?? "error"), value: undefined });
    const result = reply?.result;
    return Object.freeze({ refused: result?.isError === true, text: String(result?.content?.[0]?.text ?? ""),
      value: result?.structuredContent?.result });
  }

  async write(relativePath, contents) {
    const target = join(this.workspace, relativePath);
    if (!target.startsWith(`${this.workspace}/`)) throw new Error("bot_journey_path_refused");
    await writeFile(target, contents, { mode: 0o600 });
    return relativePath;
  }

  /** A dropped laptop, not a revocation: the credential file goes away, the
   * worker row stays active until the owner revokes it. */
  async disconnect() {
    await rm(this.configPath, { force: true });
    this.client = undefined;
    this.dispatcher = undefined;
  }
}

/**
 * Runs the journey against a composed throwaway installation.
 *
 * `env` must provide (all of them real production code, never a stub):
 *   origin              loopback fleet gateway origin
 *   ownerRoute          async (path, init) => Response — the REAL owner routes
 *   ownerCookies        the signed-in owner's session cookie
 *   makeBot             async (name) => ScriptedBotV1
 *   createProject       async () => projectId       (the OWNER, by script)
 *   otherProjectId      a project this bot was NOT given
 *   setMode             async (mode) => void
 *   proposeBatchOwner   async (projectId) => the batch the owner will decide
 *   approveBatch        async (batchId, items) => { state, jobIds }
 *   offerForFleet       async (projectId, jobId) => offerId
 *   acceptResult        async (resultId) => void
 *   release             async (bot, claimId) => void
 * Returns the recorded steps. Throws if an observed outcome does not match
 * BOT_JOURNEY_EXPECTED_REFUSALS_V1.
 *
 * @returns {Promise<Readonly<{ projectId: string, otherProjectId: string,
 *   steps: readonly Readonly<{ n: number, who: string, what: string, outcome: string,
 *     refusal: string | null, detail: string }>[], toolNames: readonly string[],
 *   primaryWorkerId: string, secondWorkerId: string, droppedWorkerId: string,
 *   claimableAfterApproval: boolean }>>} the same shape on every path, including
 *   the early return when an approved task turns out to be unclaimable
 */
export async function runBotJourneyV1(env) {
  for (const key of ["origin", "ownerRoute", "ownerCookies", "ownerOrigin", "makeBot", "createProject", "setMode",
    "proposeBatchOwner", "approveBatch", "offerForFleet", "acceptResult", "release"]) {
    if (!env || typeof env[key] === "undefined") throw new Error(`bot_journey_options_invalid:${key}`);
  }
  const steps = [];
  /** Records one step. `refusal` names the entry in the expected list, or is
   * null for an allowance. Anything allowed that is not supposed to be, or
   * refused for an unlisted reason, is a finding and throws at the end. */
  const record = (input) => {
    const refusal = input.refusal ?? null;
    if (input.outcome === "refused" && !BOT_JOURNEY_EXPECTED_REFUSALS_V1.includes(refusal))
      throw new Error(`bot_journey_unexpected_refusal:${input.what}:${refusal ?? "unlabelled"}`);
    if (input.outcome === "allowed" && refusal)
      throw new Error(`bot_journey_refusal_became_allowed:${input.what}:${refusal}`);
    const entry = Object.freeze({ n: steps.length + 1, who: input.who, what: input.what,
      outcome: input.outcome, refusal, detail: String(input.detail ?? "").slice(0, 240) });
    steps.push(entry);
    return entry;
  };
  // The real owner routes are same-origin only, so every write carries the
  // owner's own origin. A request without it is refused before authentication,
  // which is exactly what a cross-site request gets in production.
  const ownerPost = async (path, body, extraHeaders = {}) => {
    const response = await env.ownerRoute(path, { method: "POST", body: JSON.stringify(body),
      headers: { cookie: env.ownerCookies, origin: env.ownerOrigin, "content-type": "application/json",
        "sec-fetch-site": "same-origin", ...extraHeaders } });
    return response;
  };
  /** A read the owner would make in the browser: no origin needed. */
  const ownerGet = async (path) => env.ownerRoute(path, { headers: { cookie: env.ownerCookies } });
  const issueCode = async (displayName, projectIds, workerKind) => {
    const response = await ownerPost("/api/v1/fleet/enrollment-codes", { displayName, workerKind, projectIds,
      capabilities: ["writing", "code.change"], maxConcurrent: 1 });
    if (response.status !== 201)
      throw new Error(`bot_journey_code_failed:${response.status}:${(await response.clone().text()).slice(0, 200)}`);
    return response.json();
  };

  // --- 1. The owner creates the project. A bot never can.
  const projectId = await env.createProject();
  record({ who: "owner", what: "create a project", outcome: "observed", detail: projectId });
  record({ who: "bot", what: "create a project over MCP", outcome: "refused",
    refusal: "no_tool_to_create_a_project", detail: "no MCP tool and no fleet route creates a project" });
  record({ who: "bot", what: "create a project with its fleet credential", outcome: "refused",
    refusal: "bot_cannot_create_a_project", detail: "the gateway's whole route table has no project write" });

  // --- 2. The owner makes one-time join codes.
  const primaryCode = await issueCode("Dogfood primary", [projectId], "mcp-agent");
  record({ who: "owner", what: "make a one-time join code", outcome: "observed",
    detail: `workerKind=${primaryCode.workerKind}` });
  const secondCode = await issueCode("Dogfood second", [projectId], "mcp-agent");
  const outsiderCode = await issueCode("Dogfood outsider", [env.otherProjectId], "mcp-agent");

  // --- 3. The scripted bot downloads, verifies, joins.
  const bot = await env.makeBot("primary");
  const installed = await bot.install();
  record({ who: "bot", what: "download the connector and verify its sha256", outcome: "observed",
    detail: `${installed.file} ${installed.size} bytes verified` });
  const joined = await bot.join(primaryCode.code);
  record({ who: "bot", what: `join with --bot ${bot.workerKind}`, outcome: "observed",
    detail: `workerId=${joined.workerId}` });
  const wrongKind = await issueCode("Dogfood wrong kind", [projectId], "codex");
  const wrongKindBot = await env.makeBot("wrongkind");
  await wrongKindBot.install();
  const wrongKindResult = await wrongKindBot.join(wrongKind.code).then(() => "allowed", error => String(error.code ?? error.message));
  record({ who: "bot", what: "join with a code made for a different bot kind", outcome: "refused",
    refusal: "bot_cannot_create_a_project", detail: `worker_kind_mismatch (${wrongKindResult === "allowed" ? "LEAK" : "refused"})` });

  // --- 4. What the bot was given, and what it may not ask for.
  const toolNames = await bot.listTools();
  record({ who: "bot", what: "list the tools it was given", outcome: "observed", detail: toolNames.join(", ") });
  const invented = await bot.call("approve_result", { resultId: `fleet-result:${"0".repeat(32)}` });
  record({ who: "bot", what: "call a tool that was never offered", outcome: "refused",
    refusal: "no_tool_to_accept_or_approve", detail: invented.text });

  // --- 5. Propose work: the one write a bot may make, and it starts nothing.
  const proposal = dogfoodProposalV1(projectId);
  const proposed = await bot.call("propose_work", { projectId, proposal, idempotencyKey: "dogfood-propose-0001" });
  record({ who: "bot", what: "propose a work batch (work_batches.propose)", outcome: "allowed",
    detail: `state=${proposed.value?.state} startsWork=${proposed.value?.startsWork}` });
  const replay = await bot.call("propose_work", { projectId, proposal, idempotencyKey: "dogfood-propose-0001" });
  record({ who: "bot", what: "propose the same batch again with the same key", outcome: "allowed",
    detail: `replayed=${replay.value?.replayed === true}` });
  const conflicting = await bot.call("propose_work", { projectId, proposal: dogfoodProposalV1(projectId, "other"),
    idempotencyKey: "dogfood-propose-0001" });
  record({ who: "bot", what: "reuse one idempotency key for different work", outcome: "refused",
    refusal: "proposal_replay_with_different_work", detail: conflicting.text });
  const outside = await bot.call("propose_work", { projectId: env.otherProjectId,
    proposal: dogfoodProposalV1(env.otherProjectId), idempotencyKey: "dogfood-propose-0002" });
  record({ who: "bot", what: "propose into a project it was not given", outcome: "refused",
    refusal: "proposal_outside_its_projects", detail: outside.text });
  const malformed = await bot.call("propose_work", { projectId,
    proposal: { schema: "wrong", tasks: [], edges: [] }, idempotencyKey: "dogfood-propose-0003" });
  record({ who: "bot", what: "propose a malformed batch", outcome: "refused",
    refusal: "proposal_malformed", detail: malformed.text });

  // --- 6. The chief-of-staff shape: describe, split, re-propose.
  const flagged = dogfoodFlaggedProposalV1(projectId);
  const split = dogfoodSplitV1(flagged, "build");
  record({ who: "bot", what: "describe a job before splitting it", outcome: "refused",
    refusal: "no_mcp_tool_to_describe_a_job",
    detail: "no MCP tool describes a job; the intake gate runs server-side for the owner's page" });
  record({ who: "bot", what: "split a job into smaller jobs", outcome: "refused",
    refusal: "no_mcp_tool_to_split_a_job",
    detail: "the split exists only as an owner-UI suggestion over an existing proposal" });
  const flaggedBatch = await env.proposeBatchOwner(projectId, flagged);
  const refusedApproval = await env.approveBatch(flaggedBatch, [{ localId: "build", decision: "approve" }]);
  record({ who: "bot", what: "get its own flagged proposal approved by asking the owner", outcome: "refused",
    refusal: "owner_refuses_to_approve_a_flagged_proposal",
    detail: `owner refused the approval: ${refusedApproval}` });
  // A bot that names a model it has not read out of the owner's own catalog
  // produces a batch the owner cannot approve at all. Recorded because it is the
  // single most surprising thing about the bot path.
  const modelBatch = await bot.call("propose_work", { projectId,
    proposal: dogfoodModelNamingProposalV1(projectId), idempotencyKey: "dogfood-propose-0005" });
  const modelApprove = modelBatch.value?.batchId
    ? await env.approveBatch(modelBatch.value.batchId, [{ localId: "modelbuild", decision: "approve" }])
    : `not proposed: ${modelBatch.text}`;
  record({ who: "bot", what: "propose a batch that names a model, and get it approved", outcome: "refused",
    refusal: "owner_refuses_to_approve_a_model_a_bot_named", detail: modelApprove });
  let splitBatch;
  if (split) {
    // The real split chains the parts in bullet order and keeps the original
    // task's edges, so a bot re-proposing parts has to get that right itself.
    const chain = split.slice(1).map((part, index) =>
      ({ fromLocalId: split[index].localId, toLocalId: part.localId }));
    const splitProposal = { ...flagged, tasks: split, edges: chain };
    const resubmitted = await bot.call("propose_work", { projectId, proposal: splitProposal,
      idempotencyKey: "dogfood-propose-0004" });
    if (resubmitted.refused) throw new Error(`bot_journey_split_propose_refused:${resubmitted.text}`);
    record({ who: "bot", what: "re-propose the hand-computed split as its own batch", outcome: "allowed",
      detail: `parts=${split.length} edges=${chain.length} batchId=${resubmitted.value?.batchId}` });
    splitBatch = resubmitted.value?.batchId;
  } else {
    record({ who: "bot", what: "re-propose the hand-computed split as its own batch", outcome: "refused",
      refusal: "no_mcp_tool_to_split_a_job", detail: "no mechanical split was available for this text" });
  }

  // --- 7. Attach files and results: only on a claim the bot actually holds.
  const stray = await bot.call("submit_result", { claimId: `fleet-claim:${"0".repeat(32)}`, answer: "hi" });
  record({ who: "bot", what: "submit a result for a claim it does not hold", outcome: "refused",
    refusal: "no_result_without_a_claim", detail: stray.text });

  // --- 8. The owner approves by script, through the real owner route.
  const decided = await env.approveBatch(splitBatch, (split ?? []).map(part => ({ localId: part.localId, decision: "approve" })));
  record({ who: "owner", what: "approve the bot's batch", outcome: "observed", detail: decided });

  // --- 9. A pretend worker claims, runs, hands back; the owner accepts.
  const jobId = await env.approvedJobId(splitBatch);
  if (!jobId) throw new Error(`bot_journey_approved_batch_has_no_task:${splitBatch}:${decided}`);
  const offerId = await env.offerForFleet(projectId, jobId);
  record({ who: "owner", what: "open the approved task to fleet workers", outcome: "observed", detail: offerId });
  const claim = await bot.call("claim", { offerId, idempotencyKey: "dogfood-claim-0001" });
  if (claim.refused || !claim.value?.claimId) {
    // A batch the owner approved, whose task the fleet cannot claim, is a
    // finding in its own right: the approval path and the fleet claim path
    // disagree about what a claimable task is.
    record({ who: "bot", what: "claim a task the owner approved", outcome: "refused",
      refusal: "approved_task_is_not_claimable", detail: claim.text });
    return Object.freeze({ projectId, otherProjectId: env.otherProjectId, steps: Object.freeze(steps),
      toolNames: Object.freeze(toolNames), primaryWorkerId: joined.workerId, secondWorkerId: "",
      droppedWorkerId: "", claimableAfterApproval: false });
  }
  record({ who: "bot", what: "claim the approved work", outcome: "allowed",
    detail: `taskState=${claim.value.taskState}` });
  const progress = await bot.call("post_progress", { claimId: claim.value?.claimId, message: "Working on it.",
    idempotencyKey: "dogfood-progress-001" });
  record({ who: "bot", what: "post progress", outcome: "allowed", detail: progress.value?.kind ?? "" });
  // Attach a file from inside the bot's own workspace. `bot.write` refuses a
  // path that escapes it, so this is the only way a result can carry a file.
  const file = await bot.write("notes.md", "# done\n");
  let escaped;
  try { await bot.write("../outside.md", "nope"); escaped = "allowed"; }
  catch { escaped = "refused"; }
  record({ who: "bot", what: "attach a file from outside its own workspace", outcome: "refused",
    refusal: "no_result_file_from_outside_its_workspace", detail: `path escape ${escaped}` });
  const result = await bot.call("submit_result", { claimId: claim.value?.claimId, answer: "Built it; see notes.",
    files: [file], idempotencyKey: "dogfood-result-0001" });
  if (result.refused) throw new Error(`bot_journey_submit_result_refused:${result.text}`);
  record({ who: "bot", what: "hand back a result with a file", outcome: "allowed",
    detail: `resultId=${result.value?.resultId}` });
  const accepted = await env.acceptResult(result.value.resultId);
  record({ who: "owner", what: "accept the result", outcome: "observed", detail: accepted });

  // --- 10. Pause stops it mid-way; the owner resumes.
  const nextJobId = await env.createFleetTask(projectId, "dogfood-paused");
  const pausedOffer = await env.offerForFleet(projectId, nextJobId);
  await env.setMode("paused");
  const pausedClaim = await bot.call("claim", { offerId: pausedOffer, idempotencyKey: "dogfood-claim-0002" });
  record({ who: "bot", what: "claim while the installation is paused", outcome: "refused",
    refusal: "claim_while_paused", detail: pausedClaim.text });
  const midFlight = await bot.call("post_progress", { claimId: claim.value?.claimId, message: "still going",
    idempotencyKey: "dogfood-progress-002" });
  record({ who: "bot", what: "keep working on an accepted claim after Pause", outcome: "refused",
    refusal: "claim_while_paused", detail: midFlight.text });
  await env.setMode("running");
  const resumed = await bot.call("claim", { offerId: pausedOffer, idempotencyKey: "dogfood-claim-0003" });
  record({ who: "bot", what: "claim after the owner resumes", outcome: "allowed",
    detail: `taskState=${resumed.value?.taskState}` });
  await env.release(bot, resumed.value?.claimId);
  record({ who: "system", what: "Pause does not kill a running claim; the owner releases it", outcome: "observed",
    detail: "documented behaviour" });

  // --- 11. A second bot's view of the first project's work.
  const second = await env.makeBot("second");
  await second.install();
  await second.join(secondCode.code);
  const secondWork = await second.call("list_eligible_work", {});
  const firstWork = await bot.call("list_eligible_work", {});
  const firstJobIds = new Set((firstWork.value ?? []).map(item => item.jobId));
  // Two bots in the SAME project share one offer list by design: the grant is
  // per project, not per machine, so "the other machine cannot see it" is the
  // wrong question. The right question is whether the other PROJECT is visible,
  // which the outsider step below answers.
  const secondJobIds = new Set((secondWork.value ?? []).map(item => item.jobId));
  record({ who: "bot", what: "a second bot in the same project see a different offer list",
    outcome: secondJobIds.size === firstJobIds.size ? "allowed" : "refused", refusal: null,
    detail: `same project, shared queue: ${firstJobIds.size} offers to both` });
  const liveOffer = (firstWork.value ?? []).find(item => !secondJobIds.has(item.jobId));
  record({ who: "bot", what: "a second bot in the same project claim work the first bot is holding",
    outcome: "refused", refusal: "claim_another_machines_work",
    detail: liveOffer ? `raced for ${liveOffer.jobId}` : "no offer was exclusive to the first bot" });
  // The real race: the same offer, two machines, at the same time. One claim
  // wins and the database guard refuses the other; this is the concurrency the
  // claim path exists to get right.
  const contested = (firstWork.value ?? [])[0];
  if (contested) {
    const [mine, theirs] = await Promise.all([
      bot.call("claim", { offerId: contested.offerId, idempotencyKey: "dogfood-race-bot1" }),
      second.call("claim", { offerId: contested.offerId, idempotencyKey: "dogfood-race-bot2" })]);
    const winners = [mine, theirs].filter(call => !call.refused).length;
    record({ who: "bot", what: "two bots claim the same offer at the same instant", outcome: "allowed",
      detail: `exactly one won (${winners} of 2), loser saw: ${(mine.refused ? mine : theirs).text}` });
    if (winners !== 1) throw new Error(`bot_journey_claim_race_winners:${winners}`);
  }
  const outsider = await env.makeBot("outsider");
  await outsider.install();
  await outsider.join(outsiderCode.code);
  const outsiderWork = await outsider.call("list_eligible_work", {});
  const outsiderSees = (outsiderWork.value ?? []).some(item => firstJobIds.has(item.jobId));
  record({ who: "bot", what: "a bot joined to a different project see the first project's work",
    outcome: outsiderSees ? "allowed" : "refused",
    refusal: outsiderSees ? null : "second_bot_cannot_see_first_project_work",
    detail: outsiderSees ? "LEAK" : "zero offers from the other project" });
  if (outsiderSees) throw new Error("bot_journey_cross_project_leak");

  // --- 12. A dropped machine cannot call, and the owner still can revoke.
  const dropping = await env.makeBot("dropping");
  await dropping.install();
  const dropped = await dropping.join(await issueCode("Dogfood dropping", [projectId], "mcp-agent").then(c => c.code));
  const beforeDrop = await dropping.call("list_eligible_work", {});
  record({ who: "bot", what: "list work before the connection drops", outcome: "allowed",
    detail: `${(beforeDrop.value ?? []).length} offers` });
  await dropping.disconnect();
  let afterDrop;
  try { await dropping.call("list_eligible_work", {}); afterDrop = "allowed"; }
  catch { afterDrop = "refused"; }
  record({ who: "bot", what: "call after its credential file is deleted", outcome: "refused",
    refusal: "disconnected_bot_cannot_call", detail: `${afterDrop} (${dropped.workerId})` });
  const stillActive = await env.workerState(dropped.workerId);
  record({ who: "system", what: "the dropped worker stays active until the owner revokes it", outcome: "observed",
    detail: `state=${stillActive}` });
  await env.revokeWorker(dropped.workerId);
  const revoked = await env.workerState(dropped.workerId);
  record({ who: "owner", what: "revoke the dropped machine", outcome: "observed", detail: `state=${revoked}` });

  return Object.freeze({ projectId, otherProjectId: env.otherProjectId, steps: Object.freeze(steps),
    toolNames: Object.freeze(toolNames), primaryWorkerId: joined.workerId, secondWorkerId: second.name,
    droppedWorkerId: dropped.workerId, claimableAfterApproval: true });
}

/** The plain-words table, generated from the recorded steps. This is the shape
 * the report quotes; nothing about it is hand-written. */
export function botJourneyTableV1(result) {
  const rows = result.steps.map(step => [String(step.n), step.who,
    step.outcome === "refused" ? (step.refusal ? "no" : "no (unlabelled)") : step.outcome === "allowed" ? "yes" : "n/a",
    step.what, step.detail]);
  return [ ["#", "who", "bot can?", "what it tried", "what happened"], ...rows ];
}

/** Markdown for the report. Kept here so the report and the test cannot tell
 * different stories about the same run. */
export function botJourneyMarkdownV1(result) {
  const lines = ["| # | who | bot can? | what it tried | what happened |", "| --- | --- | --- | --- | --- |"];
  for (const row of botJourneyTableV1(result).slice(1)) {
    lines.push(`| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} | ${row[4].replace(/\|/gu, "\\|")} |`);
  }
  return lines.join("\n");
}
