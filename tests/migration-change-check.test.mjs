import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMigrations, classifyMigrationChanges } from "../scripts/check-migration-changes.mjs";

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function checkerGit(cwd) {
  return args => command("git", args, cwd);
}

async function commit(t, root, message) {
  command("git", ["add", "."], root);
  command("git", ["commit", "--quiet", "-m", message], root);
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

test("the migration checker rejects every symlink under db/migrations", async t => {
  const internal = await repository(t);
  await writeFile(join(internal.root, "db/payload.sql"), "SELECT 1;\n");
  await symlink("../payload.sql", join(internal.root, "db/migrations/0002_internal_link.sql"));
  await commit(t, internal.root, "add internal link");
  const internalResult = checkMigrations({ base: internal.base, cwd: internal.root, runGit: checkerGit(internal.root) });
  assert.match(internalResult.violations.join("\n"), /0002_internal_link\.sql is not a regular file/);

  const outside = await repository(t);
  const payload = join(outside.root, "..", "outside-migration-payload.sql");
  await writeFile(payload, "SELECT 1;\n");
  t.after(() => rm(payload, { force: true }));
  await symlink(payload, join(outside.root, "db/migrations/0002_outside_link.sql"));
  await commit(t, outside.root, "add outside link");
  const outsideResult = checkMigrations({ base: outside.base, cwd: outside.root, runGit: checkerGit(outside.root) });
  assert.match(outsideResult.violations.join("\n"), /0002_outside_link\.sql is not a regular file/);

  const directory = await repository(t);
  const linkedDirectory = join(directory.root, "..", "outside-migration-directory");
  await mkdir(linkedDirectory);
  t.after(() => rm(linkedDirectory, { recursive: true, force: true }));
  await symlink(linkedDirectory, join(directory.root, "db/migrations/0002_linked_directory"));
  await commit(t, directory.root, "add linked directory");
  const directoryResult = checkMigrations({ base: directory.base, cwd: directory.root, runGit: checkerGit(directory.root) });
  assert.match(directoryResult.violations.join("\n"), /0002_linked_directory is not a regular file/);

  const nested = await repository(t);
  await mkdir(join(nested.root, "db/migrations/0002_nested"));
  await writeFile(join(nested.root, "db/migrations/0002_nested/hidden.sql"), "SELECT 1;\n");
  await commit(t, nested.root, "add nested migration directory");
  const nestedResult = checkMigrations({ base: nested.base, cwd: nested.root, runGit: checkerGit(nested.root) });
  assert.match(nestedResult.violations.join("\n"), /0002_nested is not a regular file/);
});

test("the migration CLI rejects a shipped edit, a symlink, and a real Squawk rejection", async t => {
  const checker = new URL("../scripts/check-migration-changes.mjs", import.meta.url).pathname;
  const edited = await repository(t);
  await writeFile(join(edited.root, "db/migrations/0001_base.sql"), "SELECT 1;\n");
  command("git", ["add", "."], edited.root);
  command("git", ["commit", "--quiet", "-m", "edit shipped"], edited.root);
  const refused = spawnSync(process.execPath, [checker, "--base", edited.base], { cwd: edited.root, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exists on main/);

  const linked = await repository(t);
  await writeFile(join(linked.root, "db/payload.sql"), "SELECT 1;\n");
  await symlink("../payload.sql", join(linked.root, "db/migrations/0002_link.sql"));
  await commit(t, linked.root, "add link");
  const linkedRefused = spawnSync(process.execPath, [checker, "--base", linked.base], { cwd: linked.root, encoding: "utf8" });
  assert.notEqual(linkedRefused.status, 0);
  assert.match(linkedRefused.stderr, /0002_link\.sql is not a regular file/);

  const dangerous = await repository(t);
  await writeFile(join(dangerous.root, "db/migrations/0002_dangerous.sql"),
    "ALTER TABLE public.base_records ADD COLUMN owner_id bigint NOT NULL;\n");
  await commit(t, dangerous.root, "add dangerous migration");
  const checked = checkMigrations({ base: dangerous.base, cwd: dangerous.root, runGit: checkerGit(dangerous.root), runSquawk: files => spawnSync("squawk", files, { encoding: "utf8" }) });
  assert.match(checked.violations.join("\n"), /Squawk rejected a changed migration/);
  const squawkRefused = spawnSync(process.execPath, [checker, "--base", dangerous.base], { cwd: dangerous.root, encoding: "utf8" });
  assert.notEqual(squawkRefused.status, 0, squawkRefused.stdout + squawkRefused.stderr);
  assert.match(squawkRefused.stderr, /Squawk rejected a changed migration/);

  const added = await repository(t);
  await writeFile(join(added.root, "db/migrations/0002_additive.sql"),
    "CREATE TABLE public.additive_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);\n");
  command("git", ["add", "."], added.root);
  command("git", ["commit", "--quiet", "-m", "add migration"], added.root);
  const accepted = spawnSync(process.execPath, [checker, "--base", added.base], { cwd: added.root, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /Squawk passed 1 new migration/);
});
