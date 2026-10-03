import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";
import { assertNoSymlinkBelowV1, atomicSymlinkNoFollowV1, atomicWriteNoFollowV1,
  readFileNoFollowV1 } from "./fs-safety.mjs";
import { canonicalJsonV1 } from "./cli.mjs";
import { acquireKernelFileLockV1 } from "../../installer/shared/private-process-lock.mjs";
import { ATTENDED_LINKS_V1, noteSelfUpgradeHealthV1, withSelfUpgradeGuardV1 } from "./selfupgrade-state.mjs";
export { ATTENDED_LINKS_V1 } from "./selfupgrade-state.mjs";

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function attendedBootClockV1() {
  try {
    const options = { encoding: "utf8", timeout: 2000, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: ["ignore", "pipe", "pipe"] };
    const bootId = (process.platform === "darwin" ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options)
      : readFileSync("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const startedMono = Number(execFileSync("/usr/bin/perl", ["-MTime::HiRes=clock_gettime,CLOCK_MONOTONIC", "-e",
      "print int(clock_gettime(CLOCK_MONOTONIC))"], options));
    assertSafeIdV1(bootId, "updater_flip_clock_refused");
    if (!Number.isSafeInteger(startedMono) || startedMono < 0) throw updaterRefuseV1("updater_flip_clock_refused");
    return { bootId, startedMono };
  } catch { throw updaterRefuseV1("updater_flip_clock_refused"); }
}

export async function verifyBundleManifestV1(directory, manifest) {
  if (manifest?.schema !== "control-room.updater-bundle-manifest/v1" || !Array.isArray(manifest.files)
      || manifest.files.length < 1 || manifest.files.length > 10_000)
    throw updaterRefuseV1("updater_bundle_manifest_refused");
  const declared = new Set();
  for (const item of manifest.files) {
    const profileMode = /^policy\/service-[a-z-]+\.sb$/u.test(item?.path ?? "");
    if (!item || typeof item.path !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.sha256)
        || item.type !== "file" || ![0o400, 0o500, ...(profileMode ? [0o440] : []), ...(item.path === "service-output.mjs" ? [0o555] : [])].includes(item.mode)
        || declared.has(item.path))
      throw updaterRefuseV1("updater_bundle_manifest_refused");
    declared.add(item.path);
    const path = await assertNoSymlinkBelowV1(directory, item.path);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o777) !== item.mode
        || sha256(await readFile(path)) !== item.sha256)
      throw updaterRefuseV1("updater_bundle_digest_refused");
  }
  const actual = [];
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      if (current === directory && name === "manifest.json") continue;
      const path = join(current, name), entry = await lstat(path);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw updaterRefuseV1("updater_bundle_manifest_refused");
      if (entry.isDirectory()) await walk(path); else actual.push(relative(directory, path));
    }
  }
  await walk(directory);
  if (actual.length !== declared.size || actual.some(path => !declared.has(path)))
    throw updaterRefuseV1("updater_bundle_manifest_refused");
  return sha256(Buffer.from(JSON.stringify(manifest)));
}

/** Attended self-update phases A/C/D. There is deliberately no Phase B here;
 * the two-phase secret-free self-test is item 8b. */
export class AttendedUpdaterFlipV1 {
  constructor({ root, operations, clock = () => new Date(), bootClock = attendedBootClockV1 }) {
    this.root = root; this.operations = operations; this.clock = clock; this.bootClock = bootClock;
  }

  async run({ planId, version, bundleDirectory, expectedBundleDigest, links }) {
    const lock = await acquireKernelFileLockV1(join(this.root, "updater-state/selfupgrade.lock"), { busyCode: "updater_flip_busy" });
    try { return await this.#run({ planId, version, bundleDirectory, expectedBundleDigest, links }); }
    finally { await lock.release(); }
  }

  async #run({ planId, version, bundleDirectory, expectedBundleDigest, links }) {
    assertSafeIdV1(planId, "updater_plan_refused");
    assertSafeIdV1(version, "updater_version_refused");
    const flag = (await readFileNoFollowV1(this.root, "updater-state/self-update", { maxBytes: 16 })).trim();
    if (flag !== "Off") throw updaterRefuseV1("updater_attended_requires_off");
    const confirmation = JSON.parse(await readFileNoFollowV1(this.root,
      `updater-state/confirmations/${planId}.json`, { maxBytes: 8192 }));
    if (confirmation?.planId !== planId || confirmation?.confirmed !== true)
      throw updaterRefuseV1("updater_mac_confirmation_missing");
    const plan = JSON.parse(await readFileNoFollowV1(this.root,
      `updater-state/plans/${planId}.json`, { maxBytes: 65_536 }));
    const planDigest = sha256(Buffer.from(canonicalJsonV1(plan)));
    if (plan?.planId !== planId || confirmation.planDigest !== planDigest)
      throw updaterRefuseV1("updater_attended_plan_digest_mismatch");
    const manifest = JSON.parse(await readFile(join(bundleDirectory, "manifest.json"), "utf8"));
    const digest = await verifyBundleManifestV1(bundleDirectory, manifest);
    if (digest !== expectedBundleDigest) throw updaterRefuseV1("updater_bundle_digest_refused");

    // Phase A: the operation copies bytes, applies read-only modes, and T1-checks
    // new runtime pins. It never executes candidate code.
    await this.operations.stage({ version, bundleDirectory, manifest });

    const requested = [...links];
    if (requested.some(item => !ATTENDED_LINKS_V1.includes(item.link))
        || new Set(requested.map(item => item.link)).size !== requested.length)
      throw updaterRefuseV1("updater_flip_links_refused");
    const resolved = [];
    for (const item of requested) {
      const from = await readlink(join(this.root, item.link));
      if (from.startsWith("/") || from.split("/").includes("..") || item.to.startsWith("/")
          || item.to.split("/").includes("..")) throw updaterRefuseV1("updater_flip_target_refused");
      resolved.push(Object.freeze({ link: item.link, from, to: item.to }));
    }
    const { bootId, startedMono } = this.bootClock(), attemptId = randomUUID();
    assertSafeIdV1(bootId, "updater_flip_clock_refused");
    if (!Number.isSafeInteger(startedMono) || startedMono < 0) throw updaterRefuseV1("updater_flip_clock_refused");
    const record = { schema: "control-room.selfupgrade/v1", phase: "flipping", at: this.clock().toISOString(),
      attemptId, bootId, startedMono, healthPassed: false,
      linkCount: resolved.length, links: resolved };
    await withSelfUpgradeGuardV1(this.root, async () => {
      await atomicWriteNoFollowV1(this.root, "updater-state/selfupgrade-attempt.json", `${JSON.stringify({
        schema: "control-room.selfupgrade-attempt/v1", attemptId, bootId, startedMono,
      })}\n`);
      await atomicWriteNoFollowV1(this.root, "updater-state/selfupgrade.json", `${JSON.stringify(record)}\n`);

      // Phase C: previous first, current last. The guard cannot overlap these
      // moves, but a killed process releases the kernel lock for recovery.
      for (const item of resolved) {
        const previous = item.link.replace(/-current$/u, "-previous").replace(/\/current$/u, "/previous");
        await atomicSymlinkNoFollowV1(this.root, previous, item.from);
      }
      for (const item of resolved) await atomicSymlinkNoFollowV1(this.root, item.link, item.to);
    });
    await this.operations.restart({ pgMoved: resolved.some(item => item.link === "runtime/pg-current") });

    // Phase D: three complete health samples. Health is the full PG/web/gateway
    // contract supplied by item 14, not merely this process's heartbeat.
    for (let sample = 0; sample < 3; sample += 1) {
      if (!await this.operations.fullHealth({ sample })) throw updaterRefuseV1("updater_phase_d_health_failed");
      // Even one passed full health check ends automatic rollback authority.
      // A later unrelated hang must never replay this attempt.
      record.healthPassed = true;
      await noteSelfUpgradeHealthV1(this.root, attemptId);
      if (sample < 2) await this.operations.waitForNextHeartbeat();
    }
    await withSelfUpgradeGuardV1(this.root, async () => {
      const current = JSON.parse(await readFileNoFollowV1(this.root, "updater-state/selfupgrade.json", { maxBytes: 16_384 }));
      if (current.attemptId !== attemptId || !["flipping", "settled"].includes(current.phase) || current.healthPassed !== true)
        throw updaterRefuseV1("updater_flip_attempt_settled");
      await atomicWriteNoFollowV1(this.root, "updater-state/selfupgrade.json", `${JSON.stringify({ ...current,
        phase: "done", doneAt: this.clock().toISOString() })}\n`);
    });
    return { version, digest, links: resolved.length };
  }
}
