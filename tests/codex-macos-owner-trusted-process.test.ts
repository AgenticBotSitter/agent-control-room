import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexMacosOwnerTrustedProcessAcquisitionV1 } from "../src/harness/codex-v1/macos-owner-trusted-process";
import { createCodexAppServerProcessSessionV1 } from "../src/harness/codex-v1/app-server-process-session";
import { CODEX_APP_SERVER_START_CONTRACT } from "../src/harness/codex-v1/schema-contract";
import { codexTaskRunIdV1 } from "../src/harness/codex-v1/delivery-contract";
import { openOwnedPrivateCodexConfigurationV1 } from "../src/node-bridge/private-codex-configuration";
import { sha256Digest } from "../src/security/canonical-digest";

const onMac = process.platform === "darwin";
const now = Date.parse("2026-09-24T12:00:00.000Z");

function binding() {
  return { mode: "initial" as const, connectionAttemptId: "connection:test",
    initializedConnectionDigest: sha256Digest("initialized"), threadStartRequestId: 1, turnStartRequestId: 2 };
}

test("Mac owner-trusted Codex provider fixes one binding, arguments and small environment", { skip: !onMac }, async () => {
  const provisionalRoot = await mkdtemp(join(tmpdir(), "acr-codex-macos-"));
  const { realpath: resolveRealpath } = await import("node:fs/promises");
  const root = await resolveRealpath(provisionalRoot);
  const executable = join(root, "codex-fixture"), home = join(root, "home"), work = join(root, "work");
  try {
    await writeFile(executable, "#!/bin/sh\nprintf '{\\\"ready\\\":true}\\n'\ncat\n", { mode: 0o700 });
    await writeFile(home, "", { flag: "w" }).catch(() => {});
    await rm(home, { force: true }); await rm(work, { force: true });
    const { mkdir } = await import("node:fs/promises"); await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
    await chmod(executable, 0o700); await chmod(home, 0o700); await chmod(work, 0o700);
    const bytes = await (await import("node:fs/promises")).readFile(executable);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const config = { executablePath: executable, executableSha256: hash, appServerVersion: CODEX_APP_SERVER_START_CONTRACT.version,
      workingDirectory: work, codexHome: home, ownerUid: process.getuid!(),
      validFrom: new Date(now - 1_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
      startupTimeoutMs: 1_000, cleanupTimeoutMs: 100 } as const;
    assert.throws(() => createCodexMacosOwnerTrustedProcessAcquisitionV1({ configuration: { ...config, codexHome: work },
      expectedBinding: binding(), assertCurrent() {}, clock: () => now }), /unavailable/);
    const seen: unknown[] = [];
    const acquisition = createCodexMacosOwnerTrustedProcessAcquisitionV1({ configuration: config,
      expectedBinding: binding(), assertCurrent(permit) { seen.push(permit); }, clock: () => now });
    assert.throws(() => acquisition.acquire({ ...binding(), threadStartRequestId: 3 }, new AbortController().signal), /unavailable/);
    const session = createCodexAppServerProcessSessionV1({ binding: binding(), signal: new AbortController().signal,
      acquire: acquisition.acquire, cleanupMs: 100 });
    const wire = await session.ready;
    if (!("close" in wire)) assert.fail("initial Codex binding must yield a writable start connection");
    assert.equal(await wire.readLine(new AbortController().signal), '{"ready":true}');
    await wire.close(new AbortController().signal);
    await acquisition.close();
    const duplicate = createCodexMacosOwnerTrustedProcessAcquisitionV1({ configuration: config,
      expectedBinding: binding(), assertCurrent() {}, clock: () => now });
    assert.throws(() => duplicate.acquire(binding(), new AbortController().signal), /unavailable/);
    await duplicate.close();
    assert.equal(seen.length, 2);
    assert.equal((seen[0] as { schema: string }).schema, "control-room.codex-macos-owner-trusted-process/v1");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Mac owner-trusted Codex provider remains unavailable away from macOS", { skip: onMac }, () => {
  assert.equal(process.platform === "darwin", false);
});

test("Mac owner-trusted provider enters the existing private Codex host without a Linux launcher", { skip: !onMac }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-codex-macos-private-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex-fixture"), home = join(root, "home"), work = join(root, "work");
  const bridge = join(root, "bridge.sqlite"), starts = join(root, "starts.sqlite");
  await writeFile(executable, "#!/bin/sh\nprintf '{\\\"ready\\\":true}\\n'\ncat\n", { mode: 0o700 });
  const { mkdir, readFile } = await import("node:fs/promises");
  await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
  await writeFile(bridge, "", { mode: 0o600 }); await writeFile(starts, "", { mode: 0o600 });
  const hash = `sha256:${createHash("sha256").update(await readFile(executable)).digest("hex")}`;
  const acquisition = createCodexMacosOwnerTrustedProcessAcquisitionV1({
    configuration: { executablePath: executable, executableSha256: hash, appServerVersion: CODEX_APP_SERVER_START_CONTRACT.version,
      workingDirectory: work, codexHome: home, ownerUid: process.getuid!(),
      validFrom: new Date(now - 1_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
      startupTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    expectedBinding: binding(), assertCurrent() {}, clock: () => now,
  });
  const basis = { tenantId: "tenant:macos", nodeId: "node:macos", projectId: "project:macos",
    jobId: "job:macos", attemptId: "attempt:macos", leaseId: "lease:macos", leaseEpoch: 1 };
  const runId = codexTaskRunIdV1(basis);
  const owner = await openOwnedPrivateCodexConfigurationV1({ mode: "initial", paths: { bridge, starts },
    runId, queueId: "queue:macos-private", connectionAttemptId: binding().connectionAttemptId,
    initializedConnectionDigest: binding().initializedConnectionDigest, threadStartRequestId: 1, turnStartRequestId: 2,
    startTimeoutMs: 1_000, processCleanupTimeoutMs: 100,
    workspacePolicy: { allowedPaths: ["src/**"], maximumChangedFiles: 1, maximumChangedBytes: 1_024 },
    workspaceIntent: { schema: "control-room.workspace-intent/v1", ...basis, runId,
      repositoryRoot: "/synthetic/repository", workspaceRoot: "/synthetic/workspaces",
      checkoutPath: `/synthetic/workspaces/codex-${sha256Digest(runId).slice(7, 31)}`,
      revision: "a".repeat(40) } }, {
    authority: { currentAdmissionDigest: () => sha256Digest("admission"), assertCurrent() {} },
    workspacePort: { inspectRootIdentities: async () => { throw new Error("synthetic_unavailable"); },
      inspectExisting: async () => { throw new Error("synthetic_unavailable"); },
      observeCheckout: async () => { throw new Error("synthetic_unavailable"); },
      createDetachedWorktree: async () => { throw new Error("synthetic_unavailable"); },
      async removeWorktree() {} }, clock: () => now,
  }, acquisition, new AbortController().signal);
  assert.equal(owner.harness, "codex-local-v1"); assert.equal(owner.mode, "initial");
  await owner.close();
});
