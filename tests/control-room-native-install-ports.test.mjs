import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// The union of both streams' imports: the installer's Tailscale-parent, Serve-443
// and rehearsal-evidence guards, and this stream's database-phase port contract.
import { assertRehearsalOwnerDeniedV1, assertRootOwnedTailscaleParentV1, assertSeatbeltAppliedV1,
  captureTailscaleServe443V1, cleanupTailscaleDirectoryV1, DATABASE_PHASE_ORDER_V1, generateVapidKeysV1,
  initializeDatabaseV1, moveLiveDatabaseV1, readLiveServePortFromStatusV1, setTailscaleServe443V1,
} from "../src/updater/v1/cli/control-room-native-ports.mjs";

const accounts = Object.freeze({
  builder: Object.freeze({ name: "_builder", uid: 300, gid: 300, created: true }),
  database: Object.freeze({ name: "_database", uid: 301, gid: 301, created: true }),
  service: Object.freeze({ name: "_service", uid: 302, gid: 302, created: false }),
});
const success = `${JSON.stringify({ schema: "control-room.live-database-move-result/v1", outcome: "moved",
  dumpVerified: true, sourceRetained: true })}\n`;
const input = root => ({ root, accounts, verifiedDump: true, scratchParent: `${root}/pg`, retainSource: true,
  spawnTrusted() {} });

test("database move calls only the pinned script with the exact future contract", async () => {
  const checked = [], calls = [], root = "/private/tmp/control-room-move-contract";
  const result = await moveLiveDatabaseV1(input(root), async (file, args, options) => {
    calls.push({ file, args, options }); return { stdout: success, stderr: "" };
  }, async (path, options) => { checked.push({ path, options }); return path; });
  assert.deepEqual(result, { schema: "control-room.live-database-move-result/v1", outcome: "moved",
    dumpVerified: true, sourceRetained: true });
  assert.deepEqual(checked, [
    { path: `${root}/runtime/node-current/bin/node`, options: { allowedRoots: [root], executable: true } },
    { path: `${root}/updater/current/bin/move-live-database.mjs`, options: { allowedRoots: [root] } },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, `${root}/runtime/node-current/bin/node`);
  assert.equal(calls[0].args[0], `${root}/updater/current/bin/move-live-database.mjs`);
  assert.equal(calls[0].args[1], "--request");
  assert.deepEqual(JSON.parse(calls[0].args[2]), { schema: "control-room.live-database-move/v1", root,
    scratchParent: `${root}/pg`, verifiedDump: true, retainSource: true,
    accounts: {
      builder: { name: "_builder", uid: 300, gid: 300 },
      database: { name: "_database", uid: 301, gid: 301 },
      service: { name: "_service", uid: 302, gid: 302 },
    } });
  assert.equal(calls[0].options.timeout, 4 * 60 * 60 * 1000);
});

test("database move rejects bad input and unproved or malformed success", async () => {
  const root = "/private/tmp/control-room-move-refusal", execute = async () => ({ stdout: success });
  const verify = async path => path;
  for (const change of [
    { verifiedDump: false }, { retainSource: false }, { scratchParent: `${root}/elsewhere` }, { spawnTrusted: null },
    { root: "relative" }, { accounts: { ...accounts, service: accounts.database } },
    { accounts: { ...accounts, extra: accounts.service } },
    { accounts: { ...accounts, database: { ...accounts.database, name: "root" } } },
    { accounts: { ...accounts, database: { ...accounts.database, uid: 0 } } },
    { accounts: { ...accounts, database: { ...accounts.database, created: "yes" } } },
  ]) await assert.rejects(moveLiveDatabaseV1({ ...input(root), ...change }, execute, verify), /database_move_input_refused/u);
  for (const stdout of ["", "{}", "not json", "\0", "x".repeat(16_385), JSON.stringify({ schema: "control-room.live-database-move-result/v1",
    outcome: "moved", dumpVerified: false, sourceRetained: true }), JSON.stringify({
    schema: "control-room.live-database-move-result/v1", outcome: "moved", dumpVerified: true,
    sourceRetained: true, extra: true })]) {
    await assert.rejects(moveLiveDatabaseV1(input(root), async () => ({ stdout }), verify), /database_move_result_refused/u);
  }
  await assert.rejects(moveLiveDatabaseV1(input(root), execute, async () => { throw new Error("t1_refused"); }),
    /t1_refused/u);
});

test("database move serializes one root, survives a dropped call, and handles a 32-root burst", async () => {
  const root = "/private/tmp/control-room-move-busy", verify = async path => path;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = moveLiveDatabaseV1(input(root), async () => { await gate; return { stdout: success }; }, verify);
  await assert.rejects(moveLiveDatabaseV1(input(root), async () => ({ stdout: success }), verify), /database_move_busy/u);
  release(); await first;
  await assert.rejects(moveLiveDatabaseV1(input(root), async () => { throw new Error("connection_dropped"); }, verify),
    /connection_dropped/u);
  await moveLiveDatabaseV1(input(root), async () => ({ stdout: success }), verify);
  const results = await Promise.all(Array.from({ length: 32 }, (_, index) => moveLiveDatabaseV1(
    input(`/private/tmp/control-room-move-burst-${index}`), async () => ({ stdout: success }), verify)));
  assert.equal(results.length, 32);
  assert.ok(results.every(result => result.outcome === "moved"));
});

test("VAPID generation is dependency-free P-256 with matching public and private keys", () => {
  const keys = generateVapidKeysV1(), publicKey = Buffer.from(keys.publicKey, "base64url"),
    privateKey = Buffer.from(keys.privateKey, "base64url");
  assert.equal(publicKey.byteLength, 65); assert.equal(publicKey[0], 4); assert.equal(privateKey.byteLength, 32);
  const reconstructed = createECDH("prime256v1"); reconstructed.setPrivateKey(privateKey);
  assert.deepEqual(reconstructed.getPublicKey(undefined, "uncompressed"), publicKey);
});

test("VAPID generation never refuses a valid key whose scalar starts with zero bytes", () => {
  // About 1 scalar in 256 has a leading zero byte; 3,000 draws miss one with odds near 1 in 100,000.
  for (let index = 0; index < 3000; index += 1) {
    const keys = generateVapidKeysV1(), privateKey = Buffer.from(keys.privateKey, "base64url");
    assert.equal(privateKey.byteLength, 32);
    const reconstructed = createECDH("prime256v1"); reconstructed.setPrivateKey(privateKey);
    assert.equal(reconstructed.getPublicKey(undefined, "uncompressed").toString("base64url"), keys.publicKey);
  }
});

test("Tailscale cleanup unlinks only serve.json and reports a non-empty owner directory", async t => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-tailscale-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "serve.json"), "{}\n"); await writeFile(join(directory, "owner-file"), "leave me\n");
  await assert.rejects(cleanupTailscaleDirectoryV1(directory), /tailscale_temp_directory_not_empty/u);
  await assert.rejects(lstat(join(directory, "serve.json")), { code: "ENOENT" });
  assert.equal((await lstat(join(directory, "owner-file"))).isFile(), true);
});

// ---------------------------------------------------------------------------
// The database phase's native port. Same process contract as the move port, and
// these tests are about what the PORT promises before any script runs: which
// binary, which script, what is on argv, what is NOT on argv, and which results
// are refusals rather than successes.
// ---------------------------------------------------------------------------

const dbRoot = "/private/tmp/control-room-db-phase";
// The DB phase's account shape is `{database, service}` and NOT the move port's
// three-account `{builder, database, service}`: the phase creates no builder
// account, and an account key nobody uses is a key nobody reviewed. MEASURED:
// reusing the move port's shape is `database_phase_input_refused`.
const dbAccounts = Object.freeze({
  database: { name: "_database", uid: 301, gid: 301 },
  service: { name: "_service", uid: 302, gid: 302 },
});
// `passwordStdin: true` is carried in the REQUEST rather than inferred, so the
// key that says "no password in argv" is in the artifact the installer journals.
const dbLogins = Object.freeze([{ name: "control_room_web", passwordStdin: true },
  { name: "control_room_coordinator", passwordStdin: true }]);
// 24 bytes minimum (`MINIMUM_LOGIN_PASSWORD_BYTES_V1`), because a short
// password is a refusal: PostgreSQL would accept one and the next login would be
// weaker than the installer promised.
const dbPasswords = Object.freeze({ control_room_web: "w".repeat(24), control_room_coordinator: "c".repeat(24) });
const initStdout = `${JSON.stringify({ schema: "control-room.database-init-result/v1", outcome: "initialized",
  pgDataId: "data-A", updaterSchemaDigest: `sha256:${"a".repeat(64)}`, clusterShutDownClean: true })}\n`;
const releaseStdout = `${JSON.stringify({ schema: "control-room.release-schema-result/v1", outcome: "applied",
  schemaDigest: `sha256:${"b".repeat(64)}`, ledgerHead: "0119_x.sql" })}\n`;

/**
 * A PORT input for one phase. `passwords` and `phase` are part of the port's own
 * argument shape and are NOT part of the REQUEST: the request the script parses
 * has an exact key set, and both `passwords` and `phase` are outside it.
 */
// `port` IS PART OF THE REQUEST, and it is here because the port's own pre-spawn
// check and the scripts' shared parser both require it: the cluster is socket-only,
// so the port is part of the SOCKET PATH, and the two sides must agree on it. A
// request without one is refused by the port's OWN check — which is the point of
// adding it there rather than only in the parser, since a caller learns about it
// from its own call instead of from a spawn that returns
// `database_phase_script_failed`.
const dbInput = (root, phase, extra = {}) => ({
  phase, root, pgDataId: "data-A", runtime: "runtime/pg-current", socketDir: "pg/socket", port: 5432,
  accounts: dbAccounts, logins: dbLogins, passwords: dbPasswords, ...extra,
});
const verifyPath = async path => path;

test("the database phase spawns the pinned script, and the passwords never reach argv", async () => {
  // The whole reason passwords are a separate argument: `ps` is world-readable
  // on macOS, so a password in argv is a password in a file any process can
  // read. This asserts the ABSENCE, not the presence: every argv element and
  // every character of the request is scanned for a password value.
  for (const [phase, stdout, script] of [["init", initStdout, "init-database.mjs"],
    ["release", releaseStdout, "apply-release-schema.mjs"]]) {
    const calls = [], checked = [];
    const result = await initializeDatabaseV1(dbInput(dbRoot, phase),
      async () => ({ stdout: "", stderr: "" }),
      async (path, options) => { checked.push({ path, options }); return path; },
      async (file, args, stdin, options) => {
        calls.push({ file, args, options, stdin }); return { stdout, stderr: "" };
      });
    assert.equal(result.outcome, phase === "init" ? "initialized" : "applied");
    // The pinned Node and the pinned script, both inside the install root.
    assert.deepEqual(checked, [
      { path: `${dbRoot}/runtime/node-current/bin/node`, options: { allowedRoots: [dbRoot], executable: true } },
      { path: `${dbRoot}/updater/current/bin/${script}`, options: { allowedRoots: [dbRoot] } },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, `${dbRoot}/runtime/node-current/bin/node`);
    assert.equal(calls[0].args[0], `${dbRoot}/updater/current/bin/${script}`);
    // Exactly two argv elements after the script: `--request` and one value.
    assert.equal(calls[0].args.length, 3);
    assert.equal(calls[0].args[1], "--request");
    // The NO-PASSWORD claim, checked three ways because two of them are cheap.
    const argvText = JSON.stringify(calls[0].args);
    for (const value of Object.values(dbPasswords)) {
      assert.equal(argvText.includes(value), false, "a password reached argv");
      assert.equal(JSON.stringify(calls[0].options ?? {}).includes(value), false, "a password reached options");
    }
    assert.equal("passwords" in JSON.parse(calls[0].args[2]), false,
      "the request must not carry the passwords");
    assert.equal("phase" in JSON.parse(calls[0].args[2]), false,
      "the phase selector is the port's business, not the request's");
    // …but the login LIST is in the request, because the script needs the names
    // to know which logins to create, and a name is not a secret.
    const request = JSON.parse(calls[0].args[2]);
    assert.deepEqual(request.logins, dbLogins);
    assert.equal(request.schema, phase === "init"
      ? "control-room.database-init/v1" : "control-room.release-schema/v1");
    assert.equal(request.runtime, "runtime/pg-current");
    assert.equal(request.socketDir, "pg/socket");
    // Where they went: the port's own third argument to the transport, which is
    // the child's stdin. The negative assertions above are the load-bearing
    // part; this is the positive statement of where they went.
    assert.deepEqual(calls[0].stdin, dbPasswords);
    assert.equal(calls[0].options.timeout, 4 * 60 * 60 * 1000);
  }
});

test("the database phase refuses a bad request, a bad proof and an unproved success", async () => {
  // The transport is the FOURTH argument; `execute` is unused by this port and is
  // passed only so the refusal cases do not have to know that.
  const execute = async () => ({ stdout: initStdout });
  const spawn = stdout => async () => ({ stdout, stderr: "" });
  for (const change of [
    { root: "relative" }, { root: "/" }, { pgDataId: "../escape" },
    { runtime: "runtime/pg-system" }, { socketDir: "/tmp" }, { logins: null }, { passwords: null },
    { passwords: [] }, { passwords: { control_room_web: "only-one-of-two" } },
    { logins: [{ name: "control_room_web" }] }, { logins: [{ name: "not a name" }] },
    { accounts: { ...dbAccounts, database: { ...dbAccounts.database, name: "root" } } },
    { accounts: { ...dbAccounts, database: { ...dbAccounts.database, uid: 0 } } },
    { accounts: { ...dbAccounts, builder: { name: "_builder", uid: 300, gid: 300 } } },
    { accounts: { ...dbAccounts, database: dbAccounts.service } },
    { accounts: { ...dbAccounts, database: { ...dbAccounts.database, uid: dbAccounts.service.uid } } },
    { logins: [{ name: "control_room_web", passwordStdin: false }] },
    { logins: [{ name: "control_room_web", passwordStdin: true }, { name: "control_room_web", passwordStdin: true }] },
    { expectedLedgerHead: "../../etc/passwd" },
  ]) await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "init", change), execute, verifyPath, spawn(initStdout)),
    /database_phase_(input|request)_refused/u, `accepted ${JSON.stringify(change)}`);
  // The message is matched EXACTLY rather than by regex, because a regex over a
  // thrown message is a regex somebody has to keep correct; `error.message ===`
  // fails the moment the code says anything different, which is the point.
  // An unknown phase is its OWN refusal, and separately, because the phase
  // selector is what chooses the script and a typo there would otherwise be
  // reported as a malformed request — which points a reader at the wrong place.
  await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "nonsense"), execute, verifyPath, spawn(initStdout)),
    (error) => error.message === "database_phase_refused");

  // A MISSING OR ABSURD PORT is refused by the port's OWN pre-spawn check, and the
  // range is the TCP range because that is what PostgreSQL accepts and what
  // `planPgClusterLayoutV1` builds the socket path from. Without the check here a
  // caller would learn about a missing port from a spawn that returned
  // `database_phase_script_failed` three steps later, naming neither the port nor
  // the request.
  for (const port of [null, 0, -1, 70000, 1.5, "5432"]) {
    await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "init", { port }), execute, verifyPath,
      spawn(initStdout)), (error) => error.message === "database_phase_input_refused",
    `a request carrying port ${JSON.stringify(port)} was not refused`);
  }
  // An ABSENT port is the installer's shape (M1b review, probe H1) and is not a
  // malformed request: the port takes the release's own value from
  // `<root>/current/deploy/postgres/role-manifest.json`. With no staged release to
  // read it from, that is its own refusal, before any spawn.
  const { port: _absent, ...withoutPort } = dbInput(dbRoot, "init");
  await assert.rejects(initializeDatabaseV1(withoutPort, execute, verifyPath, spawn(initStdout)),
    (error) => error.message === "database_phase_port_unavailable");

  // …and the PORT travels on the wire, because the socket path is
  // `.s.PGSQL.<port>` inside `pg/socket` and both phases derive it from there.
  // MEASURED: with the port only in the release's role-manifest data, a spawned
  // release phase read 5432 while the init phase used the lane's port and answered
  // `connection to server on socket "…/.s.PGSQL.5432" failed: No such file or
  // directory` — a connection error naming the wrong port rather than the
  // disagreement that caused it.
  //
  // The wire value is read from the INJECTED TRANSPORT's argv rather than from
  // `execute`, because `execute` is the port's SECOND parameter (used for the
  // `moveLiveDatabase` shape) and the request never reaches it once the transport is
  // supplied. MEASURED: the first version read `execute`'s `args[2]` and got
  // `undefined`.
  const sent = [];
  await initializeDatabaseV1(dbInput(dbRoot, "init", { port: 59910 }),
    async () => ({ stdout: initStdout, stderr: "" }), verifyPath,
    async (file, args) => {
      sent.push(JSON.parse(args[2]));
      return { stdout: initStdout, stderr: "" };
    });
  assert.equal(sent[0].port, 59910, "the request the port sends must carry the port the socket path needs");

  // An INIT request carrying a RELEASE-only key is refused by name, rather than
  // having the key dropped. MEASURED: it used to succeed silently, because the
  // request body is built from named keys and `release` is only named for the
  // release phase — so a caller that reached for the wrong phase learned nothing.
  for (const key of [{ release: "current" }, { expectedLedgerHead: "0119_x.sql" }]) {
    await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "init", key), execute, verifyPath,
      spawn(initStdout)), (error) => error.message === "database_phase_cross_phase_key_refused",
      `an init request carrying ${JSON.stringify(key)} was not refused`);
  }
  // …and the RELEASE phase accepts both of them, which is what makes the check
  // above a phase check and not a key-name ban.
  assert.equal((await initializeDatabaseV1(dbInput(dbRoot, "release",
    { release: "current", expectedLedgerHead: "0119_x.sql" }), execute, verifyPath,
  spawn(releaseStdout))).outcome, "applied");

  // Results: empty, unproved, extra-key, wrong-schema, and a value that is not
  // a digest are ALL refusals. The proofs are the point — a result that says
  // `initialized` without `clusterShutDownClean: true` is a claim that the
  // cluster stopped cleanly, and it did not.
  for (const stdout of ["", "{}", "not json", "\0", "x".repeat(16_385),
    JSON.stringify({ schema: "control-room.database-init-result/v1", outcome: "initialized",
      pgDataId: "data-A", updaterSchemaDigest: `sha256:${"a".repeat(64)}`, clusterShutDownClean: false }),
    JSON.stringify({ schema: "control-room.database-init-result/v1", outcome: "adopted",
      pgDataId: "data-A", updaterSchemaDigest: `sha256:${"a".repeat(64)}`, clusterShutDownClean: true }),
    JSON.stringify({ schema: "control-room.database-init-result/v1", outcome: "initialized",
      pgDataId: "data-A", updaterSchemaDigest: "not-a-digest", clusterShutDownClean: true }),
    JSON.stringify({ schema: "control-room.database-init-result/v1", outcome: "initialized",
      pgDataId: "data-A", updaterSchemaDigest: `sha256:${"a".repeat(64)}`, clusterShutDownClean: true,
      extra: true }),
  ]) await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "init"), execute, verifyPath, spawn(stdout)),
    /database_phase_result_refused/u);
});

test("the database phase serializes one root and survives a dropped call", async () => {
  assert.deepEqual([...DATABASE_PHASE_ORDER_V1], ["init", "release"]);
  // A second call for the SAME root while the first is in flight is refused, so
  // two installers cannot both `initdb` into one data directory.
  const spawn = stdout => async () => ({ stdout, stderr: "" });
  // Two deferreds, because the first call must be provably IN FLIGHT rather than
  // merely started: `entered` fires from inside the transport (so the port has
  // already registered the root), and `openGate` releases it.
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const first = initializeDatabaseV1(dbInput(dbRoot, "init"), async () => ({ stdout: "", stderr: "" }),
    verifyPath, async () => { entered(); await gate; return { stdout: initStdout }; });
  await reached;
  await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "init"), async () => ({ stdout: "", stderr: "" }),
    verifyPath, spawn(initStdout)), /database_phase_busy/u);
  // A DIFFERENT root is not blocked by the first: the guard is per-root, because
  // two install roots have two data directories and nothing to collide over.
  await initializeDatabaseV1(dbInput(`${dbRoot}-other`, "init"), async () => ({ stdout: "", stderr: "" }),
    verifyPath, spawn(initStdout));
  openGate();
  assert.equal((await first).outcome, "initialized");
  // …and the guard is RELEASED on failure, so a refused phase does not wedge the
  // install root forever. This is the retry-after-kill property, at the port.
  await assert.rejects(initializeDatabaseV1(dbInput(dbRoot, "init"), async () => ({ stdout: "", stderr: "" }),
    verifyPath, spawn("{}")), /database_phase_result_refused/u);
  assert.equal((await initializeDatabaseV1(dbInput(dbRoot, "init"), async () => ({ stdout: "", stderr: "" }),
    verifyPath, spawn(initStdout))).outcome, "initialized");

  // A 32-ROOT BURST, which is the load case that matters: the guard is per root,
  // so 32 concurrent phases on 32 roots must all succeed. A guard keyed on
  // anything global would refuse 31 of them here.
  //
  // MEASURED and kept from the move port's equivalent test: the first version of
  // this burst reused ONE root and would have been testing the busy guard rather
  // than the isolation, which the case above already covers.
  const burst = await Promise.all(Array.from({ length: 32 }, (_, index) => initializeDatabaseV1(
    dbInput(`${dbRoot}-burst-${index}`, "init"), async () => ({ stdout: "", stderr: "" }),
    verifyPath, spawn(initStdout))));
  assert.equal(burst.length, 32);
  assert.ok(burst.every(result => result.outcome === "initialized"),
    "32 concurrent phases on 32 roots must all succeed");

  // And a burst on ONE root: exactly one wins, the other 31 are refused with the
  // busy code. Asserting the COUNT and not just "some were refused" is what
  // catches a guard that releases early — which would let two installers into one
  // data directory and produce a cluster neither of them can use.
  let inFlight = 0, peak = 0, openRace, raceEntered;
  const held = new Promise(resolve => { openRace = resolve; });
  // A second deferred for "the winner is INSIDE the transport". MEASURED: the
  // first version used `setImmediate` to wait for it and the suite HUNG — the
  // eight calls are not scheduled in one turn, so the winner had not reached the
  // transport when the release fired, and the release was then awaited by nobody.
  // `entered` is resolved from inside the transport, so the ordering is exact.
  const firstInside = new Promise(resolve => { raceEntered = resolve; });
  // The transport is the FOURTH argument; passing it third meant `verifyPath`
  // ran as the transport and the real one never fired, so `raceEntered` was never
  // resolved and the suite hung. That is the same mistake as the earlier
  // `execute`/`spawnWithStdin` confusion, and the two together are why every
  // argument position in this file is written out rather than abbreviated.
  const racing = Array.from({ length: 8 }, () => initializeDatabaseV1(dbInput(`${dbRoot}-race`, "init"),
    async () => ({ stdout: "", stderr: "" }), verifyPath,
    async () => {
      if (++inFlight === 1) raceEntered();
      peak = Math.max(peak, inFlight); await held;
      return { stdout: initStdout, stderr: "" };
    }).catch(error => error.message));
  await firstInside;
  openRace();
  // The winner is a RESULT OBJECT and the losers are refusal MESSAGES, so the
  // two are counted differently. MEASURED: the first version compared every entry
  // to the string `"initialized"` and reported `0 !== 1` on a race that had
  // actually behaved exactly as designed — one winner, seven `database_phase_busy`.
  const outcomes = await Promise.all(racing);
  const winners = outcomes.filter(value => value?.outcome === "initialized");
  const refusals = outcomes.filter(value => value === "database_phase_busy");
  assert.equal(winners.length, 1,
    `exactly one of eight racing phases on one root may win, got ${JSON.stringify(outcomes)}`);
  assert.equal(refusals.length, 7,
    `the other seven must be refused as busy, got ${JSON.stringify(outcomes)}`);
  assert.equal(peak, 1, "two phases must never be in the transport at once for one root");
});

test("the Tailscale exchange parent must be a root-owned non-writable real directory", () => {
  const entry = (overrides = {}) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40700,
    ...overrides });
  assert.doesNotThrow(() => assertRootOwnedTailscaleParentV1(entry()));
  for (const hostile of [entry({ uid: 501 }), entry({ mode: 0o40720 }), entry({ isDirectory: () => false }),
    entry({ isSymbolicLink: () => true })]) {
    assert.throws(() => assertRootOwnedTailscaleParentV1(hostile), /tailscale_temp_directory_refused/u);
  }
});

test("the live Serve reader selects only :443 from the real two-entry shape", () => {
  assert.equal(readLiveServePortFromStatusV1({ Web: {}, TCP: {} }), null);
  const live = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: {
    "redacted.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7864" } } },
    "redacted.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3310" } } },
  }, AllowFunnel: { "redacted.example.ts.net:8443": true } };
  assert.equal(readLiveServePortFromStatusV1(live), 7864);
  assert.throws(() => readLiveServePortFromStatusV1({ Web: {
    "one.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } },
    "two.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3210" } } },
  } }), /live_serve_port_refused/u);
  assert.throws(() => readLiveServePortFromStatusV1({ ...live,
    AllowFunnel: { "redacted.example.ts.net:443": true } }), /live_serve_port_refused/u);
  assert.throws(() => readLiveServePortFromStatusV1({ Web: { ":443": { Handlers: {
    "/": { Proxy: "http://127.0.0.1:7864" }, "/two": { Proxy: "http://127.0.0.1:3210" },
  } } } }), /live_serve_port_refused/u);
  assert.throws(() => readLiveServePortFromStatusV1({ Web: { ":443": { Handlers: {
    "/": { Proxy: "http://127.0.0.1:99999" },
  } } } }), /live_serve_port_refused/u);
});

test("Serve capture and restore operate on :443 only", async () => {
  const identity = { uid: 501, gid: 20 }, calls = [], live = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: {
    "redacted.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7864" } } },
    "redacted.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3310" } } },
  } };
  const execute = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: JSON.stringify(live) }; };
  const snapshot = await captureTailscaleServe443V1(identity, execute);
  assert.deepEqual(snapshot, { schema: "control-room.tailscale-serve-443/v1", target: "http://127.0.0.1:7864" });
  await setTailscaleServe443V1(snapshot, identity, execute);
  assert.deepEqual(calls.map(call => call.args), [
    ["serve", "status", "--json"], ["serve", "--bg", "--https=443", "http://127.0.0.1:7864"],
  ]);
  assert.equal(live.Web["redacted.example.ts.net:8443"].Handlers["/"].Proxy, "http://127.0.0.1:3310");
  await assert.rejects(setTailscaleServe443V1({ ...snapshot, target: "http://127.0.0.1:99999" }, identity, execute),
    /tailscale_serve_443_snapshot_refused/u);
});

test("rehearsal evidence probes prove Seatbelt and each owner-uid denial", async () => {
  const root = "/Library/Application Support/Control Room Rehearsal", identity = { uid: 501, gid: 20 };
  const roles = ["postgresql17", "supervisor", "fleet-gateway", "nightly-backup", "updater", "updater-guard"];
  const servicePolicy = roles.map(role => ({ role, label: `xyz.agentcontrolroom.rehearsal.fixture.${role}`,
    plistPath: `/Library/LaunchDaemons/xyz.agentcontrolroom.rehearsal.fixture.${role}.plist` }));
  const denialCalls = [];
  const denialExecute = async (file, args, options) => {
    denialCalls.push({ file, args, options });
    if (file === "/bin/launchctl") return { stdout: "service = {\n  pid = 4321\n}\n" };
    throw Object.assign(new Error("denied"), { code: 1 });
  };
  for (const operation of ["read", "write", "signal"]) {
    assert.deepEqual(await assertRehearsalOwnerDeniedV1({ root, identity, operation, servicePolicy }, denialExecute),
      { uid: 501, operation, denied: true });
  }
  assert.equal(denialCalls.filter(call => call.options?.uid === 501 && call.options?.gid === 20).length, 3);
  assert.deepEqual(denialCalls.find(call => call.file === "/bin/kill")?.args, ["-0", "4321"]);
  await assert.rejects(assertRehearsalOwnerDeniedV1({ root, identity, operation: "read", servicePolicy },
    async () => { throw Object.assign(new Error("probe_failed"), { code: 2 }); }), /probe_failed/u);

  const seatbeltExecute = async (file, args) => {
    if (file === "/bin/launchctl") return { stdout: "loaded\n" };
    if (args[1] === "ProgramArguments.0") return { stdout: "/usr/bin/sandbox-exec\n" };
    if (args[1] === "ProgramArguments.2") return { stdout: `${root}/updater/current/policy/service-supervisor.sb\n` };
    throw new Error("unexpected_probe");
  };
  assert.deepEqual(await assertSeatbeltAppliedV1({ root, role: "supervisor", servicePolicy }, seatbeltExecute),
    { role: "supervisor", applied: true, skipped: false });
  await assert.rejects(assertSeatbeltAppliedV1({ root, role: "supervisor", servicePolicy }, async (file, args) => {
    const result = await seatbeltExecute(file, args);
    return args[1] === "ProgramArguments.2" ? { stdout: `${root}/wrong.sb\n` } : result;
  }), /rehearsal_seatbelt_refused/u);
});

// cl-pkwire: the install-night Face ID port the installer calls with ONE argument.
// Before this, the native object's `registerInitialPasskey` was M3's port with no
// session and no authority, so every call refused `passkey_authority_port_unbound`.
// The real-PostgreSQL half is `install-first-owner-real-postgres.test.mjs`; these
// are the refusals that happen before any connection.
test("the native registerInitialPasskey builds its own session and refuses before connecting", async t => {
  const { default: nativePorts, registerInitialPasskeyProductionV1 } =
    await import("../src/updater/v1/cli/control-room-native-ports.mjs");
  assert.equal(nativePorts.registerInitialPasskey, registerInitialPasskeyProductionV1);
  const base = await mkdtemp(join(tmpdir(), "native-passkey-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  const terminal = { isTTY: true, write() {}, setRawMode() {}, readLine: async () => { throw new Error("asked"); } };
  const installerInput = { root, config: { rpId: "control.example.ts.net" }, ownerCode: "o".repeat(43), terminal,
    qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5 };
  const code = expected => error => error?.code === expected;
  // A runtime is the real-PostgreSQL lane's port number and nothing else.
  await assert.rejects(nativePorts.registerInitialPasskey(installerInput, { authority: {} }),
    code("passkey_registration_input_refused"));
  await assert.rejects(nativePorts.registerInitialPasskey(installerInput, { databasePort: 0 }),
    code("passkey_registration_input_refused"));
  await assert.rejects(nativePorts.registerInitialPasskey({ ...installerInput, root: "relative" }),
    code("passkey_registration_input_refused"));
  // No `updater.json`: the updater's own loader refuses, so there is no socket to try.
  await assert.rejects(nativePorts.registerInitialPasskey(installerInput), code("updater_configuration_refused"));
  const { UPDATER_CONFIGURATION_SCHEMA_V1 } = await import("../src/updater/v1/services/protected-config.mjs");
  await writeFile(join(root, "updater-state", "updater.json"), `${JSON.stringify({ schema: UPDATER_CONFIGURATION_SCHEMA_V1,
    database: { host: join(root, "pg", "socket"), port: 5432, name: "control_room", user: "control_room_deployer" } })}\n`,
  { mode: 0o600 });
  // No `host.json`: the port needs its installationId, and it has nothing to guess from.
  await assert.rejects(nativePorts.registerInitialPasskey(installerInput), code("updater_passkey_config_refused"));
  await mkdir(join(root, "Protected", "config"), { recursive: true });
  await writeFile(join(root, "Protected", "config", "host.json"), `${JSON.stringify({ installationId: "install-1",
    rpId: "other.example.ts.net", expectedOrigin: "https://other.example.ts.net" })}\n`);
  // A host.json for another RP ID than the QR is printed for.
  await assert.rejects(nativePorts.registerInitialPasskey(installerInput), code("updater_passkey_config_refused"));
  await writeFile(join(root, "Protected", "config", "host.json"), `${JSON.stringify({ installationId: "install-1",
    rpId: "control.example.ts.net", expectedOrigin: "https://control.example.ts.net" })}\n`);
  // Everything in place but the server: the connection's refusal is named.
  await assert.rejects(nativePorts.registerInitialPasskey(installerInput),
    error => /^passkey_deployer_session_refused:/u.test(error?.code ?? ""));
});
