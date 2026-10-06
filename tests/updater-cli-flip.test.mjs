import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { readCodeV1 } from "../src/updater/v1/terminal/read-code.mjs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AttendedUpdaterFlipV1 } from "../src/updater/v1/attended-flip.mjs";
import { authorizeAttendedInstallV1, bufferedLineReaderV1, canonicalJsonV1, confirmationWordsV1,
  runUpdaterCliV1 } from "../src/updater/v1/cli.mjs";

const digestV1 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function rootV1(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "updater-cli-flip-")));
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  for (const path of ["updater-state/plans", "updater-state/confirmations", "status", "updater", "runtime", "releases",
    "pg"]) await mkdir(join(root, path), { recursive: true });
  return root;
}

async function planFixtureV1(root, { planId = "u2", kind = "updater", commit, inventoryDigest } = {}) {
  const plan = { schema: "control-room.install-plan/v2", planId, kind,
    from: { releaseId: "r1" }, artifact: { releaseId: "r2", ...(commit === undefined ? {} : { commit }),
      ...(inventoryDigest === undefined ? {} : { inventoryDigest }) },
    updaterDerived: { changesDatabase: false, changesUpdater: true } };
  const planDigest = digestV1(Buffer.from(canonicalJsonV1(plan)));
  await writeFile(join(root, `updater-state/plans/${planId}.json`), JSON.stringify(plan));
  await writeFile(join(root, "updater-state/open-confirmation.json"), JSON.stringify({ planId, planDigest }));
  return { plan, planDigest, words: confirmationWordsV1(planDigest) };
}

test("attended install prints the phone commit first and allows three six-word attempts", async t => {
  const root = await rootV1(t), commit = "a".repeat(40), inventoryDigest = `sha256:${"b".repeat(64)}`,
    fixture = await planFixtureV1(root, { commit, inventoryDigest });
  const output = [], lines = [["wrong", ...fixture.words.slice(1)].join(" "), "still wrong", fixture.words.join(" ")];
  const context = { getuid: () => 0, now: () => new Date("2026-09-30T12:00:00Z"),
    stdout: text => output.push(text), async stdinLine() { return lines.shift(); } };
  assert.equal(await authorizeAttendedInstallV1(root, context), 0);
  assert.ok(output[0].startsWith(`Commit: ${commit} (compare to the phone)\n`));
  assert(output.some(text => text.includes(`Runtime inventory: ${inventoryDigest}\n`)));
  assert.equal(output.filter(text => /did not match/u.test(text)).length, 2);
  const confirmation = JSON.parse(await readFile(join(root, "updater-state/confirmations/u2.json"), "utf8"));
  assert.equal(confirmation.confirmed, true);

  const refusedRoot = await rootV1(t), refused = await planFixtureV1(refusedRoot, { planId: "u3", commit });
  let reads = 0;
  await assert.rejects(authorizeAttendedInstallV1(refusedRoot, { getuid: () => 0, now: () => new Date(), stdout: () => {},
    async stdinLine() { reads += 1; return ["wrong", ...refused.words.slice(1)].join(" "); } }),
  /updater_confirm_words_refused/u);
  assert.equal(reads, 3);
});

test("the real piped line reader survives two wrong confirmations and supplies the later passkey code", async t => {
  const root = await rootV1(t), fixture = await planFixtureV1(root, { commit: "a".repeat(40) });
  const moduleUrl = new URL("../src/updater/v1/cli.mjs", import.meta.url).href;
  const program = `import { authorizeAttendedInstallV1, bufferedLineReaderV1 } from ${JSON.stringify(moduleUrl)};
const reader=bufferedLineReaderV1(process.stdin);const context={getuid:()=>0,now:()=>new Date("2026-09-30T12:00:00Z"),stdout:t=>process.stdout.write(t),stdinLine:()=>reader.readLine()};
await authorizeAttendedInstallV1(process.argv[1],context);const code=await reader.readLine();process.stdout.write("CODE:"+code+"\\n");reader.close();`;
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program, root], {
      stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C" },
    });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    child.stdin.end(`wrong words\nstill wrong\n${fixture.words.join(" ")}\nABC234\n`);
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
  assert.equal((result.stdout.match(/did not match/gu) ?? []).length, 2); assert.match(result.stdout, /CODE:ABC234/u);
});

test("the shared terminal reader refuses a single oversized line without consuming another prompt", async () => {
  const input = new PassThrough(), reader = bufferedLineReaderV1(input);
  input.end(`${"x".repeat(1025)}\nABC234\n`);
  await assert.rejects(reader.readLine(), /updater_terminal_input_refused/u);
  await assert.rejects(reader.readLine(), /updater_terminal_input_refused/u);
  reader.close();
});

test("the shared terminal reader refuses an oversized unfinished buffer", async () => {
  const input = new PassThrough(), reader = bufferedLineReaderV1(input);
  input.end("x".repeat(8193));
  await assert.rejects(reader.readLine(), /updater_terminal_input_refused/u);
  reader.close();
});

test("the shared terminal reader refuses an oversized queue of individually valid lines", async () => {
  const input = new PassThrough(), reader = bufferedLineReaderV1(input);
  for (let index = 0; index < 600; index += 1) input.write(`${"x".repeat(15)}\n`);
  input.end();
  await assert.rejects(reader.readLine(), /updater_terminal_input_refused/u);
  reader.close();
});

test("the CLI keeps status unprivileged, sudo verbs root-only, and confirm bound to the root plan", async t => {
  const root = await rootV1(t), output = [];
  const invoking = ["--invoking-user", "fixture-owner", "--invoking-uid", "501", "--invoking-gid", "20"];
  await writeFile(join(root, "status/status.json"), JSON.stringify({ state: "idle", releaseId: "r1",
    lastHealthAt: null, needsYou: false, updaterRestartsLastHour: 0, selfUpdate: "Off", secret: "must-not-print" }));
  assert.equal(await runUpdaterCliV1(["status", ...invoking],
    { root, getuid: () => 501, stdout: text => output.push(text) }), 0);
  assert.doesNotMatch(output.join(""), /must-not-print/u);
  await assert.rejects(runUpdaterCliV1(["pause"], { root, getuid: () => 501 }), /updater_pause_needs_root/u);
  await assert.rejects(runUpdaterCliV1(["install", "--commit", "a".repeat(40), ...invoking],
    { root, getuid: () => 501 }), /root_required/u);

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
  assert.equal(await runUpdaterCliV1(["confirm", ...fixture.words, ...invoking],
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
  let nonTtyBegan = false;
  await assert.rejects(runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0,
    passkeyAuthority: { ...passkeyAuthority, async beginRegistration() { nonTtyBegan = true; } },
    terminal: { isTTY: false, write() {}, async readLine() { return "ABC234"; }, setRawMode() {} },
    stdout: () => {} }), /updater_passkey_code_terminal_required/u);
  assert.equal(nonTtyBegan, false, "a non-TTY call is refused before it opens a registration");
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, passkeyAuthority,
    readComparisonCode: async () => " abc234 \n", stdout: text => passkeyOutput.push(text) }), 0);
  assert.match(passkeyOutput.join(""), /\/setup#reg=/u);
  assert.match(passkeyOutput.join(""), /Passkey added and active/u);
  assert.equal(await runUpdaterCliV1(["passkey", "list", ...invoking], { root, getuid: () => 0, passkeyAuthority,
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
  // `passkey-list` now LEADS, because the mode is read from the ledger before the
  // registration is begun. That extra round trip is the cost of not hard-coding
  // `add`, and it is the reason the first passkey on a fresh install is usable
  // tonight. MEASURED: this list was the old four-verb sequence and the assertion
  // caught the extra call.
  assert.deepEqual(controlVerbs, ["passkey-list", "passkey-add-begin", "passkey-add-complete", "passkey-list",
    "passkey-revoke"]);
  assert.deepEqual(sendOptions, [undefined, undefined, { timeoutMs: 15_000 }, undefined, undefined]);
  // And the mode travels to the daemon, because the authority is not the only
  // thing that has to agree on it: a `passkey-add-begin` with no argument means
  // `add`, and the ledger is empty here so the reply is the `initial` path.
  const beginArguments = [];
  const capturingSend = async (_path, request) => { beginArguments.push(request);
    if (request.verb === "passkey-add-begin") return { registrationSecret: "B".repeat(43), mode: "initial",
      expectedOrigin: "https://control-room.example.test" };
    if (request.verb === "passkey-add-complete") return { credentialId: "unused", coolingOffUntil: null };
    if (request.verb === "passkey-list") return [];
    return { number: 1, credentialId: "unused" }; };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, send: capturingSend,
    readComparisonCode: async () => "ABC234", stdout: () => {} }), 0);
  assert.deepEqual(beginArguments[1].arguments, ["initial"],
    "the CLI tells the daemon which ceremony to run; the daemon does not guess");

  // THE MODE `passkey add` CHOOSES, and it is the H2 fix.
  //
  // `add` is the ceremony that makes a new passkey wait out a 24-hour cooling-off
  // window unless an ACTIVE passkey approves it. On a Mac with no passkey there
  // is none to approve it, so `add` on a fresh install produced a first passkey
  // that could not sign anything for a day. The mode is now read from the ledger:
  // no passkey -> `initial`, any passkey -> `add`.
  //
  // The authority REFUSES `initial` whenever the ledger holds a passkey, so
  // choosing it here cannot become a second way to add a later passkey without
  // approval — the ledger is the same rule, counted in the same place.
  // ONE recorder for every authority below, because the point of these cases is
  // the MODE each one produces and three separate arrays would compare three
  // different things.
  const modes = [], freshOutput = [], freshAuthority = { ...passkeyAuthority,
    async listPasskeys() { return []; },
    async beginRegistration(input) { modes.push(input.mode);
      return { registrationSecret: "C".repeat(43), config: { expectedOrigin: "https://control-room.example.test" } }; },
    // The shared fixture asserts the SECRET it issued, so this authority asserts
    // its own: without that, the fresh-install case would be measuring the
    // fixture's assertion rather than the mode.
    async completeRegistration(input) { assert.deepEqual(input, { registrationSecret: "C".repeat(43),
      typedCode: "ABC234" }); return { coolingOffUntil: null }; } };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, passkeyAuthority: freshAuthority,
    readComparisonCode: async () => "ABC234", stdout: text => freshOutput.push(text) }), 0);
  assert.deepEqual(modes, ["initial"], "a Mac with no passkey registers its FIRST one in initial mode");
  assert.match(freshOutput.join(""), /mode=initial/u);
  assert.match(freshOutput.join(""), /active as soon as you finish/u,
    "the owner is told the first passkey works tonight, not told to wait a day");
  // And with an existing passkey the mode is `add`, and the message is the caution.
  modes.length = 0;
  const secondOutput = [];
  const existingAuthority = { ...passkeyAuthority,
    async beginRegistration(input) { modes.push(input.mode);
      return { registrationSecret: "A".repeat(43), config: { expectedOrigin: "https://control-room.example.test" } }; } };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, passkeyAuthority: existingAuthority,
    readComparisonCode: async () => "ABC234", stdout: text => secondOutput.push(text) }), 0);
  assert.deepEqual(modes, ["add"], "a Mac that already has one adds in add mode");
  assert.match(secondOutput.join(""), /mode=add/u);
  assert.match(secondOutput.join(""), /inactive for 24 hours/u);
  // A REVOKED passkey still counts, so `initial` is not reachable through a
  // revocation. The authority refuses `initial` on any row, so counting all of
  // them is the same rule it applies.
  const revokedOnly = [], revokedAuthority = { ...passkeyAuthority,
    async listPasskeys() { return [{ number: 1, credentialId: "gone", createdAt: "2026-09-30T12:00:00.000Z",
      coolingOffUntil: null, revokedAt: "2026-10-01T00:00:00.000Z" }]; },
    async beginRegistration(input) { revokedOnly.push(input.mode);
      return { registrationSecret: "D".repeat(43), config: { expectedOrigin: "https://control-room.example.test" } }; },
    async completeRegistration(input) { assert.deepEqual(input, { registrationSecret: "D".repeat(43),
      typedCode: "ABC234" }); return { coolingOffUntil: null }; } };
  assert.equal(await runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0, passkeyAuthority: revokedAuthority,
    readComparisonCode: async () => "ABC234", stdout: () => {} }), 0);
  assert.deepEqual(revokedOnly, ["add"], "a revoked passkey still means this is not the first");
  // An UNREADABLE ledger refuses rather than defaulting to `initial`, because
  // guessing `initial` on a Mac that already has keys is the weaker outcome.
  await assert.rejects(runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0,
    passkeyAuthority: { ...passkeyAuthority, async listPasskeys() { throw new Error("ledger unreadable"); } },
    readComparisonCode: async () => "ABC234", stdout: () => {} }), /ledger unreadable/u);
  await assert.rejects(runUpdaterCliV1(["passkey", "add"], { root, getuid: () => 0,
    passkeyAuthority: { ...passkeyAuthority, async listPasskeys() { return "not an array"; } },
    readComparisonCode: async () => "ABC234", stdout: () => {} }), /updater_passkey_control_reply_refused/u);

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
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "u2", version: "updater-2",
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
  const result = await new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations,
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
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }), /updater_attended_requires_off/u);
  await writeFile(join(root, "updater-state/self-update"), "Off\n");
  const confirmationPath = join(root, "updater-state/confirmations/u2.json");
  const confirmation = await readFile(confirmationPath, "utf8");
  await writeFile(confirmationPath, JSON.stringify({ ...JSON.parse(confirmation), planId: "wrong-plan" }));
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }),
  /updater_mac_confirmation_missing/u);
  await writeFile(confirmationPath, confirmation);
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: `sha256:${"0".repeat(64)}`, links: [] }),
  /updater_bundle_digest_refused/u);
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "u2", version: "updater-2",
    bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [{ link: "current", to: "r2" }] }),
  /updater_flip_links_refused/u);
  const links = await linksV1(root);
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "u2", version: "updater-2",
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
  await assert.rejects(new AttendedUpdaterFlipV1({ root, bootClock: () => ({ bootId: "test-boot", startedMono: 20000 }), operations }).run({ planId: "plan-22",
    version: "updater-2", bundleDirectory: bundle.directory, expectedBundleDigest: bundle.digest, links: [] }),
  /updater_bundle_manifest_refused/u);
});

// Exercise the production reader with a fake terminal, including individual raw bytes.
// EventEmitter and readCodeV1 are imported at the top of the file (r5sfix).
import { getEventListeners } from "node:events";
import { updaterRecoveryLineV1 } from "../src/updater/v1/cli.mjs";

function rawFixture() {
  const input = new PassThrough(), reader = bufferedLineReaderV1(input), modes = [];
  const terminal = { isTTY: true, write() {}, setRawMode: mode => modes.push(mode),
    readLine: signal => reader.readLine(signal, { raw: true }) };
  return { input, reader, terminal, modes };
}

test("R5G raw Ctrl-C and Ctrl-D stop before Enter and leave no stale read", { timeout: 2000 }, async () => {
  for (const byte of ["\u0003", "\u0004"]) {
    const f = rawFixture();
    try {
      const read = readCodeV1(f.terminal, { timeoutMs: 500 });
      await Promise.resolve(); f.input.write(`ABC${byte}`);
      await assert.rejects(Promise.race([read, new Promise((_, reject) => setTimeout(() => reject(new Error("raw cancellation did not stop promptly")), 50))]), /updater_passkey_code_interrupted/u);
      assert.deepEqual(f.modes, [true, false]);
      const retry = readCodeV1(f.terminal); await Promise.resolve(); f.input.write("abc234\r");
      assert.equal(await retry, "ABC234");
    } finally { f.reader.close(); f.input.destroy(); }
  }
});

test("R5G Delete and Backspace correct the code across chunks and at an empty prompt", async () => {
  for (const byte of ["\u007f", "\b"]) {
    const f = rawFixture();
    try {
      const read = readCodeV1(f.terminal); await Promise.resolve();
      for (const chunk of [byte, "ABC23X", byte, "4\r"]) f.input.write(chunk);
      assert.equal(await read, "ABC234"); assert.deepEqual(f.modes, [true, false]);
    } finally { f.reader.close(); f.input.destroy(); }
  }
});

test("R5G abort, closed input, missing code, and timeout restore terminal custody", { timeout: 2000 }, async () => {
  const f = rawFixture();
  try {
    const preStopped = new AbortController(); preStopped.abort();
    await assert.rejects(f.reader.readLine(preStopped.signal, { raw: true }), /updater_passkey_code_interrupted/u);
    const controller = new AbortController(), stopped = f.reader.readLine(controller.signal, { raw: true });
    f.input.write("partial"); controller.abort();
    await assert.rejects(stopped, /updater_passkey_code_interrupted/u);
    const retry = readCodeV1(f.terminal); await Promise.resolve(); f.input.write("ABC234\n");
    assert.equal(await retry, "ABC234");
    const second = f.reader.readLine();
    await assert.rejects(f.reader.readLine(), /updater_terminal_read_busy/u);
    f.input.end(); assert.equal(await second, "");
    await assert.rejects(readCodeV1(f.terminal), /updater_passkey_code_refused/u);
  } finally { f.reader.close(); f.input.destroy(); }
  const slow = rawFixture();
  try {
    await assert.rejects(readCodeV1(slow.terminal, { timeoutMs: 10 }), /updater_passkey_code_interrupted/u);
    assert.deepEqual(slow.modes, [true, false]);
  } finally { slow.reader.close(); slow.input.destroy(); }
  const closed = rawFixture();
  const waiting = closed.reader.readLine(); closed.reader.close();
  await assert.rejects(waiting, /updater_terminal_input_refused/u); closed.input.destroy();
});

test("R5G fifty isolated raw prompts survive a slow byte stream and correction burst", async () => {
  await Promise.all(Array.from({ length: 50 }, async (_, i) => {
    const f = rawFixture();
    try {
      const signals = new EventEmitter();
      const read = readCodeV1(f.terminal, { signals }); await Promise.resolve();
      f.input.write("ABC23X"); await new Promise(resolve => setTimeout(resolve, i % 3));
      f.input.write("\u007f4\n"); assert.equal(await read, "ABC234");
    } finally { f.reader.close(); f.input.destroy(); }
  }));
});

test("R5G recovery distinguishes completed rollback, incomplete rollback and cancelled code", async () => {
  assert.match(updaterRecoveryLineV1({ code: "updater_confirm_words_refused", installRollbackComplete: true }), /attempted install was undone/u);
  assert.match(updaterRecoveryLineV1({ message: "install_rollback_incomplete" }), /could not be fully undone.*Leave its files/u);
  assert.match(updaterRecoveryLineV1({ code: "updater_passkey_code_interrupted" }), /Code entry stopped.*may remain installed/u);
  assert.match(updaterRecoveryLineV1({ code: "updater_passkey_code_refused" }), /not six letters and numbers/u);
  assert.match(updaterRecoveryLineV1({}), /installation state is not confirmed/u);
  const output = [];
  await assert.rejects(runUpdaterCliV1(["install", "--commit", "bad"], { stdinLine: async () => "", stdout() {},
    stderr: line => output.push(line), installerPorts: { geteuid: () => 0 }, getuid: () => 0 }));
  assert.match(output.join(""), /Do not retry.*show the lead after reopening Claude/u);
});

test("R5G actual CLI input wiring stops Ctrl-C cleanly and accepts a Delete correction", { timeout: 2000 }, async () => {
  for (const cancel of [true, false]) {
    const input = new PassThrough(), modes = [], errors = [];
    input.isTTY = true; input.setRawMode = value => modes.push(value);
    let submitted;
    const running = runUpdaterCliV1(["passkey", "add"], { stdin: input, getuid: () => 0,
      stdout: text => { if (text.includes('Type the 6-character code')) setImmediate(() => input.write(cancel ? 'ABC\u0003' : 'ABC23X\u007f4\r')); },
      stderr: text => errors.push(text), passkeyAuthority: {
        listPasskeys: async () => [], beginRegistration: async () => ({ registrationSecret: 'A'.repeat(43), expectedOrigin: 'https://control-room.example.test' }),
        completeRegistration: async value => { submitted = value.typedCode; return { coolingOffUntil: null }; },
      } });
    try {
      if (cancel) {
        await assert.rejects(running, /updater_passkey_code_interrupted/u);
        assert.equal(submitted, undefined);
        assert.match(errors.join(''), /Code entry stopped.*Do not retry/u);
      } else { assert.equal(await running, 0); assert.equal(submitted, 'ABC234'); }
      assert.deepEqual(modes, [true, false]);
      assert.equal(input.listenerCount('data'), 0);
      assert.equal(input.listenerCount('end'), 0);
    } finally { input.destroy(); }
  }
});

test("R5G real CLI reader receives abort and releases its pending read on SIGINT", { timeout: 2000 }, async t => {
  // Observe the real reader's subscription, without injecting a comparison reader.
  // Checking only the CLI rejection would also pass if Promise.race hid a stale read.
  const subscriptions = t.mock.method(AbortSignal.prototype, "addEventListener");
  const input = new PassThrough(), modes = [], errors = [];
  input.isTTY = true; input.setRawMode = value => modes.push(value);
  let submitted = false;
  const options = { stdin: input, getuid: () => 0, stdout() {}, stderr: text => errors.push(text),
    passkeyAuthority: {
      listPasskeys: async () => [],
      beginRegistration: async () => ({ registrationSecret: "A".repeat(43), expectedOrigin: "https://control-room.example.test" }),
      completeRegistration: async () => { submitted = true; return { coolingOffUntil: null }; },
    } };
  const before = process.listenerCount("SIGINT");
  const running = runUpdaterCliV1(["passkey", "add"], options);
  const rejection = assert.rejects(running, /updater_passkey_code_interrupted/u);
  try {
    await new Promise(resolve => setImmediate(resolve));
    input.write("ABC");
    const calls = subscriptions.mock.calls.filter(call => call.arguments[0] === "abort");
    assert.equal(calls.length, 1, "the real pending reader must subscribe to the code-entry signal");
    const signal = calls[0].this;
    assert.equal(signal.aborted, false);
    assert.equal(getEventListeners(signal, "abort").length, 1);
    process.emit("SIGINT");
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(signal, "abort").length, 0, "abort must settle and detach the pending reader");
    await rejection;
    assert.equal(submitted, false);
    assert.match(errors.join(""), /Code entry stopped.*Do not retry/u);
    assert.deepEqual(modes, [true, false]);
    assert.equal(process.listenerCount("SIGINT"), before);
    for (const event of ["data", "end", "error"]) assert.equal(input.listenerCount(event), 0);
    // The same input remains usable after the failed ceremony.
    options.stdout = text => {
      if (text.includes("Type the 6-character code")) setImmediate(() => input.write("ABC234\r"));
    };
    input.resume();
    assert.equal(await runUpdaterCliV1(["passkey", "add"], options), 0);
    assert.equal(submitted, true);
    assert.deepEqual(modes, [true, false, true, false]);
  } finally {
    if (process.listenerCount("SIGINT") > before) process.emit("SIGINT");
    input.destroy(); await rejection;
  }
});

test("R5G default code-entry backstop aborts at exactly 300 seconds", { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = rawFixture(), signals = new EventEmitter();
  const read = readCodeV1(f.terminal, { signals });
  let settled = false;
  read.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(read, /updater_passkey_code_interrupted/u);
  try {
    await Promise.resolve(); f.input.write("ABC");
    t.mock.timers.tick(299999); await Promise.resolve();
    assert.equal(settled, false, "the default wait must last 300 seconds");
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, "the default wait must abort at the 300-second boundary");
    await rejection;
    assert.deepEqual(f.modes, [true, false]);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    const retry = readCodeV1(f.terminal, { signals });
    await Promise.resolve(); f.input.write("ABC234\r");
    assert.equal(await retry, "ABC234", "timeout must release the reader and discard partial input");
  } finally {
    signals.emit("SIGINT"); f.reader.close(); f.input.destroy(); await rejection;
  }
});


test("R5S-03: actual buffered reader cancels fifty raw setup prompts immediately on Ctrl-C", async () => {
  await Promise.all(Array.from({ length: 50 }, async () => {
    const input = new PassThrough(), reader = bufferedLineReaderV1(input), modes = [], signals = new EventEmitter();
    const result = readCodeV1({ isTTY: true, write() {}, readLine: () => reader.readLine(),
      setRawMode: mode => modes.push(mode) }, { signals });
    let timer;
    try {
      const refused = assert.rejects(Promise.race([result, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("ctrl_c_did_not_settle")), 250);
      })]), /updater_passkey_code_interrupted/u);
      input.write("partial\u0003");
      await refused;
      assert.deepEqual(modes, [true, false]);
      assert.equal(signals.listenerCount("SIGINT"), 0);
      input.write("ABC123\r");
      assert.equal(await readCodeV1({ isTTY: true, write() {}, readLine: () => reader.readLine(),
        setRawMode() {} }, { signals }), "ABC123");
    } finally { clearTimeout(timer); input.end(); await result.catch(() => {}); reader.close(); }
  }));
});


test("R5S-05: split CRLF delivers two answers without spending a phantom attempt", async () => {
  const input = new PassThrough(), reader = bufferedLineReaderV1(input);
  try {
    input.write("ABC123\r"); assert.equal(await reader.readLine(), "ABC123");
    input.emit("data", Buffer.alloc(0));
    input.write("\nDEF456\r\n"); assert.equal(await reader.readLine(), "DEF456");
    input.end(); assert.equal(await reader.readLine(), "");
  } finally { input.end(); reader.close(); }
});

test("R5S-05: every CRLF split and fifty fragmented answers preserve real blank lines", async () => {
  const text = "ABC123\r\n\r\nDEF456\rNEXT\n";
  for (let split = 0; split <= text.length; split += 1) {
    const input = new PassThrough(), reader = bufferedLineReaderV1(input);
    try {
      input.write(text.slice(0, split)); input.end(text.slice(split));
      for (const expected of ["ABC123", "", "DEF456", "NEXT"]) assert.equal(await reader.readLine(), expected, `split ${split}`);
      assert.equal(await reader.readLine(), "");
    } finally { reader.close(); }
  }
  const input = new PassThrough(), reader = bufferedLineReaderV1(input);
  try {
    for (let index = 0; index < 50; index += 1) {
      for (const character of `code${index}\r\n`) input.write(character);
      assert.equal(await reader.readLine(), `code${index}`);
    }
  } finally { input.end(); reader.close(); }
});
