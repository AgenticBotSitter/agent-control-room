// N1: the production first-owner port's boundary, without a database.
//
// The real-PostgreSQL proof is `install-first-owner-script-real-postgres.test.mjs`.
// This file pins what does not need a server: the input contract the installer
// sends, the once-written retry state, and the one-line result contract.
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureFirstOwnerStateV1, firstOwnerViaScriptV1, parseFirstOwnerOwnerV1, parseFirstOwnerResultV1,
  FIRST_OWNER_RESULT_V1,
} from "../src/updater/v1/pg/first-owner-script.mjs";
import { FIRST_OWNER_OWNER_V1 } from "../src/updater/v1/install/install-steps.mjs";
import { DATABASE_PORT_CONTRACTS_V1 } from "../src/updater/v1/install/stage-one-ports.mjs";

async function root(t) {
  const base = await mkdtemp(join(tmpdir(), "first-owner-script-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return join(base, "root");
}

const owner = FIRST_OWNER_OWNER_V1;
const receipt = { schema: "control-room.mac-local-first-owner-receipt/v1", manifestDigest: `sha256:${"a".repeat(64)}`,
  tenantId: owner.tenantId, created: 14, kept: 0, fingerprints: {} };
const line = value => `${JSON.stringify(value)}\n`;

test("the installer's owner values are the release provisioner's Mac-local values and parse exactly", () => {
  assert.deepEqual(parseFirstOwnerOwnerV1(owner), owner);
  assert.equal(owner.tenantId, "tenant:mac-local");
  assert.equal(owner.subject, "owner:local");
  for (const bad of [{ ...owner, extra: 1 }, { ...owner, provider: "other" }, { ...owner, tenantId: "" },
    { ...owner, workers: { ...owner.workers, codex: undefined } }, { ...owner, workIntakeProjectIds: ["*", "x y"] }]) {
    assert.throws(() => parseFirstOwnerOwnerV1(bad), /first_owner_input_refused/u);
  }
  assert.deepEqual(DATABASE_PORT_CONTRACTS_V1.firstOwner.inputKeys,
    ["root", "accounts", "release", "schemaDigest", "pgDataId", "owner"]);
});

test("the retry state is written once, reused on every re-run, and refused when it is not private", async t => {
  const r = await root(t);
  let calls = 0;
  const runtime = { now: () => "2026-10-01T00:00:00.000Z", randomBytes: size => { calls += 1; return Buffer.alloc(size, calls); } };
  const first = await ensureFirstOwnerStateV1(r, runtime);
  const again = await ensureFirstOwnerStateV1(r, { ...runtime, now: () => "2027-01-01T00:00:00.000Z" });
  assert.deepEqual(again, first, "a re-run must reuse the killed run's createdAt and key");
  assert.equal(first.createdAt, "2026-10-01T00:00:00.000Z");
  const path = join(r, "updater-state", "first-owner.json");
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(r, "updater-state"))).mode & 0o777, 0o700);
  await chmod(path, 0o644);
  await assert.rejects(ensureFirstOwnerStateV1(r, runtime), /first_owner_state_refused/u);
  await chmod(path, 0o600);
  await writeFile(path, "{\"schema\":\"x\"}\n");
  await assert.rejects(ensureFirstOwnerStateV1(r, runtime), /first_owner_state_refused/u);
  await rm(path);
  await symlink("/dev/null", path);
  await assert.rejects(ensureFirstOwnerStateV1(r, runtime), /first_owner_state_refused/u);
  await rm(path);
  await assert.rejects(ensureFirstOwnerStateV1(r, { ...runtime, randomBytes: () => Buffer.alloc(16) }),
    /first_owner_state_refused/u);
});

test("a first-owner state torn by a kill between create and write is replaced, and no temporary is left", async t => {
  // atk-fa F12: an empty first-owner.json (O_EXCL create, then a kill before the write)
  // refused every retry with first_owner_state_refused.
  const r = await root(t), runtime = { now: () => "2026-10-01T00:00:00.000Z", randomBytes: size => Buffer.alloc(size, 3) };
  const directory = join(r, "updater-state"), path = join(directory, "first-owner.json");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(path, "", { mode: 0o600 });
  const state = await ensureFirstOwnerStateV1(r, runtime);
  assert.equal(state.reviewKey, Buffer.alloc(32, 3).toString("base64url"));
  assert.deepEqual(await ensureFirstOwnerStateV1(r, { ...runtime, randomBytes: size => Buffer.alloc(size, 4) }), state);
  assert.deepEqual(await readdir(directory), ["first-owner.json"]);
  await writeFile(path, "{", { mode: 0o600 });
  await assert.rejects(ensureFirstOwnerStateV1(r, runtime), /first_owner_state_refused/u);
});

test("the result is exactly one line with exactly the result keys naming exactly the owner sent", () => {
  const good = { schema: FIRST_OWNER_RESULT_V1, receipt,
    identity: { provider: owner.provider, subject: owner.subject, workspaceId: owner.workspaceId } };
  assert.deepEqual(parseFirstOwnerResultV1(line(good), owner), good);
  for (const text of ["", JSON.stringify(good), `${line(good)}${line(good)}`, "not json\n",
    line({ ...good, extra: true }), line({ ...good, schema: "x" }),
    line({ ...good, identity: { ...good.identity, subject: "owner:someone-else" } }),
    line({ ...good, identity: { ...good.identity, workspaceId: "workspace:other" } }),
    line({ ...good, receipt: { ...receipt, password: "x" } })]) {
    assert.throws(() => parseFirstOwnerResultV1(text, owner), /first_owner_result_refused/u, JSON.stringify(text));
  }
});

test("the port refuses an input the installer does not send before it touches anything", async t => {
  const r = await root(t);
  const input = { root: r, accounts: { database: { uid: 600, gid: 600 }, service: { gid: 601 } }, release: "current",
    schemaDigest: `sha256:${"1".repeat(64)}`, pgDataId: "data-a", owner };
  for (const bad of [{ ...input, extra: 1 }, { ...input, release: "releases/x" }, { ...input, pgDataId: "../x" },
    { ...input, accounts: { database: { uid: 0, gid: 0 } } }, { ...input, root: "relative" },
    (({ owner: _, ...rest }) => rest)(input), { ...input, owner: { ...owner, provider: "x" } }]) {
    await assert.rejects(firstOwnerViaScriptV1(bad), /first_owner_input_refused/u);
  }
  // A well-formed input on a root with no database is a database refusal, not a spawn.
  let spawned = false;
  await assert.rejects(firstOwnerViaScriptV1(input, { onSpawn: () => { spawned = true; } }),
    /first_owner_database_refused/u);
  assert.equal(spawned, false);
  await assert.rejects(readFile(join(r, "updater-state", "first-owner.json")), /ENOENT/u,
    "no retry state is written before the database is found");
});
