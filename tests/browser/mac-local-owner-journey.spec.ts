import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { AuditStore, auditPartition } from "../../src/audit/audit-store";
import type { DatabaseClient } from "../../src/persistence/database";
import { MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1 } from "../../src/fleet/v1/mac-local-composition";
import { workBatchProposalDigestV1 } from "../../src/work-intake/v1/digest";
import { captureWorkIntakeClientConfigurationV1, captureWorkIntakeServerConfigurationV1,
  workIntakeClientFileNameV1,
} from "../../src/work-intake/v1";
import { makeBotWorkspaceV1, removeBotWorkspaceV1, ScriptedBotV1 } from "../../scripts/dogfood/bot-journey.mjs";

const ownerCode = process.env.CONTROL_ROOM_E2E_OWNER_CODE;
if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
const rehearsalRoot = process.env.CONTROL_ROOM_E2E_ROOT;
if (!rehearsalRoot || resolve(rehearsalRoot) !== rehearsalRoot) throw new Error("CONTROL_ROOM_E2E_ROOT must be absolute");
const botWorkspaces: string[] = [];
test.afterAll(async () => { await Promise.all(botWorkspaces.map(removeBotWorkspaceV1)); });

async function expectHealthyPage(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|could not read the saved task database or service/i);
}

type BotKind = "hermes" | "claude-code" | "codex";

/** The installed Mac is connector-only (start-web-host.mjs `connectorOnly: true`):
 * its bots are fleet connector workers, and an owner's task reaches one only as
 * an offer claimed through the fleet gateway. This is a pretend bot on that
 * exact route: the real connector client (scripts/fleet/connector.mjs) joined
 * with a one-time code the owner issued, never a real bot CLI. */
async function connectPretendBot(page: Page, projectId: string, kind: BotKind, name: string) {
  // The same owner route the Connect a bot page posts to.
  const issued = await page.evaluate(async ({ projectId, kind, name }) => {
    const response = await fetch("/api/v1/fleet/connect-codes", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name, botKind: kind, operatingSystem: "macos", projectIds: [projectId],
        capabilities: ["code.change"], unattended: false, workerModel: "", workerProfile: "", workerProvider: "" }) });
    return { status: response.status, body: await response.json() as { installLine?: string; botKind?: string } };
  }, { projectId, kind, name });
  expect(issued.status, "a signed connector release and a running gateway make Connect a bot available").toBe(201);
  const code = /crj_[A-Za-z0-9_-]+/u.exec(issued.body.installLine ?? "")?.[0];
  expect(code, "the install line carries the one-time join code").toBeTruthy();
  const workspace = await makeBotWorkspaceV1(`journey-${kind}`);
  botWorkspaces.push(workspace);
  const bot = new ScriptedBotV1({ name: `journey-${kind}`, workspace, origin: MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1, workerKind: kind });
  await bot.join(code!);
  return bot;
}

/** The owner saves a task and offers it from the task page, as on the real Mac. */
async function createOfferedTask(page: Page, projectPath: string, title: string) {
  await page.goto(`${projectPath}/tasks#new-task`);
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("What should the agent deliver?").fill("Return one harmless short line for owner review.");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // No dead-end direct-path steps on a connector-only host.
  await expect(page.getByRole("heading", { name: "Send this task to a bot" })).toBeVisible();
  await expect(page.getByText("Task preparation is not connected in this installation.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assign after preparation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Offer to other machines" }).click();
  await expect(page.getByText("Offered. Any connected bot in this project with that skill can claim it.")).toBeVisible();
  await expectHealthyPage(page);
  return { url: page.url(), jobId: decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!) };
}

/** The pretend bot finds the owner's offer for this exact task, claims it, and hands back a result. */
async function botDeliversResult(bot: ScriptedBotV1, jobId: string, answer: string, attempt: string) {
  let offerId: string | undefined;
  await expect.poll(async () => {
    const work = await bot.call("list_eligible_work", {});
    expect(work.refused, work.text).toBe(false);
    offerId = (work.value as { offerId: string; jobId: string }[]).find(item => item.jobId === jobId)?.offerId;
    return !!offerId;
  }, { timeout: 75_000, intervals: [500] }).toBe(true);
  const claim = await bot.call("claim", { offerId, idempotencyKey: `journey-claim-${attempt}` });
  expect(claim.refused, claim.text).toBe(false);
  const claimId = (claim.value as { claimId: string }).claimId;
  const progress = await bot.call("post_progress", { claimId, message: "Working on it.", idempotencyKey: `journey-progress-${attempt}` });
  expect(progress.refused, progress.text).toBe(false);
  const result = await bot.call("submit_result", { claimId, answer, idempotencyKey: `journey-result-${attempt}` });
  expect(result.refused, result.text).toBe(false);
}

/** The owner's decision on the Workers page, where a bot's result waits. */
async function decideOnWorkersPage(page: Page, title: string, decision: "Accept" | "Ask for changes" | "Reject", note?: string) {
  await page.goto("/workers");
  await expectHealthyPage(page);
  const card = page.locator("li.private-local-agent-card").filter({ has: page.getByRole("heading", { name: title }) })
    .filter({ has: page.getByRole("button", { name: "Accept" }) });
  await expect(card).toHaveCount(1);
  await card.getByText(/^Read the result/).click();
  if (note) await card.getByLabel(/Changes you want/).fill(note);
  if (decision === "Reject") page.once("dialog", dialog => void dialog.accept());
  const saved = page.waitForResponse(response => /\/api\/v1\/fleet\/results\/[^/]+\/review$/u.test(new URL(response.url()).pathname));
  await card.getByRole("button", { name: decision }).click();
  const response = await saved;
  expect(response.status(), `${decision} on "${title}": ${JSON.stringify(response.headers())} ${await response.text().catch(() => "(no body)")}`).toBe(200);
  await expect(card).toHaveCount(0);
}

/** The installed Mac's web host has no hook into the separate gateway process,
 * so an owner decision reaches the canonical task on the gateway's 30-second
 * reconcile timer (mac-local-composition.ts). Waits below allow for that. */
async function taskStateLabel(page: Page, url: string) {
  await page.goto(url);
  await expectHealthyPage(page);
  return page.locator(".private-task-detail .private-state").first().innerText();
}

async function disposableAdmin() {
  const config = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/mac-local.json`, "utf8"));
  if (config.database?.host !== "127.0.0.1" || config.database?.database !== "control_room")
    throw new Error("browser_fixture_refused_non_disposable_database");
  const client = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres" });
  await client.connect();
  return { client, config };
}

async function submitProposalOnlyBatch(projectId: string) {
  const { client, config } = await disposableAdmin();
  const installed = captureWorkIntakeServerConfigurationV1(JSON.parse(
    await readFile(`${rehearsalRoot}/protected/config/work-intake-server.json`, "utf8")));
  const worker=config.enablement.workers.find((candidate:{kind:string})=>candidate.kind==="hermes");
  if(!worker)throw new Error("browser_fixture_missing_proposal_agent");
  const agentClient = captureWorkIntakeClientConfigurationV1(JSON.parse(await readFile(
    `${rehearsalRoot}/protected/config/work-intake-clients/${workIntakeClientFileNameV1(worker.workerId)}`, "utf8")));
  const proposal = { schema: "control-room.work-batch-proposal/v1", projectId, tasks: [{ localId: "build",
    title: "Machine-only proposed batch", instructions: "Remain a proposal for this boundary check.",
    requiredCapability: "code.change", role: "builder", acceptanceCriteria: "No ordinary task exists.",
    acceptanceTests: "Owner task surface stays unchanged." }], edges: [] };
  try {
    const before = (await client.query<{ requests: string; workflows: string; jobs: string; tasks: string; queue: string }>(`SELECT
      (SELECT count(*)::text FROM control_requests) requests,
      (SELECT count(*)::text FROM control_workflows) workflows,
      (SELECT count(*)::text FROM control_jobs) jobs,
      (SELECT count(*)::text FROM work_items) tasks,
      (SELECT count(*)::text FROM control_room_queue.job) queue`)).rows[0]!;
    const envelope = JSON.stringify({ idempotencyKey: "browser-machine-intake-0001", proposal });
    const origin = agentClient.origin;
    const headers = { authorization: `Bearer ${agentClient.bearerSecret}`, "content-type": "application/json" };
    const submitted = await fetch(`${origin}/v1/projects/${encodeURIComponent(projectId)}/work-batches`,
      { method: "POST", headers, body: envelope });
    expect(submitted.status).toBe(202);
    const receipt = (await submitted.json()).result;
    expect(receipt).toMatchObject({ projectId, state: "proposed", proposalDigest: workBatchProposalDigestV1(proposal),
      revision: 1, replayed: false, startsWork: false, grantsExecutionAuthority: false });
    const replay = await fetch(`${origin}/v1/projects/${encodeURIComponent(projectId)}/work-batches`,
      { method: "POST", headers, body: envelope });
    expect(replay.status).toBe(202);
    expect((await replay.json()).result.replayed).toBe(true);
    const status = await fetch(`${origin}/v1/projects/${encodeURIComponent(projectId)}/work-batches/${encodeURIComponent(receipt.batchId)}`,
      { headers: { authorization: `Bearer ${agentClient.bearerSecret}` } });
    expect(status.status, "status reread must verify the stored digest and HMAC").toBe(200);
    const durable = (await client.query<{ revisions: string; proposes: string; replays: string }>(`SELECT
      (SELECT count(*)::text FROM work_batch_revisions WHERE tenant_id=$1 AND batch_id=$2) revisions,
      (SELECT count(*)::text FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='work_batches.propose') proposes,
      (SELECT count(*)::text FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='work_batches.propose.replayed') replays`,
    [config.localOwnerSession.tenantId, receipt.batchId])).rows[0]!;
    expect(durable).toEqual({ revisions: "1", proposes: "1", replays: "1" });
    const audit = await new AuditStore(client as unknown as DatabaseClient).verify(config.localOwnerSession.tenantId,
      auditPartition(new Date().toISOString()));
    expect(audit.valid, "the real proposal and replay must preserve the audit chain").toBe(true);
    const after = (await client.query<{ requests: string; workflows: string; jobs: string; tasks: string; queue: string }>(`SELECT
      (SELECT count(*)::text FROM control_requests) requests,
      (SELECT count(*)::text FROM control_workflows) workflows,
      (SELECT count(*)::text FROM control_jobs) jobs,
      (SELECT count(*)::text FROM work_items) tasks,
      (SELECT count(*)::text FROM control_room_queue.job) queue`)).rows[0]!;
    expect(after, "a proposal-only batch cannot create an ordinary task, workflow, job, or queue item").toEqual(before);
    return { batchId: receipt.batchId as string, before };
  } finally { await client.end(); }
}

test("owner sends work to every connected bot on the real connector-only local website", async ({ page }) => {
  const failedResponses: string[] = [];
  page.on("response", response => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  // r7iui returns the owner to the page they asked for after sign-in, so the
  // journey asks for the Projects page it means to start on.
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  await page.getByLabel("Owner code").fill(ownerCode);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Owner browser journey");
  await page.getByLabel("What do you want to accomplish?").fill("Exercise the complete local owner workflow in a disposable rehearsal.");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Owner browser journey" })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  const projectId = decodeURIComponent(projectPath.split("/").at(-1)!);
  await expect(page.getByRole("link", { name: "New task" })).toBeVisible();

  const browserMachineBoundary = await page.evaluate(async ({ projectId }) => (await fetch(
    `/v1/projects/${encodeURIComponent(projectId)}/work-batches`)).status, { projectId });
  expect(browserMachineBoundary, "the owner website must not expose the machine-intake route").toBe(404);
  const proposedBatch = await submitProposalOnlyBatch(projectId);
  await page.goto(`${projectPath}/tasks`);
  await expect(page.getByText("Machine-only proposed batch")).toHaveCount(0);
  await page.goto(`${projectPath}/pipelines/${encodeURIComponent(proposedBatch.batchId)}`);
  await expect(page.getByRole("heading", { name: "Pipeline batch" })).toBeVisible();
  await expect(page.getByText("Machine-only proposed batch").first()).toBeVisible();
  await expect(page.getByText(/does not assign, approve execution, dispatch, or start work/).first()).toBeVisible();
  await page.getByRole("button", { name: "Approve all items" }).click();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByRole("heading", { name: "Recorded item decisions" })).toBeVisible();
  const { client: approvalClient } = await disposableAdmin();
  try {
    const afterApproval = (await approvalClient.query<{ jobs: string; queue: string; attempts: string }>(`SELECT
      (SELECT count(*)::text FROM control_jobs) jobs,
      (SELECT count(*)::text FROM control_room_queue.job) queue,
      (SELECT count(*)::text FROM control_attempts) attempts`)).rows[0]!;
    expect(Number(afterApproval.jobs)).toBe(Number(proposedBatch.before.jobs) + 1);
    expect(afterApproval.queue).toBe(proposedBatch.before.queue);
    expect(afterApproval.attempts).toBe("0");
  } finally { await approvalClient.end(); }
  await page.goto(`${projectPath}/tasks`);
  await expect(page.getByText("Machine-only proposed batch").first()).toBeVisible();

  // The installed Mac is connector-only: every bot is a connector worker the
  // owner connects, and a task reaches one only when the owner offers it.
  const bots = {
    hermes: await connectPretendBot(page, projectId, "hermes", "Journey Hermes"),
    claude: await connectPretendBot(page, projectId, "claude-code", "Journey Claude Code"),
    codex: await connectPretendBot(page, projectId, "codex", "Journey Codex"),
  };
  await page.goto("/workers");
  await expectHealthyPage(page);
  for (const name of ["Journey Hermes", "Journey Claude Code", "Journey Codex"])
    await expect(page.locator("li.private-local-agent-card").filter({ has: page.getByRole("heading", { name }) })
      .getByText("Connected", { exact: true })).toBeVisible();

  // Hermes: the owner asks for changes; the same task is offered again and the
  // revised result is accepted.
  const hermesTask = await createOfferedTask(page, projectPath, "Hermes browser task");
  await botDeliversResult(bots.hermes, hermesTask.jobId, "First harmless line.", "hermes-1");
  await decideOnWorkersPage(page, "Hermes browser task", "Ask for changes", "Return a second harmless line.");
  await expect.poll(() => taskStateLabel(page, hermesTask.url), { timeout: 30_000 }).not.toMatch(/Completed|Cancelled/);
  await botDeliversResult(bots.hermes, hermesTask.jobId, "Second harmless line.", "hermes-2");
  await decideOnWorkersPage(page, "Hermes browser task", "Accept");
  await expect.poll(() => taskStateLabel(page, hermesTask.url), { timeout: 75_000, intervals: [2_000] }).toMatch(/^Completed/);

  // Claude Code: accepted first time; it shows as completed work.
  const claudeTask = await createOfferedTask(page, projectPath, "Claude browser task");
  await botDeliversResult(bots.claude, claudeTask.jobId, "One harmless line.", "claude-1");
  await decideOnWorkersPage(page, "Claude browser task", "Accept");
  await expect.poll(() => taskStateLabel(page, claudeTask.url), { timeout: 75_000, intervals: [2_000] }).toMatch(/^Completed/);
  await page.goto(`${projectPath}/tasks`);
  await expect(page.locator('section[aria-label="Saved tasks"] li').filter({ hasText: "Claude browser task" })
    .filter({ hasText: /Completed/ })).toHaveCount(1);
  await page.goto("/needs-me");
  await expect(page.getByRole("region", { name: "Action Inbox" })).not.toContainText("Claude browser task");

  // Codex: the owner rejects the result. The task the owner closed that way
  // reads "Rejected by you", not the generic cancellation wording, because the
  // gateway recorded the owner's own Reject decision on the attempt. The chip
  // capitalizes its text (private.css), so match case-insensitively.
  const codexTask = await createOfferedTask(page, projectPath, "Codex browser task");
  await botDeliversResult(bots.codex, codexTask.jobId, "One harmless line.", "codex-1");
  await decideOnWorkersPage(page, "Codex browser task", "Reject");
  await expect.poll(() => taskStateLabel(page, codexTask.url), { timeout: 75_000, intervals: [2_000] })
    .toMatch(/^rejected by you$/iu);
  await page.goto("/workers");
  await expect(page.getByText(/results? from other machines needs? you/)).toHaveCount(0);

  // No "Files" or "Activity" section here: the connector-only host builds no
  // task result store and no project-event source, so it offers neither; a
  // bot's files open from the Workers page.
  for (const [label, suffix] of [["Overview", ""], ["Tasks", "/tasks"], ["Reviews", "/reviews"]] as const) {
    await page.goto(`${projectPath}${suffix}`);
    await expectHealthyPage(page);
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
  for (const path of ["/", "/projects", "/workers", "/needs-me"]) {
    await page.goto(path);
    await expectHealthyPage(page);
  }

  await page.goto(projectPath);
  await page.getByRole("button", { name: "Pause project" }).click();
  await expect(page.getByText(/^paused ·/)).toBeVisible();
  await page.getByRole("button", { name: "Reopen project" }).click();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByText(/^completed ·/)).toBeVisible();
  await page.getByRole("button", { name: "Reopen project" }).click();
  await page.getByRole("button", { name: "Archive project" }).click();
  await expect(page.getByText(/^archived ·/)).toBeVisible();

  const signOutStatus = await page.evaluate(async () => (await fetch("/api/v1/local-owner-session", { method: "DELETE" })).status);
  expect(signOutStatus).toBe(204);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  await expect(page.getByLabel("Owner code")).toBeVisible();
  expect(failedResponses, "the owner journey must not hide a server error behind rendered controls").toEqual([]);
});
