import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  adoptBootstrapV1, loadInstallStepsV1, removeAdoptedBootstrapV1, seedUpdaterV1, verifyBootstrapSourceV1,
} from "../src/updater/v1/install/bootstrap.mjs";
import { loadRuntimeInventoryV1, vendorRuntimeV1 } from "../src/updater/v1/install/runtime.mjs";

const repository = resolve(dirname(new URL(import.meta.url).pathname), "..");
const bootstrapSource = join(repository, "scripts/install-night/bootstrap.sh");
const commit = "a".repeat(40);
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function cleanup(path) {
  async function thaw(current) {
    const entry = await lstat(current).catch(() => null);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
    await chmod(current, 0o700).catch(() => {});
    for (const name of await readdir(current).catch(() => [])) await thaw(join(current, name));
  }
  await thaw(path); await rm(path, { recursive: true, force: true });
}

async function executable(path, text) { await writeFile(path, `#!/bin/sh\nset -eu\n${text}\n`, { mode: 0o700 }); await chmod(path, 0o700); }

async function harness(t, prefix = "/private/tmp/control-room-bootstrap-test-") {
  const base = await realpath(await mkdtemp(prefix)), tools = join(base, "tools");
  await mkdir(tools); t.after(() => cleanup(base));
  const common = tool => `printf '%s\\n' '${tool} '$* >> "$FAKE_LOG"\n[ "\${FAKE_FAIL_TOOL-}" != '${tool}' ] || exit 91`;
  await executable(join(tools, "id"), `${common("id")}\nprintf '%s\\n' "\${FAKE_ID_UID-0}"`);
  await executable(join(tools, "uname"), `${common("uname")}\n[ "$1" = -s ] && printf 'Darwin\\n' || printf 'arm64\\n'`);
  await executable(join(tools, "stat"), `${common("stat")}\ncase "$*" in *%z*) printf '49963763\\n' ;; *) printf '%s\\n' "\${FAKE_ROOT_STAT-0 700 Directory}" ;; esac`);
  await executable(join(tools, "sudo"), `${common("sudo")}\nexit 0`);
  await executable(join(tools, "stty"), `${common("stty")}\nexit 0`);
  await executable(join(tools, "curl"), `${common("curl")}\n[ "$1" = -q ] || exit 92\nout=; maximum_time=\nwhile [ "$#" -gt 0 ]; do [ "$1" = --output ] && { out=$2; shift 2; continue; }; [ "$1" = --max-time ] && { maximum_time=$2; shift 2; continue; }; shift; done\n[ -n "$maximum_time" ] || exit 93\nprintf node > "$out"`);
  await executable(join(tools, "shasum"), `${common("shasum")}\n[ "\${FAKE_SHA_MISMATCH-}" != 1 ]`);
  await executable(join(tools, "chflags"), `${common("chflags")}\nexit 0`);
  await executable(join(tools, "chown"), `${common("chown")}\nexit 0`);
  await executable(join(tools, "chmod"), `${common("chmod")}\n/bin/chmod "$@" 2>/dev/null || :`);
  await executable(join(tools, "mkdir"), `${common("mkdir")}\n/bin/mkdir "$@"`);
  await executable(join(tools, "rm"), `${common("rm")}\n/bin/rm "$@"`);
  await executable(join(tools, "cmp"), `${common("cmp")}\n/usr/bin/cmp "$@"`);
  await executable(join(tools, "find"), `${common("find")}\n[ "\${FAKE_SOURCE_SYMLINK-}" != 1 ] || printf 'hostile-link\\n'`);
  await executable(join(tools, "cat"), `${common("cat")}\n/bin/cat "$@"`);
  await executable(join(tools, "xcrun"), `${common("xcrun")}\nprintf '%s\\n' "$CONTROL_ROOM_BOOTSTRAP_TOOL_DIR/git"`);
  await executable(join(tools, "env"), `${common("env")}\n[ "$1" = -i ] && shift
while [ "$#" -gt 0 ]; do case "$1" in *=*) export "$1"; shift ;; *) break ;; esac; done
"$@"`);
  await executable(join(tools, "tar"), `${common("tar")}
case " $* " in
  *' -xzf '*)
    [ "\${FAKE_FAIL_POINT-}" != node-tar ] || exit 93
    destination=; while [ "$#" -gt 0 ]; do [ "$1" = -C ] && { destination=$2; break; }; shift; done
    /bin/mkdir -p "$destination/bin"
    /bin/cat > "$destination/bin/node" <<'NODE'
#!/bin/sh
if [ "\${1-}" = --input-type=module ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
printf '%s\n' "node $*" >> "$FAKE_LOG"
previous=; for argument in "$@"; do
  [ "$previous" = --bootstrap ] && /bin/cat "$argument/bootstrap.json" >> "$FAKE_LOG"
  previous=$argument
done
exit "\${FAKE_NODE_EXIT-0}"
NODE
    /bin/chmod 700 "$destination/bin/node"
    ;;
  *' -xf '*)
    [ "\${FAKE_FAIL_POINT-}" != source-tar ] || exit 94
    destination=; while [ "$#" -gt 0 ]; do [ "$1" = -C ] && { destination=$2; break; }; shift; done
    /bin/mkdir -p "$destination/scripts/install-night" "$destination/src/updater/v1"
    /bin/cp "$FAKE_BOOTSTRAP_SOURCE" "$destination/scripts/install-night/bootstrap.sh"
    [ "\${FAKE_INCONSISTENT_SCRIPT-}" != 1 ] || printf '\n# changed\n' >> "$destination/scripts/install-night/bootstrap.sh"
    printf 'export {};\n' > "$destination/src/updater/v1/cli.mjs"
    ;;
  *) exit 95 ;;
esac`);
  await executable(join(tools, "git"), `${common("git")}
mirror=; previous=; command=
last=; for argument in "$@"; do
  last=$argument
  [ "$previous" = --git-dir ] && mirror=$argument
  case "$argument" in credential.helper=*) helper=\${argument#credential.helper=} ;; esac
  case "$argument" in init|fetch|config|rev-parse|merge-base|grep|archive) [ -z "$command" ] && command=$argument ;; esac
  previous=$argument
done
case "$command" in
  init) [ "\${FAKE_FAIL_POINT-}" != git-init ] || exit 96; /bin/mkdir -p "$last/info" "$last/refs" ;;
  fetch)
    [ "\${FAKE_FAIL_POINT-}" != fetch ] || exit 97
    if [ "\${FAKE_CHECK_CREDENTIAL_HOST-}" = 1 ]; then
      [ -z "$(printf 'protocol=https\nhost=evil.example\n\n' | "$helper" get)" ] || exit 101
      printf 'protocol=https\nhost=github.com\n\n' | "$helper" get | /usr/bin/grep -q '^username=x-access-token$' || exit 102
    fi
    if [ "\${FAKE_PLANT_REPO-}" = 1 ]; then
      /bin/mkdir -p "$mirror/hooks" "$mirror/info" "$mirror/refs/replace"
      printf hostile > "$mirror/hooks/post-fetch"; printf '* filter=hostile\n' > "$mirror/info/attributes"
      printf replacement > "$mirror/refs/replace/$FAKE_COMMIT"
    fi
    ;;
  config)
    [ "\${FAKE_CONFIG_FAILURE-}" != 1 ] || exit 103
    printf 'core.repositoryformatversion\ncore.filemode\ncore.bare\n'
    [ "\${FAKE_PLANT_CONFIG-}" != 1 ] || printf 'filter.hostile.smudge\n'
    ;;
  rev-parse) [ "\${FAKE_FAIL_POINT-}" != rev-parse ] || exit 98; printf '%s\n' "$FAKE_COMMIT" ;;
  merge-base) [ "\${FAKE_NOT_ON_MAIN-}" != 1 ] ;;
  grep) [ "\${FAKE_DANGEROUS_ATTRIBUTES-}" = 1 ] && exit 0 || exit 1 ;;
  archive)
    [ "\${FAKE_FAIL_POINT-}" != archive ] || exit 99
    for argument in "$@"; do case "$argument" in --output=*) output=\${argument#--output=} ;; esac; done
    printf archive > "$output"
    ;;
  *) exit 100 ;;
esac`);
  return { base, tools, log: join(base, "calls.log") };
}

async function makeRun(fixture, { token = true, tokenText = "fixture-token", bootstrapArguments = [], ...overrides } = {}) {
  const root = join(fixture.base, `run-${Math.random().toString(16).slice(2)}`); await mkdir(root, { mode: 0o700 });
  const script = join(root, "bootstrap.sh"); await cp(bootstrapSource, script); await chmod(script, 0o700);
  if (token) await writeFile(join(root, "github-read.token"), "fixture-token\n", { mode: 0o600 });
  const tty = join(fixture.base, "tty.log"), tokenInput = join(fixture.base, "token.input");
  await writeFile(tty, ""); await writeFile(tokenInput, `${tokenText}\n`);
  const env = { ...process.env, CONTROL_ROOM_BOOTSTRAP_TESTING: "1", CONTROL_ROOM_BOOTSTRAP_TOOL_DIR: fixture.tools,
    CONTROL_ROOM_BOOTSTRAP_TTY: tty, CONTROL_ROOM_BOOTSTRAP_TOKEN_INPUT: tokenInput, FAKE_LOG: fixture.log,
    FAKE_BOOTSTRAP_SOURCE: bootstrapSource, FAKE_COMMIT: commit, SUDO_USER: "fixture-owner", SUDO_UID: "501", SUDO_GID: "20",
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, String(value)])) };
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn("/bin/sh", ["-p", script, commit, root, ...bootstrapArguments], {
      cwd: repository, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { root, tty, result };
}

async function composedRuntimeFixture(base) {
  const originals = await loadRuntimeInventoryV1(), archives = {}, executables = {};
  for (const artifact of originals.artifacts) {
    const executable = Buffer.from(`#!/bin/sh\nprintf '%s\\n' ${artifact.tool}-fixture\n`), tree = join(base, `tree-${artifact.tool}`);
    let executablePath;
    if (artifact.tool === "node") executablePath = join(tree, `node-v${artifact.version}`, "bin/node");
    else if (artifact.tool === "pnpm") executablePath = join(tree, "pnpm");
    else if (artifact.tool === "esbuild") executablePath = join(tree, "package/bin/esbuild");
    else {
      archives[artifact.tool] = join(base, artifact.archiveName); executables[artifact.tool] = executable;
      await writeFile(archives[artifact.tool], "postgresql-fixture-archive", { mode: 0o600 }); continue;
    }
    await mkdir(dirname(executablePath), { recursive: true }); await writeFile(executablePath, executable, { mode: 0o755 });
    archives[artifact.tool] = join(base, artifact.archiveName); executables[artifact.tool] = executable;
    await command("/usr/bin/tar", ["-czf", archives[artifact.tool], "-C", tree, ...artifact.tool === "node"
      ? [`node-v${artifact.version}`] : artifact.tool === "pnpm" ? ["pnpm"] : ["package"]], base);
  }
  const artifacts = [];
  for (const artifact of originals.artifacts) {
    const bytes = await readFile(archives[artifact.tool]);
    artifacts.push({ ...artifact, archiveSha256: createHash("sha256").update(bytes).digest("hex"), archiveBytes: bytes.length,
      executableSha256: createHash("sha256").update(executables[artifact.tool]).digest("hex") });
  }
  const curl = join(base, "fixture-curl.mjs"), mapping = Object.fromEntries(artifacts.map(row => [row.url, archives[row.tool]]));
  await writeFile(curl, `import{copyFile}from'node:fs/promises';let a=process.argv.slice(2),u=a.at(-1),o=a[a.indexOf('--output')+1],m=${JSON.stringify(mapping)};if(!m[u])process.exit(64);await copyFile(m[u],o);\n`, { mode: 0o500 });
  const inventory = Object.freeze({ ...originals, artifacts: Object.freeze(artifacts.map(Object.freeze)) });
  const runtime = { curlPath: process.execPath, curlArgumentsPrefix: [curl], skipMacMetadata: true,
    async vendorPostgresql({ archivePath, runtimeDirectory }) {
      assert.equal((await readFile(archivePath, "utf8")), "postgresql-fixture-archive");
      await mkdir(join(runtimeDirectory, "bin"), { recursive: true });
      await writeFile(join(runtimeDirectory, "bin/postgres"), executables.postgresql, { mode: 0o555 });
      return { status: "pg_runtime_vendored" };
    } };
  return { inventory, runtime };
}

async function composedHandoffFixture(root, commitValue) {
  const releaseId = `1.0.0-${commitValue.slice(0, 12)}`;
  const target = join(root, "updater", releaseId), lib = join(target, "lib"); await mkdir(lib, { recursive: true });
  const modulePath = join(lib, "install-steps.mjs"), production = pathToFileURL(
    join(repository, "src/updater/v1/install/install-steps.mjs")).href;
  await writeFile(modulePath, `export{continueInstallV1,createStageOnePortsV1}from ${JSON.stringify(production)};\n`, { mode: 0o500 });
  const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: [{ path: "lib/install-steps.mjs",
    sha256: sha256(await readFile(modulePath)), mode: 0o500, type: "file" }] };
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o400 });
  await chmod(lib, 0o500); await chmod(target, 0o500);
  return { target, releaseId, digest: sha256(Buffer.from(JSON.stringify(manifest))) };
}

test("the real bootstrap is POSIX-sh syntax and runs only injected tools under a private test root", async t => {
  const syntax = await new Promise(resolveResult => {
    const child = spawn("/bin/sh", ["-n", bootstrapSource]); child.once("close", code => resolveResult(code));
  });
  assert.equal(syntax, 0);
  const fixture = await harness(t), run = await makeRun(fixture);
  assert.equal(run.result.code, 0, run.result.stderr);
  const calls = await readFile(fixture.log, "utf8");
  assert.match(calls, /sudo -n[\s\S]*-u[\s\S]*#501[\s\S]*\/usr\/bin\/sudo[\s\S]*-K/u);
  assert.match(calls, /curl -q[\s\S]*--proto[\s\S]*=https/u);
  assert.match(calls, /curl[\s\S]*--max-time\n1800/u);
  assert.match(calls, new RegExp(`node .*install --commit ${commit} --bootstrap ${run.root.replaceAll("/", "\\/")}`, "u"));
  assert.doesNotMatch(calls, /(?:^|\n)curl (?!-q)/u);
  assert.match(calls, new RegExp(`"git":"${join(fixture.tools, "git").replaceAll("/", "\\/")}"`, "u"));
});

test("E2E-1 composes real Stage B, fixture-archive vendoring, verified hand-off and the installed step table",
  { timeout: 90_000 }, async t => {
  const fixture = await harness(t), rehearsal = join(fixture.base, "rehearsal.json"),
    evidence = join(fixture.base, "e2e2-evidence.jsonl");
  await writeFile(rehearsal, "{}\n", { mode: 0o600 });
  const stageB = await makeRun(fixture, { bootstrapArguments: ["--rehearsal-config", rehearsal, "--fresh-database", "yes",
    "--authenticator", "software", "--e2e2-evidence-log", evidence] });
  assert.equal(stageB.result.code, 0, stageB.result.stderr);
  const stageBCalls = await readFile(fixture.log, "utf8");
  assert.match(stageBCalls, new RegExp(`install --commit ${commit} --bootstrap [^\\n]+ --rehearsal-config ${rehearsal.replaceAll("/", "\\/")} --fresh-database yes --authenticator software --e2e2-evidence-log ${evidence.replaceAll("/", "\\/")}`, "u"));
  const bootstrapMetadata = JSON.parse(stageBCalls.split("\n").find(line => line.startsWith('{"schema":"control-room.bootstrap/v1"')));
  assert.equal(bootstrapMetadata.commit, commit);

  const root = await realpath(await mkdtemp(join(fixture.base, "composed-install-")));
  await mkdir(join(root, "build")); await mkdir(join(root, "runtime"));
  await mkdir(join(root, "updater-state/tmp"), { recursive: true });
  const runtimeFixture = await composedRuntimeFixture(join(fixture.base, "archives"));
  const handoff = await composedHandoffFixture(root, bootstrapMetadata.commit);
  const loaded = await loadInstallStepsV1({ updaterTarget: handoff.target, expectedDigest: handoff.digest },
    { expectedUid: process.geteuid() });
  await vendorRuntimeV1(Object.freeze({ root, inventory: runtimeFixture.inventory,
    tools: Object.freeze(["node", "pnpm", "esbuild"]), fresh: true,
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId: "m5-composed" }),
  runtimeFixture.runtime);
  for (const tool of ["node", "pnpm", "esbuild"]) assert.equal((await lstat(join(root, `runtime/${tool}-current`))).isSymbolicLink(), true);
  const digest = `sha256:${"a".repeat(64)}`, receipts = roles => ({ bundleDigest: digest,
    receipt: { schema: "control-room.services-receipt/v1", receiptDigest: digest, roles: [...roles] } });
  let serve = { Web: {}, TCP: {}, AllowFunnel: {} };
  const ports = {
    randomBytes: size => Buffer.alloc(size, 7),
    async vendorRuntime(input) { return vendorRuntimeV1(Object.freeze({ ...input, inventory: runtimeFixture.inventory,
      download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }) }), runtimeFixture.runtime); },
    async rollbackRuntime() {},
    async initializeDatabase(input) { return input.phase === "init"
      ? { schema: "control-room.database-init-result/v1", outcome: "initialized", pgDataId: input.pgDataId,
        updaterSchemaDigest: digest, clusterShutDownClean: true }
      : { schema: "control-room.release-schema-result/v1", outcome: "applied", schemaDigest: digest,
        ledgerHead: "fixture.sql" }; },
    async installServices(input) { return receipts(input.roles); }, async uninstallServices() {}, async recoverServices() {},
    async killAccountProcesses() {}, async retireDatabase() {},
    async firstOwner() { return { tenantId: "tenant", workspaceId: "workspace", provider: "fixture", subject: "owner" }; },
    async installGuard(input) { return { digest, target: input.target }; }, async removeGuard() {},
    async composeProtectedConfig() { return []; },
    async writeDatabaseLogins(input) { return { references: Object.keys(input.passwords).map(name => ({ name })) }; },
    async removeDatabaseLogins() {}, async readTailscaleRpId() { return "rehearsal-fixture.ts.net"; },
    async captureTailscaleServe() { return { Web: {}, TCP: {}, AllowFunnel: {} }; },
    async activateTailscaleServe({ webPort }) { serve = { Web: { "rehearsal-fixture.ts.net:443": {
      Handlers: { "/": { Proxy: `http://127.0.0.1:${webPort}` } } } }, TCP: {}, AllowFunnel: {} }; },
    async inspectTailscaleServe() { return serve; }, async restoreTailscaleServe() {},
    async recordTailscaleServe() { return { serveDigest: digest }; },
    async checkHealth(input) { return { healthy: true, samples: 3, schemaDigest: input.schemaDigest }; },
    async seedKnownGood(input) { return { releaseId: input.releaseId, pgDataId: input.pgDataId,
      schemaDigest: input.schemaDigest }; }, async removeKnownGood() {},
    async remintOwnerCode() { return { ownerCode: "fixture-owner-code-123456789", ownerCodeDigest: digest,
      receipt: { digest } }; }, async rollbackOwnerCode() {},
    async startPostHealthServices(input) { return receipts(input.roles); },
  };
  const stepTable = new Map(), undo = [], accounts = Object.fromEntries(["service", "database", "builder"]
    .map((role, index) => [role, { name: `_fixture${role}`, uid: process.getuid() + index + 1,
      gid: process.getgid() + index + 1 }]));
  const result = await loaded.continueInstallV1({ root, transactionId: "m5-composed", accounts,
    invokingUser: { user: "fixture-owner", uid: process.getuid(), gid: process.getgid() },
    async write(phase, action) { stepTable.set(action, phase); }, undo, ports,
    options: { webPort: 4383, gatewayPort: 4384, freshDatabase: true, moveLiveDatabase: false,
      tailnetIdentity: "rehearsal-fixture.ts.net" },
    attended: { current: `releases/${handoff.releaseId}`, release: { releaseId: handoff.releaseId },
      bundle: { uver: handoff.releaseId } }, runtimeInventory: runtimeFixture.inventory });
  stepTable.set("transaction", result ? "installed" : "failed");
  assert.equal(stepTable.get("transaction"), "installed");
  assert([...stepTable.entries()].filter(([action]) => action !== "transaction").every(([, phase]) => phase === "done"));
  assert.equal(await readFile(join(root, "runtime/pg-current/bin/postgres"), "utf8"),
    "#!/bin/sh\nprintf '%s\\n' postgresql-fixture\n");
});

test("bootstrap metadata JSON-escapes an absolute tool path", async t => {
  const fixture = await harness(t, "/private/tmp/control-room-bootstrap-\\quoted-"), run = await makeRun(fixture);
  assert.equal(run.result.code, 0, run.result.stderr);
  const metadataLine = (await readFile(fixture.log, "utf8")).split("\n").find(line => line.startsWith('{"schema":"control-room.bootstrap/v1"'));
  const metadata = JSON.parse(metadataLine);
  assert.equal(metadata.git, join(fixture.tools, "git"));
});

test("bootstrap tool injection is unavailable outside an explicit private test root", async t => {
  const fixture = await harness(t), root = await realpath(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "bootstrap-wrong-root-")));
  t.after(() => cleanup(root)); const script = join(root, "bootstrap.sh"); await cp(bootstrapSource, script); await chmod(script, 0o700);
  const result = await new Promise(resolveResult => {
    const child = spawn("/bin/sh", ["-p", script, commit, root], { env: { ...process.env,
      CONTROL_ROOM_BOOTSTRAP_TESTING: "1", CONTROL_ROOM_BOOTSTRAP_TOOL_DIR: fixture.tools }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.once("close", code => resolveResult({ code, stderr }));
  });
  assert.notEqual(result.code, 0); assert.match(result.stderr, /bootstrap_test_root_refused/u);
});

test("stage B refusals are retryable at every boundary", { timeout: 60_000 }, async t => {
  const fixture = await harness(t);
  for (const failure of [
    { FAKE_FAIL_TOOL: "sudo" }, { FAKE_FAIL_TOOL: "curl" }, { FAKE_SHA_MISMATCH: 1 },
    { FAKE_FAIL_POINT: "node-tar" }, { FAKE_FAIL_POINT: "git-init" }, { FAKE_FAIL_POINT: "fetch" },
    { FAKE_FAIL_POINT: "rev-parse" }, { FAKE_NOT_ON_MAIN: 1 }, { FAKE_FAIL_POINT: "archive" },
    { FAKE_FAIL_POINT: "source-tar" }, { FAKE_SOURCE_SYMLINK: 1 }, { FAKE_INCONSISTENT_SCRIPT: 1 },
  ]) {
    const stopped = await makeRun(fixture, failure); assert.notEqual(stopped.result.code, 0, JSON.stringify(failure));
    const retried = await makeRun(fixture); assert.equal(retried.result.code, 0, `${JSON.stringify(failure)}: ${retried.result.stderr}`);
  }
});

test("a failed stage-0 child removes the private bootstrap root", async t => {
  const fixture = await harness(t), run = await makeRun(fixture, { FAKE_NODE_EXIT: 47 });
  assert.equal(run.result.code, 47); await assert.rejects(lstat(run.root), { code: "ENOENT" });
});

test("a refusal before the bootstrap root is validated never deletes the directory it was given", async t => {
  // atk-fa F1: the EXIT trap removed "$d" before "$d" was proved to be the private
  // root-owned 0700 folder, so any early refusal deleted whatever path was passed.
  const fixture = await harness(t);
  for (const [failure, code] of [[{ FAKE_ID_UID: 501 }, "bootstrap_root_required"],
    [{ SUDO_UID: "0" }, "bootstrap_invoking_user_refused"], [{ SUDO_USER: "bad name" }, "bootstrap_invoking_user_refused"],
    [{ FAKE_ROOT_STAT: "501 700 Directory" }, "bootstrap_root_refused"],
    [{ FAKE_ROOT_STAT: "0 755 Directory" }, "bootstrap_root_refused"]]) {
    const run = await makeRun(fixture, failure);
    assert.notEqual(run.result.code, 0, JSON.stringify(failure)); assert.match(run.result.stderr, new RegExp(code, "u"));
    assert.equal(await readFile(join(run.root, "github-read.token"), "utf8"), "fixture-token\n", JSON.stringify(failure));
  }
  const validated = await makeRun(fixture, { FAKE_FAIL_TOOL: "sudo" });
  assert.notEqual(validated.result.code, 0); await assert.rejects(lstat(validated.root), { code: "ENOENT" });
});

test("stage B rejects pin, mirror, ancestry, config and self-consistency attacks and restores terminal echo", async t => {
  const fixture = await harness(t);
  const sha = await makeRun(fixture, { FAKE_SHA_MISMATCH: 1 }); assert.match(sha.result.stderr, /bootstrap_node_digest_refused/u);
  const mirrorRoot = join(fixture.base, "preexisting"), script = join(mirrorRoot, "bootstrap.sh");
  await mkdir(join(mirrorRoot, "mirror.git"), { recursive: true, mode: 0o700 }); await cp(bootstrapSource, script); await chmod(script, 0o700);
  await writeFile(join(mirrorRoot, "github-read.token"), "fixture-token\n", { mode: 0o600 });
  const env = { ...process.env, CONTROL_ROOM_BOOTSTRAP_TESTING: "1", CONTROL_ROOM_BOOTSTRAP_TOOL_DIR: fixture.tools,
    FAKE_LOG: fixture.log, FAKE_BOOTSTRAP_SOURCE: bootstrapSource, FAKE_COMMIT: commit, SUDO_USER: "owner", SUDO_UID: "501", SUDO_GID: "20" };
  const existing = await new Promise(resolveResult => { const child = spawn("/bin/sh", ["-p", script, commit, mirrorRoot], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.once("close", code => resolveResult({ code, stderr })); });
  assert.match(existing.stderr, /bootstrap_mirror_exists/u);
  const ancestry = await makeRun(fixture, { FAKE_NOT_ON_MAIN: 1 }); assert.match(ancestry.result.stderr, /bootstrap_commit_not_on_main/u);
  const config = await makeRun(fixture, { FAKE_PLANT_CONFIG: 1 }); assert.match(config.result.stderr, /bootstrap_git_config_refused/u);
  const configFailure = await makeRun(fixture, { FAKE_CONFIG_FAILURE: 1 });
  assert.match(configFailure.result.stderr, /bootstrap_git_config_refused/u);
  const linked = await makeRun(fixture, { FAKE_SOURCE_SYMLINK: 1 }); assert.match(linked.result.stderr, /bootstrap_source_link_refused/u);
  const inconsistent = await makeRun(fixture, { FAKE_INCONSISTENT_SCRIPT: 1 }); assert.match(inconsistent.result.stderr, /bootstrap_script_consistency_refused/u);
  const hidden = await makeRun(fixture, { token: false }); assert.equal(hidden.result.code, 0, hidden.result.stderr);
  const calls = await readFile(fixture.log, "utf8"); assert.match(calls, /stty -echo/u); assert.match(calls, /stty echo/u);
  assert.doesNotMatch(calls, /fixture-token/u);
  assert.match(calls, /http\.followRedirects=false/u);
  assert.match(calls, /ident/u); assert.match(calls, /working-tree-encoding/u);
  const credentials = await makeRun(fixture, { FAKE_CHECK_CREDENTIAL_HOST: 1 });
  assert.equal(credentials.result.code, 0, credentials.result.stderr);
});

test("stage B refuses dot-dot path components before touching tools", async t => {
  const fixture = await harness(t), script = join(fixture.base, "bootstrap.sh"); await cp(bootstrapSource, script); await chmod(script, 0o700);
  const result = await new Promise(resolveResult => {
    const child = spawn("/bin/sh", ["-p", script, commit, `${fixture.base}/safe/../escape`], {
      env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("close", code => resolveResult({ code, stderr }));
  });
  assert.notEqual(result.code, 0); assert.match(result.stderr, /bootstrap_root_refused/u);
});

test("stage B refuses malformed or incomplete rehearsal-only arguments", async t => {
  const fixture = await harness(t);
  const relative = await makeRun(fixture, { bootstrapArguments: ["--rehearsal-config", "relative.json",
    "--fresh-database", "yes"] });
  assert.notEqual(relative.result.code, 0); assert.match(relative.result.stderr, /bootstrap_rehearsal_config_refused/u);
  const notFresh = await makeRun(fixture, { bootstrapArguments: ["--fresh-database", "no"] });
  assert.notEqual(notFresh.result.code, 0); assert.match(notFresh.result.stderr, /bootstrap_fresh_database_refused/u);
  const incomplete = await makeRun(fixture, { bootstrapArguments: ["--rehearsal-config", join(fixture.base, "config.json"),
    "--fresh-database", "yes"] });
  assert.notEqual(incomplete.result.code, 0); assert.match(incomplete.result.stderr, /bootstrap_rehearsal_arguments_refused/u);
  const badAuthenticator = await makeRun(fixture, { bootstrapArguments: ["--authenticator", "face-id"] });
  assert.notEqual(badAuthenticator.result.code, 0);
  assert.match(badAuthenticator.result.stderr, /bootstrap_authenticator_refused/u);
  const badEvidence = await makeRun(fixture, { bootstrapArguments: ["--e2e2-evidence-log", join(fixture.base, "wrong.jsonl")] });
  assert.notEqual(badEvidence.result.code, 0); assert.match(badEvidence.result.stderr, /bootstrap_evidence_log_refused/u);
  const realWithAuthenticator = await makeRun(fixture, { bootstrapArguments: ["--authenticator", "software"] });
  assert.notEqual(realWithAuthenticator.result.code, 0);
  assert.match(realWithAuthenticator.result.stderr, /bootstrap_rehearsal_arguments_refused/u);
});

test("fresh mirror hardening neutralizes hooks, info attributes and replacement refs", async t => {
  const fixture = await harness(t), run = await makeRun(fixture, { FAKE_PLANT_REPO: 1 });
  assert.equal(run.result.code, 0, run.result.stderr);
  await assert.rejects(lstat(join(run.root, "mirror.git", "hooks")), { code: "ENOENT" });
  await assert.rejects(lstat(join(run.root, "mirror.git", "info", "attributes")), { code: "ENOENT" });
  const calls = await readFile(fixture.log, "utf8");
  assert.match(calls, /GIT_CONFIG_NOSYSTEM=1/u); assert.match(calls, /GIT_NO_REPLACE_OBJECTS=1/u);
  assert.match(calls, /GIT_ATTR_NOSYSTEM=1/u); assert.match(calls, /core\.hooksPath=\/dev\/null/u);
  assert.match(calls, /core\.attributesFile=\/dev\/null/u);
});

async function command(file, args, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolveResult({ stdout, stderr })
      : reject(new Error(`${file}:${code}:${stderr}`)));
  });
}

test("stage 0 rehashes the archive, seeds only reviewed tools, and moves prior adoption aside", async t => {
  const base = await realpath(await mkdtemp("/private/tmp/control-room-stage0-test-")); t.after(() => cleanup(base));
  const checkout = join(base, "checkout"), bootstrap = join(base, "bootstrap"), source = join(bootstrap, "source");
  await mkdir(checkout); await command("/usr/bin/git", ["init", "--quiet"], checkout);
  await command("/usr/bin/git", ["config", "user.email", "stage0@example.invalid"], checkout);
  await command("/usr/bin/git", ["config", "user.name", "Stage Zero"], checkout);
  for (const path of ["src/updater/v1/build-attended-release.mjs", "src/updater/v1/bin/git-credential-control-room",
    "src/updater/v1/policy", "scripts/updater/build-fixed-updater-bundle.mjs", "scripts/install-night/bootstrap.sh"]) {
    const target = join(checkout, path); await mkdir(dirname(target), { recursive: true }); await cp(join(repository, path), target, { recursive: true });
  }
  await command("/usr/bin/git", ["add", "."], checkout); await command("/usr/bin/git", ["commit", "--quiet", "-m", "fixture"], checkout);
  const revision = (await command("/usr/bin/git", ["rev-parse", "HEAD"], checkout)).stdout.trim();
  await mkdir(bootstrap); await command("/usr/bin/git", ["clone", "--quiet", "--bare", checkout, join(bootstrap, "mirror.git")], base);
  const archive = join(base, "source.tar"); await command("/usr/bin/git", ["archive", `--output=${archive}`, revision], checkout);
  await mkdir(source); await command("/usr/bin/tar", ["-xf", archive, "-C", source], base);
  const verified = await verifyBootstrapSourceV1({ bootstrapRoot: bootstrap, commit: revision },
    { expectedUid: process.geteuid(), gitPath: "/usr/bin/git" });
  assert(verified.treeEntries >= 5); assert.match(verified.sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  const relativeGit = join(base, "relative-git"), relativeGitMarker = join(base, "relative-git-ran");
  await executable(relativeGit, `printf used > "${relativeGitMarker}"\nexit 1`);
  await assert.rejects(verifyBootstrapSourceV1({ bootstrapRoot: bootstrap, commit: revision,
    gitPath: relative(repository, relativeGit) },
    { expectedUid: process.geteuid() }), /bootstrap_source_git_refused/u);
  await assert.rejects(lstat(relativeGitMarker), { code: "ENOENT" });
  const changedPath = join(source, "scripts/install-night/bootstrap.sh"), originalBytes = await readFile(changedPath);
  const changedBytes = Buffer.from(originalBytes); changedBytes[0] ^= 1; await writeFile(changedPath, changedBytes);
  await assert.rejects(verifyBootstrapSourceV1({ bootstrapRoot: bootstrap, commit: revision },
    { expectedUid: process.geteuid(), gitPath: "/usr/bin/git" }), /bootstrap_source_tree_refused/u);
  await rm(source, { recursive: true }); await mkdir(source); await command("/usr/bin/tar", ["-xf", archive, "-C", source], base);

  const installRoot = join(base, "install"); await mkdir(join(installRoot, "updater"), { recursive: true });
  const transactionId = "a1234567-1234-4123-8123-123456789abc";
  const seed = await seedUpdaterV1({ root: installRoot, bootstrapRoot: bootstrap, commit: revision, transactionId },
    { expectedUid: process.geteuid() });
  assert.deepEqual((await readdir(join(seed.dir, "bin"))).sort(),
    ["build-attended-release.mjs", "build-fixed-bundle.mjs", "git-credential-control-room"]);
  assert.match(seed.digest, /^sha256:[a-f0-9]{64}$/u);
  // rv-9b B3: the seeded builders LOAD and reach their own argument check, from the
  // seed and from a per-job `builder-tools/bin` copy (`attended-source.mjs`
  // stageBuilderTools). With the shared guard imported by relative path both died at
  // ERR_MODULE_NOT_FOUND, so every fresh install stopped at the release build.
  const jobBin = join(base, "job", "builder-tools", "bin"); await mkdir(jobBin, { recursive: true });
  for (const [name, refusal] of [["build-attended-release.mjs", "updater_build_arguments_refused"],
    ["build-fixed-bundle.mjs", "updater_bundle_arguments_refused"]]) {
    await cp(join(seed.dir, "bin", name), join(jobBin, name));
    for (const entry of [join(seed.dir, "bin", name), join(jobBin, name)]) {
      const run = spawnSync(process.execPath, [entry], { encoding: "utf8", cwd: base,
        env: { PATH: "/usr/bin:/bin", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
      assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/u, `${entry}: ${run.stderr}`);
      assert.equal(run.status, 1, `${entry}: ${run.stderr}`);
      assert.match(run.stderr, new RegExp(refusal, "u"), `${entry} must reach its own argument check`);
    }
  }

  await mkdir(join(installRoot, "updater-state")); await writeFile(join(bootstrap, "github-read.token"), "token-one\n", { mode: 0o600 });
  const remoteUrl = "https://github.com/AgenticBotSitter/agent-control-room.git";
  await assert.rejects(adoptBootstrapV1({ root: installRoot, bootstrapRoot: bootstrap, transactionId,
    remoteUrl: "https://evil.example/AgenticBotSitter/agent-control-room.git" }, { expectedUid: process.geteuid() }),
  /bootstrap_adoption_refused/u);
  assert.equal(await readFile(join(bootstrap, "github-read.token"), "utf8"), "token-one\n");
  assert.equal((await lstat(join(bootstrap, "mirror.git"))).isDirectory(), true);
  const first = await adoptBootstrapV1({ root: installRoot, bootstrapRoot: bootstrap, transactionId, remoteUrl },
    { expectedUid: process.geteuid() });
  assert.deepEqual(first.movedAside, []);
  assert.deepEqual(JSON.parse(await readFile(join(installRoot, "updater-state/source.json"), "utf8")),
    { schema: "control-room.attended-source/v1", remoteUrl });
  const secondBootstrap = join(base, "bootstrap-two"); await mkdir(join(secondBootstrap, "mirror.git"), { recursive: true });
  await writeFile(join(secondBootstrap, "github-read.token"), "token-two\n", { mode: 0o600 });
  const second = await adoptBootstrapV1({ root: installRoot, bootstrapRoot: secondBootstrap,
    transactionId: "b1234567-1234-4123-8123-123456789abc", remoteUrl }, { expectedUid: process.geteuid() });
  assert.equal(second.movedAside.length, 1); assert.equal(await readFile(join(installRoot, "updater-state/github-read.token"), "utf8"), "token-two\n");
  await assert.rejects(lstat(join(installRoot, "updater-state/.github-read.token-b1234567-1234-4123-8123-123456789abc")),
    { code: "ENOENT" });
  await removeAdoptedBootstrapV1(installRoot);
});

test("bootstrap adoption falls back to no-follow copying across volumes", async t => {
  const base = await realpath(await mkdtemp("/private/tmp/control-room-adopt-exdev-")); t.after(() => cleanup(base));
  const root = join(base, "install"), bootstrap = join(base, "bootstrap"), mirror = join(bootstrap, "mirror.git");
  await mkdir(join(root, "updater-state"), { recursive: true }); await mkdir(join(mirror, "objects"), { recursive: true });
  await writeFile(join(mirror, "HEAD"), "ref: refs/heads/main\n"); await writeFile(join(mirror, "objects/fixture"), "object\n");
  await writeFile(join(bootstrap, "github-read.token"), "token-one\n", { mode: 0o600 });
  let crossVolumeAttempts = 0;
  const adopted = await adoptBootstrapV1({ root, bootstrapRoot: bootstrap, transactionId: "c1234567",
    remoteUrl: "https://github.com/AgenticBotSitter/agent-control-room.git" }, { expectedUid: process.geteuid(),
    async rename(from, to) { crossVolumeAttempts += 1; throw Object.assign(new Error(`${from}:${to}`), { code: "EXDEV" }); } });
  assert.equal(crossVolumeAttempts, 2); assert.equal(adopted.source, true);
  assert.equal(await readFile(join(root, "updater-state/mirror.git/objects/fixture"), "utf8"), "object\n");
  await assert.rejects(lstat(join(bootstrap, "mirror.git")), { code: "ENOENT" });
});

async function bundleFixture(t) {
  const root = await realpath(await mkdtemp("/private/tmp/control-room-handoff-test-")); t.after(() => cleanup(root));
  const target = join(root, "updater", "1.0.0-aaaaaaaaaaaa"), lib = join(target, "lib"); await mkdir(lib, { recursive: true });
  const modulePath = join(lib, "install-steps.mjs"); await writeFile(modulePath,
    "export async function continueInstallV1(){return {loaded:true};} export function createStageOnePortsV1(value){return value;}\n",
    { mode: 0o500 });
  await chmod(modulePath, 0o500);
  const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: [{ path: "lib/install-steps.mjs",
    sha256: sha256(await readFile(modulePath)), mode: 0o500, type: "file" }] };
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o400 });
  await chmod(lib, 0o500); await chmod(target, 0o500);
  return { root, target, lib, modulePath, manifest, digest: sha256(Buffer.from(JSON.stringify(manifest))), uid: process.geteuid() };
}

test("hand-off rehashes the confirmed bundle and rejects one byte or a symlinked module ancestor", async t => {
  const good = await bundleFixture(t);
  const loaded = await loadInstallStepsV1({ updaterTarget: good.target, expectedDigest: good.digest }, { expectedUid: good.uid });
  assert.equal((await loaded.continueInstallV1({})).loaded, true);
  await chmod(good.target, 0o700); await chmod(good.lib, 0o700); await chmod(good.modulePath, 0o700);
  await writeFile(good.modulePath,
    "export async function continueInstallV1(){return {loaded:false};} export function createStageOnePortsV1(value){return value;}\n",
    { mode: 0o500 });
  await chmod(good.modulePath, 0o500);
  good.manifest.files[0].sha256 = sha256(await readFile(good.modulePath));
  await chmod(join(good.target, "manifest.json"), 0o600);
  await writeFile(join(good.target, "manifest.json"), `${JSON.stringify(good.manifest)}\n`, { mode: 0o400 });
  await assert.rejects(loadInstallStepsV1({ updaterTarget: good.target, expectedDigest: good.digest }, { expectedUid: good.uid }),
    /updater_bundle_digest_refused/u);

  const writable = await bundleFixture(t); await chmod(writable.lib, 0o777);
  await assert.rejects(loadInstallStepsV1({ updaterTarget: writable.target, expectedDigest: writable.digest }, {
    expectedUid: writable.uid,
  }), /install_steps_refused/u);

  const linked = await bundleFixture(t), outside = join(linked.root, "outside"); await cp(linked.lib, outside, { recursive: true });
  await chmod(linked.target, 0o700); await chmod(linked.lib, 0o700);
  await rm(linked.lib, { recursive: true }); await symlink(outside, linked.lib);
  await assert.rejects(loadInstallStepsV1({ updaterTarget: linked.target, expectedDigest: linked.digest }, {
    expectedUid: linked.uid, verifyBundle: async () => linked.digest,
  }),
    /updater_bundle_manifest_refused|install_steps_refused/u);
  await rm(linked.lib); await chmod(outside, 0o700); await chmod(join(outside, "install-steps.mjs"), 0o700);
});

test("hand-off refuses a version directory owned by a different uid", async t => {
  const fixture = await bundleFixture(t);
  await assert.rejects(loadInstallStepsV1({ updaterTarget: fixture.target, expectedDigest: fixture.digest }, {
    expectedUid: process.getuid(), async lstat(path) {
      const entry = await lstat(path);
      if (path !== fixture.target) return entry;
      return new Proxy(entry, { get(target, property) {
        if (property === "uid") return process.getuid() + 1;
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  }), /install_steps_refused/u);
});

test("R5G bootstrap early refusals put a plain recovery line before the retained code", async t => {
  const early = spawnSync("/bin/sh", [bootstrapSource, "bad", "/fixture/bootstrap"], { encoding: "utf8" });
  assert.equal(early.status, 1);
  assert.match(early.stderr, /^The install line was not accepted\. The installer has not started\..*Do not retry.*\nbootstrap_commit_refused\n/u);
  const wrongFlag = spawnSync("/bin/sh", [bootstrapSource, commit, "/fixture/bootstrap", "--typo", "yes"], { encoding: "utf8" });
  assert.match(wrongFlag.stderr, /^The install line.*\nbootstrap_arguments_refused\n/u);
  const fixture = await harness(t);
  for (const tokenText of ["", "bad token"]) {
    const rejected = await makeRun(fixture, { token: false, tokenText });
    assert.match(rejected.result.stderr, /^The read token was empty or not accepted\..*Do not retry.*\nbootstrap_token_refused\n/u);
    await assert.rejects(lstat(rejected.root), { code: "ENOENT" });
  }
  const stopped = await makeRun(fixture, { token: false, FAKE_FAIL_TOOL: "stty" });
  assert.match(stopped.result.stderr, /^Preparation stopped\..*Do not retry.*\nbootstrap_terminal_refused\n/u);
});
