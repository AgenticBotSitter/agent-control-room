import { releaseSourceFixtureV1 } from "./support/release-source-fixture.mjs";
import assert from "node:assert/strict";
import { assertReleaseImportGraphV1, releaseProgramsV1 } from "./support/release-import-graph.mjs";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isUnbundledMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { mainFleetGatewayEntryV1 } from "../src/fleet/v1/gateway-entry.ts";
import { buildAttendedReleaseV1 } from "../src/updater/v1/build-attended-release.mjs";
import { CORE_SERVICE_ROLES_V1, SERVICE_BATCH_ROLES_V1, composeServiceBundleV1 } from
  "../src/updater/v1/services/bundle.mjs";

async function exec(file, args, options) {
  let child;
  try {
    return await new Promise((resolve, reject) => {
      child = execFile(file, args, { timeout: 90_000, ...options, detached: true }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
      if (options?.keepStdinOpen) child.stdin.write(options.input);
      else child.stdin.end(options?.input ?? "");
    });
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

async function assertNoBuilderPaths(root) {
  const forbidden = new Set([repository, homedir(), await realpath(repository), await realpath(homedir())]);
  for (const path of [...forbidden]) forbidden.add(pathToFileURL(path).href);
  for (const name of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    const bytes = await readFile(join(name.parentPath, name.name));
    for (const path of forbidden) assert.equal(bytes.includes(Buffer.from(path)), false,
      `builder path leaked in ${relative(root, join(name.parentPath, name.name))}`);
  }
}
const repository = resolve(import.meta.dirname, "..");
const account = (name, id) => Object.freeze({ name, uid: id, gid: id, created: true });
const accounts = Object.freeze({ builder: account("_crbuild", 300), database: account("_crdb", 301),
  service: account("_controlroom", 302) });

function protectedConfiguration(root) {
  return ["host.json", "local-owner-session.json", "fleet-gateway.json", "supervisor.json", "backup.json", "mac-local.json", "database-roles.json", "release-trust.json"]
    .map(name => ({ path: join(root, "Protected", "config", name), contents: '{"fixture":true}\n',
      accountName: accounts.service.name, groupName: accounts.service.name, fileMode: "0600" }))
    .concat({ path: join(root, "updater-state", "updater.json"), contents: '{"fixture":true}\n',
      accountName: "root", groupName: "wheel", fileMode: "0600" });
}

function serviceInput(root, roles) {
  return Object.freeze({ root, accounts, roles,
    protectedConfig: roles === CORE_SERVICE_ROLES_V1 ? protectedConfiguration(root) : [],
    pgRuntime: join(root, "runtime", "pg-current", "bin", "postgres"), updaterVersion: "1.2.3-proof" });
}

function programArguments(contents) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(contents)?.[1] ?? "";
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(match => match[1]
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'"));
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

test("unbundled source guards preserve canonical entry and refusal semantics", () => {
  assert.equal(isUnbundledMainModuleV1(undefined, import.meta.url), false);
  assert.equal(isUnbundledMainModuleV1(process.argv[1], import.meta.url), true);
  assert.equal(isUnbundledMainModuleV1(join(repository, "scripts/build-vps.mjs"), import.meta.url), false);
  assert.throws(() => isUnbundledMainModuleV1("", import.meta.url), { code: "direct_entry_guard_refused" });
  assert.throws(() => isUnbundledMainModuleV1(join(repository, "missing-entry.mjs"), import.meta.url),
    { code: "direct_entry_guard_refused" });
  assert.equal(isUnbundledMainModuleV1(process.argv[1], import.meta.url), true);
});

test("the fleet gateway entry passes bundle.mjs's --configuration contract to the live gateway body", async () => {
  const calls = [];
  assert.equal(await mainFleetGatewayEntryV1(["--configuration", "/private/fixture/gateway.json"], async path => {
    calls.push(path);
  }), 0);
  assert.deepEqual(calls, ["/private/fixture/gateway.json"]);
});

test("every release program composed by bundle.mjs loads from an isolated attended release without node_modules",
  { timeout: 120_000 }, async t => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "control-room-attended-programs-")));
    t.after(() => rm(temporary, { recursive: true, force: true }));

    await exec(process.execPath, ["scripts/build-vps.mjs"], { cwd: repository,
      env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" }, maxBuffer: 16 * 1024 * 1024 });
    await t.test("every server file is free of checkout and home paths", async () => {
      await assertNoBuilderPaths(join(repository, "dist-vps/server"));
    });
    const assembled = join(temporary, "assembled"), installRoot = join(temporary, "install");
    const current = join(installRoot, "current");
    await mkdir(assembled); await mkdir(installRoot);
    const source = await releaseSourceFixtureV1(repository, join(temporary,"source"));
    await buildAttendedReleaseV1({ source, output: assembled, commit: "a".repeat(40) });
    await cp(assembled, current, { recursive: true, errorOnExist: true, force: false });

    const resources = SERVICE_BATCH_ROLES_V1.flatMap(roles =>
      composeServiceBundleV1(serviceInput(installRoot, roles)).resources);
    const releasePrograms = new Set(resources.filter(resource => resource.kind === "launchd_plist")
      .flatMap(resource => programArguments(resource.contents))
      .filter(path => isAbsolute(path) && inside(current, path)));
    assert.ok(releasePrograms.size > 0, "the proof must be driven by at least one release-local launch path");

    await assertReleaseImportGraphV1(repository, current, releaseProgramsV1(installRoot));

    // The supervisor starts the task host through stack.mjs. Derive that child
    // from the shipped helper too, so the release cannot contain the supervisor
    // while omitting the next program in its production path.
    const stack = await import(`${pathToFileURL(join(current, "scripts/mac-local/stack.mjs")).href}?proof=${Date.now()}`);
    const childArgument = stack.taskHostCommand(join(temporary, "Protected"))[1];
    releasePrograms.add(resolve(current, childArgument));

    for (const path of releasePrograms) await access(path);
    await assert.rejects(access(join(current, "node_modules")), error => error?.code === "ENOENT");
    assert.deepEqual(JSON.parse(await readFile(join(current, "dist-vps/server/vinext-externals.json"), "utf8")), [],
      "the build must leave no npm package for a release-local server entry to resolve at runtime");

    const imports = [...releasePrograms].map(path => pathToFileURL(path).href);
    const environment = { ...process.env };
    delete environment.NODE_PATH;
    delete environment.NODE_OPTIONS;
    const script = `for (const url of ${JSON.stringify(imports)}) await import(url);`;
    const loaded = await exec(process.execPath, ["--no-warnings", "--input-type=module", "--eval", script],
      { cwd: current, env: environment, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(loaded.stdout, "");
    assert.equal(loaded.stderr, "");

    await t.test("bundled CLIs run only as their real entry, including release symlinks", async () => {
      const cases = [
        { name: "firstOwner", args: ["--bad"], code: 64,
          stdout: "", stderr: "first-owner failed: first_owner_usage_refused\n" },
        { name: "nightlyBackup", args: ["--help"], code: 0,
          stdout: /Usage: nightlyBackup.js/u, stderr: "" },
        { name: "fleetGateway", args: ["--configuration", join(temporary, "missing.json")], code: 0,
          stdout: "", stderr: "fleet gateway failed: fleet_gateway_configuration_refused\n" },
      ];
      async function direct(path, scenario) {
        const result = await exec(process.execPath, ["--no-warnings", path, ...scenario.args],
          { cwd: current, env: environment }).then(result => ({ ...result, code: 0 }), error => error);
        assert.equal(result.code, scenario.code);
        if (scenario.stdout instanceof RegExp) assert.match(result.stdout, scenario.stdout);
        else assert.equal(result.stdout, scenario.stdout);
        assert.equal(result.stderr, scenario.stderr);
      }
      for (const scenario of cases) {
        const entry = join(current, "dist-vps/server", `${scenario.name}.js`);
        await direct(entry, scenario);
        const linked = join(temporary, `${scenario.name}-linked.js`);
        await symlink(entry, linked);
        await direct(linked, scenario);
        // argv[1] has exactly the entry's basename, but is a different file.
        const launcher = join(temporary, `${scenario.name}.js`);
        await writeFile(launcher, `await import(${JSON.stringify(pathToFileURL(entry).href)});\n`);
        const imported = await exec(process.execPath, ["--no-warnings", launcher, ...scenario.args],
          { cwd: current, env: environment });
        assert.deepEqual(imported, { stdout: "", stderr: "" });
      }
      // A burst exercises independent entry decisions without opening services or databases.
      await Promise.all(Array.from({ length: 24 }, (_, index) => {
        const scenario = cases[index % cases.length];
        return direct(join(current, "dist-vps/server", `${scenario.name}.js`), scenario);
      }));
      const malformed = await exec(process.execPath,
        ["--no-warnings", join(current, "dist-vps/server/firstOwner.js")],
        { cwd: current, env: environment, input: "{broken" }).catch(error => error);
      assert.equal(malformed.code, 1);
      assert.equal(malformed.stderr, "first-owner failed: first_owner_request_refused\n");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 200);
      try {
        await assert.rejects(exec(process.execPath,
          ["--no-warnings", join(current, "dist-vps/server/firstOwner.js")],
          { cwd: current, env: environment, input: "{", keepStdinOpen: true, signal: abort.signal }),
        { name: "AbortError" });
      } finally { clearTimeout(timer); }
      await direct(join(current, "dist-vps/server/firstOwner.js"), cases[0]);
    });

    const gatewayResource = resources.find(resource => resource.kind === "launchd_plist"
      && resource.role === "fleet-gateway");
    const gatewayProgram = programArguments(gatewayResource.contents).find(path => inside(current, path));
    const refused = await exec(process.execPath, ["--no-warnings", gatewayProgram,
      "--configuration", join(temporary, "missing.json")],
      { cwd: current, env: environment });
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, "fleet gateway failed: fleet_gateway_configuration_refused\n");
  });
