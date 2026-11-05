import assert from "node:assert/strict";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
import { firstWebsiteConfigSchemaV1, loadFirstWebsiteAssemblyV1, type FirstWebsiteHostV1 } from "./helpers/improve-control-room-first-website";
import { withFirstWebsiteOwnerCodeV1 } from "../scripts/workflow-journeys/first-website-host";
import { B5DeviceRefusalV1, resolveB5DeviceSmokePacketV1, readB5DeviceFileV1, parseB5DeviceJsonV1, loadB5TransportV1,
  b5DeviceHashV1, b5MappingDigestV1, createB5DeviceCleanupV1, waitB5DeviceJsonV1, writeB5DeviceRequestV1,
  B5_DEVICE_INSTALL_COMMAND_V1, B5_DEVICE_OFF_COMMAND_V1, B5_DEVICE_STATUS_COMMAND_V1,
  type B5DeviceReceiptV1, type B5DeviceMailboxV1 } from "../scripts/workflow-journeys/first-website-device";

const gate = process.env.CONTROL_ROOM_B5_DEVICE_REQUIRE_A2 === "1";
const packetFile = process.env.CONTROL_ROOM_B5_DEVICE_PACKET;
const scenarios = ["smoke", "deadline", "stop", "cold-read", "verifier", "interrupt"] as const;
type Scenario = typeof scenarios[number];
function code(value: unknown, reason: string): asserts value { if (!value) throw new B5DeviceRefusalV1(reason); }

// Every gated body resolves this FIRST. No browser import/launch, subprocess,
// connection, listener, mailbox creation or owner notification precedes it.
async function resolveQualification(scenario: Scenario, file?: string) {
  const packet = await resolveB5DeviceSmokePacketV1(file);
  const trial = packet.trials[scenario];
  const bytes = await readB5DeviceFileV1(trial.configFile, dirname(trial.configFile));
  code(b5DeviceHashV1(bytes) === trial.configDigest, "B5_DEVICE_QUALIFICATION_CHANGED");
  const config = firstWebsiteConfigSchemaV1.parse(parseB5DeviceJsonV1(bytes.toString("utf8")));
  code(trial.configFile === join(config.scratchRoot, "config/b5.json"), "B5_DEVICE_PATH");
  const q = await loadB5TransportV1(config.device.transportQualification, config.scratchRoot, config.device.origin, trial.transportDigest);
  const socket = trial.ownerCodeSocket, part = relative(config.scratchRoot, socket);
  code(part && part !== ".." && !part.startsWith(`..${sep}`) && resolve(socket) === socket, "B5_DEVICE_OWNER_CHANNEL_REQUIRED");
  for (let p = socket;; p = dirname(p)) {
    const st = await lstat(p); code(!st.isSymbolicLink(), "B5_DEVICE_PATH"); if (p === dirname(p)) break;
  }
  const st = await lstat(socket);
  code(st.isSocket() && st.uid === process.getuid?.() && (st.mode & 0o777) === 0o600 && await realpath(socket) === socket, "B5_DEVICE_OWNER_CHANNEL_REQUIRED");
  // The factory repeats assembly/transport preflight with the actual registered
  // cleanup owner before PG acquisition. Browser acquisition follows the host.
  // A packet alone cannot clear the signal-ownership fence.
  return { config, q, trial };
}

test("B5 device-postgres missing qualification refuses before acquisition", async () => {
  const resources: string[] = [];
  const hook = createHook({ init(_id, type) { if (["PROCESSWRAP", "TCPSERVERWRAP", "TCPWRAP", "PIPECONNECTWRAP"].includes(type)) resources.push(type); } });
  hook.enable();
  try { await assert.rejects(resolveQualification("smoke"), { code: "B5_DEVICE_QUALIFICATION_REQUIRED" }, "B5 device qualification guard refuses missing packet"); }
  finally { hook.disable(); }
  assert.deepEqual(resources, []);
  console.log("RESULT: PASS B5_DEVICE_QUALIFICATION_REQUIRED before acquisition");
});

test("B5 device-postgres native gates cannot skip to green with absent qualification", { timeout: 120_000 }, async () => {
  const exec = promisify(execFile);
  for (const scenario of scenarios) {
    const name = scenario === "smoke" ? "B5 actual phone and desktop Tailscale smoke" : `B5 actual device forced-abort ${scenario}`;
    const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_B5_DEVICE_REQUIRE_A2: "1" }; delete env.NODE_TEST_CONTEXT; delete env.CONTROL_ROOM_B5_DEVICE_PACKET;
    const result = await exec(process.execPath, ["scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test",
      `--test-name-pattern=^${name}$`, "tests/improve-control-room-first-website-device-postgres.test.ts"], { env, timeout: 20_000, maxBuffer: 1 << 20 })
      .then(() => assert.fail("missing native qualification must refuse"), (error: { code: number; stdout: string }) => error);
    assert.equal(result.code, 1); assert.match(result.stdout, /B5_DEVICE_QUALIFICATION_REQUIRED/u);
    assert.match(result.stdout, /# fail 1/u); assert.match(result.stdout, /# skipped 0/u);
    assert.doesNotMatch(result.stdout, /RESULT: PASS B5 actual/u);
  }
  console.log("RESULT: PASS F03b all six gated bodies refuse missing qualification (no acquisitions)");
});

test("B5 device qualification guard-off mutation fails its intended assertion", { timeout: 120_000 }, async () => {
  const root = resolve("."), exec = promisify(execFile); await mkdir(join(root, ".test-tmp"), { recursive: true });
  const copy = await mkdtemp(join(root, ".test-tmp/b5-device-mutation-"));
  const file = "scripts/workflow-journeys/first-website-device.ts", lane = "tests/improve-control-room-first-website-device-postgres.test.ts";
  try {
    await exec("git", ["-c", "core.hooksPath=/dev/null", "clone", "--local", "--no-hardlinks", "--quiet", root, copy], { timeout: 60_000 });
    const { symlink } = await import("node:fs/promises"); await symlink(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    for (const path of [file, lane, "src/web/v1/improve-control-room-loop-finalization.ts", "src/web/v1/improve-control-room-loop-recovery.ts", "src/web/v1/improve-control-room-loop-service.ts", "scripts/workflow-journeys/first-website-host.ts", "tests/helpers/improve-control-room-first-website.ts",
      "tests/support/attack-kit/real-postgres.ts", "tests/improve-control-room-first-website-device.test.ts"])
      await writeFile(join(copy, path), await readFile(join(root, path)));
    const cmd = [process.execPath, "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test",
      "--test-name-pattern=^B5 device-postgres missing qualification refuses before acquisition$", lane];
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const green = () => exec(cmd[0]!, cmd.slice(1), { cwd: copy, env, timeout: 30_000, maxBuffer: 1 << 20 });
    assert.match((await green()).stdout, /# pass 1/u);
    const original = await readFile(join(copy, file), "utf8");
    const result = await assertGuardBites({ root: copy, file, allowDirtyTree: true,
      find: '  need(file, "B5_DEVICE_QUALIFICATION_REQUIRED");', replace: "", testCmd: cmd, boundMs: 30_000,
      because: "B5 device qualification guard refuses missing packet" });
    assert.equal(result.applied, true); assert.equal(result.exitCode, 1); assert.equal(result.signal, null);
    assert.match(result.output, /B5 device qualification guard refuses missing packet/u); assert.match(result.output, /ERR_ASSERTION/u);
    assert.doesNotMatch(result.output, /SyntaxError|# tests 0|# skipped [1-9]|timed out/iu);
    assert.equal(await readFile(join(copy, file), "utf8"), original); assert.match((await green()).stdout, /# pass 1/u);
    console.log("RESULT: PASS F03b qualification mutation baseline=green guard-off=intended-assertion restored=green");
    const helperFile = "tests/support/attack-kit/real-postgres.ts";
    const helperOriginal = await readFile(join(copy, helperFile), "utf8");
    const seamCmd = [process.execPath, "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test",
      "--test-name-pattern=^F03b helper refuses caller ownership without cleanup before acquisition$", "tests/improve-control-room-first-website-device.test.ts"];
    const seam = await assertGuardBites({ root: copy, file: helperFile, allowDirtyTree: true,
      find: 'if (options.signalOwner === "caller" && typeof options.cleanup !== "function")', replace: "if (false)",
      testCmd: seamCmd, boundMs: 30_000, because: "caller cleanup guard refuses before acquisition" });
    assert.equal(seam.applied, true); assert.equal(seam.exitCode, 1); assert.equal(seam.signal, null);
    assert.match(seam.output, /caller cleanup guard refuses before acquisition/u);
    assert.match(seam.output, /ERR_ASSERTION/u);
    assert.doesNotMatch(seam.output, /SyntaxError|# tests 0|# skipped [1-9]|timed out|initdb/u);
    assert.equal(await readFile(join(copy, helperFile), "utf8"), helperOriginal);
    console.log("RESULT: PASS caller cleanup guard mutation baseline=green guard-off=intended-assertion restored=green; no PG acquisition");
  } finally { await rm(copy, { recursive: true, force: true }); }
});

// Owner-only socket is prepared by the lead in private scratch. The receiver
// must deliver directly to the owner; code is never printed or stored by tests.
async function deliverOwnerCode(socketPath: string, ownerCode: string) {
  await new Promise<void>((yes, no) => {
    const socket = createConnection(socketPath); socket.setTimeout(5000);
    socket.once("connect", () => socket.end(ownerCode + "\n"));
    socket.once("close", hadError => hadError ? no(new B5DeviceRefusalV1("B5_DEVICE_OWNER_CHANNEL")) : yes());
    socket.once("error", () => { socket.destroy(); no(new B5DeviceRefusalV1("B5_DEVICE_OWNER_CHANNEL")); });
    socket.once("timeout", () => { socket.destroy(); no(new B5DeviceRefusalV1("B5_DEVICE_OWNER_CHANNEL")); });
  });
}
async function ownerReceipt(mailbox: B5DeviceMailboxV1, sequence: number, signal: AbortSignal) {
  const value = await waitB5DeviceJsonV1(join(mailbox.root, "inbox", `${sequence}.json`), mailbox.root, signal, Date.now() + 180_000);
  return mailbox.accept(value);
}
async function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((yes, no) => { const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", abort); yes(); }
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); no(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

for (const scenario of scenarios) test(scenario === "smoke" ? "B5 actual phone and desktop Tailscale smoke" : `B5 actual device forced-abort ${scenario}`, {
  skip: !gate ? "NOT RUN: owner-approved device/transport packet required; set CONTROL_ROOM_B5_DEVICE_REQUIRE_A2=1" : false, timeout: 600_000,
}, async () => {
  const qualificationStartedAt = Date.now();
  const { config, q, trial } = await resolveQualification(scenario, packetFile);
  const bodyBudget = Math.min(410_000, 600_000 - (Date.now() - qualificationStartedAt) - 190_000);
  code(bodyBudget > (scenario === "smoke" ? 330_000 : 10_000), "B5_DEVICE_QUALIFICATION_WINDOW");
  // Trials have distinct fresh roots. The real PG helper must keep each run
  // and its short Unix socket below THAT trial's already-qualified tmp folder.
  const previousRunRoot = process.env.ATTACK_KIT_RUN_ROOT, previousSocketRoot = process.env.ATTACK_KIT_SOCKET_ROOT;
  process.env.ATTACK_KIT_RUN_ROOT = join(config.scratchRoot, "tmp");
  process.env.ATTACK_KIT_SOCKET_ROOT = join(config.scratchRoot, "tmp");
  const restorePgRoots = () => {
    if (previousRunRoot === undefined) delete process.env.ATTACK_KIT_RUN_ROOT; else process.env.ATTACK_KIT_RUN_ROOT = previousRunRoot;
    if (previousSocketRoot === undefined) delete process.env.ATTACK_KIT_SOCKET_ROOT; else process.env.ATTACK_KIT_SOCKET_ROOT = previousSocketRoot;
  };
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new B5DeviceRefusalV1("B5_DEVICE_DEADLINE")), bodyBudget);
  const interrupt = () => abort.abort(new B5DeviceRefusalV1("B5_DEVICE_INTERRUPT"));
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  let closeServing: (() => Promise<void>) | undefined, stopPostgres: (() => Promise<void>) | undefined;
  let host: FirstWebsiteHostV1 | undefined, acquiring: Promise<FirstWebsiteHostV1> | undefined;
  let browser: Awaited<ReturnType<(typeof import("@playwright/test"))["chromium"]["launch"]>> | undefined;
  let reachedMapping = false, completed = false, reason: unknown, cleanupResult: Awaited<ReturnType<ReturnType<typeof createB5DeviceCleanupV1>>> | undefined;
  const deviceRoot = join(config.scratchRoot, "device");
  // Registered before ANY acquisition or owner installation request, including
  // uncertain/in-flight installation. Late host acquisition is still owned.
  const removalCleanup = createB5DeviceCleanupV1(q, { async closeHost() {
    await mkdir(deviceRoot, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const failures: unknown[] = [];
    try { await writeB5DeviceRequestV1(join(deviceRoot, "install-cancelled.json"), { schemaVersion: 1, cancelledAt: new Date().toISOString(), cancelPendingInstall: true }); }
    catch (error) { failures.push(error); }
    try { await browser?.close(); } catch (error) { failures.push(error); }
    // This handle drains host acquisition/serving only. Full host close also
    // awaits this cleanup's receipt, so awaiting that here would deadlock.
    try { await closeServing?.(); } catch (error) { failures.push(error); }
    if (failures.length) throw new B5DeviceRefusalV1("B5_DEVICE_HOST_CLEANUP");
  }, async requestRemoval(request, signal) {
    await writeB5DeviceRequestV1(join(deviceRoot, "removal-request.json"), { schemaVersion: 1, ...request, port: 60462,
      beforeDigest: q.beforeDigest, installedDigest: q.installedDigest, reconcilePendingInstall: true,
      commands: [B5_DEVICE_OFF_COMMAND_V1, B5_DEVICE_STATUS_COMMAND_V1] });
    return waitB5DeviceJsonV1(join(deviceRoot, "removal-receipt.json"), deviceRoot, signal, Date.now() + 120_000);
  } });
  let cleanupWork: Promise<Awaited<ReturnType<typeof removalCleanup>>> | undefined;
  const cleanup = () => cleanupWork ??= (async () => {
    try { return await removalCleanup(); } finally { await stopPostgres?.(); }
  })();
  const interrupted = () => { void cleanup().catch(() => {}); };
  abort.signal.addEventListener("abort", interrupted, { once: true });
  try {
    const factory = await loadFirstWebsiteAssemblyV1(config);
    acquiring = factory(config, abort.signal, { signalOwner: {
      registerCloseHost(close) { closeServing = close; }, registerStopPostgres(stop) { stopPostgres = stop; }, cleanup,
    } }).then(value => { host = value; return value; });
    host = await acquiring; abort.signal.throwIfAborted();
    code(host.proof.device, "B5_DEVICE_MAILBOX_REQUIRED");
    const mailbox = host.proof.device;
    const installNonce = randomBytes(16).toString("hex"), requestedAt = new Date().toISOString();
    await writeB5DeviceRequestV1(join(deviceRoot, "install-request.json"), { schemaVersion: 1, installNonce, requestedAt,
      origin: q.origin, backend: q.backend, port: 60462, commands: [B5_DEVICE_INSTALL_COMMAND_V1, B5_DEVICE_STATUS_COMMAND_V1], beforeDigest: q.beforeDigest, installedDigest: q.installedDigest });
    const installed = await waitB5DeviceJsonV1(join(deviceRoot, "install-receipt.json"), deviceRoot, abort.signal, Date.now() + 120_000) as Record<string, unknown>;
    code(installed.schemaVersion === 1 && installed.actor === "owner" && installed.installNonce === installNonce
      && installed.command === B5_DEVICE_INSTALL_COMMAND_V1 && installed.statusCommand === B5_DEVICE_STATUS_COMMAND_V1 && installed.exitCode === 0 && installed.statusExitCode === 0
      && typeof installed.observedAt === "string" && Date.parse(installed.observedAt) >= Date.parse(requestedAt)
      && Date.parse(installed.observedAt) <= Date.now() && installed.statusDigest === q.installedDigest
      && b5MappingDigestV1(installed.status) === q.installedDigest, "B5_DEVICE_INSTALL_RECEIPT");
    reachedMapping = true;
    if (scenario !== "smoke") {
      if (scenario === "cold-read") {
        await host.proof.restart(abort.signal);
        await withFirstWebsiteOwnerCodeV1(host, async ownerCode => {
          const issued = await fetch(q.origin + "/api/v1/local-owner-session", { method: "POST", headers: { origin: q.origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }), signal: AbortSignal.timeout(10_000) });
          assert.equal(issued.status, 201); const cookie = issued.headers.get("set-cookie")!.split(";")[0]!; await issued.arrayBuffer();
          try {
            const catalog = await fetch(q.origin + "/api/v1/projects", { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
            assert.equal(catalog.status, 200); await catalog.arrayBuffer();
            const readCard = async () => {
              const response = await fetch(q.origin + `/api/v1/projects/${encodeURIComponent(host!.proof.project.projectId)}/improvements/loop/request:b5-absent/candidate`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
              await response.arrayBuffer(); assert.equal(response.status, 404, "cold authenticated card read must reach the absent production card");
              throw new B5DeviceRefusalV1("B5_DEVICE_COLD_READ");
            };
            await assert.rejects(readCard(), { code: "B5_DEVICE_COLD_READ" });
          } finally {
            const signedOut = await fetch(q.origin + "/api/v1/local-owner-session", { method: "DELETE", headers: { origin: q.origin, cookie }, signal: AbortSignal.timeout(10_000) });
            await signedOut.arrayBuffer(); assert.equal(signedOut.status, 204);
          }
        });
        abort.abort(new B5DeviceRefusalV1("B5_DEVICE_COLD_READ"));
      } else if (scenario === "verifier") {
        const error = await mailbox.accept({}).then(() => assert.fail("invalid device evidence must refuse"), error => error);
        assert.equal(error.code, "B5_DEVICE_SCHEMA"); abort.abort(error);
      } else if (scenario === "stop") {
        const stopNonce = randomBytes(16).toString("hex"), requestedAt = new Date().toISOString();
        await writeB5DeviceRequestV1(join(deviceRoot, "stop-request.json"), { schemaVersion: 1, stopNonce, requestedAt });
        const receipt = await waitB5DeviceJsonV1(join(deviceRoot, "stop-receipt.json"), deviceRoot, abort.signal, Date.now() + 120_000) as Record<string, unknown>;
        code(receipt.schemaVersion === 1 && receipt.actor === "owner" && receipt.stop === true && receipt.stopNonce === stopNonce
          && typeof receipt.observedAt === "string" && Date.parse(receipt.observedAt) >= Date.parse(requestedAt) && Date.parse(receipt.observedAt) <= Date.now(), "B5_DEVICE_STOP_RECEIPT");
        abort.abort(new B5DeviceRefusalV1("B5_DEVICE_OWNER_STOP"));
      } else if (scenario === "interrupt") process.emit("SIGINT");
      else {
        const expired = setTimeout(() => abort.abort(new B5DeviceRefusalV1("B5_DEVICE_DEADLINE")), 0);
        try { await pause(1000, abort.signal); } finally { clearTimeout(expired); }
      }
      abort.signal.throwIfAborted();
    }
    await withFirstWebsiteOwnerCodeV1(host, ownerCode => deliverOwnerCode(trial.ownerCodeSocket, ownerCode));
    const phone = await mailbox.request("connect", "phone", new Date(Date.now() + 180_000).toISOString());
    // Owner signs in, visits this existing project URL twice, captures natively,
    // transfers over the approved route; lead writes the bounded inbox receipt
    // using observations/<sequence>.json. No challenge is claimed to be visible.
    const phoneReceipt = await ownerReceipt(mailbox, phone.sequence, abort.signal);
    assert.equal(phoneReceipt.real, true); assert.equal(phoneReceipt.device, "phone");
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true });
    assert.equal(browser.browserType().name(), q.inventory.desktop.browser);
    assert.equal(browser.version(), q.inventory.desktop.browserVersion);
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(q.origin + "/session");
    await withFirstWebsiteOwnerCodeV1(host, async ownerCode => {
      try { await page.getByLabel("Owner code").fill(ownerCode); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(q.origin + "/projects"); }
      catch { throw new B5DeviceRefusalV1("B5_DEVICE_DESKTOP_SIGN_IN"); }
    });
    await page.getByText("Disposable B5 website", { exact: true }).waitFor();
    const desktop = await mailbox.request("connect", "desktop", new Date(Date.now() + 60_000).toISOString());
    await page.goto(q.origin + mailbox.projectPath); await page.reload();
    assert.equal(await page.locator('script[src*="/_next/static/"]').count() > 0, true);
    const png = await page.screenshot({ fullPage: true });
    const capture = "captures/desktop.png"; await writeFile(join(deviceRoot, capture), png, { flag: "wx", mode: 0o600 });
    const capturedAt = new Date().toISOString();
    const observation = mailbox.observation(); code(observation, "B5_DEVICE_CORRELATION");
    const desktopReceipt = await mailbox.accept({ ...desktop, real: true, browser: `${q.inventory.desktop.browser}/${q.inventory.desktop.browserVersion}`,
      observedAt: new Date().toISOString(), actions: ["connected"], captures: [{ path: capture, sha256: b5DeviceHashV1(png), device: "desktop", sessionNonce: desktop.sessionNonce, sequence: desktop.sequence, capturedAt }], observation } satisfies B5DeviceReceiptV1);
    assert.notEqual(desktopReceipt.observation.sessionDigest, phoneReceipt.observation.sessionDigest);
    const baseline = await host.proof.readSnapshot();
    const denied = await context.request.post(q.origin + `/api/v1/projects/${encodeURIComponent(host.proof.project.projectId)}/improvements/loop/intake`, {
      headers: { origin: "https://wrong.invalid", "idempotency-key": "b5-device-csrf-refusal-0001" }, data: { description: config.requestText } });
    assert.equal(denied.status(), 403); assert.deepEqual((await host.proof.readSnapshot()).rows, baseline.rows);
    const funnel = await context.request.get(q.origin + "/api/v1/projects", { headers: { "tailscale-funnel-request": "true" } });
    assert.equal(funnel.status(), 403);
    const anonymous = await browser.newContext();
    assert.equal((await anonymous.request.get(q.origin + "/api/v1/projects")).status(), 401); await anonymous.close();
    // Real expiry, no clock override, route interception or manufactured session.
    await pause(301_000, abort.signal);
    assert.equal((await context.request.get(q.origin + "/api/v1/projects")).status(), 401);
    await mailbox.readReceipt(phone.sequence); await mailbox.readReceipt(desktop.sequence);
    completed = true;
  } catch (error) { reason = error; }
  finally {
    cleanupResult = await cleanup();
    // Full host close includes the PG stop after the shared owner cleanup.
    try { await host?.close(); await acquiring?.catch(() => {}); }
    catch (error) { reason ??= error; cleanupResult.failures.push("B5_DEVICE_PG_CLEANUP"); }
    try {
      const owned = host ? await host.proof.inspectOwned().catch(() => null) : null;
      await writeB5DeviceRequestV1(join(deviceRoot, "cleanup-result.json"), { ...cleanupResult, owned, reachedMapping,
        exitReason: reason instanceof B5DeviceRefusalV1 ? reason.code : reason ? "B5_DEVICE_NATIVE_FAILURE" : "complete" });
    } finally {
      clearTimeout(deadline); abort.signal.removeEventListener("abort", interrupted);
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      restorePgRoots();
    }
  }
  assert.equal(cleanupResult.disposition, "mapping-removed"); assert.equal(cleanupResult.hostStopped, true); assert.deepEqual(cleanupResult.failures, []);
  code(host, "B5_DEVICE_HOST_REQUIRED");
  assert.deepEqual(await host.proof.inspectOwned(), { processCount: 0, listenerReleased: true, postgresStopped: true, runScratchAbsent: true });
  if (scenario === "smoke") { if (reason) throw reason instanceof B5DeviceRefusalV1 ? reason : new B5DeviceRefusalV1("B5_DEVICE_NATIVE_FAILURE"); assert.equal(completed, true); }
  else { assert.equal(reachedMapping, true); assert.equal(abort.signal.aborted, true); assert.equal(reason, abort.signal.reason); }
  console.log(`RESULT: PASS B5 actual ${scenario === "smoke" ? "phone and desktop Tailscale smoke" : `device forced-abort ${scenario}`} mapping-removed owned-delta=0`);
});

// Independent seam qualification: no device packet, mapping command or live
// install. The owner receipt below is an IPC barrier, not transport evidence.
test("B5 cooperative PG17 SIGTERM child stops PG after owner receipt", {
  skip: process.env.CONTROL_ROOM_B5_SIGNAL_REQUIRE_PG !== "1", timeout: 600_000,
}, async () => {
  const scratch = process.env.CONTROL_ROOM_B5_SIGNAL_ROOT;
  code(scratch && resolve(scratch) === scratch && await realpath(scratch) === scratch, "B5_SIGNAL_DISPOSABLE_ROOT_REQUIRED");
  code(scratch.startsWith("/private/tmp/b5-seam-"), "B5_SIGNAL_DISPOSABLE_ROOT_REQUIRED");
  const st = await lstat(scratch);
  code(st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o777) === 0o700, "B5_SIGNAL_DISPOSABLE_ROOT_REQUIRED");
  const exec = promisify(execFile), pgBin = process.env.PG_BIN;
  code(pgBin, "B5_SIGNAL_PG17_REQUIRED");
  const version = await exec(join(pgBin, "postgres"), ["--version"], { timeout: 30_000 });
  code(/PostgreSQL\) 17\./u.test(version.stdout), "B5_SIGNAL_PG17_REQUIRED");
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const helper = pathToFileURL(resolve("tests/support/attack-kit/real-postgres.ts")).href;
  for (const mode of ["receipt", "throw", "exit"] as const) {
    const failure = mode === "throw";
    const root = join(scratch, mode);
    await mkdir(root, { mode: 0o700 });
    const script = join(root, "signal-child.mjs");
    await writeFile(script, `
import { withRealPostgres } from ${JSON.stringify(helper)};
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.ATTACK_KIT_RUN_ROOT;
const events = [], server = createServer();
let releaseBody, releaseReceipt, pgRef, cleanupWork;
const body = new Promise(yes => { releaseBody = yes; });
const receipt = new Promise(yes => { releaseReceipt = yes; });
const keepAlive = setInterval(() => {}, 1000);
const cleanup = () => cleanupWork ??= (async () => {
  if (server.listening) await new Promise((yes, no) => server.close(e => e ? no(e) : yes()));
  events.push('host-close');
  process.send({ kind: 'removal-request', events });
  await receipt;
  events.push('owner-removal-receipt');
  try { if (${failure}) throw new Error('injected-cleanup-failure'); }
  finally { await pgRef?.stop(); events.push('pg-stop'); }

})();
const interrupt = () => { void cleanup().finally(() => releaseBody()).catch(() => {}); };
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
process.on('message', message => { if (message?.kind === 'receipt') releaseReceipt(); if (message?.kind === 'exit-now') process.exit(143); });
try {
  const result = await withRealPostgres(async pg => {
    pgRef = pg;
    await new Promise((yes, no) => { server.once('error', no); server.listen(join(root, 'host.sock'), yes); });
    const pid = Number((await readFile(join(pg.dataDirectory, 'postmaster.pid'), 'utf8')).split('\\n')[0]);
    process.send({ kind: 'ready', pid, run: pg.runDirectory, data: pg.dataDirectory, socket: pg.socketDirectory });
    await body; await cleanup();
  }, { port: 60470, allowedPorts: [60470,60471,60472,60473,60474,60475,60476,60477,60478,60479],
    pgBin: process.env.PG_BIN, signalOwner: 'caller', cleanup });
  if (!result.cleanedUp) throw new Error('cluster-not-cleaned');
} catch (error) {
  if (!${failure} || error.message !== 'injected-cleanup-failure') {
    process.send({ kind: 'failure', message: 'native-child-failure' }); process.exitCode = 1;
  }
} finally {
  if (pgRef && await pgRef.isRunning()) throw new Error('postmaster-survived');
  if (server.listening) await new Promise(yes => server.close(yes));
  clearInterval(keepAlive); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
}
events.push('exit-143');
process.send({ kind: 'complete', events }, () => { process.disconnect(); process.exitCode ??= 143; });
`, { mode: 0o600, flag: "wx" });
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      env: { ...process.env, ATTACK_KIT_RUN_ROOT: root, ATTACK_KIT_SOCKET_ROOT: root },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let childError = "", ready: { pid: number; run: string; data: string; socket: string } | undefined;
    child.stderr?.on("data", chunk => { childError += String(chunk); });
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((yes, no) => {
      child.once("error", no); child.once("exit", (exitCode, signal) => yes([exitCode, signal]));
    });
    const messages: Record<string, unknown>[] = [];
    child.on("message", message => { messages.push(message as Record<string, unknown>); });
    async function message(kind: string) {
      const end = Date.now() + 180_000;
      while (Date.now() < end) {
        const found = messages.find(m => m.kind === kind);
        if (found) return found;
        assert.equal(child.exitCode, null, `child exited before ${kind}; stderr-present=${!!childError}`);
        assert.equal(messages.some(m => m.kind === "failure"), false);
        await new Promise(yes => setTimeout(yes, 20));
      }
      throw new Error(`B5_SIGNAL_CHILD_TIMEOUT:${kind}`);
    }
    try {
      ready = await message("ready") as unknown as typeof ready;
      assert.ok(ready && Number.isInteger(ready.pid) && ready.pid > 1);
      if (mode === "exit") {
        child.send({ kind: "exit-now" });
        assert.deepEqual(await exited, [143, null]);
        assert.equal(messages.some(m => m.kind === "removal-request"), false, "exit fallback must never invoke caller cleanup");
        assert.throws(() => process.kill(ready!.pid, 0), { code: "ESRCH" });
      } else {
        child.kill("SIGTERM");
        const waiting = await message("removal-request");
        assert.deepEqual(waiting.events, ["host-close"]);
        process.kill(ready.pid, 0); // PG must still be alive at the receipt barrier.
        assert.equal(messages.some(m => m.kind === "complete"), false);
        child.send({ kind: "receipt" });
        const complete = await message("complete");
        assert.deepEqual(complete.events, ["host-close", "owner-removal-receipt", "pg-stop", "exit-143"]);
        assert.deepEqual(await exited, [143, null]);
        assert.throws(() => process.kill(ready!.pid, 0), { code: "ESRCH" });
        for (const path of [ready.run, ready.data, ready.socket]) assert.equal(await lstat(path).then(() => true, () => false), false);
      }
    } finally {
      // Keep the child's cooperative receipt path available even if an assertion
      // fails. Reap its own PG before any last-resort child termination.
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send({ kind: "receipt" });
        child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([exited, new Promise(yes => { timer = setTimeout(yes, 120_000); })]).finally(() => clearTimeout(timer));
        if (child.exitCode === null && child.signalCode === null) {
          // The helper may still be provisioning and not have sent ready.
          // Its exclusively owned root is the recovery boundary in that case.
          for (const name of await readdir(root)) {
            if (!/^attack-kit-pg-[A-Za-z0-9]+$/u.test(name)) continue;
            const data = join(root, name, "data");
            const status = await exec(join(pgBin, "pg_ctl"), ["-D", data, "status"], { timeout: 30_000 })
              .then(() => true, () => false);
            if (status) await exec(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "60", "stop"], { timeout: 90_000 });
          }
          child.kill("SIGKILL"); await exited;
        }
      }
      if (ready) {
        const running = await exec(join(pgBin, "pg_ctl"), ["-D", ready.data, "status"], { timeout: 10_000 }).then(() => true, () => false);
        if (running) await exec(join(pgBin, "pg_ctl"), ["-D", ready.data, "-m", "fast", "-w", "-t", "20", "stop"], { timeout: 30_000 });
        assert.throws(() => process.kill(ready!.pid, 0), { code: "ESRCH" }, "native seam reaper left no postmaster");
      }
      if (mode === "exit") await rm(root, { recursive: true, force: true });
    }
  }
  console.log("RESULT: PASS native PG17 SIGTERM receipt/throw paths host-close -> owner-removal-receipt -> pg-stop -> exit-143; caller process.exit PG-only fallback; orphaned-postgres=0");
});
