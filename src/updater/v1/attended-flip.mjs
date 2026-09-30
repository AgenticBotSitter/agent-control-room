import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir, readlink, rename, symlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";
import { assertNoSymlinkBelowV1, atomicWriteNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { canonicalJsonV1 } from "./cli.mjs";

export const ATTENDED_LINKS_V1 = Object.freeze([
  "updater/current", "runtime/node-current", "runtime/pnpm-current", "runtime/pg-current", "runtime/esbuild-current",
]);

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function atomicSymlinkV1(root, link, target) {
  const absolute = join(root, link);
  const parent = dirname(absolute);
  await assertNoSymlinkBelowV1(root, parent);
  try {
    const current = await lstat(absolute);
    if (!current.isSymbolicLink()) throw updaterRefuseV1("updater_flip_link_refused");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = join(parent, `.${basename(link)}.${process.pid}.${randomBytes(8).toString("hex")}.link`);
  await symlink(target, temporary);
  await rename(temporary, absolute);
}

export async function verifyBundleManifestV1(directory, manifest) {
  if (manifest?.schema !== "control-room.updater-bundle-manifest/v1" || !Array.isArray(manifest.files)
      || manifest.files.length < 1 || manifest.files.length > 10_000)
    throw updaterRefuseV1("updater_bundle_manifest_refused");
  const declared = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.sha256)
        || item.type !== "file" || ![0o400, 0o500].includes(item.mode) || declared.has(item.path))
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
  constructor({ root, operations, clock = () => new Date() }) {
    this.root = root; this.operations = operations; this.clock = clock;
  }

  async run({ planId, version, bundleDirectory, expectedBundleDigest, links }) {
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
    const record = { schema: "control-room.selfupgrade/v1", phase: "flipping", at: this.clock().toISOString(),
      linkCount: resolved.length, links: resolved };
    await atomicWriteNoFollowV1(this.root, "updater-state/selfupgrade.json", `${JSON.stringify(record)}\n`);

    // Phase C: previous first, current last. A crash leaves a complete record
    // from which guard.sh reverts the whole set.
    for (const item of resolved) {
      const previous = item.link.replace(/-current$/u, "-previous").replace(/\/current$/u, "/previous");
      await atomicSymlinkV1(this.root, previous, item.from);
    }
    for (const item of resolved) await atomicSymlinkV1(this.root, item.link, item.to);
    await this.operations.restart({ pgMoved: resolved.some(item => item.link === "runtime/pg-current") });

    // Phase D: three complete health samples. Health is the full PG/web/gateway
    // contract supplied by item 14, not merely this process's heartbeat.
    for (let sample = 0; sample < 3; sample += 1) {
      if (!await this.operations.fullHealth({ sample })) throw updaterRefuseV1("updater_phase_d_health_failed");
      if (sample < 2) await this.operations.waitForNextHeartbeat();
    }
    await atomicWriteNoFollowV1(this.root, "updater-state/selfupgrade.json", `${JSON.stringify({ ...record,
      phase: "done", doneAt: this.clock().toISOString() })}\n`);
    return { version, digest, links: resolved.length };
  }
}
