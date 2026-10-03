// The connector-only Mac's own journey helpers.
//
// The installed Mac builds no planner, no assignment coordinator and no queue:
// its bots are fleet connector workers, and an owner's task reaches one only as
// an offer claimed through the gateway. These helpers drive that exact route
// with the REAL connector client, so the journey and the browser suites share
// one path rather than each describing its own idea of it.
//
// Nothing here is a code seam: the bot joins with a one-time code the owner
// issued, calls the gateway's real MCP tools, and every claim, progress note and
// result goes through the production gateway store.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1 } from "../../../src/fleet/v1/mac-local-composition";
import { makeBotWorkspaceV1, removeBotWorkspaceV1, ScriptedBotV1 } from "../../dogfood/bot-journey.mjs";

type BotKind = "hermes" | "claude-code" | "codex";
const workspaces: string[] = [];

/** Removes every bot workspace this module created. Called from the journey's
 * own teardown so a failed journey leaves nothing running. */
export async function removeJourneyConnectorWorkspacesV1(): Promise<void> {
  await Promise.all(workspaces.map(removeBotWorkspaceV1));
  workspaces.length = 0;
}

export async function connectBotForJourney(input: Readonly<{
  origin: string;
  cookie: string;
  projectId: string;
  name: string;
  kind?: BotKind;
}>): Promise<ScriptedBotV1> {
  const kind = input.kind ?? "hermes";
  // The same owner route the Connect a bot page posts to.
  const response = await fetch(new URL("/api/v1/fleet/connect-codes", input.origin), {
    method: "POST", headers: { origin: input.origin, cookie: input.cookie,
      "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ name: input.name, botKind: kind, operatingSystem: "macos", projectIds: [input.projectId],
      capabilities: ["code.change"], unattended: false, workerModel: "", workerProfile: "", workerProvider: "" }),
  });
  const issued = await response.json() as { installLine?: string };
  assert.equal(response.status, 201,
    `a signed connector release and a running gateway must make ${input.name} joinable: ${JSON.stringify(issued)}`);
  const code = /crj_[A-Za-z0-9_-]+/u.exec(issued.installLine ?? "")?.[0];
  assert.ok(code, "the install line must carry the one-time join code");
  const workspace = await makeBotWorkspaceV1(`journey-default-${kind}`);
  workspaces.push(workspace);
  // The scripted bot's own name must be lowercase alphanumeric with dashes; the
  // owner-visible display name is separate and may be anything.
  const bot = new ScriptedBotV1({ name: `journey-default-${kind}`, workspace,
    origin: MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1, workerKind: kind });
  await bot.join(code);
  return bot;
}

/** Waits for the bot to see the owner's offer, claims it, and returns a result. */
export async function deliverForJourney(input: Readonly<{
  bot: ScriptedBotV1;
  jobId: string;
  answer: string;
  key: string;
}>): Promise<void> {
  let offerId: string | undefined;
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline && !offerId) {
    const work = await input.bot.call("list_eligible_work", {});
    assert.equal(work.refused, false, `list_eligible_work: ${work.text}`);
    offerId = (work.value as { offerId: string; jobId: string }[]).find(item => item.jobId === input.jobId)?.offerId;
    if (!offerId) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(offerId, `the owner's offer for ${input.jobId} must become claimable`);
  const claim = await input.bot.call("claim", { offerId, idempotencyKey: `${input.key}-claim` });
  assert.equal(claim.refused, false, `claim: ${claim.text}`);
  const claimId = (claim.value as { claimId: string }).claimId;
  const progress = await input.bot.call("post_progress", { claimId, message: "Working on it.",
    idempotencyKey: `${input.key}-progress` });
  assert.equal(progress.refused, false, `post_progress: ${progress.text}`);
  const submitted = await input.bot.call("submit_result", { claimId, answer: input.answer,
    idempotencyKey: `${input.key}-result` });
  assert.equal(submitted.refused, false, `submit_result: ${submitted.text}`);
}