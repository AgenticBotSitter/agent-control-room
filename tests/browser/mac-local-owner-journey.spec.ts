import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:https";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { sha256Digest } from "../../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../../src/web/v1/mac-local-web-process";
import { createMacLocalNodeHandler } from "../../src/web/v1/private-node-handler";
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
const rehearsalRoot = process.env.CONTROL_ROOM_E2E_ROOT;
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
  if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
  if (!rehearsalRoot || resolve(rehearsalRoot) !== rehearsalRoot) throw new Error("CONTROL_ROOM_E2E_ROOT must be absolute");
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


// This fixture exercises the real HTTP/session wrapper and shipped registration
// component. The synthetic passkey port proves browser navigation and fragment
// handling, not PostgreSQL persistence, phone Face ID, or installed HTTPS.
// The attempt budget belongs to the server, not a browser context. Each
// viewport and link journey therefore needs its own real session service.
for (const includeOwnerCode of [true, false]) for (const width of [390, 1280]) test(`${includeOwnerCode
  ? "V101: a fresh browser opens the installer fragment and reaches registration without leaking URL secrets"
  : "V101: a fresh browser scans a reg-only QR and signs in on setup without losing registration"} (${width}px)`,
  async ({ browser }) => runSetupJourney(browser, includeOwnerCode, width));

test("V101: setup refuses the eleventh authentication attempt with the documented wait message", async ({ browser }) => {
  await runSetupJourney(browser, true, 390, true);
});

async function runSetupJourney(browser: Browser, includeOwnerCode: boolean, width: number, exerciseLimiter = false) {
  const code = "A".repeat(43), secret = "R".repeat(43), nextSecret = "T".repeat(43);
  const bundle = await build({ stdin: { contents: `import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {PasskeyRegistration} from './private-app/app/setup/passkey-registration';
    createRoot(document.getElementById('registration')).render(<PasskeyRegistration />);`,
    loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", jsx: "automatic" });
  const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body><a class="skip-link" href="#private-main">Skip to content</a><main id="private-main"><div id="registration"></div></main><script>${bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const tlsParent = join(process.cwd(), ".test-tmp");
  await mkdir(tlsParent, { recursive: true });
  const tlsRoot = await mkdtemp(join(tlsParent, "browser-setup-tls-"));
  let server: ReturnType<typeof createServer> | undefined;
  const requests: Array<{ url: string; referer: string }> = [];
  let app: ReturnType<typeof createMacLocalWebProcessV1> | undefined;
  try {
    const key = join(tlsRoot, "key.pem"), certificate = join(tlsRoot, "cert.pem");
    const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
      "-out", certificate, "-days", "1", "-subj", "/CN=localhost"], { encoding: "utf8", timeout: 10_000 });
    expect(generated.status, `openssl must create the disposable certificate: ${generated.error ?? generated.stderr}`).toBe(0);
    server = createServer({ key: await readFile(key), cert: await readFile(certificate) });
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject); server!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_listener_address_invalid");
    const loopbackOrigin = `http://127.0.0.1:${address.port}`;
    const localOrigin = `https://localhost:${address.port}`;
    const unavailable = async (): Promise<never> => { throw new Error("setup fixture must not touch database"); };
    let inserted = 0; const used = new Set<string>();
    app = createMacLocalWebProcessV1({ origin: loopbackOrigin, workspaceId: "workspace:browser-setup",
      localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: loopbackOrigin, trustedOrigin: localOrigin,
        tenantId: "tenant:browser-setup", provider: "local", subject: "owner:browser-setup",
        ownerCodeDigest: sha256Digest({ ownerCode: code }), sessionSeconds: 900 },
      database: { client: { query: unavailable, transaction: unavailable, transactionWithPreCommitCheck: unavailable },
        close: async () => {}, isAvailable: () => true },
      passkeyRegistration: {
        async options(input) {
          expect([secret, nextSecret]).toContain(input.registrationSecret);
          expect(input.ownerSessionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
          if (used.has(input.registrationSecret)) throw Object.assign(new Error("synthetic used-link refusal"), { code: "updater_registration_expired" });
          return { publicKey: { challenge: "B".repeat(43), rp: { name: "Disposable setup", id: "localhost" },
            user: { id: "U".repeat(43), name: "owner", displayName: "Owner" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" } } };
        },
        async insert(input) { expect([secret, nextSecret]).toContain(input.registrationSecret); expect(input.comparisonCode).toMatch(/^[A-Z2-7]{6}$/);
          used.add(input.registrationSecret); inserted += 1; return { registered: true }; },
      } });
    const nodeHandler = createMacLocalNodeHandler({ origin: loopbackOrigin, secondaryOrigin: localOrigin, application: app,
      assets: { count: 0, digest: "synthetic:no-assets", respond: () => undefined },
      handler: request => app!.handle(request, () => new Response(html, { headers: { "content-type": "text/html" } })) });
    server.on("request", (input, output) => {
      // Observe the wire before the production adapter filters headers.
      requests.push({ url: new URL(input.url ?? "/", localOrigin).href, referer: input.headers.referer ?? "" });
      void nodeHandler.handle(input, output);
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 } });
    try {
      expect(await context.cookies()).toEqual([]);
      const page = await context.newPage();
      const skipContent = async (keyboard = false) => {
        // Wait for the actual hashchange and React render, rather than racing
        // an assertion against the old DOM or assuming a fixed delay.
        const changed = page.evaluate(() => new Promise<void>(done => window.addEventListener("hashchange", () => {
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        }, { once: true })));
        if (keyboard) {
          await page.getByRole("link", { name: "Skip to content" }).focus();
          await page.keyboard.press("Enter");
        } else await page.getByRole("link", { name: "Skip to content" }).click();
        await changed;
        await expect(page).toHaveURL(/#private-main$/);
      };
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      if (includeOwnerCode) {
        let first = true;
        await page.route("**/api/v1/local-owner-session", async route => {
          if (first) { first = false; await route.abort("connectionreset"); }
          else await route.continue();
        });
      }
      const link = includeOwnerCode ? `${localOrigin}/setup#code=${code}&reg=${secret}`
        : `${localOrigin}/setup#reg=${secret}&mode=initial`;
      const response = await page.goto(link);
      expect(response!.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Register Face ID" })).toBeVisible();
      if (includeOwnerCode) {
        await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(page.getByLabel("Owner code")).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText(code);
        await page.getByRole("button", { name: "Try again" }).click();
      } else {
        await expect(page.getByLabel("Owner code")).toBeVisible();
        expect(new URL(page.url()).hash).toBe("");
        expect(await context.cookies()).toEqual([]);
        await page.getByLabel("Owner code").fill("ABC234");
        await page.getByRole("button", { name: "Sign in and continue" }).click();
        await expect(page.getByRole("alert")).toHaveText("Owner codes are 43 characters. You may have copied extra text. Copy only the owner code, without the link.");
        expect(new URL(page.url()).pathname).toBe("/setup");
        await page.getByLabel("Owner code").fill(code);
        await page.getByRole("button", { name: "Sign in and continue" }).click();
      }
      await expect(page.getByRole("status", { name: "Passkey comparison code" })).toHaveText(/^[A-Z2-7]{6}$/);
      expect(new URL(page.url()).hash).toBe("");
      if (exerciseLimiter) {
        // Policy: ten authentication attempts in sixty seconds. The first
        // registration used two: options and insert. Signing in has a
        // separate failure budget. Eight replay option requests exhaust
        // this budget; the ninth must be refused.
        // Keep the real browser, session service and HTTP adapter in this path.
        const replay = async () => {
          await page.goto("about:blank");
          const options = page.waitForResponse(response => new URL(response.url()).pathname
            === "/api/v1/passkeys/registration/options");
          await page.goto(`${localOrigin}/setup#reg=${secret}&mode=initial`);
          return await options;
        };
        for (let attempt = 3; attempt <= 10; attempt++) {
          expect((await replay()).status(), `attempt ${attempt} reaches the used-link refusal`).toBe(410);
          await expect(page.getByRole("alert")).toContainText("Registration stopped");
        }
        const limited = await replay();
        expect(limited.status(), "the eleventh authentication attempt is limited").toBe(429);
        const retryAfter = limited.headers()["retry-after"];
        expect(retryAfter).toMatch(/^[1-9][0-9]*$/);
        expect(Number(retryAfter)).toBeLessThanOrEqual(60);
        await expect(page.getByRole("alert")).toHaveText(`Too many tries — wait ${retryAfter} seconds`);
        expect(inserted, "replay must not insert a second credential").toBe(1);
        expect(new URL(page.url()).hash).toBe("");
      } else {
        // S6: the first focusable layout link must preserve the displayed code.
        const comparison = page.getByRole("status", { name: "Passkey comparison code" });
        const beforeSkip = await comparison.textContent();
        await skipContent(true);
        await expect(comparison, "R5: comparison code survives skip link").toHaveText(beforeSkip!);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect((await context.cookies()).some(cookie => cookie.name === "control_room_local_owner")).toBe(true);
        // Same-document link replacement must be consumed by the product.
        await page.goto(`${localOrigin}/setup#reg=${nextSecret}&mode=add`);
        await expect.poll(() => used.has(nextSecret)).toBe(true);
        await expect(page.getByRole("status", { name: "Passkey comparison code" })).toHaveText(/^[A-Z2-7]{6}$/);
        expect(new URL(page.url()).hash).toBe("");
        // Replay is a full document navigation, separate from hashchange.
        await page.goto("about:blank");
        await page.goto(link);
        await expect(page.getByRole("alert")).toContainText("Registration stopped");
        expect(new URL(page.url()).hash).toBe("");
        await page.goto("about:blank");
        await page.goto(`${localOrigin}/setup#code=${code}&reg=${secret}&extra=1`);
        await expect(page.getByRole("alert")).toContainText("Registration stopped");
        // S6c: a plain setup page must not invent a stopped registration.
        await page.goto("about:blank");
        await page.goto(`${localOrigin}/setup`);
        await skipContent();
        await expect(page.getByRole("heading", { name: "Register Face ID" })).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        // S6b: hold the credential boundary, then click the real layout link.
        used.delete(nextSecret);
        await page.goto("about:blank");
        await page.addInitScript(() => {
          const state = { calls: 0, aborted: false };
          Object.assign(window, { r5Credential: state });
          navigator.credentials.create = async input => {
            state.calls++;
            return await new Promise<never>((_, reject) => input?.signal?.addEventListener("abort", () => {
              state.aborted = true; reject(new DOMException("aborted", "AbortError"));
            }, { once: true }));
          };
        });
        await page.goto(`${localOrigin}/setup#reg=${nextSecret}&mode=add`);
        await expect.poll(() => page.evaluate(() => (window as any).r5Credential.calls)).toBe(1);
        await skipContent();
        await expect(page.getByRole("status")).toHaveText("Waiting for Face ID. Keep this page open.");
        expect(await page.evaluate(() => (window as any).r5Credential.aborted), "R5: skip link must not cancel Face ID").toBe(false);
        await expect(page.getByRole("alert")).toHaveCount(0);
      }
    } finally { await context.close(); }
    expect(inserted).toBe(exerciseLimiter ? 1 : 2);
    expect(requests.some(request => new URL(request.url).pathname === "/setup")).toBe(true);
    for (const request of requests) {
      expect(request.url).not.toContain(code); expect(request.url).not.toContain(secret);
      expect(request.url).not.toContain(nextSecret); expect(request.referer).not.toContain(nextSecret);
      expect(request.url).not.toContain("#"); expect(request.referer).not.toContain(code); expect(request.referer).not.toContain(secret);
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
    }
    try { await app?.close(); }
    finally { await rm(tlsRoot, { recursive: true, force: true }); }
  }
}
