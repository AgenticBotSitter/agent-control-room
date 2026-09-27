import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1 } from "../../src/completion-gate/v1";
import { sha256Digest } from "../../src/security";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres";
import { openMacLocalRollbackCheckpointStoreV1 } from "../../src/web/v1/mac-local-rollback-checkpoint-store";
import { loadMacLocalTaskRuntimeFromRootV1 } from "../../src/web/v1/mac-local-task-runtime";
import { AuditStore, auditPartition } from "../../src/audit/audit-store";
import type { DatabaseClient } from "../../src/persistence/database";
import { workBatchProposalDigestV1 } from "../../src/work-intake/v1/schemas";

const ownerCode = process.env.CONTROL_ROOM_E2E_OWNER_CODE;
if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
const rehearsalRoot = process.env.CONTROL_ROOM_E2E_ROOT;
if (!rehearsalRoot || resolve(rehearsalRoot) !== rehearsalRoot) throw new Error("CONTROL_ROOM_E2E_ROOT must be absolute");
const exec = promisify(execFile);

async function expectHealthyPage(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|could not read the saved task database or service/i);
}

async function refreshUntil(page: Page, locatorName: string, timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.getByRole("button", { name: locatorName }).count()) return;
    const refresh = page.getByRole("button", { name: "Check latest saved status" }).first();
    if (await refresh.isEnabled().catch(() => false)) await refresh.click();
    await page.waitForTimeout(1_000);
  }
  throw new Error(`timed out waiting for ${locatorName}`);
}

async function createPreparedTask(page: Page, projectPath: string, title: string, worker: "Hermes Agent" | "Claude Code" | "Codex",
  observePolling = false, run = true, preUpgradeShape = false) {
  await page.goto(`${projectPath}/tasks#new-task`);
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("What should the agent deliver?").fill("Return one harmless short line for owner review.");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  if (preUpgradeShape) {
    const sourceJobId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
    await removePostUpgradeProposalRows(sourceJobId);
    await page.reload();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  const sourceUrl = page.url();
  const workerChoice = page.getByLabel("Choose a prepared worker");
  await workerChoice.selectOption({ label: worker });
  if (observePolling) {
    let apiRequests = 0;
    const count = (request: { url(): string }) => { if (request.url().includes("/api/v1/")) apiRequests++; };
    page.on("request", count);
    await page.waitForTimeout(60_500);
    page.off("request", count);
    expect(apiRequests, "a visible task page must use bounded refreshes, not a tight request loop").toBeLessThanOrEqual(30);
    await expect(workerChoice).toHaveValue(/template:/);
  }
  await page.getByRole("button", { name: "Prepare saved task" }).click();
  await page.goto(sourceUrl);
  await expect(page.getByRole("status")).toContainText("Prepared task status: proposed");
  await expect(page.getByRole("button", { name: "Assign after preparation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve after assignment" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open the prepared task" }).click();
  await expect(page.getByRole("button", { name: "Assign and run" })).toBeEnabled();
  if (!run) return;
  await page.getByRole("button", { name: "Assign and run" }).click();
  await expect(page.getByText("Assignment and queue submission recorded.")).toBeVisible();
  await expectHealthyPage(page);
}

async function disposableAdmin() {
  const config = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/mac-local.json`, "utf8"));
  if (config.database?.host !== "127.0.0.1" || config.database?.database !== "control_room")
    throw new Error("browser_fixture_refused_non_disposable_database");
  const client = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres" });
  await client.connect();
  return { client, config };
}

async function removePostUpgradeProposalRows(jobId: string) {
  const { client } = await disposableAdmin();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM control_task_model_selections WHERE job_id=$1", [jobId]);
    await client.query("DELETE FROM control_task_declared_scopes WHERE job_id=$1", [jobId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { await client.end(); }
}

async function submitProposalOnlyBatch(projectId: string) {
  const { client, config } = await disposableAdmin();
  const installed = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/work-intake.json`, "utf8"));
  const identityId = installed.principal.identityId;
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
    await client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Browser journey proposer',
      'work-intake',$3,'active',clock_timestamp(),clock_timestamp()) ON CONFLICT(tenant_id,id) DO NOTHING`,
    [identityId, config.localOwnerSession.tenantId, `sha256:${"1".repeat(64)}`]);
    await client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES('grant:browser-journey-proposer',$1,$2,'work_batch_proposer','["work_batches.propose"]',$3::jsonb,
      'low',false,false,clock_timestamp(),clock_timestamp()) ON CONFLICT(tenant_id,id) DO NOTHING`,
    [config.localOwnerSession.tenantId, identityId, JSON.stringify([projectId])]);
    const envelope = JSON.stringify({ idempotencyKey: "browser-machine-intake-0001", proposal });
    const origin = `http://127.0.0.1:${installed.port}`;
    const headers = { authorization: `Bearer ${installed.bearerSecret}`, "content-type": "application/json" };
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
      { headers: { authorization: `Bearer ${installed.bearerSecret}` } });
    expect(status.status, "status reread must verify the stored digest and HMAC").toBe(200);
    const durable = (await client.query<{ revisions: string; proposes: string; replays: string }>(`SELECT
      (SELECT count(*)::text FROM work_batch_revisions WHERE tenant_id=$1 AND batch_id=$2) revisions,
      (SELECT count(*)::text FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='work_batches.propose') proposes,
      (SELECT count(*)::text FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='work_batches.propose.replayed') replays`,
    [config.localOwnerSession.tenantId, receipt.batchId])).rows[0]!;
    expect(durable).toEqual({ revisions: "1", proposes: "1", replays: "1" });
    const audit = await new AuditStore(client as unknown as DatabaseClient).verify(config.localOwnerSession.tenantId,
      auditPartition(installed.principal.authenticatedAt));
    expect(audit.valid, "the real proposal and replay must preserve the audit chain").toBe(true);
    const after = (await client.query<{ requests: string; workflows: string; jobs: string; tasks: string; queue: string }>(`SELECT
      (SELECT count(*)::text FROM control_requests) requests,
      (SELECT count(*)::text FROM control_workflows) workflows,
      (SELECT count(*)::text FROM control_jobs) jobs,
      (SELECT count(*)::text FROM work_items) tasks,
      (SELECT count(*)::text FROM control_room_queue.job) queue`)).rows[0]!;
    expect(after, "a proposal-only batch cannot create an ordinary task, workflow, job, or queue item").toEqual(before);
  } finally { await client.end(); }
}

async function waitForLatestDisposableLeaseExpiry(jobId: string) {
  const { client, config } = await disposableAdmin();
  let waitMs = -1;
  try {
    const lease = (await client.query<{ wait_ms: string }>(`SELECT GREATEST(0,
        CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000))::bigint::text AS wait_ms
      FROM control_leases
      WHERE tenant_id=$1 AND job_id=$2 AND state='active'`, [config.localOwnerSession.tenantId, jobId])).rows[0];
    if (!lease) throw new Error("browser_expiry_fixture_missing_active_lease");
    waitMs = Number(lease.wait_ms);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5 * 60_000)
      throw new Error("browser_expiry_fixture_unbounded_wait");
  } finally { await client.end(); }
  await new Promise(resolveWait => setTimeout(resolveWait, waitMs + 250));
}

async function openResult(page: Page) {
  await refreshUntil(page, "Read result");
  await expect(page.getByText(/Local agent evidence/).first()).toBeVisible();
  await expect(page.getByText(/Legacy adapter evidence/)).toHaveCount(0);
  await page.getByRole("button", { name: "Read result" }).first().click();
  await expect(page.getByRole("heading", { name: "Received result" })).toBeVisible();
}

async function acceptReadResult(page: Page) {
  await page.getByLabel("I read it and it’s correct").check();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText(/Saved: quality acceptance/)).toBeVisible();
}

async function seedAcceptedEarlierReview(page: Page) {
  const pageUrl = new URL(page.url());
  const jobId = decodeURIComponent(pageUrl.pathname.split("/").at(-1)!);
  const projectId = decodeURIComponent(pageUrl.pathname.split("/").at(-3)!);
  const config = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/mac-local.json`, "utf8"));
  const roles = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/database-roles.json`, "utf8"));
  await exec(process.execPath, ["scripts/mac-local/down.mjs", "--protected-root", `${rehearsalRoot}/protected`],
    { cwd: process.cwd(), timeout: 120_000 });
  let database: ReturnType<typeof createPrivatePostgresDatabase> | undefined;
  let checkpoints: Awaited<ReturnType<typeof openMacLocalRollbackCheckpointStoreV1>> | undefined;
  try {
    database = createPrivatePostgresDatabase(roles.web);
    checkpoints = await openMacLocalRollbackCheckpointStoreV1(`${rehearsalRoot}/protected`);
    const runtime = await loadMacLocalTaskRuntimeFromRootV1(`${rehearsalRoot}/protected`);
    const gate = new CompletionGateStoreV1(database.client, runtime.keys.review, checkpoints);
    const plan = (await database.client.query<{ target_id: string }>(
      "SELECT plan->>'targetId' AS target_id FROM control_native_review_plans WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3",
      [config.localOwnerSession.tenantId, projectId, jobId])).rows[0];
    if (!plan?.target_id) throw new Error("browser_accepted_earlier_fixture_missing_target");
    const snapshot = await gate.snapshot(config.localOwnerSession.tenantId, plan.target_id);
    const profile = await gate.getRecord(config.localOwnerSession.tenantId,
      snapshot.target.acceptanceProfileId, "profile") as CompletionAcceptanceProfileV1;
    await gate.recordReview({ schemaVersion: "control-room-completion-gate/v1", id: `review:${randomUUID()}`,
      tenantId: config.localOwnerSession.tenantId, projectId, targetId: snapshot.target.id,
      targetDigest: snapshot.targetDigest, acceptanceProfileId: profile.id,
      acceptanceProfileDigest: sha256Digest(profile),
      reviewer: { actorId: `identity:${config.localOwnerSession.tenantId}:owner`, actorType: "human" },
      authority: "completion_gate", decision: "accepted", assessedRisk: "low", effectiveRisk: "low",
      evidenceDigests: [snapshot.target.subjectDigest], findingIds: [], reviewedAt: new Date().toISOString(),
      grantsApproval: false, grantsExecutionAuthority: false }, []);
  } finally {
    await checkpoints?.close();
    await database?.close();
    await exec(process.execPath, ["scripts/mac-local/up.mjs", "--protected-root", `${rehearsalRoot}/protected`],
      { cwd: process.cwd(), timeout: 180_000 });
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectHealthyPage(page);
}

async function recordStandaloneAcceptanceVerification(page: Page) {
  await page.getByRole("button", { name: "I read it and it’s correct", exact: true }).click();
  await expect(page.getByText(/Recorded human verification: Passed/)).toBeVisible();
}

async function waitForCompletedAccepted(page: Page) {
  await expect.poll(async () => {
    const refresh = page.getByRole("button", { name: "Check latest saved status" }).first();
    if (await refresh.isEnabled().catch(() => false)) await refresh.click();
    return page.locator(".private-task-detail .private-state").first().innerText();
  }, { timeout: 150_000 }).toBe("Completed · Accepted");
  await expect(page.getByRole("heading", { name: /Revision 0 · Accepted/ })).toBeVisible();
  await expect(page.getByText(/Checks still needed:/)).toHaveCount(0);
}

test("owner completes the real local website journey for every configured worker", async ({ page }) => {
  const failedResponses: string[] = [];
  page.on("response", response => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  await page.getByLabel("Owner code").fill(ownerCode);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Owner browser journey");
  await page.getByLabel("What do you want to accomplish?").fill("Exercise the complete local owner workflow in a disposable rehearsal.");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Owner browser journey" })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  const projectId = decodeURIComponent(projectPath.split("/").at(-1)!);
  await expect(page.getByRole("link", { name: "New task" })).toBeVisible();

  const browserMachineBoundary = await page.evaluate(async ({ projectId }) => (await fetch(
    `/v1/projects/${encodeURIComponent(projectId)}/work-batches`, { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" })).status, { projectId });
  expect(browserMachineBoundary, "the owner website must not expose the machine-intake route").toBe(404);
  await submitProposalOnlyBatch(projectId);
  await page.goto(`${projectPath}/tasks`);
  await expect(page.getByText("Machine-only proposed batch")).toHaveCount(0);

  await createPreparedTask(page, projectPath, "Hermes browser task", "Hermes Agent", true, true, true);
  await openResult(page);
  await page.getByLabel("Changes you want").fill("Return a second harmless line in a linked revision.");
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByText(/Saved: changes requested/)).toBeVisible();
  await page.getByRole("button", { name: "Prepare revised task" }).click();
  await expect(page.getByRole("link", { name: "Open revised task" })).toBeVisible();

  await createPreparedTask(page, projectPath, "Claude browser task", "Claude Code");
  await openResult(page);
  const selectedResult = new URL(page.url()).searchParams.get("result");
  expect(selectedResult).toBeTruthy();
  const reloaded = await page.reload({ waitUntil: "domcontentloaded" });
  expect(reloaded?.status()).toBe(200);
  await expectHealthyPage(page);
  await expect(page.getByRole("heading", { name: "Received result" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("result")).toBe(selectedResult);
  await acceptReadResult(page);
  await waitForCompletedAccepted(page);

  await page.goto(`${projectPath}/tasks`);
  const completedWork = page.locator('section[aria-label="Saved tasks"] li').filter({ hasText: "Claude browser task" })
    .filter({ hasText: "Completed · Accepted" });
  await expect(completedWork).toHaveCount(1);
  await page.goto("/");
  const recentResults = page.locator('section[aria-labelledby="home-results"]');
  await expect(recentResults.getByText("Claude browser task")).toBeVisible();
  await expect(recentResults).toContainText("Completed · Accepted");
  await expect(page.locator('section[aria-labelledby="home-active"]')).not.toContainText("Claude browser task");
  await expect(page.locator('section[aria-labelledby="home-attention"]')).not.toContainText("Claude browser task");
  await page.goto("/needs-me");
  await expect(page.getByRole("heading", { name: "Tasks needing attention" }).locator("..")).not.toContainText("Claude browser task");

  await createPreparedTask(page, projectPath, "Codex browser task", "Codex");
  await openResult(page);
  await seedAcceptedEarlierReview(page);
  await expect(page.getByText(/accepted · Completion review/)).toBeVisible();
  await expect(page.getByText(/Checks still needed:/)).toBeVisible();
  await expect.poll(async () => {
    const refresh = page.getByRole("button", { name: "Check latest saved status" }).first();
    if (await refresh.isEnabled().catch(() => false)) await refresh.click();
    return page.locator(".private-task-detail .private-state").first().innerText();
  }, { timeout: 150_000 }).toBe("Completed");
  const acceptedEarlierUrl = page.url();
  await page.goto("/");
  await expect(page.locator('section[aria-labelledby="home-active"]')).not.toContainText("Codex browser task");
  await page.goto(acceptedEarlierUrl);
  await expect(page.getByRole("heading", { name: "Received result" })).toBeVisible();
  await recordStandaloneAcceptanceVerification(page);
  await waitForCompletedAccepted(page);

  await createPreparedTask(page, projectPath, "Expired reservation recovery", "Hermes Agent", false, false);
  let blockedSubmission = true;
  await page.route("**/submission", async route => {
    if (blockedSubmission && route.request().method() === "POST") { blockedSubmission = false; await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Assign and run" }).click();
  await expect(page.getByText(/reservation was recorded, but queue submission was not confirmed/i)).toBeVisible();
  const jobId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  await waitForLatestDisposableLeaseExpiry(jobId);
  await page.reload();
  await page.getByRole("button", { name: "Reconcile expired reservation" }).click();
  await expect(page.getByRole("button", { name: "Assign and run" })).toBeEnabled();
  await page.unroute("**/submission");
  await page.getByRole("button", { name: "Assign and run" }).click();
  await expect(page.getByText("Assignment and queue submission recorded.")).toBeVisible();
  await expectHealthyPage(page);

  for (const [label, suffix] of [["Overview", ""], ["Tasks", "/tasks"], ["Reviews", "/reviews"],
    ["Activity", "/activity"], ["Files", "/files"]] as const) {
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
