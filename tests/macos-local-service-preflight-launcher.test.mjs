import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("macOS local service preflight emits only a redacted no-start result", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-service-launcher-")));
  const release = join(root, "release"), protectedRoot = join(root, "protected"), work = join(release, "work"), logs = join(protectedRoot, "logs");
  const launcher = join(release, "launch.mjs"), configuration = join(protectedRoot, "config.mjs"), input = join(root, "service.json");
  await Promise.all([mkdirp(work), mkdirp(logs)]);
  await Promise.all([chmod(release, 0o700), chmod(protectedRoot, 0o700), chmod(work, 0o700), chmod(logs, 0o700),
    writeFile(launcher, "export {};\n", { mode: 0o700 }), writeFile(configuration, "export {};\n", { mode: 0o600 })]);
  await writeFile(input, JSON.stringify({ label: "xyz.agentcontrolroom.local", nodePath: await realpath(process.execPath), launcherPath: launcher,
    configurationPath: configuration, workingDirectory: work, standardOutPath: join(logs, "out.log"),
    standardErrorPath: join(logs, "err.log"), releaseRoot: release, protectedRoot, ownerUid: process.getuid?.() ?? -1 }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/preflight-macos-local-service.ts",
    "--owner-attended", "--service-definition", input], { cwd: process.cwd() });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { schema: "control-room.macos-local-service-preflight/v1", ready: true, startsWork: false });
  assert.doesNotMatch(stdout, /acr-service-launcher|release|protected|config\.mjs|launch\.mjs/);
});

test("macOS local service preflight fails without echoing a private configuration path", async () => {
  const privatePath = "/private/owner/local-service.json";
  const result = await run(process.execPath, ["--import", "tsx", "scripts/preflight-macos-local-service.ts",
    "--owner-attended", "--service-definition", privatePath], { cwd: process.cwd() })
    .catch(error => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  assert.match(result.stdout, /macos_local_service_preflight_refused/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private\/owner/);
});

async function mkdirp(path) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}
