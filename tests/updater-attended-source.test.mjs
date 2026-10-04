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
  abortAttendedV1, buildFixedBundleV1, buildReleaseV1, fetchVerifiedSourceV1, installAttendedCommitV1,
  parseAttendedTreeV1, parseBuilderPidsV1, runningBundleDigestV1, stageReleaseV1, stageUpdaterBundleV1, switchPairV1,
  validateResolvedBuilderIdentityV1,
} from "../src/updater/v1/attended-source.mjs";
import { buildAttendedReleaseV1 } from "../src/updater/v1/build-attended-release.mjs";
import { buildFleetConnectorReleaseFromVerifiedSourceV1 } from "../scripts/build-fleet-connector.mjs";
import { generateInstallationReleaseKeyV1 } from "../scripts/release-signing.mjs";
import { loadInstallStepsV1 } from "../src/updater/v1/install/bootstrap.mjs";

const exec = promisify(execFile);
const gitPath = (await exec("/usr/bin/xcrun", ["--find", "git"])).stdout.trim();

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
  for (const name of ["is-main-module", "strict-json", "rehearsal-hostname", "file-custody", "private-process-lock", "jsonl-prefix"])
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
let [mode,out,commit,extra]=process.argv.slice(2);if(mode==='fetch')process.exit(0);if(mode==='install'){await mkdir(join(process.cwd(),'node_modules'),{recursive:true});await writeFile(join(process.cwd(),'node_modules/.package-map.json'),'{}\\n');process.exit(0);}if(mode==='run'){await mkdir(join(process.cwd(),'dist-vps/client'),{recursive:true});await writeFile(join(process.cwd(),'dist-vps/client/generated.js'),'generated\\n');process.exit(0);}if(out==='AUTO')out=join(process.cwd(),'..','output');if(out==='AUTO_BUNDLE')out=join(process.cwd(),'..','bundle');const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
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
    expected.push("src/installer/v1/nightly-backup-recency.ts", "src/installer/shared/jsonl-prefix.mjs");
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
    "src/installer/shared/private-process-lock.mjs"];
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

test("post-kill verification refuses when the same builder pid survives a no-op kill", async t => {
  const f = await fixture(t); let inspections = 0, kills = 0;
  const builderProcessControl = {
    async listPids() { inspections += 1; return inspections === 1 ? [] : [424_242]; },
    async hasScheduledEntries() { return false; },
    async killPid(pid) { assert.equal(pid, 424_242); kills += 1; },
  };
  await assert.rejects(installAttendedCommitV1({ ...f.materialize({ builderProcessControl }),
    authorize: value => authorize(f.root, value) }), /builder_left_process/u);
  assert.equal(kills, 2); assert.equal(inspections, 5,
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
