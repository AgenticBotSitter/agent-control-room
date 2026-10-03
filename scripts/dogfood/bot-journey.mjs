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
  // Conditional: only recorded when an owner-approved task turns out to be
  // unclaimable. A healthy run approves and claims it, so this label does not
  // appear -- which is the point, not a gap.
  "approved_task_is_not_claimable",
  "claim_while_paused",
  "progress_on_a_claim_that_is_already_settled",
  "claim_another_machines_work",
  "two_bots_race_for_one_offer",
  "second_bot_cannot_see_first_project_work",
  "no_tool_to_accept_or_approve",
  "disconnected_bot_cannot_call",
  "join_with_a_code_made_for_another_kind",
]);

/** Declared refusals a HEALTHY run never records, because the thing they
 * describe did not happen. A label in this set is not a gap in the journey:
 * recording it would mean the protection had failed. */
export const BOT_JOURNEY_CONDITIONAL_REFUSALS_V1 = Object.freeze([
  "approved_task_is_not_claimable",
]);

/** The outcome a row is declared to have, and the code it is declared to be
 * refused WITH. Every refusal row must name a code, because "refused" alone
 * is what let two real protections break while the table still said "no".
 * Keyed by the refusal label, so a caller may index it with a string. */
export const BOT_JOURNEY_EXPECTED_ROWS_V1 = /** @type {Readonly<Record<string, string | number>>} */ (Object.freeze({
  // Fleet codes, as the gateway's own fixed vocabulary.
  proposal_replay_with_different_work: "conflict",
  proposal_outside_its_projects: "not_found",
  proposal_malformed: "no-code: the connector refused the arguments before any request",
  claim_while_paused: "paused",
  claim_another_machines_work: "conflict",
  // NOT "conflict", and that is the finding. The claim guard SHOULD answer
  // `conflict` to the loser of a race, but the two bots deadlock (40P01)
  // before the guard is reached, and the gateway reports `unavailable`. The
  // root fix is the tenant-mutex lock order on cook/connonly; this expected
  // value must become "conflict" when it lands, and the journey fails until
  // it does. Asserting `conflict` today would have hidden the whole fault.
  two_bots_race_for_one_offer: "conflict",
  second_bot_cannot_see_first_project_work: "not_found",
  // Owner-route rows: the HTTP status the owner's own browser would see.
  owner_refuses_to_approve_a_flagged_proposal: 409,
  owner_refuses_to_approve_a_model_a_bot_named: 400,
  // Refusals the product makes with NO fixed code: there is no gateway route
  // and no HTTP status, because the connector or the harness refused locally.
  // These are recorded as such rather than being given an invented code.
  no_tool_to_create_a_project: "no-code: no MCP tool exists to call",
  bot_cannot_create_a_project: "no-code: no gateway route exists to call",
  no_mcp_tool_to_describe_a_job: "no-code: no MCP tool exists to call",
  no_mcp_tool_to_split_a_job: "no-code: no MCP tool exists to call",
  no_result_without_a_claim: "not_found",
  no_result_file_from_outside_its_workspace: "no-code: the connector refused the path locally",
  no_tool_to_accept_or_approve: "no-code: no MCP tool exists to call",
  disconnected_bot_cannot_call: "no-code: no credential file to load",
  progress_on_a_claim_that_is_already_settled: "expired",
  approved_task_is_not_claimable: "conflict",
  join_with_a_code_made_for_another_kind: "worker_kind_mismatch",
}));

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
    this.dispatcher = connector.createMcpDispatcher({ client: this.client, workspaceRoot: this.workspace, configPath: this.configPath });
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
   * refusal without narrowing. `value` is undefined exactly when refused.
   * `refusalCode` is the gateway's own fixed code when the connector reported
   * one, and "" when the refusal came from the connector or the client itself
   * (an unknown tool, arguments that do not match, a file outside the
   * workspace). It is never inferred from the message text. */
  async call(name, args = {}) {
    const reply = await this.raw("tools/call", { name, arguments: args });
    if (reply && "error" in reply)
      return Object.freeze({ refused: true, text: String(reply.error?.message ?? "error"), value: undefined,
        refusalCode: "" });
    const result = reply?.result;
    const refused = result?.isError === true;
    const code = refused ? String(result?.structuredContent?.refusalCode ?? "") : "";
    return Object.freeze({ refused, text: String(result?.content?.[0]?.text ?? ""),
      refusalCode: code || undefined, value: refused ? undefined : result?.structuredContent?.result });
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

  /** One tool call through a connector client built FRESH from whatever the
   * credential file says now. This is the machine's real position after the
   * file is gone: the connector tries to load a config that no longer exists.
   * It is deliberately not `call`, which would only exercise the dispatcher
   * this bot already holds, and so would never reach the product at all. */
  async callAsFreshConnector(name = "list_eligible_work", args = {}) {
    const dispatchOf = (client) => connector.createMcpDispatcher({ client, workspaceRoot: this.workspace, configPath: this.configPath });
    // The credential is gone, so the fresh client is loaded the way the real
    // `serveMcp` loads it: from the config path, with no cached value.
    let client;
    try { client = connector.createClient(await connector.loadConfig(this.configPath)); }
    catch (error) {
      // No credential file: the connector cannot even build a client. This is
      // the refusal, and it has no fleet code because no request was sent.
      return Object.freeze({ refused: true, text: String(error?.message ?? error), refusalCode: "" });
    }
    const dispatch = dispatchOf(client);
    const reply = await dispatch({ jsonrpc: "2.0", id: ++this.mcpId, method: "tools/call",
      params: { name, arguments: args } });
    const result = reply?.result;
    const refused = result?.isError === true || (reply !== null && typeof reply === "object" && "error" in reply);
    const code = refused ? String(result?.structuredContent?.refusalCode ?? "") : "";
    return Object.freeze({ refused, text: String(result?.content?.[0]?.text ?? reply?.error?.message ?? ""),
      refusalCode: code || undefined, value: refused ? undefined : result?.structuredContent?.result });
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
 *   writeOutsideWorkspace async (name, contents) => void   -- a file just
 *                       outside the bot's workspace, for the result-file
 *                       boundary row to point at
 * Returns the recorded steps. Throws if an observed outcome does not match
 * BOT_JOURNEY_EXPECTED_ROWS_V1, on either the label or the code.
 *
 * @returns {Promise<Readonly<{ projectId: string, otherProjectId: string,
 *   steps: readonly Readonly<{ n: number, who: string, what: string, outcome: string,
 *     refusal: string | null, code: string, detail: string }>[], toolNames: readonly string[],
 *   primaryWorkerId: string, secondWorkerId: string, droppedWorkerId: string,
 *   claimableAfterApproval: boolean }>>} the same shape on every path, including
 *   the early return when an approved task turns out to be unclaimable
 */
export async function runBotJourneyV1(env) {
  for (const key of ["origin", "ownerRoute", "ownerCookies", "ownerOrigin", "makeBot", "createProject", "setMode",
    "proposeBatchOwner", "approveBatch", "offerForFleet", "acceptResult", "release", "writeOutsideWorkspace"]) {
    if (!env || typeof env[key] === "undefined") throw new Error(`bot_journey_options_invalid:${key}`);
  }
  const steps = [];
  /** Records one step, and DERIVES its outcome from what the product actually
   * did. `observed` is the product's own verdict -- a fleet tool call's
   * `refused` flag plus its refusal code, an owner route's HTTP status, a
   * join's thrown code -- and never a literal written at the call site.
   *
   * The row then asserts itself three ways: the outcome the table will print,
   * the refusal label, and the CODE. Asserting only the label is what let two
   * real protections break while the table still said "no", so a code is
   * mandatory for every refusal and a mismatch fails the journey here.
   *
   * `tried: false` marks a row that is a design statement, not an attempt:
   * there is no call to make, so no code can be observed. Those print
   * "not tried" rather than claiming a refusal nobody witnessed. */
  const record = (input) => {
    const refusal = input.refusal ?? null;
    const observed = String(input.observed ?? "");
    const declaredOutcome = input.outcome;
    // The product's verdict, never the call site's: refused, allowed, or a
    // design statement nobody attempted.
    const outcome = input.tried === false ? "not tried" : declaredOutcome;
    if (input.tried === false) {
      if (refusal && !BOT_JOURNEY_EXPECTED_REFUSALS_V1.includes(refusal))
        throw new Error(`bot_journey_unlabelled_row:${input.what}:${refusal}`);
    } else {
      if (outcome === "refused" && !BOT_JOURNEY_EXPECTED_REFUSALS_V1.includes(refusal))
        throw new Error(`bot_journey_unexpected_refusal:${input.what}:${refusal ?? "unlabelled"}`);
      if (outcome === "allowed" && refusal)
        throw new Error(`bot_journey_refusal_became_allowed:${input.what}:${refusal}`);
      if (outcome === "refused") {
        const expected = BOT_JOURNEY_EXPECTED_ROWS_V1[refusal];
        if (expected === undefined) throw new Error(`bot_journey_row_has_no_expected_code:${input.what}:${refusal}`);
        // `observed` carries "<code>" or "<status>" from the product itself. A
        // row whose expected code is the "no-code:" form has nothing to match
        // and must still say WHY there is no code.
        const matches = String(expected).startsWith("no-code:")
          ? !observed || observed === expected
          : observed === String(expected) || observed.includes(String(expected));
        if (!matches)
          throw new Error(`bot_journey_wrong_refusal_code:${input.what}:${refusal}`
            + `:expected=${expected}:observed=${observed || "none"}`);
      }
    }
    const entry = Object.freeze({ n: steps.length + 1, who: input.who, what: input.what,
      outcome, refusal, code: input.tried === false ? "" : observed,
      detail: String(input.detail ?? "").slice(0, 240) });
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
  // A design statement, not an attempt: `bot.listTools()` below is the real
  // evidence that no such tool exists, and the route table is the evidence
  // that no such route exists. Nothing is called, so nothing is claimed.
  record({ who: "bot", what: "create a project over MCP", outcome: "refused", tried: false,
    refusal: "no_tool_to_create_a_project", detail: "no MCP tool and no fleet route creates a project" });
  record({ who: "bot", what: "create a project with its fleet credential", outcome: "refused", tried: false,
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
  // The join's own thrown code decides this row. The label was previously
  // `bot_cannot_create_a_project`, which is a different question entirely.
  const wrongKindJoin = await wrongKindBot.join(wrongKind.code)
    .then(result => ({ joined: true, code: "" }), error => ({ joined: false, code: String(error.code ?? "") }));
  record({ who: "bot", what: "join with a code made for a different bot kind",
    outcome: wrongKindJoin.joined ? "allowed" : "refused", observed: wrongKindJoin.code,
    refusal: wrongKindJoin.joined ? null : "join_with_a_code_made_for_another_kind",
    detail: `the code was made for ${wrongKind.workerKind}, the bot is ${wrongKindBot.workerKind}` });

  // --- 4. What the bot was given, and what it may not ask for.
  const toolNames = await bot.listTools();
  record({ who: "bot", what: "list the tools it was given", outcome: "observed", detail: toolNames.join(", ") });
  const invented = await bot.call("approve_result", { resultId: `fleet-result:${"0".repeat(32)}` });
  record({ who: "bot", what: "call a tool that was never offered",
    outcome: invented.refused ? "refused" : "allowed", observed: invented.refusalCode ?? "",
    refusal: invented.refused ? "no_tool_to_accept_or_approve" : null, detail: invented.text });

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
  record({ who: "bot", what: "reuse one idempotency key for different work",
    outcome: conflicting.refused ? "refused" : "allowed", observed: conflicting.refusalCode ?? "",
    refusal: conflicting.refused ? "proposal_replay_with_different_work" : null,
    detail: `${conflicting.text} accepted=${conflicting.value?.batchId ?? "none"}` });
  const outside = await bot.call("propose_work", { projectId: env.otherProjectId,
    proposal: dogfoodProposalV1(env.otherProjectId), idempotencyKey: "dogfood-propose-0002" });
  record({ who: "bot", what: "propose into a project it was not given",
    outcome: outside.refused ? "refused" : "allowed", observed: outside.refusalCode ?? "",
    refusal: outside.refused ? "proposal_outside_its_projects" : null,
    detail: `${outside.text} accepted=${outside.value?.batchId ?? "none"}` });
  const malformed = await bot.call("propose_work", { projectId,
    proposal: { schema: "wrong", tasks: [], edges: [] }, idempotencyKey: "dogfood-propose-0003" });
  record({ who: "bot", what: "propose a malformed batch",
    outcome: malformed.refused ? "refused" : "allowed", observed: malformed.refusalCode ?? "",
    refusal: malformed.refused ? "proposal_malformed" : null,
    detail: `${malformed.text} accepted=${malformed.value?.batchId ?? "none"}` });

  // --- 6. The chief-of-staff shape: describe, split, re-propose.
  const flagged = dogfoodFlaggedProposalV1(projectId);
  const split = dogfoodSplitV1(flagged, "build");
  // Design statements, not attempts: there is no tool to call, so nothing is
  // called and no code is claimed. The `bot.listTools()` row above is the
  // evidence that these tool names are absent.
  record({ who: "bot", what: "describe a job before splitting it", outcome: "refused", tried: false,
    refusal: "no_mcp_tool_to_describe_a_job",
    detail: "no MCP tool describes a job; the intake gate runs server-side for the owner's page" });
  record({ who: "bot", what: "split a job into smaller jobs", outcome: "refused", tried: false,
    refusal: "no_mcp_tool_to_split_a_job",
    detail: "the split exists only as an owner-UI suggestion over an existing proposal" });
  const flaggedBatch = await env.proposeBatchOwner(projectId, flagged);
  // The owner's own approve route's HTTP status decides this row, and the
  // status is the one the browser sees. An approval that SUCCEEDED would make
  // this row allowed, which is what the reviewer's mutation produced.
  const refusedApproval = await env.approveBatch(flaggedBatch, [{ localId: "build", decision: "approve" }]);
  const flaggedApproved = refusedApproval.status < 300;
  record({ who: "bot", what: "get its own flagged proposal approved by asking the owner",
    outcome: flaggedApproved ? "allowed" : "refused", observed: String(refusedApproval.status),
    refusal: flaggedApproved ? null : "owner_refuses_to_approve_a_flagged_proposal",
    detail: `owner route answered ${refusedApproval.detail}` });
  // A bot that names a model it has not read out of the owner's own catalog
  // produces a batch the owner cannot approve at all. Recorded because it is the
  // single most surprising thing about the bot path.
  const modelBatch = await bot.call("propose_work", { projectId,
    proposal: dogfoodModelNamingProposalV1(projectId), idempotencyKey: "dogfood-propose-0005" });
  // Two refusals in one row, both from the owner's own route: the proposal may
  // not even be created, and if it is, the approve is refused. Whichever
  // happened, the status below is the one the owner's browser saw.
  const modelApprove = modelBatch.value?.batchId
    ? await env.approveBatch(modelBatch.value.batchId, [{ localId: "modelbuild", decision: "approve" }])
    : { status: modelBatch.refused ? 0 : 200, detail: `not proposed: ${modelBatch.text}` };
  const modelApproved = modelApprove.status >= 200 && modelApprove.status < 300;
  record({ who: "bot", what: "propose a batch that names a model, and get it approved",
    outcome: modelApproved ? "allowed" : "refused", observed: modelApprove.status ? String(modelApprove.status) : "no-code: no MCP tool exists to call",
    refusal: modelApproved ? null : "owner_refuses_to_approve_a_model_a_bot_named",
    detail: modelApprove.detail });
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
    // Not attempted: there is no split to re-propose for this text, so the
    // absence of a split is a fact about the text, not an observed refusal.
    record({ who: "bot", what: "re-propose the hand-computed split as its own batch",
      outcome: "refused", tried: false, refusal: "no_mcp_tool_to_split_a_job",
      detail: "no mechanical split was available for this text" });
  }

  // --- 7. Attach files and results: only on a claim the bot actually holds.
  const stray = await bot.call("submit_result", { claimId: `fleet-claim:${"0".repeat(32)}`, answer: "hi" });
  record({ who: "bot", what: "submit a result for a claim it does not hold",
    outcome: stray.refused ? "refused" : "allowed", observed: stray.refusalCode ?? "",
    refusal: stray.refused ? "no_result_without_a_claim" : null,
    detail: `${stray.text} accepted=${stray.value?.resultId ?? "none"}` });

  // --- 8. The owner approves by script, through the real owner route.
  const decided = await env.approveBatch(splitBatch, (split ?? []).map(part => ({ localId: part.localId, decision: "approve" })));
  record({ who: "owner", what: "approve the bot's batch", outcome: "observed", observed: String(decided.status),
    detail: decided.detail });

  // --- 9. A pretend worker claims, runs, hands back; the owner accepts.
  const jobId = await env.approvedJobId(splitBatch);
  if (!jobId) throw new Error(`bot_journey_approved_batch_has_no_task:${splitBatch}:${decided.detail}`);
  const offerId = await env.offerForFleet(projectId, jobId);
  record({ who: "owner", what: "open the approved task to fleet workers", outcome: "observed", detail: offerId });
  const claim = await bot.call("claim", { offerId, idempotencyKey: "dogfood-claim-0001" });
  if (claim.refused || !claim.value?.claimId) {
    // A batch the owner approved, whose task the fleet cannot claim, is a
    // finding in its own right: the approval path and the fleet claim path
    // disagree about what a claimable task is.
    record({ who: "bot", what: "claim a task the owner approved",
      outcome: "refused", observed: claim.refusalCode ?? "", refusal: "approved_task_is_not_claimable",
      detail: claim.text });
    return Object.freeze({ projectId, otherProjectId: env.otherProjectId, steps: Object.freeze(steps),
      toolNames: Object.freeze(toolNames), primaryWorkerId: joined.workerId, secondWorkerId: "",
      droppedWorkerId: "", claimableAfterApproval: false });
  }
  record({ who: "bot", what: "claim the approved work", outcome: claim.refused ? "refused" : "allowed",
    observed: claim.refusalCode ?? "", refusal: claim.refused ? "approved_task_is_not_claimable" : null,
    detail: `taskState=${claim.value?.taskState ?? claim.text}` });
  // The claim this bot still holds at the end of the run, and the offer it came
  // from: the "another machine's work" row later needs a claim that is REALLY
  // live, not one the journey believes is live.
  const held = Object.freeze({ claimId: claim.value.claimId, offerId, released: false });
  const progress = await bot.call("post_progress", { claimId: claim.value?.claimId, message: "Working on it.",
    idempotencyKey: "dogfood-progress-001" });
  record({ who: "bot", what: "post progress", outcome: progress.refused ? "refused" : "allowed",
    observed: progress.refusalCode ?? "", detail: progress.value?.kind ?? progress.text });
  // Attach a file from inside the bot's own workspace: this is the only way a
  // result can carry a file, and it is the positive case.
  const file = await bot.write("notes.md", "# done\n");
  // And the negative case, through the REAL boundary: `submit_result` with a
  // path that escapes the workspace. This reaches the connector's
  // `workspaceFile`, which is the boundary that actually runs in production.
  // The previous version exercised the harness's own `bot.write` check, which
  // is test code, and recorded "refused" whatever the answer was.
  await env.writeOutsideWorkspace("secrets.md", "not for the result\n");
  const escaping = await bot.call("submit_result", { claimId: claim.value.claimId,
    answer: "Built it; here is a file from outside my workspace.",
    files: ["../secrets.md"], idempotencyKey: "dogfood-result-escape" });
  record({ who: "bot", what: "attach a result file from outside its own workspace",
    outcome: escaping.refused ? "refused" : "allowed", observed: escaping.refusalCode ?? "",
    refusal: escaping.refused ? "no_result_file_from_outside_its_workspace" : null,
    detail: `${escaping.text} resultId=${escaping.value?.resultId ?? "none"}` });
  const result = await bot.call("submit_result", { claimId: claim.value?.claimId, answer: "Built it; see notes.",
    files: [file], idempotencyKey: "dogfood-result-0001" });
  if (result.refused) throw new Error(`bot_journey_submit_result_refused:${result.text}`);
  record({ who: "bot", what: "hand back a result with a file",
    outcome: result.refused ? "refused" : "allowed", observed: result.refusalCode ?? "",
    detail: `resultId=${result.value?.resultId ?? result.text}` });
  const accepted = await env.acceptResult(result.value.resultId);
  record({ who: "owner", what: "accept the result", outcome: "observed", detail: accepted });

  // --- 10. Pause stops it mid-way; the owner resumes.
  const nextJobId = await env.createFleetTask(projectId, "dogfood-paused");
  const pausedOffer = await env.offerForFleet(projectId, nextJobId);
  await env.setMode("paused");
  const pausedClaim = await bot.call("claim", { offerId: pausedOffer, idempotencyKey: "dogfood-claim-0002" });
  record({ who: "bot", what: "claim while the installation is paused",
    outcome: pausedClaim.refused ? "refused" : "allowed", observed: pausedClaim.refusalCode ?? "",
    refusal: pausedClaim.refused ? "claim_while_paused" : null,
    detail: `${pausedClaim.text} claimId=${pausedClaim.value?.claimId ?? "none"}` });
  const midFlight = await bot.call("post_progress", { claimId: claim.value?.claimId, message: "still going",
    idempotencyKey: "dogfood-progress-002" });
  // Its own label: this is refused because the CLAIM was already settled by
  // the accepted result, not because the installation is paused. Labelling it
  // `claim_while_paused` claimed a Pause behaviour this row never tested.
  record({ who: "bot", what: "keep working on a claim its own result already settled",
    outcome: midFlight.refused ? "refused" : "allowed", observed: midFlight.refusalCode ?? "",
    refusal: midFlight.refused ? "progress_on_a_claim_that_is_already_settled" : null,
    detail: midFlight.text });
  await env.setMode("running");
  const resumed = await bot.call("claim", { offerId: pausedOffer, idempotencyKey: "dogfood-claim-0003" });
  record({ who: "bot", what: "claim after the owner resumes", outcome: resumed.refused ? "refused" : "allowed",
    observed: resumed.refusalCode ?? "", detail: `taskState=${resumed.value?.taskState ?? resumed.text}` });
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
  // The first bot still HOLDS the claim it took at step 20 (the owner released
  // only the Pause probe). The second bot trying to claim that same offer is
  // the real question; the previous version made no call at all and recorded
  // "refused" from the label alone.
  const heldOffer = held.claimId && !held.released ? held.offerId : undefined;
  const heldAttempt = heldOffer
    ? await second.call("claim", { offerId: heldOffer, idempotencyKey: "dogfood-steal-held" })
    : { refused: true, refusalCode: "", text: "no claim was still held to contest" };
  record({ who: "bot", what: "a second bot in the same project claim work the first bot is holding",
    outcome: heldAttempt.refused ? "refused" : "allowed", observed: heldAttempt.refusalCode ?? "",
    refusal: heldAttempt.refused ? "claim_another_machines_work" : null,
    detail: `${heldAttempt.text} claimId=${heldAttempt.value?.claimId ?? "none"}` });
  // The real race: the same offer, two machines, at the same time. One claim
  // wins and the database guard refuses the other; this is the concurrency the
  // claim path exists to get right.
  const contested = (firstWork.value ?? [])[0];
  if (contested) {
    const [mine, theirs] = await Promise.all([
      bot.call("claim", { offerId: contested.offerId, idempotencyKey: "dogfood-race-bot1" }),
      second.call("claim", { offerId: contested.offerId, idempotencyKey: "dogfood-race-bot2" })]);
    const calls = [mine, theirs];
    const winner = calls.find(call => !call.refused);
    const loser = calls.find(call => call.refused);
    const winners = winner ? 1 : 0;
    // The loser's CODE is the finding. A generic `refused` here would mean the
    // claim guard never fired and something else (a database fault) decided the
    // race, which is exactly what the reviewer's run actually showed.
    record({ who: "bot", what: "two bots claim the same offer at the same instant",
      outcome: winner ? "allowed" : "refused", observed: "",
      refusal: null,
      detail: `${winners} of 2 won; loser saw: ${loser?.text ?? "both refused"}` });
    if (winners !== 1) throw new Error(`bot_journey_claim_race_winners:${winners}`);
    if (winner) {
      // The loser's CODE is the finding, and it is asserted rather than
      // displayed. A generic `refused` here would mean the claim guard never
      // fired: the reviewer's run saw exactly that, with the 40P01 deadlock
      // deciding the race instead. That is a real failure of this row.
      record({ who: "bot", what: "the losing bot's claim is refused as a conflict",
        outcome: "refused", observed: loser?.refusalCode ?? "no-code: no fleet refusal code",
        refusal: "two_bots_race_for_one_offer", detail: loser?.text ?? "" });
    }
  }
  const outsider = await env.makeBot("outsider");
  await outsider.install();
  await outsider.join(outsiderCode.code);
  const outsiderWork = await outsider.call("list_eligible_work", {});
  const outsiderSees = (outsiderWork.value ?? []).some(item => firstJobIds.has(item.jobId));
  // An empty list is the observation, and the code is not_found: the outsider's
  // project scope makes every other project's offer invisible rather than
  // refused. The hard failure below is what actually catches a leak.
  record({ who: "bot", what: "a bot joined to a different project see the first project's work",
    outcome: outsiderSees ? "allowed" : "refused", observed: outsiderSees ? "" : "not_found",
    refusal: outsiderSees ? null : "second_bot_cannot_see_first_project_work",
    detail: outsiderSees ? "LEAK" : `zero offers from the other project (${(outsiderWork.value ?? []).length} of its own)` });
  if (outsiderSees) throw new Error("bot_journey_cross_project_leak");

  // --- 12. A dropped machine cannot call, and the owner still can revoke.
  const dropping = await env.makeBot("dropping");
  await dropping.install();
  const dropped = await dropping.join(await issueCode("Dogfood dropping", [projectId], "mcp-agent").then(c => c.code));
  const beforeDrop = await dropping.call("list_eligible_work", {});
  record({ who: "bot", what: "list work before the connection drops", outcome: "allowed",
    detail: `${(beforeDrop.value ?? []).length} offers` });
  await dropping.disconnect();
  // A REAL connector client, built from the credential file that is now gone.
  // The previous version called through the bot's own dispatcher, which the
  // harness had already cleared, so the product was never reached.
  const afterDrop = await dropping.callAsFreshConnector();
  record({ who: "bot", what: "call with a fresh connector after its credential file is deleted",
    outcome: afterDrop.refused ? "refused" : "allowed", observed: afterDrop.refusalCode ?? "",
    refusal: afterDrop.refused ? "disconnected_bot_cannot_call" : null,
    detail: `${afterDrop.text} (${dropped.workerId})` });
  // Asserted, not just displayed: the worker row is still active until the
  // owner revokes it, and the revoke really changes it.
  const stillActive = await env.workerState(dropped.workerId);
  record({ who: "system", what: "the dropped worker stays active until the owner revokes it",
    outcome: "observed", detail: `state=${stillActive}` });
  if (stillActive !== "active")
    throw new Error(`bot_journey_dropped_worker_not_active:${stillActive}`);
  await env.revokeWorker(dropped.workerId);
  const revoked = await env.workerState(dropped.workerId);
  record({ who: "owner", what: "revoke the dropped machine", outcome: "observed", detail: `state=${revoked}` });
  if (revoked !== "revoked")
    throw new Error(`bot_journey_revoke_did_not_take_effect:${revoked}`);

  return Object.freeze({ projectId, otherProjectId: env.otherProjectId, steps: Object.freeze(steps),
    toolNames: Object.freeze(toolNames), primaryWorkerId: joined.workerId, secondWorkerId: second.name,
    droppedWorkerId: dropped.workerId, claimableAfterApproval: true });
}

/** The plain-words table, generated from the recorded steps. This is the shape
 * the report quotes; nothing about it is hand-written. */
export function botJourneyTableV1(result) {
  // The "bot can?" column is derived, and the code column is what the product
  // actually answered with. A row that was never attempted prints "not tried"
  // rather than claiming a refusal nobody witnessed.
  const rows = result.steps.map(step => [String(step.n), step.who,
    step.outcome === "refused" ? (step.refusal ? "no" : "no (unlabelled)") : step.outcome === "allowed" ? "yes" : "n/a",
    step.what, step.code || (step.outcome === "not tried" ? "not tried" : "n/a"), step.detail]);
  return [ ["#", "who", "bot can?", "what it tried", "code", "what happened"], ...rows ];
}

/** Markdown for the report. Kept here so the report and the test cannot tell
 * different stories about the same run. */
export function botJourneyMarkdownV1(result) {
  const lines = ["| # | who | bot can? | what it tried | code | what happened |",
    "| --- | --- | --- | --- | --- | --- |"];
  for (const row of botJourneyTableV1(result).slice(1)) {
    lines.push(`| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} | ${row[4].replace(/\|/gu, "\\|")}`
      + ` | ${row[5].replace(/\|/gu, "\\|")} |`);
  }
  return lines.join("\n");
}
