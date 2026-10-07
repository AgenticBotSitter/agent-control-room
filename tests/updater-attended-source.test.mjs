import { publishLocalFixtureV1 } from "./support/publish-local-fixture.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  abortAttendedV1, buildFixedBundleV1, buildReleaseV1, classifyAttendedSourceV1, confirmAttendedV1, fetchVerifiedSourceV1, installAttendedCommitV1,
  isAttendedDatabasePathV1,
  parseAttendedTreeV1, parseBuilderPidsV1, crontabStateV1, runningBundleDigestV1, stageReleaseV1, stageUpdaterBundleV1, switchPairV1,
  validateResolvedBuilderIdentityV1,
} from "../src/updater/v1/attended-source.mjs";
import { buildAttendedReleaseV1 } from "../src/updater/v1/build-attended-release.mjs";
import { buildFleetConnectorReleaseFromVerifiedSourceV1 } from "../scripts/build-fleet-connector.mjs";
import { generateInstallationReleaseKeyV1 } from "../scripts/release-signing.mjs";
import { loadInstallStepsV1 } from "../src/updater/v1/install/bootstrap.mjs";

const exec = promisify(execFile);
// The updater resolves git through xcrun on the Mac. The mutation-checks job runs
// this file's classifier tests on Ubuntu, where git is simply on PATH.
const gitPath = process.platform === "darwin" ? (await exec("/usr/bin/xcrun", ["--find", "git"])).stdout.trim()
  : (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();

async function git(cwd, ...args) { return (await exec(gitPath, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" } })).stdout.trim(); }
async function gitStdin(cwd, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(gitPath, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolvePromise(stdout.trim())
      : reject(new Error(`git failed: ${stderr}`))); child.stdin.end(input);
  });
}

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "attended-source-"));
  t.after(async () => {
    async function writable(path) {
      const entry = await lstat(path).catch(() => null); if (!entry) return;
      if (entry.isSymbolicLink()) return;
      if (entry.isDirectory()) { await chmod(path, 0o700); for (const name of await import("node:fs/promises").then(fs => fs.readdir(path)))
        await writable(join(path, name)); }
      else await chmod(path, 0o600).catch(() => {});
    }
    await writable(temporary); await rm(temporary, { recursive: true, force: true });
  });
  const repository = join(temporary, "repository"), remote = join(temporary, "remote.git"), root = join(temporary, "root");
  await mkdir(repository); await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.email", "builder@example.invalid"); await git(repository, "config", "user.name", "Builder");
  await mkdir(join(repository, "src/updater/v1"), { recursive: true });
  // The crossed-in cluster layout goes in the BASE fixture, not only in
  // `prepareDefaultBundlePath`. MEASURED: staging it only in the one fixture that runs
  // the builder left every OTHER test in this file answering
  // `updater_bundle_input_refused` at the staging step - eight tests, all of which
  // failed before reaching the behaviour they exist to check. The staging list is
  // correct (the builder cannot read the file otherwise), so the fix belongs where the
  // file is produced, and that is every repository this fixture builds.
  await mkdir(join(repository, "src/pg-runtime/v1"), { recursive: true });
  await copyFile(join(process.cwd(), "src/pg-runtime/v1/pg-cluster-layout.ts"),
    join(repository, "src/pg-runtime/v1/pg-cluster-layout.ts"));
  // The SECOND file `FIXED_BUNDLE_INPUTS` stages from outside `src/updater/v1`, and
  // it needs the same treatment for the same reason: the builder reads it from the
  // source tree by path, so a fixture repository without it refuses every test in
  // this file at the staging step with `updater_bundle_input_refused` — the exact
  // symptom the note above was written about, one file over.
  await mkdir(join(repository, "src/installer/shared"), { recursive: true });
  for (const name of ["is-main-module", "strict-json", "rehearsal-hostname", "file-custody", "private-process-lock", "jsonl-prefix", "vapid"])
    await copyFile(join(process.cwd(), `src/installer/shared/${name}.mjs`),
      join(repository, `src/installer/shared/${name}.mjs`));
  // The THIRD and fourth files `FIXED_BUNDLE_INPUTS` stages from outside
  // `src/updater/v1`. MEASURED: without this line the whole attended-source lane
  // answered `updater_bundle_input_refused` from `copyRootHeldInput` — the staged
  // repository has to carry every file the staging list names, and adding one to
  // the list without adding it to the fixture breaks NINE tests across this file,
  // `tests/updater-attended-release-programs.test.mjs` and
  // `tests/helpers/updater-attended-sigkill-runner.mjs`'s callers. The fixture is
  // the same discipline `tests/updater-fixed-bundle.test.mjs` follows: stage the
  // same set a real build has, so a missing input is a build failure rather than
  // an accident of the fixture.
  await mkdir(join(repository, "src/installer/v1"), { recursive: true });
  await copyFile(join(process.cwd(), "src/installer/v1/nightly-backup-recency.ts"),
    join(repository, "src/installer/v1/nightly-backup-recency.ts"));
  await writeFile(join(repository, "package.json"), '{"name":"control-room","version":"1.2.3"}\n');
  await writeFile(join(repository, "app.txt"), "checked source\n");
  await writeFile(join(repository, "app-copy.txt"), "checked source\n");
  await mkdir(join(repository, "db/migrations"), { recursive: true });
  await writeFile(join(repository, "db/migrations/0001.sql"), "select 1;\n");
  await writeFile(join(repository, "src/updater/v1/updater.mjs"), "export const checked = true;\n");
  await mkdir(join(repository, "scripts/updater"), { recursive: true });
  await copyFile(join(process.cwd(), "scripts/release-signing.mjs"), join(repository, "scripts/release-signing.mjs"));
  await writeFile(join(repository, "scripts/updater/build-fixed-updater-bundle.mjs"), "export const checked = true;\n");
  await mkdir(join(repository, "updater-bundle")); await writeFile(join(repository, "updater-bundle/evil.mjs"), "throw new Error('candidate output');\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "initial");
  const commit = await git(repository, "rev-parse", "HEAD");
  await exec(gitPath, ["init", "--bare", remote]); await git(repository, "remote", "add", "origin", `file://${remote}`);
  await publishLocalFixtureV1(repository);
  for (const path of ["updater-state/plans", "updater-state/confirmations", "build", "releases", "updater", "trusted"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "updater-state/self-update"), "Off\n", { mode: 0o600 });
  const credential = join(root, "updater-state/github-read.token"); await writeFile(credential, "fake-read-token\n", { mode: 0o600 });
  const helper = join(root, "trusted/git-credential-control-room");
  await copyFile(join(process.cwd(), "src/updater/v1/bin/git-credential-control-room"), helper); await chmod(helper, 0o500);
  const fake = join(temporary, "fake-build.mjs");
  await writeFile(fake, `#!${process.execPath}
import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import {chmod,mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
let [mode,out,commit,extra]=process.argv.slice(2);if(mode==='fetch'){await mkdir(join(process.cwd(),'node_modules/.pnpm'),{recursive:true});process.exit(0);}if(mode==='bundle'&&(await import('node:fs')).existsSync(join(process.cwd(),'src/updater/v1/node_modules'))){process.stderr.write('updater_bundle_source_modules_refused\\n');process.exit(1);}if(mode==='install'){await mkdir(join(process.cwd(),'node_modules'),{recursive:true});await writeFile(join(process.cwd(),'node_modules/.package-map.json'),'{}\\n');process.exit(0);}if(mode==='run'){await mkdir(join(process.cwd(),'dist-vps/client'),{recursive:true});await writeFile(join(process.cwd(),'dist-vps/client/generated.js'),'generated\\n');process.exit(0);}if(out==='AUTO')out=join(process.cwd(),'..','output');if(out==='AUTO_BUNDLE')out=join(process.cwd(),'..','bundle');const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
if(mode==='sleep'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
if(mode==='linger'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await writeFile(extra,String(child.pid));process.exit(0);}
if(mode==='daemon'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();await writeFile(extra,String(child.pid));mode='build';extra='';}
await mkdir(out,{recursive:true});if(mode==='bundle'){const body=Buffer.from('export const fixed=true;\\n');await writeFile(join(out,'updater.mjs'),body,{mode:0o500});await chmod(join(out,'updater.mjs'),0o500);const m={schema:'control-room.updater-bundle-manifest/v1',files:[{path:'updater.mjs',sha256:digest(body),mode:0o500,type:'file'}]};await writeFile(join(out,'manifest.json'),JSON.stringify(m),{mode:0o400});}
else {const body=Buffer.from('{"name":"control-room"}\\n');await writeFile(join(out,'package.json'),body,{mode:0o400});await chmod(join(out,'package.json'),0o400);const m={schema:'control-room.attended-build-manifest/v1',commit,version:'1.2.3',fileCount:1,byteCount:body.length,files:[{path:'package.json',sha256:digest(body),mode:0o400,bytes:body.length}]};await writeFile(join(out,'RELEASE_MANIFEST.json'),JSON.stringify(m),{mode:0o400});if(mode==='extra')await writeFile(join(out,'not-in-manifest'),'bad');if(extra)try{await writeFile(extra,'escaped');}catch{}}
`);
  await chmod(fake, 0o500);
  const identities = { rootUid: process.getuid(), rootGid: process.getgid(), builderUid: process.getuid(),
    builderGid: process.getgid(), serviceGid: process.getgid(), builderAccount: "_crbuild" };
  const spawned = [], events = [];
  const builderProcessControl = { async listPids() { return []; }, async hasScheduledEntries() { return false; },
    async killPid() { throw new Error("fixture has no builder process to kill"); } };
  const base = { root, commit, remoteUrl: `file://${remote}`, allowFileRemote: true, credentialPath: credential, identities,
    tools: { git: gitPath, tar: "/usr/bin/tar", helper, node: process.execPath, pnpm: process.execPath,
      buildEntry: fake, bundleEntry: fake }, onSpawn: call => { spawned.push(call); events.push("spawn"); },
    trustedRuntimeVerifier: async () => { events.push("t1"); return {}; }, builderProcessControl,
    fetchSteps: [], buildSteps: [{ file: process.execPath, args: [fake, "build", "AUTO", commit] }],
    bundleFetchStep: null, bundleStep: null };
  const materialize = (overrides = {}) => {
    const value = { ...base, ...overrides };
    value.fetchSteps = overrides.fetchSteps ?? [];
    value.buildSteps = overrides.buildSteps ?? [{ file: process.execPath,
      args: [fake, overrides.buildMode ?? "build", "AUTO", commit, overrides.outside ?? ""] }];
    value.bundleFetchStep = overrides.bundleFetchStep ?? null;
    value.bundleStep = { file: process.execPath, args: [fake, "bundle", "AUTO_BUNDLE", commit] };
    return value;
  };
  return { temporary, repository, remote, root, commit, credential, helper, fake, spawned, events, materialize };
}

async function authorize(root, { planDigest }) {
  const index = JSON.parse(await readFile(join(root, "updater-state/open-confirmation.json"), "utf8"));
  await writeFile(join(root, `updater-state/confirmations/${index.planId}.json`), `${JSON.stringify({
    schema: "control-room.mac-confirmation/v1", planId: index.planId, planDigest, confirmed: true,
  })}\n`);
}

async function fileInventory(root) {
  const result = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), entry = await lstat(path);
      if (entry.isDirectory()) await visit(path);
      else result.push(path.slice(root.length + 1));
    }
  }
  await visit(root); return result;
}

async function prepareDefaultBundlePath(f) {
  await rm(join(f.repository, "src/updater/v1"), { recursive: true, force: true });
  await cp(join(process.cwd(), "src/updater/v1"), join(f.repository, "src/updater/v1"), { recursive: true });
  await mkdir(join(f.repository, "scripts/updater"), { recursive: true });
  await copyFile(join(process.cwd(), "scripts/updater/build-fixed-updater-bundle.mjs"),
    join(f.repository, "scripts/updater/build-fixed-updater-bundle.mjs"));
  // `src/pg-runtime/v1/pg-cluster-layout.ts` was already committed by the base
  // fixture, which is where it belongs: every test in this file builds a repository, and
  // only the tests that reach the fixed-bundle builder need the file staged. See the
  // base fixture's note.
  await git(f.repository, "add", "."); await git(f.repository, "commit", "-m", "production bundle inputs");
  await publishLocalFixtureV1(f.repository);
  // The COMMIT must actually contain it, asserted here rather than discovered three
  // processes later as a bare `ENOENT` naming no missing path. The builder reads this
  // file from the `--source` tree it is given, and that tree is an archive of this
  // commit, so a file missing from the commit is a file the builder cannot find - and
  // `git archive` of a commit that omits it is indistinguishable, from the builder's
  // side, from a builder bug.
  //
  // MEASURED: an earlier version of this assertion ran BEFORE `git add .`, so
  // `ls-files` listed the index rather than the commit and the assertion was false
  // for a repository that did contain the file. It is after the commit for that reason.
  assert.ok((await git(f.repository, "ls-tree", "-r", "--name-only", "HEAD"))
    .includes("src/pg-runtime/v1/pg-cluster-layout.ts"),
    "the crossed-in cluster layout must be committed for the builder to read it");
  const commit = await git(f.repository, "rev-parse", "HEAD");

  const bootstrap = join(f.root, "updater/bootstrap");
  await mkdir(join(bootstrap, "bin"), { recursive: true }); await mkdir(join(bootstrap, "policy"));
  await copyFile(f.helper, join(bootstrap, "bin/git-credential-control-room"));
  await chmod(join(bootstrap, "bin/git-credential-control-room"), 0o500);
  const buildEntry = join(bootstrap, "bin/build-attended-release.mjs");
  await writeFile(buildEntry, `#!${process.execPath}
import{createHash}from'node:crypto';import{chmod,mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';
const a=process.argv.slice(2),get=n=>a[a.indexOf(n)+1],out=get('--output'),commit=get('--commit');await mkdir(join(out,'scripts'),{recursive:true});const body=Buffer.from('{"name":"control-room"}\\n'),start=Buffer.from('#!/bin/sh\\nexit 0\\n'),digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');await writeFile(join(out,'package.json'),body,{mode:0o400});await chmod(join(out,'package.json'),0o400);await writeFile(join(out,'scripts/start.sh'),start,{mode:0o500});await chmod(join(out,'scripts/start.sh'),0o500);await writeFile(join(out,'RELEASE_MANIFEST.json'),JSON.stringify({schema:'control-room.attended-build-manifest/v1',commit,version:'1.2.3',fileCount:2,byteCount:body.length+start.length,files:[{path:'package.json',sha256:digest(body),mode:0o400,bytes:body.length},{path:'scripts/start.sh',sha256:digest(start),mode:0o500,bytes:start.length}]}),{mode:0o400});
`); await chmod(buildEntry, 0o500);
  await copyFile(join(process.cwd(), "scripts/updater/build-fixed-updater-bundle.mjs"),
    join(bootstrap, "bin/build-fixed-bundle.mjs")); await chmod(join(bootstrap, "bin/build-fixed-bundle.mjs"), 0o500);
  await copyFile(join(process.cwd(), "src/updater/v1/policy/bundle.json"), join(bootstrap, "policy/bundle.json"));
  await chmod(join(bootstrap, "policy/bundle.json"), 0o400);
  await chmod(join(bootstrap, "bin"), 0o500); await chmod(join(bootstrap, "policy"), 0o500); await chmod(bootstrap, 0o500);
  await symlink("bootstrap", join(f.root, "updater/current"));

  const pnpm = join(f.root, "runtime/pnpm-current/pnpm"), esbuild = join(f.root, "runtime/esbuild-current/esbuild");
  await mkdir(dirname(pnpm), { recursive: true }); await mkdir(dirname(esbuild), { recursive: true });
  await copyFile(f.fake, pnpm); await chmod(pnpm, 0o555);
  await writeFile(esbuild, `#!${process.execPath}
	import{chmod,mkdir,writeFile}from'node:fs/promises';import{dirname}from'node:path';const out=process.argv.find(v=>v.startsWith('--outfile=')).slice(10);await mkdir(dirname(out),{recursive:true});const body=out.endsWith('/lib/install-steps.mjs')?'export async function continueInstallV1(){return {loaded:true};} export function createStageOnePortsV1(value){return value;}\\n':out.endsWith('/init-database.mjs')||out.endsWith('/apply-release-schema.mjs')?'export const phase=true;\\n':'export const fixed=true;\\n';await writeFile(out,body,{mode:0o500});await chmod(out,0o500);
`); await chmod(esbuild, 0o555);
  return { commit, trustedRuntime: { developerTools: { tools: { git: gitPath } },
    tools: { node: { executable: process.execPath }, pnpm: { executable: pnpm } } } };
}

test("the attended source library fetches a local bare mirror, confirms the root summary, and adopts only verified output", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "updater-state/root-owned-sentinel");
  await writeFile(outside, "unchanged\n", { mode: 0o400 });
  const input = f.materialize({ outside });
  delete input.fetchSteps; delete input.bundleFetchStep; input.tools = { ...input.tools, pnpm: f.fake };
  input.authorize = value => authorize(f.root, value);
  // Use the library once to prove the full local-remote path; CLI confirmation is covered separately below.
  const result = await installAttendedCommitV1(input);
  assert.equal(f.events[0], "t1", "the runtime is verified before the first child process is spawned");
  assert.equal(result.commit, f.commit); assert.equal(await readlink(join(f.root, "current")), `releases/${result.releaseId}`);
  const installedPlan = JSON.parse(await readFile(join(f.root, `updater-state/plans/${result.planId}.json`), "utf8"));
  assert.deepEqual(installedPlan.classes, ["code", "database", "protected", "updater"]);
  assert.match(await readFile(join(f.root, `releases/${result.releaseId}/package.json`), "utf8"), /control-room/u);
  assert.equal(await readFile(join(f.root, `updater/1.2.3-${f.commit.slice(0, 12)}/updater.mjs`), "utf8"),
    "export const fixed=true;\n");
  await assert.rejects(readFile(join(f.root, `updater/1.2.3-${f.commit.slice(0, 12)}/evil.mjs`)), /ENOENT/u);
  assert.equal(await readFile(outside, "utf8"), "unchanged\n", "the builder could not write the root-held outside target");
  assert.deepEqual(await import("node:fs/promises").then(fs => fs.readdir(join(f.root, "build"))), []);
  const commandText = JSON.stringify(f.spawned); assert.doesNotMatch(commandText, /fake-read-token/u);
  assert.ok(f.spawned.every(call => !Object.values(call.env ?? {}).some(value => String(value).includes("fake-read-token"))));
  const builderCalls = f.spawned.filter(call => call.file === process.execPath);
  assert.ok(builderCalls.length >= 2 && builderCalls.every(call => call.uid === process.getuid()
    && call.gid === process.getgid()), "every build child uses only the configured builder identity");
  const fetchCalls = f.spawned.filter(call => call.file === f.fake && call.args[0] === "fetch");
  assert.equal(fetchCalls.length, 2); assert.ok(fetchCalls.every(call => call.args.includes("--ignore-scripts")
    && call.args.includes("--frozen-lockfile") && !call.args.includes("--offline")));

});

test("the default tools path completes with generated outputs and simulated separate root and builder identities", async t => {
  const f = await fixture(t), prepared = await prepareDefaultBundlePath(f), inspected = [], ownership = [];
  const rootUid = process.getuid(), rootGid = process.getgid(), builderUid = rootUid + 10_000, builderGid = rootGid + 10_000;
  const originalToolRoot = await realpath(join(f.root, "updater/bootstrap"));
  const virtualOwner = path => {
    const change = [...ownership].reverse().find(item => path === item.path || path.startsWith(`${item.path}/`));
    return change ? { uid: change.uid, gid: change.gid } : { uid: rootUid, gid: rootGid };
  };
  const input = f.materialize({ identities: { rootUid, rootGid, builderUid, builderGid,
    serviceGid: rootGid, builderAccount: "_crbuild" },
  async changeOwnership(path, uid, gid) { ownership.push({ path, uid, gid }); },
  async commandRunner(file, args, options) {
    options.onSpawn?.({ file, args: [...args], cwd: options.cwd, env: { ...options.env }, uid: options.uid, gid: options.gid });
    if (options.uid === builderUid) {
      const protectedArguments = [file, ...args].filter(value => typeof value === "string"
        && (value === originalToolRoot || value.startsWith(`${originalToolRoot}/`)));
      assert.deepEqual(protectedArguments, [], "the simulated builder cannot receive a root-only updater path");
      for (const value of [file, ...args].filter(item => typeof item === "string"
        && /build-(?:attended-release|fixed-bundle)\.mjs$|builder-tools\/policy\/bundle\.json$/u.test(item))) {
        assert.equal(virtualOwner(value).uid, builderUid, `the simulated builder owns ${value}`);
        const entry = await lstat(value); assert.ok((entry.mode & 0o400) !== 0, "the staged input is builder-readable");
      }
    }
    const result = await exec(file, args, { cwd: options.cwd, env: options.env, maxBuffer: 8 * 1024 * 1024 });
    return { ...result, code: 0 };
  },
  hooks: { async beforeCandidateFinalVerification() {
    assert.equal(await readFile(join(f.root, "build", (await readdir(join(f.root, "build")))[0],
      "src/node_modules/.package-map.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(f.root, "build", (await readdir(join(f.root, "build")))[0],
      "src/dist-vps/client/generated.js"), "utf8"), "generated\n");
  }, async beforeFixedBundleBuild({ source, candidateSource }) {
    const expected = (await fileInventory(join(f.repository, "src/updater/v1")))
      .map(path => `src/updater/v1/${path}`);
    expected.push("scripts/updater/build-fixed-updater-bundle.mjs", "scripts/release-signing.mjs");
    // The two files `FIXED_BUNDLE_INPUTS` stages from outside `src/updater/v1`,
    // because the fixed-step builder reads them from the source tree by path (see
    // `attended-source.mjs`).
    //
    // MEASURED, and the assertion earning its keep three times in one tree. Without
    // the staging lines the builder failed with a bare `ENOENT` naming no missing
    // path; with a staging line but without this inventory entry the same assertion
    // failed with `+ actual - expected ... 'src/pg-runtime/…'`, i.e. present but
    // unlisted. That is the inventory doing its job: an input the assertion does not
    // name is an input the assertion cannot vouch for, and these two exist precisely
    // to prove the scratch tree holds only reviewed fixed-step inputs.
    expected.push("src/pg-runtime/v1/pg-cluster-layout.ts");
    expected.push("src/installer/shared/is-main-module.mjs", "src/installer/shared/strict-json.mjs",
      "src/installer/shared/rehearsal-hostname.mjs",
      "src/installer/shared/file-custody.mjs");
    expected.push("src/installer/shared/private-process-lock.mjs");
    expected.push("src/installer/v1/nightly-backup-recency.ts", "src/installer/shared/jsonl-prefix.mjs", "src/installer/shared/vapid.mjs");
    expected.sort();
    assert.deepEqual((await fileInventory(source)).sort(), expected, "the builder scratch tree contains only fixed-step inputs");
    assert.deepEqual((await readdir(source)).sort(), ["scripts", "src"]);
    async function inspect(directory) {
      const entry = await lstat(directory);
      assert.equal(virtualOwner(directory).uid, builderUid); assert.ok((entry.mode & 0o100) !== 0, "builder owns searchable directories");
      for (const name of await readdir(directory)) {
        const path = join(directory, name), child = await lstat(path);
        if (child.isDirectory()) await inspect(path);
        else { assert.equal(virtualOwner(path).uid, builderUid); assert.ok((child.mode & 0o400) !== 0, "builder owns readable files"); }
      }
    }
    await inspect(source);
    const candidate = await lstat(candidateSource);
    assert.equal(virtualOwner(candidateSource).uid, rootUid);
    assert.equal(candidate.mode & 0o777, 0o700, "the root-held candidate remains closed to the builder");
    inspected.push({ source, candidateSource });
  } } });
  input.commit = prepared.commit; input.trustedRuntimeVerifier = async () => prepared.trustedRuntime;
  delete input.tools; delete input.fetchSteps; delete input.buildSteps; delete input.bundleFetchStep; delete input.bundleStep;
  input.authorize = value => authorize(f.root, value);
  const result = await installAttendedCommitV1(input);
  assert.equal(result.commit, prepared.commit); assert.equal(inspected.length, 1);
  const call = f.spawned.find(item => item.args?.[0]?.endsWith("/builder-tools/bin/build-fixed-bundle.mjs"));
  assert.ok(call, "the default production fixed-bundle entry actually ran");
  assert.equal(call.cwd, inspected[0].source); assert.ok(call.args.includes(inspected[0].source));
  assert.ok(!call.args.includes(inspected[0].candidateSource), "the fixed step receives no candidate-tree path");
  const toolEntries = f.spawned.flatMap(item => item.args ?? []).filter(value =>
    typeof value === "string" && /build-(?:attended-release|fixed-bundle)\.mjs$/u.test(value));
  assert.equal(toolEntries.length, 2);
  assert.ok(toolEntries.every(value => value.includes("/builder-tools/bin/")),
    "every builder-side program comes from the builder-owned scratch");
  assert.ok(f.spawned.some(item => item.args?.[0] === "install" && item.args.includes("--offline")));
  assert.ok(f.spawned.some(item => item.args?.[0] === "run" && item.args?.[1] === "build"));
  assert.match(await readFile(join(f.root, `updater/1.2.3-${prepared.commit.slice(0, 12)}/updater.mjs`), "utf8"),
    /fixed=true/u);
  const updaterTarget = await realpath(join(f.root, "updater/current"));
  const loaded = await loadInstallStepsV1({ updaterTarget, expectedDigest: result.updaterBundleDigest },
    { expectedUid: process.getuid() });
  assert.equal(loaded.bundleDigest, result.updaterBundleDigest,
    "the real stage preserves the fixed-bundle manifest modes through the hand-off");
  assert.equal(await runningBundleDigestV1({ root: f.root }), result.updaterBundleDigest,
    "the running updater accepts the same staged bytes and modes");
  const releaseTarget = await realpath(join(f.root, "current"));
  assert.equal((await lstat(join(releaseTarget, "package.json"))).mode & 0o777, 0o440,
    "the staged release remains readable by its service group");
  assert.equal((await lstat(join(releaseTarget, "scripts/start.sh"))).mode & 0o777, 0o550,
    "the staged release keeps executable files executable for its service group");
  assert.equal((await lstat(join(updaterTarget, "policy/service-supervisor.sb"))).mode & 0o777, 0o440,
    "the service account can open its sandbox profile after launchd drops privileges");
  // The DATABASE account is neither the owner (root) nor in the service group, and
  // `sandbox-exec` opens the profile with that account's rights (init-database,
  // apply-release-schema and the database LaunchDaemon all do). So from the bundle
  // root down, every directory needs the other-search bit and the profile the
  // other-read bit -- and nothing else in `policy/` may become other-readable, and
  // nothing may become writable beyond root.
  const otherReachable = async (base, relativePath) => {
    let path = base;
    for (const part of ["", ...relativePath.split("/")]) {
      path = part ? join(path, part) : path;
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory() ? (entry.mode & 0o001) === 0 : (entry.mode & 0o004) === 0) return false;
    }
    return true;
  };
  assert.equal(await otherReachable(updaterTarget, "policy/service-postgres.sb"), true,
    "the database account (not in the service group) can open its own Seatbelt profile");
  assert.equal((await lstat(join(updaterTarget, "policy"))).mode & 0o777, 0o551,
    "policy/ is searchable but not listable by other accounts");
  assert.equal((await lstat(join(updaterTarget, "policy/service-postgres.sb"))).mode & 0o777, 0o444,
    "the PostgreSQL profile is read-only for everyone and writable by nobody");
  for (const name of await readdir(join(updaterTarget, "policy"))) {
    if (name === "service-postgres.sb") continue;
    assert.equal(await otherReachable(updaterTarget, `policy/${name}`), false, `policy/${name} stays private`);
  }
  for (const [name, mode] of [["", 0o551], ["policy", 0o551], ["lib", 0o550], ["bin", 0o550]]) {
    assert.equal((await lstat(join(updaterTarget, name))).mode & 0o777, mode, `updater/${name || "."} mode`);
  }
});

test("post-build source verification refuses a changed archived file before adoption", async t => {
  const f = await fixture(t);
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ hooks: {
    async beforeCandidateFinalVerification() {
      const [job] = await readdir(join(f.root, "build"));
      await writeFile(join(f.root, "build", job, "src/app.txt"), "changed after build\n");
    },
  } }), authorize: value => authorize(f.root, value) }), /updater_archive_tree_mismatch/u);
  assert.deepEqual(await readdir(join(f.root, "build")), []);
});

test("an owner-writable toolRoot is refused before a builder program executes", async t => {
  const f = await fixture(t), prepared = await prepareDefaultBundlePath(f), input = f.materialize();
  input.commit = prepared.commit; input.trustedRuntimeVerifier = async () => prepared.trustedRuntime;
  delete input.tools; delete input.fetchSteps; delete input.buildSteps; delete input.bundleFetchStep; delete input.bundleStep;
  input.authorize = value => authorize(f.root, value);
  await chmod(join(f.root, "updater/bootstrap"), 0o755);
  await assert.rejects(installAttendedCommitV1(input), /updater_tool_root_refused/u);
  assert.equal(f.spawned.length, 0);
});

test("a toolRoot program symlink is refused before a builder program executes", async t => {
  const f = await fixture(t), prepared = await prepareDefaultBundlePath(f), input = f.materialize();
  input.commit = prepared.commit; input.trustedRuntimeVerifier = async () => prepared.trustedRuntime;
  delete input.tools; delete input.fetchSteps; delete input.buildSteps; delete input.bundleFetchStep; delete input.bundleStep;
  input.authorize = value => authorize(f.root, value);
  const root = join(f.root, "updater/bootstrap"), bin = join(root, "bin"), entry = join(bin, "build-attended-release.mjs");
  await chmod(root, 0o755); await chmod(bin, 0o755); await rm(entry); await symlink(f.fake, entry);
  await chmod(bin, 0o555); await chmod(root, 0o555);
  await assert.rejects(installAttendedCommitV1(input), /updater_tool_root_refused/u);
  assert.equal(f.spawned.length, 0);
});

test("the split pieces refuse a changed bundle digest and an escaping restore target", async t => {
  const f = await fixture(t), input = f.materialize();
  delete input.fetchSteps; delete input.bundleFetchStep; input.tools = { ...input.tools, pnpm: f.fake };
  const fetched = await fetchVerifiedSourceV1(input);
  try {
    await buildReleaseV1({ ...input, ...fetched });
    const bundle = await buildFixedBundleV1({ ...input, ...fetched });
    await assert.rejects(stageUpdaterBundleV1({ root: f.root, bundle, uver: bundle.uver,
      expectedDigest: `sha256:${"0".repeat(64)}` }), /updater_bundle_digest_refused/u);
  } finally { await abortAttendedV1(fetched); }
  await assert.rejects(switchPairV1({ root: f.root, restore: { oldCurrent: "../../outside",
    oldPrevious: null, oldUpdaterCurrent: null, oldUpdaterPrevious: null } }), /updater_release_pointer_refused/u);
});

test("the raw tree parser refuses .git, node_modules, symlink, and gitlink entries before archive", () => {
  const oid = "a".repeat(40), row = (mode, type, path) => `${mode} ${type} ${oid}\t${path}\0`;
  assert.throws(() => parseAttendedTreeV1(row("100644", "blob", ".git/config")), /updater_tree_dot_git_refused/u);
  assert.throws(() => parseAttendedTreeV1(row("100644", "blob", "x/node_modules/y")), /updater_tree_node_modules_refused/u);
  assert.throws(() => parseAttendedTreeV1(row("120000", "blob", "linked")), /updater_tree_symlink_refused/u);
  assert.throws(() => parseAttendedTreeV1(row("160000", "commit", "nested")), /updater_tree_gitlink_refused/u);
});

test("builder process discovery matches only the exact numeric uid", () => {
  assert.deepEqual(parseBuilderPidsV1(" 10 501\n 11 1501\n 12 501\n", 501), [10, 12]);
  assert.throws(() => parseBuilderPidsV1("not ps output\n", 501), /builder_left_process/u);
  // Exact macOS shape: dhcp6d runs as nobody, printed as uid -2. It is never the builder.
  assert.deepEqual(parseBuilderPidsV1(" 77687    -2\n 10 501\n", 501), [10]);
  assert.throws(() => parseBuilderPidsV1(" 10 --2\n", 501), /builder_left_process/u);
});

test("the fixed attended release builder emits only its reviewed manifest policy and refuses links", async t => {
  const root = await mkdtemp(join(tmpdir(), "attended-release-builder-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), output = join(root, "output"); await mkdir(source); await mkdir(output);
  const files = ["LICENSE", "NOTICE", "THIRD_PARTY.md", "package.json", "pnpm-lock.yaml", "deploy/operator-config.mjs",
    "deploy/agent-task-operator-config.mjs", "scripts/prepare-local-installation.mjs",
    "scripts/prepare-local-production-dependencies.mjs", "scripts/launch-local-setup.mjs",
    "scripts/initialize-local-installation-plan.mjs", "scripts/run-local-setup-host.mjs",
    "scripts/preflight-private-local-owner-host.mjs", "scripts/run-private-local-installation-operator.mjs",
    "scripts/run-private-vps.mjs", "scripts/activate-private-vps.mjs", "scripts/bootstrap-private-vps-owner.mjs",
    "scripts/check-private-vps-database.mjs", "deploy/FIRST_ACTIVATION.md",
    "scripts/mac-local/task-host-supervisor.mjs", "scripts/mac-local/stack.mjs",
    "scripts/mac-local/start-task-host.mjs", "scripts/mac-local/start-web-host.mjs",
    "src/installer/shared/is-main-module.mjs", "src/installer/shared/file-custody.mjs", "src/installer/shared/mac-local-runtime-directory.mjs",
    "src/installer/shared/private-process-lock.mjs", "src/installer/shared/backup-files.mjs",
    "src/installer/shared/nightly-backup-constants.mjs", "src/installer/shared/vapid.mjs"];
  for (const name of files) { await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), name === "package.json" ? '{"name":"control-room","version":"1.2.3"}\n' : `${name}\n`); }
  for (const name of ["db/migrations", "db/roles", "db/setup", "deploy/postgres", "dist-vps/client", "dist-vps/server", "third_party"]) {
    await mkdir(join(source, name), { recursive: true }); await writeFile(join(source, name, "entry"), `${name}\n`);
  }
  const commit = "a".repeat(40), manifest = await buildAttendedReleaseV1({ source, output, commit });
  assert.equal(manifest.fileCount, files.length + 7); assert.equal(manifest.commit, commit);
  assert.deepEqual((await import("node:fs/promises").then(fs => fs.readdir(output))).sort(),
    ["LICENSE", "NOTICE", "RELEASE_MANIFEST.json", "THIRD_PARTY.md", "db", "deploy", "dist-vps", "package.json",
      "pnpm-lock.yaml", "scripts", "src", "third_party"]);
  const linkedOutput = join(root, "linked-output"); await mkdir(linkedOutput); await rm(join(source, "LICENSE"));
  await symlink("NOTICE", join(source, "LICENSE"));
  await assert.rejects(buildAttendedReleaseV1({ source, output: linkedOutput, commit }), /updater_build_input_refused/u);
  const hardlinkedOutput = join(root, "hardlinked-output"); await mkdir(hardlinkedOutput); await rm(join(source, "LICENSE"));
  await link(join(source, "NOTICE"), join(source, "LICENSE"));
  await assert.rejects(buildAttendedReleaseV1({ source, output: hardlinkedOutput, commit }), /updater_build_input_refused/u);
});

test("hostile source trees, a moved main ref, and a wrong-mode credential fail closed", async t => {
  await t.test("symlink", async t2 => {
    const f = await fixture(t2); await symlink("app.txt", join(f.repository, "linked")); await git(f.repository, "add", "linked");
    await git(f.repository, "commit", "-m", "symlink"); await publishLocalFixtureV1(f.repository);
    const commit = await git(f.repository, "rev-parse", "HEAD");
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit, authorize: value => authorize(f.root, value) }),
      /updater_tree_symlink_refused/u);
  });
  await t.test("node_modules and huge file", async t2 => {
    const f = await fixture(t2); await mkdir(join(f.repository, "node_modules")); await writeFile(join(f.repository, "node_modules/x"), "x");
    await git(f.repository, "add", "-f", "node_modules/x"); await git(f.repository, "commit", "-m", "modules"); await publishLocalFixtureV1(f.repository);
    let commit = await git(f.repository, "rev-parse", "HEAD");
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit, authorize: value => authorize(f.root, value) }),
      /updater_tree_node_modules_refused/u);
    await git(f.repository, "rm", "-r", "node_modules"); await writeFile(join(f.repository, "large"), "123456789");
    await git(f.repository, "add", "large"); await git(f.repository, "commit", "-m", "large"); await publishLocalFixtureV1(f.repository);
    commit = await git(f.repository, "rev-parse", "HEAD");
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit, maxTreeFileBytes: 8,
      authorize: value => authorize(f.root, value) }), /updater_source_too_large/u);
  });
  await t.test("gitattributes cannot hide a tracked file from the archive", async t2 => {
    const f = await fixture(t2); await writeFile(join(f.repository, ".gitattributes"), "app.txt export-ignore\n");
    await git(f.repository, "add", ".gitattributes"); await git(f.repository, "commit", "-m", "hide guard");
    await publishLocalFixtureV1(f.repository); const commit = await git(f.repository, "rev-parse", "HEAD");
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit,
      authorize: value => authorize(f.root, value) }), /updater_archive_tree_mismatch/u);
    assert.equal(f.spawned.some(call => call.file === process.execPath
      && call.args[0] === f.fake && call.args[1] === "build"), false,
    "an incomplete archive is refused before the builder runs");
  });
  await t.test("a raw tree containing a .git entry is refused", async t2 => {
    const f = await fixture(t2), blobPath = join(f.temporary, "dot-git-blob"); await writeFile(blobPath, "hostile\n");
    const oid = await git(f.repository, "hash-object", "-w", blobPath);
    const tree = await gitStdin(f.repository, ["mktree"], `100644 blob ${oid}\t.git\n`);
    const commit = await gitStdin(f.repository, ["commit-tree", tree, "-p", f.commit], "dot git\n");
    await git(f.repository, "update-ref", "refs/heads/main", commit); await publishLocalFixtureV1(f.repository);
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit,
      authorize: value => authorize(f.root, value) }), /updater_fetch_refused|updater_tree_dot_git_refused/u);
  });
  await t.test("hardlink after archive and moved ref", async t2 => {
    const f = await fixture(t2);
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), hooks: { async afterArchive({ source }) {
      await rm(join(source, "app.txt")); await link(join(source, "app-copy.txt"), join(source, "app.txt")); } },
    authorize: value => authorize(f.root, value) }), /updater_archive_hardlink_refused|updater_archive_tree_mismatch/u);
    assert.equal(f.spawned.some(call => call.file === process.execPath
      && call.args[0] === f.fake && call.args[1] === "build"), false,
    "a hard-linked archive entry is refused before the builder runs");
    await writeFile(join(f.repository, "second"), "second\n"); await git(f.repository, "add", "second");
    await git(f.repository, "commit", "-m", "second"); await publishLocalFixtureV1(f.repository);
    const second = await git(f.repository, "rev-parse", "HEAD");
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit: second, hooks: { async afterArchive({ mirror, mainRef }) {
      await exec(gitPath, ["--git-dir", mirror, "update-ref", mainRef, f.commit]); } },
    authorize: value => authorize(f.root, value) }), /updater_main_ref_moved/u);
    await publishLocalFixtureV1(f.repository, f.commit);
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), commit: second,
      authorize: value => authorize(f.root, value) }), /updater_commit_not_on_main/u);
  });
  await t.test("credential mode", async t2 => {
    const f = await fixture(t2); await chmod(f.credential, 0o644);
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), authorize: value => authorize(f.root, value) }),
      /updater_credential_refused/u);
  });
  await t.test("self-update On", async t2 => {
    const f = await fixture(t2); await writeFile(join(f.root, "updater-state/self-update"), "On\n");
    await assert.rejects(installAttendedCommitV1({ ...f.materialize(), authorize: value => authorize(f.root, value) }),
      /updater_install_requires_off/u);
  });
});

test("unmanifested build output refuses, cleans up, and an exact retry succeeds", async t => {
  const f = await fixture(t);
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ buildMode: "extra" }),
    authorize: value => authorize(f.root, value) }), /updater_build_unmanifested_file/u);
  const result = await installAttendedCommitV1({ ...f.materialize(), authorize: value => authorize(f.root, value) });
  assert.equal(result.commit, f.commit);
});

test("adoption refuses when authorization returns without the exact confirmation", async t => {
  const f = await fixture(t);
  await assert.rejects(installAttendedCommitV1({ ...f.materialize(), authorize: async () => {} }),
    /updater_install_confirmation_missing/u);
  assert.equal(await lstat(join(f.root, "current")).then(() => true, () => false), false);
});

test("a concurrent caller is refused and stopping halfway kills the build before a clean retry", async t => {
  const f = await fixture(t), controller = new AbortController();
  const first = installAttendedCommitV1({ ...f.materialize({ buildMode: "sleep" }), signal: controller.signal,
    buildTimeoutMs: 30_000, authorize: value => authorize(f.root, value) });
  for (let index = 0; index < 200; index += 1) {
    if (f.spawned.some(call => call.args?.includes("sleep"))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(f.spawned.some(call => call.args?.includes("sleep")), "the primary caller reached its build process");
  const burst = await Promise.allSettled(Array.from({ length: 25 }, () => installAttendedCommitV1({
    ...f.materialize(), authorize: value => authorize(f.root, value),
  })));
  assert.equal(burst.filter(result => result.status === "rejected"
    && /updater_attended_busy/u.test(String(result.reason))).length, 25);
  controller.abort(); await assert.rejects(first, /updater_attended_stopped|updater_command_failed/u);
  const result = await installAttendedCommitV1({ ...f.materialize(), authorize: value => authorize(f.root, value) });
  assert.equal(result.commit, f.commit);
});

test("real subprocess SIGKILL inside builders 11-13 and release staging 15 permits an exact retry",
  { timeout: 90_000 }, async t => {
  const helper = join(process.cwd(), "tests/helpers/updater-attended-sigkill-runner.mjs"), children = new Set();
  t.after(() => { for (const pid of children) { try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (error?.code !== "ESRCH") throw error; } } });
  const run = (base, phase, mode) => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [helper, base, phase, mode], { cwd: process.cwd(), detached: true,
      stdio: ["ignore", "pipe", "pipe"] }); children.add(child.pid);
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject);
    child.once("exit", (code, signal) => { children.delete(child.pid); resolvePromise({ code, signal, stdout, stderr }); });
  });
  for (const phase of ["fetch-source", "build-release", "build-updater-bundle", "stage-release"]) {
    const base = await mkdtemp(join(tmpdir(), `attended-sigkill-${phase}-`)); t.after(async () => {
      async function thaw(path) {
        const entry = await lstat(path).catch(() => null); if (!entry || entry.isSymbolicLink()) return;
        if (entry.isDirectory()) {
          await chmod(path, 0o700).catch(() => {});
          for (const name of await readdir(path).catch(() => [])) await thaw(join(path, name));
        } else await chmod(path, 0o600).catch(() => {});
      }
      await thaw(base); await rm(base, { recursive: true, force: true });
    });
    const killed = await run(base, phase, "kill");
    assert.deepEqual({ code: killed.code, signal: killed.signal }, { code: null, signal: "SIGKILL" }, `${phase}: ${killed.stderr}`);
    assert.equal(await lstat(join(base, `${phase}.marker`)).then(() => true, () => false), true, `${phase}: boundary marker`);
    const retried = await run(base, phase, "retry"); assert.equal(retried.code, 0, `${phase}: ${retried.stderr}`);
    assert.deepEqual(await readdir(join(base, "root/build")), [], `${phase}: retry cleared run-owned build scratch`);
    assert.match(await readlink(join(base, "root/current")), /^releases\/1\.2\.3-/u);
  }
});

test("the shared T1 runtime check runs before any spawn and fails closed", async t => {
  const f = await fixture(t), input = f.materialize();
  input.trustedRuntimeVerifier = async () => { throw new Error("trusted_runtime_inventory_mismatch"); };
  await assert.rejects(installAttendedCommitV1({ ...input, authorize: value => authorize(f.root, value) }),
    /trusted_runtime_inventory_mismatch/u);
  assert.deepEqual(f.spawned, [], "no command may spawn after the runtime check refuses");
});

test("job start refuses an exact builder-uid process or scheduled entry and an exact retry succeeds", async t => {
  const f = await fixture(t), state = { pids: [999_999], scheduled: false };
  const builderProcessControl = { async listPids() { return [...state.pids]; },
    async hasScheduledEntries() { return state.scheduled; }, async killPid() { throw new Error("job start must not kill"); } };
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ builderProcessControl }),
    authorize: value => authorize(f.root, value) }), /builder_left_process/u);
  assert.deepEqual(f.spawned, [], "a leftover process refuses before repository or build tools run");
  state.pids = []; state.scheduled = true;
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ builderProcessControl }),
    authorize: value => authorize(f.root, value) }), /builder_left_process/u);
  state.scheduled = false;
  const result = await installAttendedCommitV1({ ...f.materialize({ builderProcessControl }),
    authorize: value => authorize(f.root, value) });
  assert.equal(result.commit, f.commit);
});

test("the real account lookup refuses a uid-zero builder before repository or build tools run", async t => {
  const f = await fixture(t), calls = [], input = f.materialize(); delete input.identities;
  assert.throws(() => validateResolvedBuilderIdentityV1({ builderUid: 0, rootUid: 0, builderAccount: "_crbuild" }),
    /updater_account_refused/u);
  input.commandRunner = async (file, args) => {
    calls.push({ file, args });
    assert.equal(file, "/usr/bin/id");
    return { stdout: args[0] === "-u" ? "0\n" : "20\n", stderr: "", code: 0 };
  };
  await assert.rejects(installAttendedCommitV1({ ...input, authorize: value => authorize(f.root, value) }),
    /updater_account_refused/u);
  assert.deepEqual(calls.map(call => call.args), [["-u", "_crbuild"], ["-g", "_crbuild"], ["-g", "_controlroom"]]);
  assert.deepEqual(f.spawned, [], "a uid-zero builder is refused before any real child process is spawned");
});

test("a killed builder pid that is still listed for a moment does not fail the build (SIGKILL is asynchronous)", async t => {
  const f = await fixture(t); let inspections = 0;
  const builderProcessControl = {
    // start: idle; after build: one helper left; right after the kill it is still listed once; then gone.
    async listPids() { inspections += 1; return inspections === 2 || inspections === 3 ? [424_243] : []; },
    async hasScheduledEntries() { return false; },
    async killPid() {},
  };
  const result = await installAttendedCommitV1({ ...f.materialize({ builderProcessControl }), authorize: value => authorize(f.root, value) })
    .then(() => "installed", error => error?.code ?? error?.message);
  // The whole install completes: the sweep re-listed until the killed pid was gone.
  assert.equal(result, "installed");
  assert.ok(inspections >= 4, `inspections ${inspections}`);
});

test("post-kill verification refuses when the same builder pid survives a no-op kill", async t => {
  const f = await fixture(t); let inspections = 0, kills = 0;
  const builderProcessControl = {
    async listPids() { inspections += 1; return inspections === 1 ? [] : [424_242]; },
    async hasScheduledEntries() { return false; },
    async killPid(pid) { assert.equal(pid, 424_242); kills += 1; },
  };
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ builderProcessControl }),
    authorize: value => authorize(f.root, value) }), /builder_left_process/u);
  // The sweep now polls (SIGKILL is asynchronous), so it kills and re-lists more than once
  // before refusing a pid that never goes away.
  assert.ok(kills >= 2, `kills ${kills}`); assert.ok(inspections >= 5,
    "the primary cleanup and its finally retry both re-list the uid after attempting the kill");
  assert.equal(f.spawned.some(call => call.args?.includes(f.fake) && call.args?.includes("bundle")), false,
    "a surviving builder process prevents the fixed bundle phase");
});

test("uid-wide cleanup kills a child that daemonises out of the build group before root ownership and final verification", async t => {
  const f = await fixture(t), pidFile = join(f.temporary, "daemon.pid"), killed = [], ownership = [];
  let daemonPid;
  const alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === "ESRCH") return false; throw error; }
  };
  t.after(async () => { if (daemonPid && alive(daemonPid)) { process.kill(daemonPid, "SIGKILL"); } });
  const builderProcessControl = {
    async listPids() {
      daemonPid ??= await readFile(pidFile, "utf8").then(Number, error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
      return daemonPid && alive(daemonPid) ? [daemonPid] : [];
    },
    async hasScheduledEntries() { return false; },
    async killPid(pid) {
      assert.equal(pid, daemonPid); killed.push(pid); process.kill(pid, "SIGKILL");
      for (let attempt = 0; attempt < 200 && alive(pid); attempt += 1)
        await new Promise(resolve => setTimeout(resolve, 5));
    },
  };
  const hooks = {
    async afterOwnershipChange(event) { ownership.push(event.path); },
    async beforeCandidateFinalVerification() {
      assert.equal(ownership.filter(path => path.includes("/build/job-")).length, 2,
        "candidate job is chowned to root before its final verification");
      assert.equal(alive(daemonPid), false, "uid cleanup precedes candidate final verification");
    },
    async beforeFinalVerification() {
      assert.equal(ownership.filter(path => path.includes("/build/job-")).length, 4,
        "fixed bundle is chowned to root before final verification");
    },
  };
  const result = await installAttendedCommitV1({ ...f.materialize({ buildMode: "daemon", outside: pidFile,
    builderProcessControl, hooks }), authorize: value => authorize(f.root, value) });
  assert.equal(result.commit, f.commit); assert.deepEqual(killed, [daemonPid]);
  assert.equal(alive(daemonPid), false, "the detached daemon cannot survive into adoption");
});

test("adoption re-hashes root-owned source descriptors and refuses a same-size post-verification rewrite", async t => {
  const f = await fixture(t);
  const input = f.materialize({ hooks: { async afterFinalVerification() {
    const build = join(f.root, "build"), [job] = await readdir(build);
    const packagePath = join(build, job, "output/package.json"), original = await readFile(packagePath, "utf8");
    const changed = original.replace("room", "pwn!"); assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    await chmod(packagePath, 0o600); await writeFile(packagePath, changed); await chmod(packagePath, 0o400);
  } } });
  await assert.rejects(installAttendedCommitV1({ ...input, authorize: value => authorize(f.root, value) }),
    /updater_adoption_source_refused/u);
  assert.equal(await lstat(join(f.root, "current")).then(() => true, () => false), false);
  const result = await installAttendedCommitV1({ ...f.materialize(), authorize: value => authorize(f.root, value) });
  assert.equal(result.commit, f.commit);
});

test("a build that exits after leaving a child has its whole process group killed", async t => {
  const f = await fixture(t), pidFile = join(f.temporary, "lingering.pid");
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ buildMode: "linger", outside: pidFile }),
    authorize: value => authorize(f.root, value) }), /updater_build_manifest_refused/u);
  const pid = Number(await readFile(pidFile, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), error => error?.code === "ESRCH", "the lingering descendant is gone");
});

test("connrel production root phase signs, stages idempotently and refuses altered installed bytes", async t => {
  const f = await fixture(t), protectedRoot = join(f.root, "Protected"); await mkdir(protectedRoot, { mode: 0o750 });
  await chmod(join(f.root, "updater-state"), 0o700);
  const key = await generateInstallationReleaseKeyV1({ protectedRoot, versionFloor: "0.0.0" }, { expectedUid: process.geteuid() });
  const input = f.materialize({ root: await realpath(f.root), hooks: { async beforeCandidateFinalVerification() {
    // Materialize the real unsigned builder output before the root phase checks
    // it; OS account changes are simulated by this lane's existing fixture.
    const job = (await readdir(join(f.root, "build")))[0], output = join(f.root, "build", job, "output");
    const root = join(output, "dist-vps/server/fleet/release");
    await buildFleetConnectorReleaseFromVerifiedSourceV1({ root, builtFrom: f.commit, releaseTrust: key.trust });
    const buildPath = join(output, "RELEASE_MANIFEST.json"), manifest = JSON.parse(await readFile(buildPath));
    for (const name of await readdir(root)) {
      const bytes = await readFile(join(root, name)); await chmod(join(root, name), 0o400);
      manifest.files.push({ path: `dist-vps/server/fleet/release/${name}`,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, mode: 0o400, bytes: bytes.length });
      manifest.fileCount += 1; manifest.byteCount += bytes.length;
    }
    await chmod(buildPath, 0o600); await writeFile(buildPath, JSON.stringify(manifest)); await chmod(buildPath, 0o400);
  } } });
  let fetched;
  try {
    fetched = await fetchVerifiedSourceV1(input);
    const release = await buildReleaseV1({ ...input, ...fetched });
    const relative = "dist-vps/server/fleet/release/connector-release.json";
    const signed = await readFile(join(release.output, relative));
    const first = await stageReleaseV1({ root: input.root, output: release.output, releaseId: release.releaseId,
      release, serviceGid: process.getgid() });
    const retry = await stageReleaseV1({ root: input.root, output: release.output, releaseId: release.releaseId,
      release, serviceGid: process.getgid() });
    assert.equal(retry.target, first.target);
    assert.deepEqual(await readFile(join(first.target, relative)), signed);
    assert.equal((await lstat(join(first.target, relative))).mode & 0o777, 0o440);
    const path = join(first.target, relative); await chmod(path, 0o640);
    await writeFile(path, "tampered\n"); await chmod(path, 0o440);
    await assert.rejects(stageReleaseV1({ root: input.root, output: release.output, releaseId: release.releaseId,
      release, serviceGid: process.getgid() }), /updater_install_target_exists/u);
  } finally { if (fetched) await abortAttendedV1(fetched); }
});

test("connrel production root phase refuses changed trust custody and disagreement with generate-keys", async t => {
  for (const damage of ["mode", "key"]) {
    const f = await fixture(t), protectedRoot = join(f.root, "Protected"); await mkdir(protectedRoot, { mode: 0o750 });
    await chmod(join(f.root, "updater-state"), 0o700);
    const key = await generateInstallationReleaseKeyV1({ protectedRoot, versionFloor: "0.0.0" }, { expectedUid: process.geteuid() });
    if (damage === "mode") await chmod(key.trustPath, 0o600);
    const input = f.materialize({ releaseTrust: damage === "key" ? { ...key.trust, epoch: 2 } : key.trust });
    let fetched;
    try {
      fetched = await fetchVerifiedSourceV1(input);
      await assert.rejects(buildReleaseV1({ ...input, ...fetched }), /updater_release_trust_refused/u);
    } finally { if (fetched) await abortAttendedV1(fetched); }
  }
});

test("cron check: the installer's own cron.deny answer means no table only when root's tabs file is absent", () => {
  const denied = { code: 1, stdout: "", stderr: "crontab: you (_crbuild_rehearsal) are not allowed to use this program\n" };
  // Exact macOS 26 text once the installer has added the builder to cron.deny.
  assert.equal(crontabStateV1(denied, "_crbuild_rehearsal", false), "none");
  assert.equal(crontabStateV1(denied, "_crbuild_rehearsal", true), "scheduled");
  assert.equal(crontabStateV1({ code: 1, stdout: "", stderr: "crontab: no crontab for _crbuild_rehearsal\n" }, "_crbuild_rehearsal", true), "none");
  // Another account's denial, unknown text, or any listed table never reads as "none".
  assert.throws(() => crontabStateV1({ ...denied, stderr: "crontab: you (_other) are not allowed to use this program" }, "_crbuild_rehearsal", false), /builder_left_process/u);
  assert.throws(() => crontabStateV1({ code: 1, stdout: "", stderr: "crontab: something else" }, "_crbuild_rehearsal", false), /builder_left_process/u);
  assert.throws(() => crontabStateV1({ code: 1, stdout: "* * * * * x", stderr: "" }, "_crbuild_rehearsal", false), /builder_left_process/u);
});

// A non-fresh install refuses any update that changes the database
// (`attended_database_change_requires_upgrader`), so the classifier has to see
// EVERY commit between the installed release and the target. The fixture
// repository's first commit plays the installed release; each case adds the
// history it names, points `current` at a release whose manifest records the
// installed commit, and classifies through the real mirror fetch.
async function commitFiles(repository, message, changes) {
  for (const [path, body] of Object.entries(changes)) {
    if (body === null) { await git(repository, "rm", "-q", path); continue; }
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), body); await git(repository, "add", path);
  }
  await git(repository, "commit", "-q", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

async function markInstalled(f, commit) {
  await rm(join(f.root, "current"), { force: true });
  if (commit === null) return;
  const releaseId = `1.2.3-${commit.slice(0, 12)}`;
  await mkdir(join(f.root, "releases", releaseId), { recursive: true });
  await writeFile(join(f.root, "releases", releaseId, "RELEASE_MANIFEST.json"),
    `${JSON.stringify({ schema: "control-room.attended-build-manifest/v1", commit, version: "1.2.3" })}\n`);
  await symlink(`releases/${releaseId}`, join(f.root, "current"));
}

async function classifyInstalled(f, { installed, target, main = target, beforeClassify }) {
  await markInstalled(f, installed);
  await git(f.repository, "branch", "-f", "classify-main", main);
  await publishLocalFixtureV1(f.repository, "classify-main");
  const fetched = await fetchVerifiedSourceV1({ ...f.materialize(), commit: target });
  try {
    await beforeClassify?.(join(f.root, "updater-state/mirror.git"));
    return await classifyAttendedSourceV1(fetched);
  } finally { await abortAttendedV1(fetched); }
}

// A side branch that adds a migration and reverts it, merged into a code-only
// main line: only the side branch's commits show the migration.
async function hiddenSideMigration(f) {
  await git(f.repository, "checkout", "-q", "-b", "side", f.commit);
  const added = await commitFiles(f.repository, "side migration", { "db/migrations/0007_side.sql": "select 7;\n" });
  await git(f.repository, "revert", "--no-edit", added);
  const sideTip = await git(f.repository, "rev-parse", "HEAD");
  await git(f.repository, "checkout", "-q", "main");
  await commitFiles(f.repository, "mainline code", { "src/main-line.mjs": "export const m = 1;\n" });
  await git(f.repository, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  return { added, sideTip, merge: await git(f.repository, "rev-parse", "HEAD") };
}
const mirrorGit = (mirror, ...args) => exec(gitPath, ["--git-dir", mirror, "-c", "user.name=Builder",
  "-c", "user.email=builder@example.invalid", ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" } });

test("the database path rule covers every release schema input and the referee's database patterns", () => {
  // Expected values written by hand from apply-release-schema.mjs, database-phase-data.mjs,
  // release-schema-digest.mjs and policy/classes.json "database", not from the rule itself.
  for (const path of ["db/migrations/0300_x.sql", "db/roles/production_roles.sql", "db/setup/production_migration_ledger.sql",
    "db/README.md", "deploy/postgres/migration-ledger.json", "deploy/postgres/role-manifest.json",
    "deploy/postgres/desired-grants.json", "deploy/postgres/fixed-queue-schema.json", "src/updater/v1/ddl/0002_schema.sql",
    "src/updater/v1/ddl/notes.txt", "src/updater/v1/policy/release-schema-digest.json",
    "src/updater/v1/pg/release-schema-digest.sql", "scripts/mac-local/database-role-manifest.mjs",
    "tests/fixtures/migrations/dangerous.sql", "DB/Roles/x.txt", "Deploy/Postgres/Desired-Grants.json",
    "SRC/Updater/V1/DDL/0009.SQL", "db", "deploy/postgres", "src/updater/v1/ddl"])
    assert.equal(isAttendedDatabasePathV1(path), true, path);
  for (const path of ["src/app.mjs", "dbx/migrations/0001.txt", "docs/db/readme.md", "deploy/postgresql/x.json",
    "deploy/vps/upgrade-tool/package.json", "src/updater/v1/ddl-notes.md", "src/updater/v1/pg/apply-release-schema.mjs",
    "src/updater/v1/policy/classes.json", "notes.sqlite", "migration.sql.md"])
    assert.equal(isAttendedDatabasePathV1(path), false, path);
});

test("reproducer: a migration in an earlier commit of the update is a database change", async t => {
  const f = await fixture(t);
  await commitFiles(f.repository, "B adds a migration", { "db/migrations/0002_b.sql": "select 2;\n" });
  const target = await commitFiles(f.repository, "C changes only src", { "src/app.mjs": "export const c = 1;\n" });
  const result = await classifyInstalled(f, { installed: f.commit, target });
  assert.equal(result.changesDatabase, true, "commit B's migration is part of what this update installs");
  assert.equal(result.baseline, "forward"); assert.equal(result.installedCommit, f.commit);
  assert.deepEqual([...result.changedPaths].sort(), ["db/migrations/0002_b.sql", "src/app.mjs"]);
});

test("reproducer: an updater DDL change in an earlier commit of the update is a database change", async t => {
  const f = await fixture(t);
  await commitFiles(f.repository, "B changes only the updater DDL", { "src/updater/v1/ddl/0005_b.sql": "select 5;\n" });
  const target = await commitFiles(f.repository, "C changes only src", { "src/app.mjs": "export const c = 1;\n" });
  const result = await classifyInstalled(f, { installed: f.commit, target });
  assert.equal(result.changesDatabase, true, "the release schema phase applies the updater DDL");
});

test("any file under the updater DDL directory and the release schema inputs count as database changes", async t => {
  const f = await fixture(t);
  for (const path of ["src/updater/v1/ddl/README.json", "deploy/postgres/desired-grants.json",
    "src/updater/v1/policy/release-schema-digest.json", "scripts/mac-local/database-role-manifest.mjs",
    "tests/fixtures/elsewhere.SQL"]) {
    const installed = await git(f.repository, "rev-parse", "HEAD");
    const target = await commitFiles(f.repository, `change ${path}`, { [path]: `${path}\n` });
    const result = await classifyInstalled(f, { installed, target });
    assert.deepEqual(result.changedPaths, [path]);
    assert.equal(result.changesDatabase, true, `${path} is read by the release schema phase or matches the referee`);
  }
  const installed = await git(f.repository, "rev-parse", "HEAD");
  const target = await commitFiles(f.repository, "an ordinary change", { "src/updater/v1/ddl-notes.md": "not ddl\n" });
  assert.equal((await classifyInstalled(f, { installed, target })).changesDatabase, false,
    "a path that only starts like the DDL directory is ordinary code");
});

test("a merge whose second parent carries the migration is a database change", async t => {
  const f = await fixture(t);
  await git(f.repository, "checkout", "-q", "-b", "feature", f.commit);
  await commitFiles(f.repository, "feature migration", { "db/migrations/0003_feature.sql": "select 3;\n" });
  await git(f.repository, "checkout", "-q", "main");
  await commitFiles(f.repository, "mainline code", { "src/main-line.mjs": "export const m = 1;\n" });
  await git(f.repository, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  const merge = await git(f.repository, "rev-parse", "HEAD");
  const target = await commitFiles(f.repository, "after the merge", { "src/app.mjs": "export const c = 1;\n" });
  for (const commit of [merge, target]) {
    const result = await classifyInstalled(f, { installed: f.commit, target: commit });
    assert.ok(result.changedPaths.includes("db/migrations/0003_feature.sql"));
    assert.equal(result.changesDatabase, true);
  }
});

test("a migration added and reverted inside the update, or a revert of an installed migration, is still a change", async t => {
  const f = await fixture(t);
  const added = await commitFiles(f.repository, "add migration", { "db/migrations/0004_revert.sql": "select 4;\n" });
  await git(f.repository, "revert", "--no-edit", added);
  const reverted = await git(f.repository, "rev-parse", "HEAD");
  assert.equal(await git(f.repository, "diff", "--name-only", f.commit, reverted), "",
    "the end states are identical, so only the commits in between show the migration");
  const inside = await classifyInstalled(f, { installed: f.commit, target: reverted });
  assert.deepEqual(inside.changedPaths, ["db/migrations/0004_revert.sql"]);
  assert.equal(inside.changesDatabase, true);
  const fromInstalled = await classifyInstalled(f, { installed: added, target: reverted });
  assert.equal(fromInstalled.changesDatabase, true, "reverting a migration the database already has is a change");
});

test("a rename into or out of db/ is a database change on both of its paths", async t => {
  const f = await fixture(t);
  const installed = await commitFiles(f.repository, "notes", { "docs/notes.txt": "notes\n", "db/readme.txt": "db\n" });
  await git(f.repository, "mv", "docs/notes.txt", "db/notes.txt"); await git(f.repository, "commit", "-q", "-m", "into db");
  const into = await git(f.repository, "rev-parse", "HEAD");
  await git(f.repository, "mv", "db/readme.txt", "docs/readme.txt"); await git(f.repository, "commit", "-q", "-m", "out of db");
  const out = await git(f.repository, "rev-parse", "HEAD");
  const intoResult = await classifyInstalled(f, { installed, target: into, main: out });
  assert.deepEqual([...intoResult.changedPaths].sort(), ["db/notes.txt", "docs/notes.txt"]);
  assert.equal(intoResult.changesDatabase, true);
  const outResult = await classifyInstalled(f, { installed: into, target: out });
  assert.deepEqual([...outResult.changedPaths].sort(), ["db/readme.txt", "docs/readme.txt"]);
  assert.equal(outResult.changesDatabase, true);
});

test("installed equals target has nothing to do, and a code-only update is not a database change", async t => {
  const f = await fixture(t);
  const same = await classifyInstalled(f, { installed: f.commit, target: f.commit });
  assert.deepEqual(same.changedPaths, []); assert.equal(same.changesDatabase, false); assert.equal(same.baseline, "same");
  const target = await commitFiles(f.repository, "code", { "src/app.mjs": "export const c = 1;\n" });
  const code = await classifyInstalled(f, { installed: f.commit, target });
  assert.deepEqual(code.changedPaths, ["src/app.mjs"]); assert.equal(code.changesDatabase, false);
});

test("a downgrade classifies the commits it undoes", async t => {
  const f = await fixture(t);
  await commitFiles(f.repository, "code", { "src/app.mjs": "export const c = 1;\n" });
  const migration = await commitFiles(f.repository, "migration", { "db/migrations/0006_down.sql": "select 6;\n" });
  const later = await commitFiles(f.repository, "more code", { "src/app.mjs": "export const c = 2;\n" });
  const back = await classifyInstalled(f, { installed: later, target: f.commit, main: later });
  assert.equal(back.changesDatabase, true, "going back past a migration leaves a newer database behind");
  assert.equal(back.baseline, "downgrade");
  const codeOnly = await classifyInstalled(f, { installed: later, target: migration, main: later });
  assert.deepEqual(codeOnly.changedPaths, ["src/app.mjs"]); assert.equal(codeOnly.changesDatabase, false);
});

test("an installed commit that is not an ancestor of the target, or is unknown, fails closed", async t => {
  const f = await fixture(t);
  const old = await commitFiles(f.repository, "old main", { "src/old.mjs": "export const o = 1;\n" });
  await git(f.repository, "branch", "-f", "classify-main", old);
  await publishLocalFixtureV1(f.repository, "classify-main");
  const seen = await fetchVerifiedSourceV1({ ...f.materialize(), commit: old }); await abortAttendedV1(seen);
  await git(f.repository, "checkout", "-q", "-b", "rewritten", f.commit);
  const target = await commitFiles(f.repository, "force-moved main", { "src/new.mjs": "export const n = 1;\n" });
  const mirror = join(f.root, "updater-state/mirror.git");
  await exec(gitPath, ["--git-dir", mirror, "cat-file", "-e", `${old}^{commit}`]);
  const diverged = await classifyInstalled(f, { installed: old, target });
  assert.equal(diverged.changesDatabase, true, "history that no longer contains the installed commit proves nothing");
  assert.equal(diverged.baseline, "unproven");
  const unknown = await classifyInstalled(f, { installed: "f".repeat(40), target });
  assert.equal(unknown.changesDatabase, true, "an installed commit the mirror never saw proves nothing");
  assert.equal(unknown.baseline, "unproven");
});

test("reproducer: a shallow side parent that hides a migration is a database change", async t => {
  const f = await fixture(t);
  const { sideTip, merge } = await hiddenSideMigration(f);
  // The complete mirror sees the side branch's migration: the expected answer.
  assert.equal((await classifyInstalled(f, { installed: f.commit, target: merge })).changesDatabase, true);
  // Cutting history at the side tip keeps the installed commit an ancestor
  // through the first parent; the mirror's own log.showRoot=false hides the cut
  // commit's root listing, so only a completeness check can see the gap.
  const shallow = await classifyInstalled(f, { installed: f.commit, target: merge, beforeClassify: async mirror => {
    await writeFile(join(mirror, "shallow"), `${sideTip}\n`);
    await mirrorGit(mirror, "config", "log.showRoot", "false");
  } });
  assert.equal(shallow.changesDatabase, true, "a shallow mirror cannot prove the side branch had no migration");
  assert.equal(shallow.baseline, "unproven");
});

test("a shallow, grafted or replaced mirror proves nothing, forward or back", async t => {
  const f = await fixture(t);
  const { sideTip, merge } = await hiddenSideMigration(f);
  const cuts = {
    shallow: mirror => writeFile(join(mirror, "shallow"), `${sideTip}\n`),
    graft: async mirror => { await mkdir(join(mirror, "info"), { recursive: true });
      await writeFile(join(mirror, "info", "grafts"), `${sideTip}\n`); },
    replace: mirror => mirrorGit(mirror, "replace", "--graft", sideTip),
  };
  const undo = async mirror => {
    await rm(join(mirror, "shallow"), { force: true }); await rm(join(mirror, "info", "grafts"), { force: true });
    for (const ref of (await mirrorGit(mirror, "for-each-ref", "--format=%(refname)", "refs/replace/")).stdout.split("\n").filter(Boolean))
      await mirrorGit(mirror, "update-ref", "-d", ref);
  };
  for (const [name, cut] of Object.entries(cuts)) {
    for (const [installed, target, main] of [[f.commit, merge, merge], [merge, f.commit, merge]]) {
      let mark;
      const result = await classifyInstalled(f, { installed, target, main, beforeClassify: async mirror => {
        await undo(mirror); await cut(mirror); await mirrorGit(mirror, "config", "log.showRoot", "false");
        mark = f.spawned.length;
        // Independent check that the cut works: git's own range walk loses the migration.
        const walk = (await mirrorGit(mirror, "log", "--no-renames", "--diff-merges=separate", "--name-only",
          "--format=", `${f.commit}..${merge}`)).stdout;
        assert.ok(!walk.includes("db/migrations/0007_side.sql"), `${name} hides the side migration from the walk`);
      } });
      assert.equal(result.baseline, "unproven", `${name} ${installed === f.commit ? "forward" : "downgrade"}`);
      assert.equal(result.changesDatabase, true, name);
      assert.ok(f.spawned.slice(mark).length > 0 && !f.spawned.slice(mark).some(call => call.args.includes("merge-base")),
        `${name}: the classifier never asks an incomplete mirror about ancestry`);
      // The next fetch would refuse a cut mirror outright; this test is about the classifier.
      await undo(join(f.root, "updater-state/mirror.git"));
    }
  }
  const restored = await classifyInstalled(f, { installed: f.commit, target: merge, beforeClassify: undo });
  assert.equal(restored.baseline, "forward", "the same mirror with its history whole is proven again");
});

test("a stop during classification is reported as a stop, not as a database change", async t => {
  const f = await fixture(t), controller = new AbortController();
  const target = await commitFiles(f.repository, "code", { "src/app.mjs": "export const c = 1;\n" });
  await markInstalled(f, f.commit);
  await git(f.repository, "branch", "-f", "classify-main", target);
  await publishLocalFixtureV1(f.repository, "classify-main");
  const fetched = await fetchVerifiedSourceV1({ ...f.materialize(), commit: target, signal: controller.signal });
  try {
    controller.abort();
    await assert.rejects(classifyAttendedSourceV1(fetched), /updater_attended_stopped/u);
  } finally { await abortAttendedV1(fetched); }
});

test("a fresh install has no installed release, so the whole tree is new and the database is created", async t => {
  const f = await fixture(t);
  const target = await commitFiles(f.repository, "code", { "src/app.mjs": "export const c = 1;\n" });
  const result = await classifyInstalled(f, { installed: null, target });
  assert.ok(result.changedPaths.includes("db/migrations/0001.sql") && result.changedPaths.includes("src/app.mjs"));
  assert.equal(result.changesDatabase, true); assert.equal(result.baseline, "not-installed");
});

// The installed identity is the release directory `current` names, and
// buildReleaseV1 names it `<version>-<first 12 of commit>` from the manifest that
// build-attended-release.mjs writes. A well-formed manifest that belongs to some
// other release must not become the commit the update is classified from.
test("reproducer: an installed manifest that disagrees with its own release directory is refused", async t => {
  const f = await fixture(t);
  await commitFiles(f.repository, "B adds a migration", { "db/migrations/0002_b.sql": "select 2;\n" });
  const target = await commitFiles(f.repository, "C changes only src", { "src/app.mjs": "export const c = 1;\n" });
  const schema = "control-room.attended-build-manifest/v1";
  // Literal: the fixture's package.json version and the installed commit's prefix.
  const manifest = join(f.root, "releases", `1.2.3-${f.commit.slice(0, 12)}`, "RELEASE_MANIFEST.json");
  for (const [label, record, code] of [
    ["claims the offered commit C", { schema, commit: target, version: "1.2.3" }, /^updater_installed_release_mismatch$/u],
    ["claims C under another schema", { schema: "wrong", commit: target, version: "1.2.3" }, /^updater_installed_release_refused$/u],
    ["claims C under another version", { schema, commit: target, version: "9.9.9" }, /^updater_installed_release_mismatch$/u],
    ["installed commit under another schema", { schema: "wrong", commit: f.commit, version: "1.2.3" }, /^updater_installed_release_refused$/u],
    ["installed commit with no schema", { commit: f.commit, version: "1.2.3" }, /^updater_installed_release_refused$/u],
    ["installed commit under another version", { schema, commit: f.commit, version: "9.9.9" }, /^updater_installed_release_mismatch$/u],
  ]) {
    await t.test(label, () => assert.rejects(classifyInstalled(f, { installed: f.commit, target,
      beforeClassify: () => writeFile(manifest, `${JSON.stringify(record)}\n`) }), error => code.test(error?.code)));
  }
  await t.test("restored to the installed commit A", async () => {
    const restored = await classifyInstalled(f, { installed: f.commit, target });
    assert.equal(restored.baseline, "forward"); assert.equal(restored.installedCommit, f.commit);
    assert.equal(restored.changesDatabase, true, "commit B's migration is in the update to C");
  });
});

test("a real installed release rewritten to claim the offered commit is refused before the owner is asked", async t => {
  // The installed record is made by the real first install (stageReleaseV1 and
  // switchPairV1), not by the test, so the reader is checked against what the
  // producer actually leaves behind.
  const f = await fixture(t);
  const installed = await installAttendedCommitV1({ ...f.materialize(), authorize: value => authorize(f.root, value) });
  assert.equal(installed.releaseId, `1.2.3-${f.commit.slice(0, 12)}`);
  await commitFiles(f.repository, "B adds a migration", { "db/migrations/0002_b.sql": "select 2;\n" });
  const target = await commitFiles(f.repository, "C changes only src", { "src/app.mjs": "export const c = 1;\n" });
  await publishLocalFixtureV1(f.repository);
  const update = () => ({ ...f.materialize(), commit: target,
    buildSteps: [{ file: process.execPath, args: [f.fake, "build", "AUTO", target] }] });
  const manifest = join(f.root, "releases", installed.releaseId, "RELEASE_MANIFEST.json");
  const original = await readFile(manifest, "utf8");
  await chmod(manifest, 0o640);
  await writeFile(manifest, `${JSON.stringify({ ...JSON.parse(original), commit: target })}\n`);
  let asked = false;
  await assert.rejects(installAttendedCommitV1({ ...update(), authorize: async () => { asked = true; } }),
    error => error?.code === "updater_installed_release_mismatch");
  assert.equal(asked, false, "the owner is never shown a plan built from the wrong installed commit");
  assert.equal(await readlink(join(f.root, "current")), `releases/${installed.releaseId}`);
  await writeFile(manifest, original);
  let plan;
  await assert.rejects(installAttendedCommitV1({ ...update(), authorize: async value => { plan = value.plan; } }),
    /updater_install_confirmation_missing/u);
  assert.equal(plan.from.commit, f.commit); assert.equal(plan.from.releaseId, installed.releaseId);
  assert.equal(plan.updaterDerived.changesDatabase, true); assert.ok(plan.classes.includes("database"));
});

test("a database path added by one merge and removed by another is a database change", async t => {
  // Neither end of the update, nor any ordinary commit, touches db/: only the two
  // merge commits' own changes against their first parents do.
  const f = await fixture(t);
  await git(f.repository, "checkout", "-q", "-b", "side1", f.commit);
  await commitFiles(f.repository, "side1", { "src/side1.mjs": "export const s = 1;\n" });
  await git(f.repository, "checkout", "-q", "main");
  await commitFiles(f.repository, "main", { "src/main.mjs": "export const m = 1;\n" });
  await git(f.repository, "merge", "-q", "--no-ff", "--no-commit", "side1");
  await commitFiles(f.repository, "merge adds database input", { "db/transient.txt": "database input\n" });
  await git(f.repository, "checkout", "-q", "-b", "side2", f.commit);
  await commitFiles(f.repository, "side2", { "src/side2.mjs": "export const s = 2;\n" });
  await git(f.repository, "checkout", "-q", "main");
  await git(f.repository, "merge", "-q", "--no-ff", "--no-commit", "side2");
  await commitFiles(f.repository, "merge removes database input", { "db/transient.txt": null });
  const target = await commitFiles(f.repository, "tail", { "src/tail.mjs": "export const t = 1;\n" });
  // Independent check of the shape: no non-merge commit and no end-to-end diff names it.
  assert.equal(await git(f.repository, "log", "--no-merges", "--name-only", "--format=", `${f.commit}..${target}`, "--", "db/transient.txt"), "");
  assert.equal(await git(f.repository, "diff", "--name-only", f.commit, target, "--", "db/"), "");
  const result = await classifyInstalled(f, { installed: f.commit, target });
  assert.equal(result.baseline, "forward");
  assert.ok(result.changedPaths.includes("db/transient.txt"), JSON.stringify(result.changedPaths));
  assert.equal(result.changesDatabase, true);
});

test("a graft cannot put a commit main never had on main for the attended fetch", async t => {
  const f = await fixture(t);
  await git(f.repository, "checkout", "-q", "-b", "dropped", f.commit);
  const dropped = await commitFiles(f.repository, "later dropped from main", { "src/dropped.mjs": "export const d = 1;\n" });
  await publishLocalFixtureV1(f.repository, "dropped");
  await abortAttendedV1(await fetchVerifiedSourceV1({ ...f.materialize(), commit: dropped }));
  await git(f.repository, "checkout", "-q", "main");
  const tip = await commitFiles(f.repository, "main moves on without it", { "src/main.mjs": "export const m = 1;\n" });
  await publishLocalFixtureV1(f.repository);
  await assert.rejects(fetchVerifiedSourceV1({ ...f.materialize(), commit: dropped }), /updater_commit_not_on_main/u);
  const mirror = join(f.root, "updater-state/mirror.git");
  await mkdir(join(mirror, "info"), { recursive: true });
  await writeFile(join(mirror, "info", "grafts"), `${tip} ${f.commit} ${dropped}\n`);
  // Independent check that the graft fabricates what it claims: plain git now says yes.
  await mirrorGit(mirror, "merge-base", "--is-ancestor", dropped, tip);
  await assert.rejects(fetchVerifiedSourceV1({ ...f.materialize(), commit: dropped }),
    error => error?.code === "updater_mirror_history_refused");
  await assert.rejects(fetchVerifiedSourceV1({ ...f.materialize(), commit: tip }),
    error => error?.code === "updater_mirror_history_refused", "a grafted mirror proves nothing, even for main's own tip");
  await rm(join(mirror, "info", "grafts"));
  await abortAttendedV1(await fetchVerifiedSourceV1({ ...f.materialize(), commit: tip }));
});

test("an installed commit that shares only the release directory's 12-character prefix proves nothing", async t => {
  // The directory name binds 48 bits of the commit; a full commit that matches
  // them but is not in the mirror is unknown history, so it fails closed.
  const f = await fixture(t);
  const target = await commitFiles(f.repository, "code only", { "src/only.mjs": "export const x = 1;\n" });
  const substituted = f.commit.slice(0, 12) + (f.commit.slice(12) === "d".repeat(28) ? "e" : "d").repeat(28);
  const manifest = join(f.root, "releases", `1.2.3-${f.commit.slice(0, 12)}`, "RELEASE_MANIFEST.json");
  const result = await classifyInstalled(f, { installed: f.commit, target, beforeClassify: () => writeFile(manifest,
    JSON.stringify({ schema: "control-room.attended-build-manifest/v1", version: "1.2.3", commit: substituted })) });
  assert.equal(result.installedCommit, substituted);
  assert.equal(result.baseline, "unproven"); assert.equal(result.changesDatabase, true);
});

test("reproducer: a graft written after classification cannot waive downgrade consent", async t => {
  // Same version, older commit: only the ancestry answer says this is a downgrade.
  // The graft makes the installed (newer) commit a parent of the target.
  const f = await fixture(t);
  const newer = await commitFiles(f.repository, "newer code", { "src/newer.mjs": "export const x = 2;\n" });
  await publishLocalFixtureV1(f.repository); await markInstalled(f, newer);
  const mirror = join(f.root, "updater-state/mirror.git"), grafts = join(mirror, "info", "grafts");
  // "ancestry": written as confirmation's own ancestry question is spawned (the
  // classifier asked twice before it). "before": written as the classifier's last
  // step, its range walk, is spawned - after classification, before confirmation.
  let injectAt = null, injected = false, ancestry = 0, askedAfterGraft = false;
  const input = { ...f.materialize(), onSpawn: async call => {
    f.spawned.push(call);
    if (call.args.includes("merge-base")) { ancestry += 1; if (injected) askedAfterGraft = true; }
    if (injectAt === "ancestry" && call.args.includes("merge-base") && ancestry === 3
      || injectAt === "before" && call.args.includes("--diff-merges=separate")) {
      await writeFile(grafts, `${f.commit} ${newer}\n${newer}\n`); injected = true;
    }
  } };
  const fetched = await fetchVerifiedSourceV1(input);
  try {
    const release = await buildReleaseV1({ ...input, ...fetched }), bundle = await buildFixedBundleV1({ ...input, ...fetched });
    const confirmOnce = async () => {
      let plan;
      const outcome = await confirmAttendedV1({ release, bundle, authorize: async value => { plan = value.plan; } })
        .then(() => "confirmed", error => error?.code);
      return { outcome, plan };
    };
    const pristine = await confirmOnce();
    assert.equal(pristine.outcome, "updater_install_confirmation_missing");
    assert.equal(pristine.plan.updaterDerived.downgrade, true, "the pristine mirror requires downgrade consent");
    for (const point of ["ancestry", "before"]) {
      await t.test(`graft written ${point === "ancestry" ? "as the ancestry question is asked" : "before the ancestry question"}`, async () => {
        injectAt = point; injected = false; ancestry = 0; askedAfterGraft = false;
        try {
          // Independent check that this graft fabricates the ancestry it claims.
          await writeFile(grafts, `${f.commit} ${newer}\n${newer}\n`);
          await mirrorGit(mirror, "merge-base", "--is-ancestor", newer, f.commit);
          await rm(grafts);
          const altered = await confirmOnce();
          assert.equal(injected, true, "the graft was written at the intended point");
          assert.equal(altered.outcome, "updater_mirror_history_refused");
          assert.equal(altered.plan, undefined, "the owner is never shown a plan without downgrade consent");
          if (point === "before") assert.equal(askedAfterGraft, false, "an incomplete mirror is never asked the ancestry question");
        } finally { injectAt = null; injected = false; await rm(grafts, { force: true }); }
      });
    }
    const restored = await confirmOnce();
    assert.equal(restored.plan.updaterDerived.downgrade, true, "with the graft gone, consent is required again");
  } finally { await abortAttendedV1(fetched); }
});

test("history metadata written while the classifier asks about ancestry is still caught", async t => {
  // The classifier checks the mirror before its ancestry questions and again
  // after them. A shallow cut written as the first question is spawned passes the
  // first check, and only the second one can see it.
  const f = await fixture(t);
  const { sideTip, merge } = await hiddenSideMigration(f);
  await markInstalled(f, f.commit);
  await git(f.repository, "branch", "-f", "classify-main", merge); await publishLocalFixtureV1(f.repository, "classify-main");
  const mirror = join(f.root, "updater-state/mirror.git");
  let armed = false, injected = false;
  const input = { ...f.materialize(), commit: merge, onSpawn: async call => {
    f.spawned.push(call);
    if (armed && !injected && call.args.includes("merge-base")) {
      await writeFile(join(mirror, "shallow"), `${sideTip}\n`); injected = true;
    }
  } };
  const fetched = await fetchVerifiedSourceV1(input);
  try {
    await mirrorGit(mirror, "config", "log.showRoot", "false");
    armed = true;
    const result = await classifyAttendedSourceV1(fetched);
    assert.equal(injected, true, "the cut was written as the ancestry question was spawned");
    assert.equal(result.baseline, "unproven"); assert.equal(result.changesDatabase, true);
  } finally { await abortAttendedV1(fetched); }
});
