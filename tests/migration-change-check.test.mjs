import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyMigrationChanges } from "../scripts/check-migration-changes.mjs";

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "migration-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "db/migrations"), { recursive: true });
  await writeFile(join(root, "db/migrations/0001_base.sql"), "CREATE TABLE public.base_records (id bigint PRIMARY KEY);\n");
  command("git", ["init", "--quiet"], root);
  command("git", ["config", "user.name", "Control Room Worker"], root);
  command("git", ["config", "user.email", "control-room-worker@users.noreply.github.com"], root);
  command("git", ["add", "."], root);
  command("git", ["commit", "--quiet", "-m", "base"], root);
  return { root, base: command("git", ["rev-parse", "HEAD"], root) };
}

test("editing a shipped migration fails and adding a new migration is linted", () => {
  const shipped = classifyMigrationChanges(
    [{ status: "M", paths: ["db/migrations/0001_control_room_core.sql"] }],
    path => path === "db/migrations/0001_control_room_core.sql",
  );
  assert.deepEqual(shipped.lint, []);
  assert.match(shipped.violations.join("\n"), /exists on main/);

  const added = classifyMigrationChanges(
    [
      { status: "A", paths: ["db/migrations/9999_fixture.sql"] },
      { status: "M", paths: ["docs/operations/postgres-production.md"] },
    ],
    () => false,
  );
  assert.deepEqual(added, { violations: [], lint: ["db/migrations/9999_fixture.sql"] });
});

test("Squawk flags adding a NOT NULL column to an existing table", () => {
  const fixture = new URL("fixtures/migrations/dangerous.sql", import.meta.url).pathname;
  const result = spawnSync("squawk", [fixture], { encoding: "utf8" });
  assert.notEqual(result.status, 0, "dangerous fixture unexpectedly passed Squawk");
  assert.match(result.stdout + result.stderr, /adding-required-field/);
});

test("the migration CLI rejects a shipped edit and accepts a lint-clean addition", async t => {
  const checker = new URL("../scripts/check-migration-changes.mjs", import.meta.url).pathname;
  const edited = await repository(t);
  await writeFile(join(edited.root, "db/migrations/0001_base.sql"), "SELECT 1;\n");
  command("git", ["add", "."], edited.root);
  command("git", ["commit", "--quiet", "-m", "edit shipped"], edited.root);
  const refused = spawnSync(process.execPath, [checker, "--base", edited.base], { cwd: edited.root, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exists on main/);

  const added = await repository(t);
  await writeFile(join(added.root, "db/migrations/0002_additive.sql"),
    "CREATE TABLE public.additive_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);\n");
  command("git", ["add", "."], added.root);
  command("git", ["commit", "--quiet", "-m", "add migration"], added.root);
  const accepted = spawnSync(process.execPath, [checker, "--base", added.base], { cwd: added.root, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /Squawk passed 1 new migration/);
});
