import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import filesystem from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildAttendedReleaseV1 } from "../src/updater/v1/build-attended-release.mjs";
import { stageVerifiedTreeV1, verifyAttendedBuildOutputV1 } from "../src/updater/v1/attended-source.mjs";
import { readGatewayLocalCapabilityV1 } from "../src/updater/v1/install/gateway-local-capability.mjs";

const COMMIT = "a".repeat(40), ID = "1.2.3-aaaaaaaaaaaa";
// Independent inventory from the reviewed release policy; setup supplies source
// inputs, never builder output, a manifest, or a staged declaration.
const INPUTS = ["LICENSE", "NOTICE", "THIRD_PARTY.md", "package.json", "pnpm-lock.yaml",
  "deploy/operator-config.mjs", "deploy/agent-task-operator-config.mjs",
  "scripts/prepare-local-installation.mjs", "scripts/prepare-local-production-dependencies.mjs",
  "scripts/launch-local-setup.mjs", "scripts/initialize-local-installation-plan.mjs",
  "scripts/run-local-setup-host.mjs", "scripts/preflight-private-local-owner-host.mjs",
  "scripts/run-private-local-installation-operator.mjs", "scripts/run-private-vps.mjs",
  "scripts/activate-private-vps.mjs", "scripts/bootstrap-private-vps-owner.mjs",
  "scripts/check-private-vps-database.mjs", "deploy/FIRST_ACTIVATION.md",
  "scripts/mac-local/task-host-supervisor.mjs", "scripts/mac-local/stack.mjs",
  "scripts/mac-local/start-task-host.mjs", "scripts/mac-local/start-web-host.mjs",
  "src/installer/shared/is-main-module.mjs", "src/installer/shared/file-custody.mjs",
  "src/installer/shared/private-process-lock.mjs", "src/installer/shared/mac-local-runtime-directory.mjs",
  "src/installer/shared/vapid.mjs", "src/installer/shared/backup-files.mjs",
  "src/installer/shared/nightly-backup-constants.mjs"];
const DIRS = ["db/migrations", "db/roles", "db/setup", "deploy/postgres", "dist-vps/client", "dist-vps/server", "third_party"];


async function scratch(t) {
  await filesystem.mkdir(resolve(".test-tmp"), { recursive: true, mode: 0o700 });
  const root = await filesystem.mkdtemp(resolve(".test-tmp/gateway-boundary-"));
  t.after(async () => {
    async function thaw(path) {
      const entry = await filesystem.lstat(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await filesystem.chmod(path, 0o700);
        for (const name of await filesystem.readdir(path)) await thaw(join(path, name));
      }
    }
    await thaw(root); await filesystem.rm(root, { recursive: true, force: true });
    assert.equal(await filesystem.lstat(root).then(() => true, () => false), false, "boundary scratch cleanup reached");
  });
  return root;
}

test("R1 real builder output passes root verification and staging", async t => {
  const root = await scratch(t), source = join(root, "source"), output = join(root, "output");
  const install = join(root, "install"), target = join(install, "releases", ID), staging = join(install, "releases", `.staging-${ID}`);
  await filesystem.mkdir(source); await filesystem.mkdir(output);
  await filesystem.mkdir(join(install, "releases"), { recursive: true });
  for (const path of INPUTS) {
    await filesystem.mkdir(join(source, path, ".."), { recursive: true });
    await filesystem.writeFile(join(source, path), path === "package.json" ? '{"name":"control-room","version":"1.2.3"}\n' : `${path}\n`);
  }
  for (const path of DIRS) await filesystem.mkdir(join(source, path), { recursive: true });
  assert.equal(await filesystem.lstat(join(output, "gateway-local-capability.json")).then(() => true, () => false), false);
  assert.equal(await filesystem.lstat(join(output, "RELEASE_MANIFEST.json")).then(() => true, () => false), false);
  assert.equal(await filesystem.lstat(target).then(() => true, () => false), false, "only the real staging producer creates the release");
  await buildAttendedReleaseV1({ source, output, commit: COMMIT });
  let verified;
  await assert.doesNotReject(async () => { verified = await verifyAttendedBuildOutputV1(output, { commit: COMMIT }); },
    "real root verifier must accept the reviewed gateway-local-capability.json output");
  assert.equal(verified.manifest.files.filter(value => value.path === "gateway-local-capability.json").length, 1);
  // Replay real verified bytes/modes into the exported production staging seam.
  // No build port or service/OS port is faked. Production's private session also
  // snapshots this tree after root verification, before stageVerifiedTreeV1.
  const snapshot = new Map();
  async function capture(directory, prefix = "") {
    for (const name of await filesystem.readdir(directory)) {
      const path = join(directory, name), local = prefix + name, entry = await filesystem.lstat(path);
      if (entry.isDirectory()) {
        snapshot.set(local, { type: "directory", mode: entry.mode & 0o777 });
        await capture(path, `${local}/`);
      } else {
        const bytes = await filesystem.readFile(path);
        snapshot.set(local, { type: "file", mode: entry.mode & 0o777, bytes: bytes.length,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
      }
    }
  }
  await capture(output);
  const session = { identity: { rootUid: process.geteuid(), rootGid: process.getegid() }, input: {} };
  const modes = (_path, mode) => mode === 0o500 ? 0o550 : 0o440;
  const staged = await stageVerifiedTreeV1(session, output, snapshot, target, staging, process.getegid(), modes);
  assert.equal(staged.target, target);
  assert.deepEqual(JSON.parse(await filesystem.readFile(join(target, "gateway-local-capability.json"))), {
    schema: "control-room.gateway-local-capability/v1", commit: COMMIT, version: "1.2.3", releaseId: ID,
    gatewayLocalHost: "127.0.0.1", updaterSupportsGatewayHosts: ["127.0.0.1", "::1"],
  }, "the real staged reader sees the independently specified declaration");
  assert.equal(await readGatewayLocalCapabilityV1({ root: install, expectedRelease: `releases/${ID}` }), "127.0.0.1");
  assert.equal((await filesystem.lstat(join(target, "gateway-local-capability.json"))).mode & 0o777, 0o440);
  // Existing stage replay must return the same complete verified release.
  assert.equal((await stageVerifiedTreeV1(session, output, snapshot, target, staging, process.getegid(), modes)).target, target);
  assert.equal(await filesystem.lstat(staging).then(() => true, () => false), false, "no partial staging remains");
});
