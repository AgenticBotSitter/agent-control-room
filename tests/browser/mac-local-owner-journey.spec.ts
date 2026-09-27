import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const ownerCode = process.env.CONTROL_ROOM_E2E_OWNER_CODE;
if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
const rehearsalRoot = process.env.CONTROL_ROOM_E2E_ROOT;
if (!rehearsalRoot || resolve(rehearsalRoot) !== rehearsalRoot) throw new Error("CONTROL_ROOM_E2E_ROOT must be absolute");

async function expectHealthyPage(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|could not read the saved task database or service/i);
}

async function refreshUntil(page: Page, locatorName: string, timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.getByRole("button", { name: locatorName }).count()) return;
    const refresh = page.getByRole("button", { name: "Check latest saved status" });
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

async function expireLatestDisposableLease(jobId: string) {
  const { client, config } = await disposableAdmin();
  try {
    const lease = (await client.query<{ acquired_at: string | Date }>(`SELECT acquired_at FROM control_leases
      WHERE tenant_id=$1 AND job_id=$2 AND state='active'`, [config.localOwnerSession.tenantId, jobId])).rows[0];
    if (!lease) throw new Error("browser_expiry_fixture_missing_active_lease");
    const expiredAt = new Date(new Date(lease.acquired_at).getTime() + 1_000).toISOString();
    const wait = Date.parse(expiredAt) - Date.now() + 100;
    if (wait > 0) await new Promise(resolveWait => setTimeout(resolveWait, wait));
    const result = await client.query(`UPDATE control_leases SET expires_at=$1,
      payload=jsonb_set(payload,'{expiresAt}',to_jsonb($1::text),false),updated_at=now()
      WHERE tenant_id=$2 AND job_id=$3 AND state='active'`, [expiredAt, config.localOwnerSession.tenantId, jobId]);
    expect(result.rowCount).toBe(1);
  } finally { await client.end(); }
}

async function openResult(page: Page) {
  await refreshUntil(page, "Read result");
  await page.getByRole("button", { name: "Read result" }).first().click();
  await expect(page.getByRole("heading", { name: "Received result" })).toBeVisible();
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

  await page.getByLabel("Project name").fill("Owner browser journey");
  await page.getByLabel("What do you want to accomplish?").fill("Exercise the complete local owner workflow in a disposable rehearsal.");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Owner browser journey" })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  await expect(page.getByRole("link", { name: "New task" })).toBeVisible();

  await createPreparedTask(page, projectPath, "Hermes browser task", "Hermes Agent", true, true, true);
  await openResult(page);
  await page.getByLabel("Changes you want").fill("Return a second harmless line in a linked revision.");
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByText(/Saved: changes requested/)).toBeVisible();
  await page.getByRole("button", { name: "Prepare revised task" }).click();
  await expect(page.getByRole("link", { name: "Open revised task" })).toBeVisible();

  await createPreparedTask(page, projectPath, "Claude browser task", "Claude Code");
  await openResult(page);
  await page.getByRole("button", { name: "Accept quality" }).click();
  await expect(page.getByText(/Saved: quality acceptance/)).toBeVisible();
  await page.getByLabel("Configured human check").selectOption({ index: 1 });
  await page.getByLabel("Observed result").selectOption("passed");
  await page.getByLabel("Required observation note").fill("Observed the harmless rehearsal result in the protected result reader.");
  await page.getByRole("button", { name: "Record human verification" }).click();
  await expect(page.getByText(/Recorded human verification: Passed/)).toBeVisible();

  await createPreparedTask(page, projectPath, "Codex browser task", "Codex");
  await openResult(page);
  await page.getByRole("button", { name: "Accept quality" }).click();
  await expect(page.getByText(/Saved: quality acceptance/)).toBeVisible();

  await createPreparedTask(page, projectPath, "Expired reservation recovery", "Hermes Agent", false, false);
  let blockedSubmission = true;
  await page.route("**/submission", async route => {
    if (blockedSubmission && route.request().method() === "POST") { blockedSubmission = false; await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Assign and run" }).click();
  await expect(page.getByText(/reservation was recorded, but queue submission was not confirmed/i)).toBeVisible();
  const jobId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  await expireLatestDisposableLease(jobId);
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

  await page.goto("/session");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  expect(failedResponses, "the owner journey must not hide a server error behind rendered controls").toEqual([]);
});
