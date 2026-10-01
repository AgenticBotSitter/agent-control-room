import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttendedUpdaterFlipV1 } from "../src/updater/v1/attended-flip.mjs";
import { canonicalJsonV1, confirmationWordsV1, runUpdaterCliV1 } from "../src/updater/v1/cli.mjs";

const digestV1 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function rootV1(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-cli-flip-"));
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  for (const path of ["updater-state/plans", "updater-state/confirmations", "status", "updater", "runtime", "releases",
    "pg"]) await mkdir(join(root, path), { recursive: true });
  return root;
}

async function planFixtureV1(root, { planId = "u2", kind = "updater" } = {}) {
  const plan = { schema: "control-room.install-plan/v2", planId, kind,
    from: { releaseId: "r1" }, artifact: { releaseId: "r2" },
    updaterDerived: { changesDatabase: false, changesUpdater: true } };
  const planDigest = digestV1(Buffer.from(canonicalJsonV1(plan)));
  await writeFile(join(root, `updater-state/plans/${planId}.json`), JSON.stringify(plan));
  await writeFile(join(root, "updater-state/open-confirmation.json"), JSON.stringify({ planId, planDigest }));
  return { plan, planDigest, words: confirmationWordsV1(planDigest) };
}

test("the CLI keeps status unprivileged, sudo verbs root-only, and confirm bound to the root plan", async t => {
  const root = await rootV1(t), output = [];
  await writeFile(join(root, "status/status.json"), JSON.stringify({ state: "idle", releaseId: "r1",
    lastHealthAt: null, needsYou: false, updaterRestartsLastHour: 0, selfUpdate: "Off", secret: "must-not-print" }));
  assert.equal(await runUpdaterCliV1(["status"], { root, getuid: () => 501, stdout: text => output.push(text) }), 0);
  assert.doesNotMatch(output.join(""), /must-not-print/u);
  await assert.rejects(runUpdaterCliV1(["pause"], { root, getuid: () => 501 }), /updater_pause_needs_root/u);
  await assert.rejects(runUpdaterCliV1(["install", "--commit", "a".repeat(40)], { root, getuid: () => 501 }),
    /updater_install_needs_root/u);

  const fixture = await planFixtureV1(root); output.length = 0;
  assert.equal(fixture.words.length, 6, "the owner confirmation carries 36 bits, not the old 24-bit code");
  const originalPlan = await readFile(join(root, "updater-state/plans/u2.json"), "utf8");
  await writeFile(join(root, "updater-state/plans/u2.json"), JSON.stringify({ ...fixture.plan,
    artifact: { releaseId: "swapped" } }));
  await assert.rejects(runUpdaterCliV1(["confirm", ...fixture.words],
    { root, getuid: () => 0, stdout: () => {} }), /updater_confirm_plan_digest_mismatch/u);
  await writeFile(join(root, "updater-state/plans/u2.json"), originalPlan);
  await assert.rejects(runUpdaterCliV1(["confirm", "wrong", ...fixture.words.slice(1)],
    { root, getuid: () => 0, stdout: text => output.push(text) }), /updater_confirm_words_refused/u);
  await assert.rejects(readFile(join(root, "updater-state/confirmations/u2.json")), /ENOENT/u);
  assert.equal(await runUpdaterCliV1(["confirm", ...fixture.words],
    { root, getuid: () => 0, now: () => new Date("2026-09-30T12:00:00Z"), stdout: text => output.push(text) }), 0);
  assert.match(output.join(""), /Changes updater: yes/u);
  const confirmation = JSON.parse(await readFile(join(root, "updater-state/confirmations/u2.json"), "utf8"));
  assert.deepEqual({ planId: confirmation.planId, digest: confirmation.planDigest, confirmed: confirmation.confirmed },
    { planId: "u2", digest: fixture.planDigest, confirmed: true });

  let sent;
  assert.equal(await runUpdaterCliV1(["backup-now"], { root, getuid: () => 0,
    send: async (_path, request) => { sent = request; }, stdout: () => {} }), 0);
  assert.equal(sent.verb, "backup-now");
  await assert.rejects(runUpdaterCliV1(["owner-code"], { root, getuid: () => 0 }),
    /updater_cli_port_not_implemented/u, "later sudo verbs are explicit typed ports, never socket aliases");
  const passkeyOutput = [], passkeyAuthority = {
    async beginRegistration() { return { registrationSecret: "A".repeat(43),
      config: { expectedOrigin: "https://control-room.example.test" } }; },
    async listPasskeys() { return [{ number: 1, credentialId: "credential-one", createdAt: "2026-09-30T12:00:00.000Z",
      coolingOffUntil: null, revokedAt: null }]; },
    async revokePasskey(number) { return { number, credentialId: "unused" }; },
    async completeRegistration(input) { assert.deepEqual(input, { registrationSecret: "A".repeat(43),
      typedCode: "ABC234" }); return { coolingOffUntil: null }; },
  };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, passkeyAuthority,
    readComparisonCode: async () => " abc234 \n", stdout: text => passkeyOutput.push(text) }), 0);
  assert.match(passkeyOutput.join(""), /\/setup#reg=/u);
  assert.match(passkeyOutput.join(""), /Passkey added and active/u);
  assert.equal(await runUpdaterCliV1(["passkey", "list"], { root, getuid: () => 0, passkeyAuthority,
    stdout: text => passkeyOutput.push(text) }), 0);
  assert.match(passkeyOutput.join(""), /created 2026-09-30T12:00:00.000Z; id credential-one/u);
  assert.equal(await runUpdaterCliV1(["passkey", "revoke", "1"], { root, getuid: () => 0, passkeyAuthority,
    stdout: () => {} }), 0);
  const controlVerbs = [], sendOptions = [], send = async (_path, request, options) => {
    controlVerbs.push(request.verb);
    sendOptions.push(options);
    if (request.verb === "passkey-add-begin") return { registrationSecret: "B".repeat(43),
      expectedOrigin: "https://control-room.example.test" };
    if (request.verb === "passkey-add-complete") return { credentialId: "unused", coolingOffUntil: null };
    if (request.verb === "passkey-list") return [];
    return { number: 1, credentialId: "unused" };
  };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, send,
    readComparisonCode: async () => "ABC234", stdout: () => {} }), 0);
  assert.equal(await runUpdaterCliV1(["passkey", "list"], { root, getuid: () => 0, send, stdout: () => {} }), 0);
  assert.equal(await runUpdaterCliV1(["passkey", "revoke", "1"], { root, getuid: () => 0, send, stdout: () => {} }), 0);
  assert.deepEqual(controlVerbs, ["passkey-add-begin", "passkey-add-complete", "passkey-list", "passkey-revoke"]);
  assert.deepEqual(sendOptions, [undefined, { timeoutMs: 15_000 }, undefined, undefined]);

  const coolingOutput = [], coolingAuthority = { ...passkeyAuthority,
    async completeRegistration() { return { coolingOffUntil: "2026-10-01T12:00:00.000Z",
      coolingOffNoticesEnqueued: true }; } };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, passkeyAuthority: coolingAuthority,
    readComparisonCode: async () => "ABC234", stdout: text => coolingOutput.push(text) }), 0);
  assert.match(coolingOutput.join(""), /Phone warning delivery is not available yet/u);
  assert.doesNotMatch(coolingOutput.join(""), /warnings? (?:were )?(?:queued|sent)|phone (?:was|will be) warn/iu);
  await assert.rejects(runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0,
    passkeyAuthority: { ...coolingAuthority, async completeRegistration() {
      return { coolingOffUntil: "2026-10-01T12:00:00.000Z", coolingOffNoticesEnqueued: false }; } },
    readComparisonCode: async () => "ABC234", stdout: () => {} }), /updater_passkey_control_reply_refused/u);
});

test("attended flip rechecks the confirmed digest immediately before staging", async t => {
  const root = await rootV1(t), fixture = await planFixtureV1(root), bundle = await bundleV1(root);
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  await runUpdaterCliV1(["confirm", ...fixture.words], { root, getuid: () => 0, stdout: () => {} });
  await writeFile(join(root, "updater-state/plans/u2.json"), JSON.stringify({ ...fixture.plan,
    artifact: { releaseId: "swapped-after-confirmation" } }));
  let staged = false;
  const operations = { async stage() { staged = true; }, async restart() {}, async fullHealth() { return true; },
    async waitForNextHeartbeat() {} };
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }),
  /updater_attended_plan_digest_mismatch/u);
  assert.equal(staged, false, "mutated plan bytes are refused before candidate bytes are staged");
});

async function bundleV1(root) {
  const directory = join(root, "bundle"); await mkdir(directory);
  await writeFile(join(directory, "updater.mjs"), "export const version = 2;\n", { mode: 0o500 });
  const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: [{ path: "updater.mjs",
    sha256: digestV1(Buffer.from("export const version = 2;\n")), mode: 0o500, type: "file" }] };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, digest: digestV1(Buffer.from(JSON.stringify(manifest))) };
}

async function linksV1(root) {
  const values = [
    ["updater/current", "u1", "u2"], ["runtime/node-current", "node-1", "node-2"],
    ["runtime/pnpm-current", "pnpm-1", "pnpm-2"], ["runtime/pg-current", "pg-1", "pg-2"],
    ["runtime/esbuild-current", "esbuild-1", "esbuild-2"],
  ];
  for (const [link, from] of values) await symlink(from, join(root, link));
  return values.map(([link, _from, to]) => ({ link, to }));
}

test("attended updater phases A/C/D flip every link, retain previous, and require three full health samples", async t => {
  const root = await rootV1(t), fixture = await planFixtureV1(root), bundle = await bundleV1(root);
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  await runUpdaterCliV1(["confirm", ...fixture.words], { root, getuid: () => 0, stdout: () => {} });
  const links = await linksV1(root), calls = [];
  const operations = { async stage() { calls.push("stage"); }, async restart(value) { calls.push(["restart", value]); },
    async fullHealth({ sample }) { calls.push(["health", sample]); return true; },
    async waitForNextHeartbeat() { calls.push("wait"); } };
  const result = await new AttendedUpdaterFlipV1({ root, operations,
    clock: () => new Date("2026-09-30T12:00:00Z") }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory,
    expectedBundleDigest: bundle.digest, links });
  assert.equal(result.links, 5);
  for (const item of links) {
    assert.equal(await readlink(join(root, item.link)), item.to);
    const previous = item.link.replace(/-current$/u, "-previous").replace(/\/current$/u, "/previous");
    assert.match(await readlink(join(root, previous)), /-1$|^u1$/u);
  }
  const record = JSON.parse(await readFile(join(root, "updater-state/selfupgrade.json"), "utf8"));
  assert.equal(record.phase, "done"); assert.equal(record.linkCount, 5);
  assert.deepEqual(calls.filter(call => Array.isArray(call) && call[0] === "health").map(call => call[1]), [0, 1, 2]);
});

test("attended flip refuses On, a bad bundle, an unknown link and failed Phase D", async t => {
  const root = await rootV1(t), fixture = await planFixtureV1(root), bundle = await bundleV1(root);
  await runUpdaterCliV1(["confirm", ...fixture.words], { root, getuid: () => 0, stdout: () => {} });
  const operations = { async stage() {}, async restart() {}, async fullHealth() { return false; },
    async waitForNextHeartbeat() {} };
  await writeFile(join(root, "updater-state/self-update"), "On\n");
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }), /updater_attended_requires_off/u);
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  const confirmationPath = join(root, "updater-state/confirmations/u2.json");
  const confirmation = await readFile(confirmationPath, "utf8");
  await writeFile(confirmationPath, JSON.stringify({ ...JSON.parse(confirmation), planId: "wrong-plan" }));
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }),
  /updater_mac_confirmation_missing/u);
  await writeFile(confirmationPath, confirmation);
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: `sha256:${"0".repeat(64)}`, links: [] }),
  /updater_bundle_digest_refused/u);
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [{ link: "current", to: "r2" }] }),
  /updater_flip_links_refused/u);
  const links = await linksV1(root);
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links }), /updater_phase_d_health_failed/u);
  const record = JSON.parse(await readFile(join(root, "updater-state/selfupgrade.json"), "utf8"));
  assert.equal(record.phase, "flipping", "guard can see and revert an incomplete Phase D");
});

test("attended staging refuses an unmanifested file and keeps plan identity separate from updater version", async t => {
  const root = await rootV1(t), fixture = await planFixtureV1(root, { planId: "plan-22" }), bundle = await bundleV1(root);
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  await runUpdaterCliV1(["confirm", ...fixture.words], { root, getuid: () => 0, stdout: () => {} });
  await writeFile(join(bundle.directory, "unlisted"), "candidate extra\n", { mode: 0o400 });
  const operations = { async stage() { throw new Error("must not stage"); }, async restart() {},
    async fullHealth() { return true; }, async waitForNextHeartbeat() {} };
  await assert.rejects(new AttendedUpdaterFlipV1({ root, operations }).run({ planId: "plan-22",
    version: "updater-2", bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }),
  /updater_bundle_manifest_refused/u);
});
