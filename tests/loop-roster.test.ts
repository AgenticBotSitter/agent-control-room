import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runLoopModelsCheckV1, type LoopRosterToolsV1 } from "../src/web/v1/loop-roster-check";
import { createLoopRosterHttpHandlerV1, isLoopRosterRouteV1 } from "../src/web/v1/loop-roster-http";
import { parseLoopRosterV1, renderLoopRosterV1, type LoopRosterRowV1 } from "../src/web/v1/loop-roster-render";
import { LoopRosterRefusedV1, LoopRosterServiceV1, loopRosterCustodyMessageV1,
  loopRosterMissingDirectoryMessageV1 } from "../src/web/v1/loop-roster-service";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const header = "name\tlauncher\tprovider\tfamily\tclass\troles\tefforts\tdefault_effort\tcost\ton\tnote\tnick\tmax_build_grade";
const synthetic = `${header}\nalpha-1\tcodex\tcodex\topenai\tfrontier\tbuild,final\tlow,medium\tmedium\tsub\ton\tfirst\tAl\tHard\n`
  + "nvidia/beta-2\topencode\tnvidia\tbeta\tstandard\tcode-review\thigh\thigh\tfree\toff\t\tBe\tnone\n";
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
let keySequence = 0;
const key = () => `b6-roster-key-${String(++keySequence).padStart(8, "0")}`;

/** Optional adjacent tools checkout (the B1b convention): CONTROL_ROOM_A2_TEST_LOOP=<tools>/loop. */
const toolsLoop = process.env.CONTROL_ROOM_A2_TEST_LOOP ? resolve(process.env.CONTROL_ROOM_A2_TEST_LOOP) : undefined;
const realTest = (name: string, body: (t: TestContext) => Promise<void>) => toolsLoop ? test(name, body) : test.skip(name, body);

/** An install root shaped like the installer's: config/, tools/loop, tools/bin/lib (cr.py needs python.sh and the
 * route table beside it), work/, runs/ and roster/. Stand-in tools never run cr and are used only where named. */
async function installRoot(t: TestContext, options: { roster?: boolean; real?: boolean;
  standIn?: (file: string) => { exitCode: number; lines: string[] } } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "b6-roster-")));
  t.after(async () => { await chmod(join(root, "roster"), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  for (const directory of ["config", "work", "runs", "tools/loop/bridge"]) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  if (options.roster !== false) await mkdir(join(root, "roster"), { mode: 0o700 });
  await writeFile(join(root, "config/manifest.sha256"), "0".repeat(64) + "  tools/loop/cr.py\n", { mode: 0o600 });
  await writeFile(join(root, "config/settings.json"), "{}\n", { mode: 0o600 });
  let check: LoopRosterToolsV1["check"];
  if (options.real) {
    const tools = dirname(toolsLoop!);
    await cp(toolsLoop!, join(root, "tools/loop"), { recursive: true, filter: source => !source.includes("__pycache__") });
    await cp(join(tools, "bin/lib"), join(root, "tools/bin/lib"), { recursive: true, filter: source => !source.includes("__pycache__") });
    await chmod(join(root, "tools/bin/lib/review_routes.tsv"), 0o644);
    const python = /CR_PYTHON=(\S+)/.exec(await readFile(join(tools, "bin/lib/python.sh"), "utf8"))![1]!.replace(/^["']|["']$/g, "");
    check = file => runLoopModelsCheckV1({ interpreter: python, crScript: join(root, "tools/loop/cr.py"), cwd: root, file });
  } else {
    await writeFile(join(root, "tools/loop/models.tsv"), synthetic);
    check = async file => (options.standIn ?? (() => ({ exitCode: 0, lines: [] })))(file);
  }
  const tools: LoopRosterToolsV1 = { rosterRoot: join(root, "roster"), toolsSeed: join(root, "tools/loop/models.tsv"), check };
  return { root, tools, exportPath: join(root, "roster/roster-export.tsv") };
}

async function rosterFixture(t: TestContext, options: Parameters<typeof installRoot>[1] = {}) {
  const f = await taskFixture(); t.after(() => void f.db.close());
  const install = await installRoot(t, options);
  const service = new LoopRosterServiceV1(f.client, scope, install.tools, () => now);
  const handler = createLoopRosterHttpHandlerV1({ origin, trust, service, clock: () => now });
  const path = (name: string, on = false) => `/api/v1/loop-roster/models/${encodeURIComponent(name)}${on ? "/on" : ""}`;
  const get = async () => (await handler(request("/api/v1/loop-roster"))).json() as Promise<{ version: number | null; seeded: boolean;
    exported: boolean; canEdit: boolean; message?: string; models: (LoopRosterRowV1 & { updatedBy: string })[] }>;
  const put = (name: string, row: Omit<LoopRosterRowV1, "name">, expectedVersion: number, k = key()) =>
    handler(request(path(name), "PUT", { expectedVersion, row }, k));
  const setOn = (name: string, on: boolean, expectedVersion: number, k = key()) =>
    handler(request(path(name, true), "POST", { expectedVersion, on }, k));
  const count = async () => (await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_loop_roster_models")).rows[0]!.n;
  return { ...f, ...install, service, handler, get, put, setOn, count };
}
const fields = (row: LoopRosterRowV1): Omit<LoopRosterRowV1, "name"> => ({ launcher: row.launcher, provider: row.provider,
  family: row.family, class: row.class, roles: row.roles, efforts: row.efforts, default_effort: row.default_effort, cost: row.cost,
  on: row.on, note: row.note, nick: row.nick, max_build_grade: row.max_build_grade });

async function snapshot(root: string, skip: string) {
  const out: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (relative(root, path) === skip) continue;
      if (entry.isDirectory()) await walk(path); else out[relative(root, path)] = sha(await readFile(path));
    }
  };
  await walk(root);
  return out;
}

test("B6 renderer reproduces a canonical roster and reads files the way cr does", () => {
  const rows = parseLoopRosterV1(synthetic);
  assert.equal(rows.length, 2); assert.equal(rows[1]!.name, "nvidia/beta-2"); assert.equal(rows[1]!.note, "");
  assert.equal(renderLoopRosterV1(rows), synthetic, "byte identity for a canonical file");
  const decorated = synthetic.replace("\nalpha-1", "\n# comment\n   \nalpha-1").replace(/\n/g, "\r\n");
  assert.deepEqual(parseLoopRosterV1(decorated), rows, "comments, blank lines and CRLF are skipped like cr's splitlines");
  assert.throws(() => parseLoopRosterV1(synthetic.replace("\tmax_build_grade", "")), /loop_roster_format/u, "legacy 12-column header");
  assert.throws(() => parseLoopRosterV1(`${header}\na\tb\n`), /loop_roster_format/u);
  for (const brk of ["\t", "\n", "\r", " ", "\x85"])
    assert.throws(() => renderLoopRosterV1([{ ...rows[0]!, note: `x${brk}y` }]), /loop_roster_format/u);
  // A row cr would skip as a comment or a blank line is never rendered: cr would not check it.
  const blankRow = Object.fromEntries(Object.keys(rows[0]!).map(column => [column, ""])) as LoopRosterRowV1;
  for (const row of [{ ...rows[0]!, name: "#evil-model" }, { ...rows[0]!, name: " #evil-model" }, { ...blankRow, name: " " }])
    assert.throws(() => renderLoopRosterV1([row]), (error: { reason?: string }) => error.reason === "skipped_row", JSON.stringify(row.name));
  assert.ok(isLoopRosterRouteV1("/api/v1/loop-roster/models/nvidia%2Fbeta-2/on"));
  assert.ok(!isLoopRosterRouteV1("/api/v1/loop-roster/models/nvidia/beta-2"));
});

test("B6 product source holds no copy of the roster rules", async () => {
  for (const file of ["loop-roster-render.ts", "loop-roster-service.ts", "loop-roster-http.ts", "loop-roster-check.ts"]) {
    const source = await readFile(join("src/web/v1", file), "utf8");
    for (const rule of ["plan-review", "attack-review", "\"frontier\"", "\"opencode\"", "\"claude\"", "\"Easy\"", "\"heavy\""])
      assert.ok(!source.includes(rule), `${file} must not carry cr's rule token ${rule}`);
  }
});

test("B6 0309 has a working rollback that refuses retained roster rows", async t => {
  const f = await rosterFixture(t);
  await writeFile(f.exportPath, synthetic, { mode: 0o600 });
  assert.equal((await f.service.start()).seeded, true);
  await assert.rejects(f.db.exec(await readFile("db/down/0309_control_loop_roster.sql", "utf8")), /loop roster retained/u);
  await f.db.exec("ROLLBACK").catch(() => {});
  await f.db.query("DELETE FROM control_loop_roster_models"); await f.db.query("DELETE FROM control_loop_roster_state");
  await f.db.exec(await readFile("db/down/0309_control_loop_roster.sql", "utf8"));
  assert.equal((await f.db.query("SELECT 1 FROM pg_class WHERE relname LIKE 'control_loop_roster%'")).rows.length, 0);
});

test("B6 HTTP shape: slashed names, stale versions, replay, owner-only edits (stand-in check)", async t => {
  const f = await rosterFixture(t);
  assert.equal((await f.get()).seeded, false);
  await writeFile(f.exportPath, synthetic, { mode: 0o600 });
  const started = await f.service.start();
  assert.deepEqual(started, { seeded: true, exported: true, version: 1 });
  const view = await f.get();
  assert.equal(view.version, 1); assert.equal(view.exported, true); assert.equal(view.canEdit, true);
  const beta = view.models.find(model => model.name === "nvidia/beta-2")!;
  const k = key();
  const edited = await f.put("nvidia/beta-2", { ...fields(beta), note: "edited" }, 1, k);
  assert.equal(edited.status, 201); assert.deepEqual(await edited.json(), { replayed: false, version: 2, exported: true });
  assert.equal((await f.get()).models.find(model => model.name === "nvidia/beta-2")!.note, "edited", "percent-encoded slash reached the row");
  assert.match(await readFile(f.exportPath, "utf8"), /\tedited\t/u);
  const replay = await f.put("nvidia/beta-2", { ...fields(beta), note: "edited" }, 1, k);
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { replayed: true, version: 2, exported: true });
  assert.equal((await f.put("nvidia/beta-2", { ...fields(beta), note: "other" }, 1, k)).status, 409, "same key, other request");
  assert.equal((await f.put("nvidia/beta-2", { ...fields(beta), note: "stale" }, 1)).status, 409, "stale expectedVersion");
  assert.equal((await f.setOn("missing-model", true, 2)).status, 404);
  assert.equal((await f.setOn("nvidia/beta-2", true, 2)).status, 201);
  assert.equal((await f.put("x", fields(beta), 3, "short")).status, 400, "idempotency key is required");
  const comment = await f.put("#evil-model", fields(beta), 3);
  assert.equal(comment.status, 422); assert.equal((await comment.json() as { reason: string }).reason, "format", "a # name is refused");
  for (const name of ["#evil-model", " #evil-model", " "])
    await assert.rejects(f.db.query(`INSERT INTO control_loop_roster_models SELECT tenant_id,$1,9999,launcher,provider,family,model_class,
      roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at FROM control_loop_roster_models LIMIT 1`, [name]),
    /check constraint/u, `the database refuses ${JSON.stringify(name)}`);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await f.get()).canEdit, false);
  assert.equal((await f.setOn("nvidia/beta-2", false, 3)).status, 403, "non-owner edit refused");
  assert.equal((await f.get()).version, 3);
});

test("B6 custody refusal, unwritable roster directory and missing directory (stand-in check)", async t => {
  let custody = false;
  const f = await rosterFixture(t, { standIn: () => custody
    ? { exitCode: 8, lines: ["cr: invalid route table: route file custody refused"] } : { exitCode: 0, lines: [] } });
  await writeFile(f.exportPath, synthetic, { mode: 0o600 });
  await f.service.start();
  const alpha = (await f.get()).models[0]!;
  custody = true;
  const refused = await f.setOn(alpha.name, false, 1);
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: "roster_refused", reason: "custody", message: loopRosterCustodyMessageV1, problems: [] });
  assert.equal((await f.get()).version, 1, "nothing committed; GET still works");
  custody = false;
  // An unwritable roster directory: the private check copy cannot be made, so the edit is refused cleanly.
  await chmod(join(f.root, "roster"), 0o500);
  const unwritable = await f.setOn(alpha.name, false, 1);
  assert.equal(unwritable.status, 422); assert.equal((await unwritable.json() as { reason: string }).reason, "unavailable");
  await chmod(join(f.root, "roster"), 0o700);
  // An export failure after a good commit (the rename target is blocked) keeps the edit: exported false, retried later.
  await rm(f.exportPath); await mkdir(join(f.exportPath, "blocked"), { recursive: true });
  const pending = await f.setOn(alpha.name, false, 1);
  assert.equal(pending.status, 201);
  assert.deepEqual(await pending.json(), { replayed: false, version: 2, exported: false, message: "export pending (version 2, last export 1)" });
  assert.match((await f.get()).message!, /export pending \(version 2, last export 1\)/u);
  await rm(f.exportPath, { recursive: true });
  assert.deepEqual(await f.service.start(), { seeded: true, exported: true, version: 2 }, "the next start retries");
  assert.match(await readFile(f.exportPath, "utf8"), /\nalpha-1\t[^\n]*\toff\t/u, "the retried export carries the edit");
  const missing = await installRoot(t, { roster: false });
  const service = new LoopRosterServiceV1(f.client, { ...scope }, missing.tools, () => now);
  assert.equal((await service.start()).message, loopRosterMissingDirectoryMessageV1);
});

test("B6 first start never replaces a non-regular export path with the tools seed (stand-in check)", async t => {
  const f = await rosterFixture(t);
  const target = join(f.root, "elsewhere.tsv"); await writeFile(target, synthetic);
  const { symlink } = await import("node:fs/promises"); await symlink(target, f.exportPath);
  assert.deepEqual(await f.service.start(), { seeded: false, exported: false, version: null,
    message: "roster not seeded: the export path is not a regular file" });
  assert.equal((await lstat(f.exportPath)).isSymbolicLink(), true, "the link is untouched");
  assert.equal((await f.db.query("SELECT 1 FROM control_loop_roster_state")).rows.length, 0);
});

realTest("B6 seed from the tools roster is byte-identical and passes the real cr check", async t => {
  const f = await rosterFixture(t, { real: true });
  const seed = await readFile(join(f.root, "tools/loop/models.tsv"), "utf8");
  assert.equal(seed.split("\n").length - 1, 14, "today's roster: header plus 13 models");
  const started = await f.service.start();
  assert.deepEqual(started, { seeded: true, exported: true, version: 1 });
  assert.equal(await readFile(f.exportPath, "utf8"), seed, "export bytes equal the seed");
  const state = (await f.db.query<{ seeded_from: string; exported_version: string }>("SELECT * FROM control_loop_roster_state")).rows[0]!;
  assert.equal(state.seeded_from, `tools-seed:${sha(seed)}`); assert.equal(Number(state.exported_version), 1);
  assert.equal((await f.tools.check(f.exportPath)).exitCode, 0, "real cr models check accepts the export");
  assert.equal((await stat(f.exportPath)).mode & 0o777, 0o600);
  await assert.rejects(f.service.seedFromTsv(seed, "export-file"), /conflict/u, "a second seed is refused");
});

realTest("B6 first start never overwrites or seeds from a bad file", async t => {
  const seedText = async (f: { root: string }) => readFile(join(f.root, "tools/loop/models.tsv"), "utf8");
  // (a) existing valid export, fresh database: file byte-unchanged, seeded from it.
  { const f = await rosterFixture(t, { real: true }); const text = (await seedText(f)).replace("\n", "\n# kept comment\n");
    await writeFile(f.exportPath, text, { mode: 0o600 });
    const started = await f.service.start();
    assert.equal(started.seeded, true);
    const state = (await f.db.query<{ seeded_from: string; exported_sha256: string | null }>("SELECT * FROM control_loop_roster_state")).rows[0]!;
    assert.equal(state.seeded_from, `export-file:${sha(text)}`);
    assert.equal(await readFile(f.exportPath, "utf8"), await seedText(f), "a valid non-canonical file is rewritten canonically once"); }
  { const f = await rosterFixture(t, { real: true }); const text = await seedText(f); await writeFile(f.exportPath, text, { mode: 0o600 });
    const before = sha(await readFile(f.exportPath));
    assert.deepEqual(await f.service.start(), { seeded: true, exported: true, version: 1 });
    assert.equal(sha(await readFile(f.exportPath)), before, "canonical export file is not rewritten"); }
  // (c) nothing: no file written.
  { const f = await rosterFixture(t, { real: true }); await rm(join(f.root, "tools/loop/models.tsv"));
    assert.deepEqual(await f.service.start(), { seeded: false, exported: false, version: null, message: "roster not seeded" });
    await assert.rejects(stat(f.exportPath), /ENOENT/u);
    assert.equal((await f.setOn("gpt-6.1-sol", false, 1)).status, 409, "edits refused while unseeded"); }
  // (d) corrupt export, (e) header-only export: untouched, not seeded, cr's message shown.
  for (const [label, bad] of [["bad row", (s: string) => s.replace("\tcodex\t", "\tno-such-launcher\t")],
    ["header only", (s: string) => `${s.split("\n")[0]}\n`]] as const) {
    const f = await rosterFixture(t, { real: true }); const text = bad(await seedText(f));
    await writeFile(f.exportPath, text, { mode: 0o600 });
    const started = await f.service.start();
    assert.equal(started.seeded, false, label);
    assert.match(started.message!, label === "bad row" ? /launcher 'no-such-launcher' unknown/u : /roster empty/u);
    assert.equal(await readFile(f.exportPath, "utf8"), text, `${label}: file untouched`);
    assert.equal((await f.db.query("SELECT 1 FROM control_loop_roster_state")).rows.length, 0); }
  // (f) state row present but zero master rows: file untouched, exported false.
  { const f = await rosterFixture(t, { real: true }); await f.service.start();
    const before = await readFile(f.exportPath, "utf8");
    await f.db.query("DELETE FROM control_loop_roster_models");
    assert.deepEqual(await f.service.start(), { seeded: true, exported: false, version: 1, message: "roster empty, export refused" });
    assert.equal(await readFile(f.exportPath, "utf8"), before); }
});

realTest("B6 rules come from cr: bad rows are refused with cr's own problem text", async t => {
  const f = await rosterFixture(t, { real: true }); await f.service.start();
  const models = (await f.get()).models;
  const sol = models.find(model => model.name === "gpt-6.1-sol")!, other = models.find(model => model.nick !== sol.nick)!;
  const cases: [string, string, Omit<LoopRosterRowV1, "name">, RegExp][] = [
    ["bad launcher", sol.name, { ...fields(sol), launcher: "nope" }, /launcher 'nope' unknown/u],
    ["unknown role", sol.name, { ...fields(sol), roles: "build,wizard" }, /role 'wizard' unknown/u],
    ["final on a standard model", sol.name, { ...fields(sol), class: "standard" }, /only a frontier model may do final/u],
    ["default effort not in efforts", sol.name, { ...fields(sol), default_effort: "high" }, /default_effort 'high' is not one of its efforts/u],
    ["duplicate nick by case", sol.name, { ...fields(sol), nick: other.nick.toUpperCase() }, /nick appears twice/u],
    ["build role with grade none", sol.name, { ...fields(sol), max_build_grade: "none" }, /a build role requires a max_build_grade/u],
    ["name with a space", "bad name", fields(sol), /is not a model id/u],
    ["bad on value", sol.name, { ...fields(sol), on: "maybe" }, /on 'maybe' must be on or off/u],
  ];
  for (const [label, name, row, problem] of cases) {
    const response = await f.put(name, row, 1);
    assert.equal(response.status, 422, label);
    const body = await response.json() as { reason: string; problems: string[] };
    assert.equal(body.reason, "rules", label); assert.ok(body.problems.some(line => problem.test(line)), `${label}: ${body.problems.join(" | ")}`);
    assert.ok(body.problems.every(line => !line.includes(f.root)), "no install paths in the refusal");
  }
  // Export structure, refused before cr: a tab splits a field, and a "#" name would make the row a comment cr skips.
  for (const [label, name, row] of [["tab in a field", sol.name, { ...fields(sol), note: "a\tb" }],
    ["name starting with #", "#evil-model", { ...fields(sol), launcher: "nope", family: "BADFAMILY", nick: "zz-unique" }]] as const) {
    const refused = await f.put(name, row, 1);
    assert.equal(refused.status, 422, label); assert.equal((await refused.json() as { reason: string }).reason, "format", label);
  }
  assert.equal((await f.get()).version, 1, "nothing committed");
  const long = await f.put(sol.name, { ...fields(sol), note: "n".repeat(201) }, 1);
  assert.equal(long.status, 201, "a 201-character note is accepted (no such rule in cr)");
  assert.equal((await f.tools.check(f.exportPath)).exitCode, 0);
});

realTest("B6 edits reach the export without restart; crashes are repaired at the next start", async t => {
  const f = await rosterFixture(t, { real: true }); await f.service.start();
  const before = await snapshot(f.root, "roster");
  assert.equal((await f.setOn("gpt-6.1-sol", false, 1)).status, 201);
  assert.match(await readFile(f.exportPath, "utf8"), /\ngpt-6\.1-sol\t[^\n]*\toff\t/u, "the next reader sees the edit");
  assert.deepEqual(await snapshot(f.root, "roster"), before, "only <R>/roster changed: manifest and tooling bytes are untouched");
  // (a) failure after the temporary write, before the rename.
  const crash = (point: "afterTemporaryWrite" | "afterRename") => new LoopRosterServiceV1(f.client, scope, f.tools, () => now,
    { [point]: () => { throw new Error(`crash:${point}`); } });
  const good = await readFile(f.exportPath, "utf8");
  await f.db.query("UPDATE control_loop_roster_models SET note='crash-a' WHERE name='gpt-6.1-sol'");
  await f.db.query("UPDATE control_loop_roster_state SET version=version+1");
  await assert.rejects(crash("afterTemporaryWrite").exportRoster(), /crash:afterTemporaryWrite/u);
  assert.equal(await readFile(f.exportPath, "utf8"), good, "old export intact");
  assert.equal((await f.tools.check(f.exportPath)).exitCode, 0, "old export still valid");
  assert.ok((await readdir(join(f.root, "roster"))).some(name => name.endsWith(".tmp")), "the crash left its temporary file");
  assert.deepEqual(await f.service.start(), { seeded: true, exported: true, version: 3 });
  assert.match(await readFile(f.exportPath, "utf8"), /\tcrash-a\t/u);
  assert.deepEqual(await readdir(join(f.root, "roster")), ["roster-export.tsv"], "no tmp or check-* remains");
  // (b) failure after the rename, before the state update.
  await f.db.query("UPDATE control_loop_roster_models SET note='crash-b' WHERE name='gpt-6.1-sol'");
  await f.db.query("UPDATE control_loop_roster_state SET version=version+1");
  await assert.rejects(crash("afterRename").exportRoster(), /crash:afterRename/u);
  const renamed = await readFile(f.exportPath);
  assert.match(renamed.toString(), /\tcrash-b\t/u);
  assert.equal(Number((await f.db.query<{ exported_version: string }>("SELECT exported_version FROM control_loop_roster_state")).rows[0]!.exported_version), 3);
  assert.deepEqual(await f.service.start(), { seeded: true, exported: true, version: 4 });
  assert.equal(sha(await readFile(f.exportPath)), sha(renamed), "state row repaired; file bytes unchanged");
  // A hand edit is overwritten at the next start.
  await writeFile(f.exportPath, `${renamed.toString()}# hand edit\n`);
  await f.service.start();
  assert.equal(sha(await readFile(f.exportPath)), sha(renamed));
});

realTest("B6 concurrent edits: exactly one commits, and it is the row cr was shown", async t => {
  const f = await rosterFixture(t, { real: true }); await f.service.start();
  const sol = (await f.get()).models.find(model => model.name === "gpt-6.1-sol")!;
  const [first, second] = await Promise.all([f.put(sol.name, { ...fields(sol), note: "from-tab-one" }, 1),
    f.put(sol.name, { ...fields(sol), note: "from-tab-two" }, 1)]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const winner = first.status === 201 ? "from-tab-one" : "from-tab-two";
  const view = await f.get();
  assert.equal(view.version, 2); assert.equal(view.models.find(model => model.name === sol.name)!.note, winner);
  assert.match(await readFile(f.exportPath, "utf8"), new RegExp(`\\t${winner}\\t`, "u"));
  assert.deepEqual(await readdir(join(f.root, "roster")), ["roster-export.tsv"], "no candidate directory remains");
  const [a, b] = await Promise.all([f.service.exportRoster(), f.service.exportRoster()]);
  assert.equal(a.exported && b.exported, true);
  assert.equal((await f.tools.check(f.exportPath)).exitCode, 0, "two concurrent exports leave one valid file");
});

test("B6 refusal type carries cr's lines", () => {
  const refusal = new LoopRosterRefusedV1("rules", ["line 2 (x): bad"], "refused");
  assert.equal(refusal.reason, "rules"); assert.deepEqual(refusal.problems, ["line 2 (x): bad"]);
});

test("B6 panel shows the roster, the on/off limit sentence and cr's problem lines; operators get no controls", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LoopRosterTable, loopRosterOnOffSentenceV1 } = await import("../private-app/app/loop-roster-panel");
  const models = parseLoopRosterV1(synthetic).map(row => ({ ...row, updatedBy: "identity:web", updatedAt: new Date(now).toISOString() }));
  const view = { seeded: true, version: 4, exportedVersion: 4, exported: true, canEdit: true, models };
  const html = renderToStaticMarkup(createElement(LoopRosterTable, { view, pending: false, onToggle: () => {}, onSave: () => {},
    refusal: { message: "the roster check refused this roster", problems: ["line 2 (alpha-1): launcher 'nope' unknown"] } }));
  assert.ok(html.includes(loopRosterOnOffSentenceV1.replace("/", "/")));
  assert.match(html, /Roster version 4, exported for the scripts/u);
  assert.match(html, /nvidia\/beta-2/u); assert.match(html, />Turn on</u); assert.match(html, />Turn off</u);
  assert.match(html, /role="alert"[^]*launcher &#x27;nope&#x27; unknown/u);
  const operator = renderToStaticMarkup(createElement(LoopRosterTable, { view: { ...view, canEdit: false, exported: false,
    message: "export pending (version 4, last export 3)" }, pending: false, onToggle: () => {}, onSave: () => {} }));
  assert.doesNotMatch(operator, /Turn (on|off)|Save model/u); assert.match(operator, /export pending \(version 4, last export 3\)/u);
  const unseeded = renderToStaticMarkup(createElement(LoopRosterTable, { view: { ...view, seeded: false, models: [],
    message: loopRosterMissingDirectoryMessageV1 }, pending: false, onToggle: () => {}, onSave: () => {} }));
  assert.match(unseeded, /roster directory missing/u);
});

realTest("B6 H1 regression: a roster edit and export through the real adapter never moves toolingRevision", async t => {
  const { createImproveControlRoomLoopAdapterV1 } = await import("../src/web/v1/improve-control-room-loop-adapter");
  const { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1 } = await import("../src/improve-control-room/v1/schemas");
  const { realpathSync } = await import("node:fs");
  const f = await taskFixture(); t.after(() => void f.db.close());
  const install = await installRoot(t, { real: true });
  const root = install.root, hash = async (path: string) => sha(await readFile(path));
  const settingsText = JSON.stringify({ project: { host_adapter: "local-loop" } });
  await writeFile(join(root, "config/settings.json"), settingsText, { mode: 0o600 });
  await writeFile(join(root, "config/availability.json"), "{}", { mode: 0o600 });
  const listed = ["tools/loop/cr.py", "tools/loop/models.tsv", "tools/loop/bridge/cr-entry.py", "tools/bin/lib/review_routes.tsv"];
  await writeFile(join(root, "config/manifest.sha256"),
    (await Promise.all(listed.map(async file => `${await hash(join(root, file))}  ${file}`))).join("\n") + "\n", { mode: 0o600 });
  const interpreter = realpathSync(/CR_PYTHON=(\S+)/.exec(await readFile(join(root, "tools/bin/lib/python.sh"), "utf8"))![1]!);
  const toolingRevision = `sha256:${await hash(join(root, "config/manifest.sha256"))}`;
  const adapter = createImproveControlRoomLoopAdapterV1({ adapterId: "adapter:b6-roster", interpreter,
    interpreterSha256: await hash(interpreter), entrypoint: join(root, "tools/loop/bridge/cr-entry.py"),
    entrypointSha256: await hash(join(root, "tools/loop/bridge/cr-entry.py")), toolingManifest: join(root, "config/manifest.sha256"),
    runRoot: join(root, "runs"), workRoot: join(root, "work"), configRoot: root, cwd: root,
    settingsFile: join(root, "config/settings.json"), availabilityFile: join(root, "config/availability.json"), toolingRevision,
    settingsSha256: sha(settingsText), availabilitySha256: sha("{}"),
    executionIdentity: { uid: process.getuid!(), isolationEvidenceDigest: `sha256:${"b".repeat(64)}` },
    contract: { lineage: { toolingRevision, decodeRunIdentity: input => loopImprovementRunIdentitySchemaV1.parse(input),
      decodeObservation: input => loopImprovementObservationSchemaV1.parse(input), matchesSavedInput: () => false },
    schemaDigest: `sha256:${"c".repeat(64)}`, generateRunId: () => "run:b6-roster", decodeStatus: () => { throw new Error("unused"); },
    qualifiedOperations: ["stop"] } });
  t.after(() => adapter.close());
  assert.equal(adapter.roster!.rosterRoot, join(root, "roster"));
  const service = new LoopRosterServiceV1(f.client, scope, adapter.roster!, () => now);
  const handler = createLoopRosterHttpHandlerV1({ origin, trust, service, clock: () => now });
  const before = await snapshot(root, "roster");
  assert.deepEqual(await service.start(), { seeded: true, exported: true, version: 1 });
  const edited = await handler(request(`/api/v1/loop-roster/models/${encodeURIComponent("gpt-6.1-sol")}/on`, "POST",
    { expectedVersion: 1, on: false }, key()));
  assert.equal(edited.status, 201); assert.deepEqual(await edited.json(), { replayed: false, version: 2, exported: true });
  assert.equal(`sha256:${await hash(join(root, "config/manifest.sha256"))}`, toolingRevision, "(i) the manifest is still the pin");
  for (const file of listed) assert.equal((await readFile(join(root, "config/manifest.sha256"), "utf8")).includes(`${await hash(join(root, file))}  ${file}`), true);
  assert.equal(adapter.available("stop"), true, "(ii) the adapter still validates its pins and accepts an operation");
  assert.equal((await adapter.roster!.check(install.exportPath)).exitCode, 0);
  assert.deepEqual(await snapshot(root, "roster"), before, "(iii) only <R>/roster changed");
  await assert.rejects(adapter.roster!.check(join(root, "config/settings.json")), /loop_adapter_unavailable/u,
    "the adapter checks only files under the roster directory");
});

test("B6 restore: an older database re-renders the surviving export to the older version (stand-in check)", async t => {
  const f = await rosterFixture(t);
  await writeFile(f.exportPath, synthetic, { mode: 0o600 });
  await f.service.start();
  const backup = { models: (await f.db.query("SELECT * FROM control_loop_roster_models ORDER BY position")).rows,
    state: (await f.db.query("SELECT * FROM control_loop_roster_state")).rows };
  assert.equal((await f.setOn("alpha-1", false, 1)).status, 201);
  assert.notEqual(await readFile(f.exportPath, "utf8"), synthetic);
  // Restore the older database; the roster directory survives the app/database restore.
  await f.db.query("DELETE FROM control_loop_roster_models"); await f.db.query("DELETE FROM control_loop_roster_state");
  for (const table of ["control_loop_roster_state", "control_loop_roster_models"] as const)
    for (const row of table === "control_loop_roster_state" ? backup.state : backup.models)
      await f.db.query(`INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json)`, [JSON.stringify(row)]);
  const restarted = new LoopRosterServiceV1(f.client, scope, f.tools, () => now);
  assert.deepEqual(await restarted.start(), { seeded: true, exported: true, version: 1 });
  assert.equal(await readFile(f.exportPath, "utf8"), synthetic, "the export follows the restored master");
});

test("B6 a slow export from another process never leaves an older file behind (stand-in check)", async t => {
  const f = await rosterFixture(t);
  await writeFile(f.exportPath, synthetic, { mode: 0o600 });
  await f.service.start();
  // Process A renders version 1; before its rename, an edit commits in process B and B exports version 2.
  let once = false;
  const slow = new LoopRosterServiceV1(f.client, scope, f.tools, () => now, { afterTemporaryWrite: async () => {
    if (once) return; once = true;
    await f.db.query("UPDATE control_loop_roster_models SET note='newer' WHERE name='alpha-1'");
    await f.db.query("UPDATE control_loop_roster_state SET version=version+1");
    assert.deepEqual(await f.service.exportRoster(), { exported: true, version: 2 });
  } });
  assert.deepEqual(await slow.exportRoster(), { exported: true, version: 2 }, "A's stale rename is followed by a current export");
  assert.match(await readFile(f.exportPath, "utf8"), /\tnewer\t/u, "the file on disk is the newer master");
  assert.deepEqual(await f.service.reconcile(), { exported: true, version: 2 });
  assert.deepEqual(await readdir(join(f.root, "roster")), ["roster-export.tsv"]);
});
