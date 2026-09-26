import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivateMacosHermesNativeLaunchHostCustodyV1, consumePrivateMacosHermesNativeLaunchHostFixtureFrameCapabilityV1,
  PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1, PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_REQUEST_V1 } from
  "../src/installer/v1/private-macos-hermes-native-launch-host-custody";
import { decodeMacosHermesNativeLaunchCustodianResponseV1 } from "../src/installer/v1/macos-hermes-native-launch-custodian-contract";

const run = promisify(execFile), nativeTest = process.platform === "darwin" ? test : test.skip;
const d = (value: string) => `sha256:${value.repeat(64)}`;
let root = "", helper = "", blockedOutputDriver = "";

before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-hermes-custodian-"); await chmod(root, 0o700); helper = join(root, "hermes-native-launch-custodian-v1");
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion",
    "native/hermes-native-launch-custodian-v1.c", "-o", helper], { cwd: process.cwd(), timeout: 30_000 });
  const driverSource = join(root, "blocked-output-driver.c"); blockedOutputDriver = join(root, "blocked-output-driver");
  await writeFile(driverSource, `#include <errno.h>\n#include <fcntl.h>\n#include <string.h>\n#include <sys/wait.h>\n#include <unistd.h>\nint main(int argc, char **argv) {\n  int input[2], output[2], flags, status; pid_t child; char bytes[4096]; ssize_t read_bytes, written;\n  if (argc != 2 || pipe(input) || pipe(output)) return 125;\n  flags = fcntl(output[1], F_GETFL); if (flags < 0 || fcntl(output[1], F_SETFL, flags | O_NONBLOCK)) return 124;\n  memset(bytes, 0, sizeof(bytes)); while (write(output[1], bytes, sizeof(bytes)) > 0) {}\n  if (errno != EAGAIN && errno != EWOULDBLOCK) return 124;\n  child = fork(); if (child < 0) return 123;\n  if (child == 0) { dup2(input[0], 0); dup2(output[1], 1); close(input[0]); close(input[1]); close(output[0]); close(output[1]); execl(argv[1], argv[1], (char *)0); _exit(126); }\n  close(input[0]); close(output[1]);\n  while ((read_bytes = read(0, bytes, sizeof(bytes))) > 0) { size_t offset = 0; while (offset < (size_t)read_bytes) { written = write(input[1], bytes + offset, (size_t)read_bytes - offset); if (written <= 0) return 122; offset += (size_t)written; } }\n  close(input[1]); waitpid(child, &status, 0); close(output[0]); return WIFEXITED(status) ? WEXITSTATUS(status) : 121;\n}\n`);
  await run("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", driverSource, "-o", blockedOutputDriver], { timeout: 30_000 });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function frame() {
  const verifiedImmutableInput = { schema: "control-room.macos-hermes-native-host-input-contract/v1", platform: "darwin", architecture: "arm64",
    releaseVersion: "0.1.0", releaseSha256: d("a"), sidecarContractDigest: d("b"), runtimeImageSha256: d("c"), runtimeManifestDigest: d("d"),
    importPolicyDigest: d("e"), nativeHostArtifactSha256: d("f"), nativeHostSourceSha256: d("1"), protocol: "ACRHCP1",
    status: "input_consistency_only", readyForLaunch: false, filesystemCustodyVerified: false, grantsLaunchAuthority: false,
    grantsPackagingAuthority: false, blockerCodes: ["native_runtime_image_not_verified", "native_launch_host_not_verified", "release_sidecar_not_bound",
      "protected_installed_manifest_not_materialized", "owner_attended_requalification_required", "runtime_import_policy_incompatible"] };
  const bindingDigest = sha256Digest(verifiedImmutableInput); const custody = createPrivateMacosHermesNativeLaunchHostCustodyV1({
    schema: PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1, verifiedImmutableInput: { ...verifiedImmutableInput, bindingDigest } });
  return consumePrivateMacosHermesNativeLaunchHostFixtureFrameCapabilityV1(custody.fixtureFrameCapability,
    { schema: PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_REQUEST_V1 }).bytes;
}
function start(input?: Buffer, keepOpen = false) {
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] }), output: Buffer[] = [];
  child.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
  if (input) child.stdin.write(input); if (!keepOpen) child.stdin.end();
  return { child, output, result: new Promise<{ code: number | null; output: Buffer }>(resolve => child.once("exit", code => resolve({ code, output: Buffer.concat(output) }))) };
}
function invoke(input?: Buffer, keepOpen = false) { return start(input, keepOpen).result; }

nativeTest("accepts exactly the existing inert custody frame and reports no launch plus cleanup refusal", async () => {
  const result = await invoke(frame()); assert.equal(result.code, 0);
  assert.deepEqual(decodeMacosHermesNativeLaunchCustodianResponseV1(result.output), { frameValidated: true, launchesHermes: false,
    cleanup: "refused_no_owned_process_group", grantsLaunchAuthority: false });
});
nativeTest("refuses malformed frames, trailing input, unclosed streams, deadline expiry, and helper-loss EOF without a success response", async () => {
  const malformed = Buffer.from(frame()); malformed[20] = 1;
  assert.deepEqual(await invoke(malformed), { code: 67, output: Buffer.alloc(0) });
  assert.deepEqual(await invoke(Buffer.concat([frame(), Buffer.from([0])])), { code: 68, output: Buffer.alloc(0) });
  assert.deepEqual(await invoke(Buffer.concat([frame(), frame()])), { code: 68, output: Buffer.alloc(0) });
  const unclosed = start(frame(), true); await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.deepEqual(await unclosed.result, { code: 68, output: Buffer.alloc(0) });
  const timed = invoke(Buffer.from(frame()).subarray(0, 8), true); await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.deepEqual(await timed, { code: 68, output: Buffer.alloc(0) });
  assert.deepEqual(await invoke(), { code: 68, output: Buffer.alloc(0) });
});
nativeTest("waits for input close, honours cancellation, and bounds closed or full output", async () => {
  const waiting = start(frame(), true); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(Buffer.concat(waiting.output).byteLength, 0); waiting.child.stdin.end();
  assert.equal((await waiting.result).code, 0);
  const cancelled = start(frame(), true); await new Promise(resolve => setTimeout(resolve, 50)); cancelled.child.kill("SIGTERM");
  assert.deepEqual(await cancelled.result, { code: 69, output: Buffer.alloc(0) });
  const closed = start(undefined, true); closed.child.stdout.destroy(); closed.child.stdin.end(frame());
  assert.deepEqual(await closed.result, { code: 70, output: Buffer.alloc(0) });
  const blocked = spawn(blockedOutputDriver, [helper], { stdio: ["pipe", "ignore", "ignore"] }); blocked.stdin.end(frame());
  const code = await new Promise<number | null>(resolve => blocked.once("exit", resolve)); assert.equal(code, 70);
});
test("refuses malformed native custodian responses", () => {
  const valid = Buffer.from([65, 67, 82, 83, 1, 4, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const wrongMagic = Buffer.from(valid), wrongReserved = Buffer.from(valid); wrongMagic[0] = 0; wrongReserved[7] = 1;
  for (const malformed of [valid.subarray(0, 15), wrongMagic, wrongReserved]) {
    assert.throws(() => decodeMacosHermesNativeLaunchCustodianResponseV1(malformed), /contract_refused/);
  }
});
