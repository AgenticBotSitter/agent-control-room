import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const ownerCode = process.env.CONTROL_ROOM_E2E_OWNER_CODE;
if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
const rehearsalRoot = process.env.CONTROL_ROOM_E2E_ROOT;
if (!rehearsalRoot || resolve(rehearsalRoot) !== rehearsalRoot) throw new Error("CONTROL_ROOM_E2E_ROOT must be absolute");
const origin = process.env.CONTROL_ROOM_E2E_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1" || new URL(origin).port === "3210")
  throw new Error("adversarial_browser_refused_non_disposable_origin");

type ApiResult = { status: number; text: string; contentType: string };

async function signIn(page: Page) {
  await page.goto("/session");
  await page.getByLabel("Owner code").fill(ownerCode!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
}

async function api(page: Page, path: string, method = "GET", body?: unknown, key?: string): Promise<ApiResult> {
  return page.evaluate(async ({ path, method, body, key }) => {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" };
  }, { path, method, body, key });
}

async function createProject(page: Page, title: string, key: string, summary = "Disposable adversarial browser coverage.") {
  const response = await api(page, "/api/v1/projects", "POST", { title, summary }, key);
  expect(response.status).toBe(201);
  return (JSON.parse(response.text) as { project: { projectId: string } }).project;
}

async function createTask(page: Page, projectId: string, title: string, instructions: string, key: string) {
  const response = await api(page, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, "POST",
    { title, instructions }, key);
  expect(response.status).toBe(201);
  return (JSON.parse(response.text) as { receipt: { jobId: string } }).receipt;
}

async function expectHealthy(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|\{"error"|undefined is not/i);
  await expect(page.locator('[role="status"]').filter({ hasText: /Loading|Checking saved|Reading|Saving…/i }))
    .toHaveCount(0, { timeout: 20_000 });
}

function observeBrowserErrors(page: Page, errors: string[], observeHttpFailures = false) {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) {
      if (/^Failed to load resource: the server responded with a status of \d+/.test(message.text())) return;
      const location = message.location().url;
      errors.push(`${message.text()}${location ? ` (${new URL(location).pathname})` : ""}`);
    }
  });
  if (observeHttpFailures) page.on("response", response => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
}

async function prepareAcceptance(page: Page) {
  const attestation = page.getByLabel("I read it and it’s correct");
  if (await attestation.count()) await attestation.check();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
}

async function activateTwice(locator: Locator) {
  await locator.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function refreshUntil(page: Page, buttonName: string, timeoutMs = 150_000) {
  await expect.poll(async () => {
    if (await page.getByRole("button", { name: buttonName }).count()) return true;
    const refresh = page.getByRole("button", { name: "Check latest saved status" }).first();
    if (await refresh.isEnabled().catch(() => false)) await refresh.click();
    return false;
  }, { timeout: timeoutMs, intervals: [1_000] }).toBe(true);
}

async function prepareTask(page: Page, projectId: string, title: string, worker = "Codex") {
  const projectPath = `/projects/${encodeURIComponent(projectId)}`;
  await page.goto(`${projectPath}/tasks#new-task`);
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("What should the agent deliver?").fill("Return one harmless short line for adversarial owner review.");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const sourceUrl = page.url();
  await page.getByLabel("Choose a prepared worker").selectOption({ label: worker });
  await page.getByRole("button", { name: "Prepare saved task" }).click();
  await page.goto(sourceUrl);
  await expect(page.getByRole("link", { name: "Open the prepared task" })).toBeVisible();
  await page.getByRole("link", { name: "Open the prepared task" }).click();
  await expect(page.getByRole("button", { name: "Assign and run" })).toBeEnabled();
  return new URL(page.url()).pathname;
}

async function assignAndOpenResult(page: Page, doubleClick = false) {
  const assignments: string[] = [], submissions: string[] = [];
  const count = (request: { method(): string; url(): string }) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/assignment")) assignments.push(request.url());
    if (request.url().endsWith("/submission")) submissions.push(request.url());
  };
  page.on("request", count);
  const button = page.getByRole("button", { name: "Assign and run" });
  if (doubleClick) await activateTwice(button); else await button.click();
  await expect(page.getByText("Assignment and queue submission recorded.")).toBeVisible();
  page.off("request", count);
  expect(assignments, "one owner gesture must record at most one assignment").toHaveLength(1);
  expect(submissions, "one owner gesture must queue at most one submission").toHaveLength(1);
  await refreshUntil(page, "Read result");
  await page.getByRole("button", { name: "Read result" }).first().click();
  await expect(page.getByRole("heading", { name: "Received result" })).toBeVisible();
}

async function disposableAdmin() {
  const config = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/mac-local.json`, "utf8"));
  const roles = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/database-roles.json`, "utf8"));
  if (config.database?.host !== "127.0.0.1" || config.database?.database !== "control_room"
    || !Number.isInteger(config.database.port) || config.database.port === 5432
    || origin !== config.localOwnerSession?.origin || new URL(origin!).port !== String(config.port)
    || roles.coordinator?.host !== config.database.host || roles.coordinator?.port !== config.database.port
    || roles.coordinator?.database !== config.database.database)
    throw new Error("adversarial_browser_refused_non_disposable_database");
  const client = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres" });
  await client.connect();
  const identity = (await client.query<{ data_directory: string }>("SELECT current_setting('data_directory') AS data_directory")).rows[0];
  if (resolve(identity?.data_directory ?? "") !== resolve(rehearsalRoot!, "pg")) {
    await client.end();
    throw new Error("adversarial_browser_refused_non_disposable_database");
  }
  return client;
}

async function setDisposableNodeState(nodeId: string, state: "active" | "disabled") {
  const client = await disposableAdmin();
  try {
    const changed = await client.query(`UPDATE control_nodes SET state=$1,
      payload=jsonb_set(payload,'{state}',to_jsonb($1::text)),updated_at=now() WHERE id=$2 RETURNING state`, [state, nodeId]);
    if (changed.rowCount !== 1) throw new Error("adversarial_browser_node_fixture_missing");
    if (changed.rows[0]?.state !== state) throw new Error("adversarial_browser_node_fixture_not_applied");
  } finally { await client.end(); }
}

test.describe("disposable owner website adversarial attacks", () => {
  test.beforeAll(async () => {
    const client = await disposableAdmin();
    await client.end();
  });

  test("readiness, invalid filters, reloads and layout tell one coherent human story", async ({ page }) => {
    const browserErrors: string[] = [];
    observeBrowserErrors(page, browserErrors, true);
    await signIn(page);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Local worker evidence" })).toBeVisible();
    await expect(page.locator("main")).toContainText("pinned executable was verified");
    await expect(page.locator("main")).toContainText("Neither signal says a worker is currently running");
    await expect(page.locator("main")).toContainText("Startup check passed · no result proof recorded this host run");
    await expect(page.locator("main")).not.toContainText(/Installation setup status is unavailable|Local worker routes are unavailable|readiness not proven/i);

    await page.goto("/projects?lifecycle=garbage");
    await expect(page.getByRole("alert")).toContainText("filter was invalid and has been reset to All");
    await expect(page.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page");

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      for (const path of ["/", "/projects", "/workers", "/needs-me"]) {
        await page.goto(path); await expectHealthy(page); await expectNoHorizontalOverflow(page);
        await page.reload(); await expectHealthy(page); await expectNoHorizontalOverflow(page);
      }
    }
    expect(browserErrors).toEqual([]);
  });

  test("hostile forms store inert text, reject invalid sizes, allow deliberate duplicate names, and survive Back", async ({ page }) => {
    const dialogs: string[] = [], browserErrors: string[] = [], createPosts: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    observeBrowserErrors(page, browserErrors);
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/projects") createPosts.push(request.url()); });
    await signIn(page);

    await page.getByRole("button", { name: "Create project" }).click();
    expect(await page.getByLabel("Project name").evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(false);
    const postsBeforeEmpty = createPosts.length;
    await page.getByLabel("Project name").fill("   ");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a name of 1–120 characters");
    expect(createPosts.length).toBe(postsBeforeEmpty);
    const tooLongProject = await api(page, "/api/v1/projects", "POST", { title: "x".repeat(5_000), summary: "bounded" }, "advlongproject0001");
    expect(tooLongProject.status).toBe(400);

    const hostileTitle = "Adversarial 🧪 שלום <script>alert(1)</script> '; DROP TABLE -- **bold**";
    const hostileSummary = "<img src=x onerror=alert(2)> [link](javascript:alert(3)) مرحبا";
    await page.getByLabel("Project name").fill(hostileTitle);
    await page.getByLabel("What do you want to accomplish?").fill(hostileSummary);
    const postsBefore = createPosts.length;
    await activateTwice(page.getByRole("button", { name: "Create project" }));
    await expect(page.getByRole("heading", { name: hostileTitle })).toBeVisible();
    expect(createPosts.length - postsBefore).toBe(1);
    const projectPath = new URL(page.url()).pathname;
    const projectId = decodeURIComponent(projectPath.split("/").at(-1)!);
    await expect(page.locator("main script")).toHaveCount(0);
    await expect(page.locator("main img")).toHaveCount(0);
    await expect(page.locator("main")).toContainText(hostileSummary);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: hostileTitle })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: hostileTitle })).toBeVisible();

    const duplicateOne = await createProject(page, "Duplicate project name", "advduplicateproject01");
    const duplicateTwo = await createProject(page, "Duplicate project name", "advduplicateproject02");
    expect(duplicateOne.projectId).not.toBe(duplicateTwo.projectId);

    await page.goto(`${projectPath}/tasks#new-task`);
    await page.getByLabel("Task title").fill("   ");
    await page.getByLabel("What should the agent deliver?").fill("   ");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(page.getByRole("alert")).toContainText("Check the title and instructions");
    const tooLongTask = await api(page, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, "POST",
      { title: "bounded", instructions: "x".repeat(5_000) }, "advlongtask000001");
    expect(tooLongTask.status).toBe(400);

    const taskTitle = "Task 😀 שלום <script>alert(4)</script> SELECT * FROM owners; **text**";
    const instructions = "Return literal text: <b>not HTML</b> `markdown` مرحبا and '; DROP TABLE jobs --";
    await page.getByLabel("Task title").fill(taskTitle);
    await page.getByLabel("What should the agent deliver?").fill(instructions);
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();
    await expect(page.locator("main")).toContainText(instructions);
    await expect(page.locator("main script")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();
    const duplicateTaskOne = await createTask(page, projectId, "Duplicate task name", "First duplicate body.", "advduplicatetask001");
    const duplicateTaskTwo = await createTask(page, projectId, "Duplicate task name", "Second duplicate body.", "advduplicatetask002");
    expect(duplicateTaskOne.jobId).not.toBe(duplicateTaskTwo.jobId);
    expect(dialogs).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test("URLs, CSRF, cross-project objects, stale pages and worker authority fail closed", async ({ page, context }) => {
    const browserErrors: string[] = [];
    observeBrowserErrors(page, browserErrors);
    await signIn(page);
    const projectA = await createProject(page, "Authority project A", "advauthorityproject1");
    const projectB = await createProject(page, "Authority project B", "advauthorityproject2");
    const source = await createTask(page, projectA.projectId, "Unfinished authority task", "Remain unfinished.", "advauthoritytask001");
    const detail = await api(page, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/tasks/${encodeURIComponent(source.jobId)}`);
    const inputDigest = (JSON.parse(detail.text) as { inputDigest: string }).inputDigest;

    const missingOrigin = await page.request.post(`${origin}/api/v1/projects`, { headers: {
      "content-type": "application/json", "idempotency-key": "advmissingorigin001" },
      data: { title: "Must not save", summary: "Missing Origin" } });
    expect(missingOrigin.status()).toBe(403);
    const wrongOrigin = await page.request.post(`${origin}/api/v1/projects`, { headers: { origin: "http://127.0.0.1:1",
      "content-type": "application/json", "idempotency-key": "advwrongorigin0001" },
      data: { title: "Must not save", summary: "Wrong Origin" } });
    expect(wrongOrigin.status()).toBe(403);

    const crossProjectPlan = await api(page, `/api/v1/projects/${encodeURIComponent(projectB.projectId)}/tasks/${encodeURIComponent(source.jobId)}/plan`,
      "POST", { expectedInputDigest: inputDigest }, "");
    expect(crossProjectPlan.status).toBe(404);
    const forgedReview = await api(page, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/tasks/${encodeURIComponent(source.jobId)}/results/artifact:missing/reviews/target:missing`,
      "POST", { artifactId: "artifact:missing", targetId: "target:missing", targetDigest: `sha256:${"a".repeat(64)}`,
        contentHash: `sha256:${"b".repeat(64)}`, decision: "accepted", feedback: "" }, "advunfinishedreview1");
    expect(forgedReview.status).toBe(404);
    const projectPath = `/projects/${encodeURIComponent(projectA.projectId)}`;
    const badPagePaths = [
      "/projects/project:missing",
      `${projectPath}/tasks/job:missing`,
      "/projects/%25",
      `/projects/${encodeURIComponent(projectB.projectId)}/tasks/${encodeURIComponent(source.jobId)}`,
    ];
    for (const badPath of badPagePaths) {
      const response = await page.goto(badPath);
      expect(response?.status(), badPath).toBeGreaterThanOrEqual(400);
      await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
      await expect(page.getByRole("alert")).toContainText("not available");
      await expect(page.locator("body")).not.toContainText('{"error"');
    }
    await page.goto("/projects?lifecycle=active&lifecycle=paused");
    await expect(page.getByRole("alert")).toContainText("page address is invalid");
    await expectHealthy(page);

    const stale = await context.newPage();
    observeBrowserErrors(stale, browserErrors);
    await page.goto(projectPath); await stale.goto(projectPath);
    const staleProject = await api(stale, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}`);
    const staleVersion = (JSON.parse(staleProject.text) as { project: { version: number } }).project.version;
    await page.getByRole("button", { name: "Pause project" }).click();
    await expect(page.getByText(/^paused ·/)).toBeVisible();
    const staleTransition = await api(stale, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/lifecycle`,
      "POST", { lifecycle: "completed", expectedVersion: staleVersion }, "advstalelifecycle01");
    expect(staleTransition.status).toBe(409);
    await stale.reload(); await expect(stale.getByText(/^paused ·/)).toBeVisible();
    await page.getByRole("button", { name: "Reopen project" }).click();
    await expect(page.getByText(/^active ·/)).toBeVisible();
    await stale.close();

    const preparedPath = await prepareTask(page, projectA.projectId, "Authority assignment task");
    const preparedId = decodeURIComponent(preparedPath.split("/").at(-1)!);
    const assignmentRead = await api(page, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/tasks/${encodeURIComponent(preparedId)}/assignment`);
    const assignment = JSON.parse(assignmentRead.text) as { inputDigest: string; candidates: { nodeId: string }[] };
    expect(assignment.candidates.length).toBeGreaterThan(0);
    const unknownWorker = await api(page, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/tasks/${encodeURIComponent(preparedId)}/assignment`,
      "POST", { action: "assign", nodeId: "node:unknown", expectedInputDigest: assignment.inputDigest });
    expect(unknownWorker.status).toBe(409);
    const candidate = assignment.candidates[0]!.nodeId;
    const crossProjectAssignment = await api(page,
      `/api/v1/projects/${encodeURIComponent(projectB.projectId)}/tasks/${encodeURIComponent(preparedId)}/assignment`,
      "POST", { action: "assign", nodeId: candidate, expectedInputDigest: assignment.inputDigest });
    expect(crossProjectAssignment.status).toBe(404);
    await setDisposableNodeState(candidate, "disabled");
    try {
      const disabledWorker = await api(page, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/tasks/${encodeURIComponent(preparedId)}/assignment`,
        "POST", { action: "assign", nodeId: candidate, expectedInputDigest: assignment.inputDigest });
      expect(disabledWorker.status).toBe(409);
      await page.getByRole("button", { name: "Assign and run" }).click();
      await expect(page.getByRole("alert")).toContainText(/worker|assign|available|active/i);
    } finally { await setDisposableNodeState(candidate, "active"); }
    await page.reload();
    await expect(page.getByRole("button", { name: "Assign and run" })).toBeEnabled();
    expect(browserErrors).toEqual([]);
  });

  test("double actions, stale review, revision rerun and sign-out preserve one canonical state", async ({ page, context }) => {
    const browserErrors: string[] = [];
    observeBrowserErrors(page, browserErrors);
    await signIn(page);
    const project = await createProject(page, "Review state consistency", "advreviewproject001");
    const projectPath = `/projects/${encodeURIComponent(project.projectId)}`;
    const reviewPosts: { path: string; body: Record<string, unknown> }[] = [];
    const captureReview = (request: Request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.includes("/reviews/")) {
        reviewPosts.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      }
    };
    page.on("request", captureReview);

    await prepareTask(page, project.projectId, "Concurrent acceptance task");
    await assignAndOpenResult(page, true);
    const acceptedTaskUrl = page.url();
    const completedTaskPath = new URL(acceptedTaskUrl).pathname;
    const staleReview = await context.newPage();
    observeBrowserErrors(staleReview, browserErrors);
    staleReview.on("request", captureReview);
    await staleReview.goto(completedTaskPath);
    await refreshUntil(staleReview, "Read result");
    await staleReview.getByRole("button", { name: "Read result" }).first().click();
    await expect(staleReview.getByRole("heading", { name: "Received result" })).toBeVisible();
    await prepareAcceptance(page);
    await prepareAcceptance(staleReview);
    await Promise.all([
      page.getByRole("button", { name: "Accept", exact: true }).click(),
      staleReview.getByRole("button", { name: "Accept", exact: true }).click(),
    ]);
    await expect.poll(async () => `${await page.locator("body").innerText()}\n${await staleReview.locator("body").innerText()}`,
      { timeout: 20_000 }).toMatch(/Saved: quality acceptance/);
    await expect.poll(async () => `${await page.locator("body").innerText()}\n${await staleReview.locator("body").innerText()}`,
      { timeout: 20_000 }).toMatch(/result or review changed|decision is already recorded/i);
    const acceptedRequest = reviewPosts.find(request => request.body.decision === "accepted");
    expect(acceptedRequest).toBeDefined();
    const acceptedDraft = { ...acceptedRequest!.body };
    delete acceptedDraft.acceptanceAttestation;
    const requestChangesAfterAccept = await api(page, acceptedRequest!.path, "POST",
      { ...acceptedDraft, decision: "changes_requested", feedback: "This must be refused after acceptance." },
      "advchangesafteraccept1");
    expect(requestChangesAfterAccept.status).toBe(409);
    await expect(page.getByRole("button", { name: /Edit task/i })).toHaveCount(0);
    const editCompleted = await api(page, completedTaskPath, "POST",
      { title: "Edited", instructions: "A completed task must remain immutable." }, "adveditcompleted01");
    expect(editCompleted.status).toBe(404);
    await staleReview.close();

    await prepareTask(page, project.projectId, "Revision lifecycle task");
    await assignAndOpenResult(page);
    await page.getByLabel("Changes you want").fill("Return a corrected harmless line in a linked revision.");
    const reviewsBeforeRevision = reviewPosts.length;
    await activateTwice(page.getByRole("button", { name: "Request changes" }));
    await expect(page.getByText(/Saved: changes requested/)).toBeVisible();
    expect(reviewPosts.length - reviewsBeforeRevision).toBe(1);
    const revisionPosts: string[] = [];
    const captureRevision = (request: Request) => {
      if (request.method() === "POST" && request.url().endsWith("/revisions")) revisionPosts.push(request.url());
    };
    page.on("request", captureRevision);
    await activateTwice(page.getByRole("button", { name: "Prepare revised task" }));
    await expect(page.getByRole("link", { name: "Open revised task" })).toBeVisible();
    page.off("request", captureRevision);
    expect(revisionPosts).toHaveLength(1);
    await page.getByRole("link", { name: "Open revised task" }).click();
    await expect(page.getByRole("button", { name: "Assign and run" })).toBeEnabled();
    await assignAndOpenResult(page, true);
    await prepareAcceptance(page);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.getByText(/Saved: quality acceptance/)).toBeVisible();

    for (const path of [projectPath, `${projectPath}/tasks`, `${projectPath}/reviews`,
      `${projectPath}/activity`, `${projectPath}/files`, "/", "/needs-me"]) {
      await page.goto(path); await expectHealthy(page);
      if (path === `${projectPath}/tasks` || path === `${projectPath}/activity` || path === `${projectPath}/files`) {
        await expect(page.locator("main")).toContainText("Concurrent acceptance task");
        await expect(page.locator("main")).toContainText("Revision lifecycle task");
      }
    }
    expect(browserErrors).toEqual([]);

    const signOut = await api(page, "/api/v1/local-owner-session", "DELETE");
    expect(signOut.status).toBe(204);
    const afterSignOut = await api(page, "/api/v1/projects", "POST",
      { title: "Must not save after sign-out", summary: "Expired authority" }, "advaftersignout001");
    expect(afterSignOut.status).toBe(401);
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
    await expect(page.getByLabel("Owner code")).toBeVisible();
  });
});
