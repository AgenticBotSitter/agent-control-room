import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { installAttendedCommitV1 } from "../../src/updater/v1/attended-source.mjs";

const exec = promisify(execFile), base = process.argv[2], phase = process.argv[3], shouldKill = process.argv[4] === "kill";
if (!base || !["fetch-source", "build-release", "build-updater-bundle", "stage-release"].includes(phase)) process.exit(64);
const repository = join(base, "repository"), remote = join(base, "remote.git"), root = join(base, "root");
const gitPath = (await exec("/usr/bin/xcrun", ["--find", "git"])).stdout.trim();
const git = async (cwd, ...args) => (await exec(gitPath, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" } })).stdout.trim();
if (!await lstat(remote).then(() => true, () => false)) {
  await mkdir(repository, { recursive: true }); await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.email", "fixture@example.invalid"); await git(repository, "config", "user.name", "Fixture");
  await mkdir(join(repository, "src/updater/v1"), { recursive: true }); await mkdir(join(repository, "scripts/updater"), { recursive: true });
  await copyFile(join(process.cwd(), "scripts/release-signing.mjs"), join(repository, "scripts/release-signing.mjs"));
  // The crossed-in cluster layout, for the same reason the main fixture provides it:
  // `FIXED_BUNDLE_INPUTS` stages it, so a repository without it is refused
  // `updater_bundle_input_refused` before the phase under test runs. MEASURED: with it
  // missing, `real subprocess SIGKILL inside builders 11-13 and release staging 15
  // permits an exact retry` failed at the staging step instead of reaching its SIGKILL.
  await mkdir(join(repository, "src/pg-runtime/v1"), { recursive: true });
  await copyFile(join(process.cwd(), "src/pg-runtime/v1/pg-cluster-layout.ts"),
    join(repository, "src/pg-runtime/v1/pg-cluster-layout.ts"));
  // The shared entry guard, the SECOND file `FIXED_BUNDLE_INPUTS` stages from
  // outside `src/updater/v1`. MEASURED: without it this runner fails at the staging
  // step with `updater_bundle_input_refused` and never reaches the SIGKILL window
  // it exists to exercise — the same trap the layout line above was written for.
  await mkdir(join(repository, "src/installer/shared"), { recursive: true });
  for (const name of ["is-main-module", "strict-json", "rehearsal-hostname", "file-custody", "private-process-lock", "jsonl-prefix"])
    await copyFile(join(process.cwd(), `src/installer/shared/${name}.mjs`),
      join(repository, `src/installer/shared/${name}.mjs`));
  // The nightly backup's recency reader, the other file `FIXED_BUNDLE_INPUTS` now
  // stages from outside `src/updater/v1`. MEASURED: without it this runner refuses
  // at the staging step with `updater_bundle_input_refused` and never reaches the
  // SIGKILL window it exists to exercise — the same trap the two lines above were
  // each written for, and the reason a staging-list addition has to be carried
  // into every fixture that builds a staged repository.
  await mkdir(join(repository, "src/installer/v1"), { recursive: true });
  await copyFile(join(process.cwd(), "src/installer/v1/nightly-backup-recency.ts"),
    join(repository, "src/installer/v1/nightly-backup-recency.ts"));
  await writeFile(join(repository, "package.json"), '{"name":"control-room","version":"1.2.3"}\n');
  await writeFile(join(repository, "app.txt"), "fixture\n");
  await writeFile(join(repository, "src/updater/v1/updater.mjs"), "export const ready=true;\n");
  await writeFile(join(repository, "scripts/updater/build-fixed-updater-bundle.mjs"), "export const ready=true;\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "fixture");
  await exec(gitPath, ["init", "--bare", remote]); await git(repository, "remote", "add", "origin", `file://${remote}`);
  await git(remote, "fetch", `file://${repository}`, "refs/heads/main:refs/heads/main");
  for (const path of ["updater-state/plans", "updater-state/confirmations", "build", "releases", "updater", "trusted"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "updater-state/self-update"), "Off\n", { mode: 0o600 });
  await writeFile(join(root, "updater-state/github-read.token"), "fixture-token\n", { mode: 0o600 });
  const helper = join(root, "trusted/git-credential-control-room");
  await copyFile(join(process.cwd(), "src/updater/v1/bin/git-credential-control-room"), helper); await chmod(helper, 0o500);
  const fake = join(base, "fake-build.mjs");
  await writeFile(fake, `#!${process.execPath}
import{createHash}from'node:crypto';import{chmod,mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';
let[mode,out,commit]=process.argv.slice(2);if(out==='AUTO')out=join(process.cwd(),'..','output');if(out==='AUTO_BUNDLE')out=join(process.cwd(),'..','bundle');const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');await mkdir(out,{recursive:true});if(mode==='bundle'){const body=Buffer.from('export const fixed=true;\\n');await writeFile(join(out,'updater.mjs'),body,{mode:0o500});await chmod(join(out,'updater.mjs'),0o500);await writeFile(join(out,'manifest.json'),JSON.stringify({schema:'control-room.updater-bundle-manifest/v1',files:[{path:'updater.mjs',sha256:digest(body),mode:0o500,type:'file'}]}),{mode:0o400});}else{const body=Buffer.from('{"name":"control-room"}\\n');await writeFile(join(out,'package.json'),body,{mode:0o400});await chmod(join(out,'package.json'),0o400);await writeFile(join(out,'RELEASE_MANIFEST.json'),JSON.stringify({schema:'control-room.attended-build-manifest/v1',commit,version:'1.2.3',fileCount:1,byteCount:body.length,files:[{path:'package.json',sha256:digest(body),mode:0o400,bytes:body.length}]}),{mode:0o400});}
`); await chmod(fake, 0o500);
  await writeFile(join(base, "commit"), `${await git(repository, "rev-parse", "HEAD")}\n`);
}
const commit = (await readFile(join(base, "commit"), "utf8")).trim(), helper = join(root, "trusted/git-credential-control-room");
const fake = join(base, "fake-build.mjs"), marker = join(base, `${phase}.marker`);
const crash = async () => { if (!shouldKill) return; await writeFile(marker, "reached\n", { mode: 0o600 }); process.kill(process.pid, "SIGKILL"); };
const hooks = {
  ...(phase === "fetch-source" ? { afterArchive: crash } : {}),
  ...(phase === "build-release" ? { beforeCandidateFinalVerification: crash } : {}),
  ...(phase === "build-updater-bundle" ? { beforeFinalVerification: crash } : {}),
  ...(phase === "stage-release" ? { afterStageRename: crash } : {}),
};
const authorize = async ({ planDigest }) => {
  const index = JSON.parse(await readFile(join(root, "updater-state/open-confirmation.json"), "utf8"));
  await writeFile(join(root, `updater-state/confirmations/${index.planId}.json`), `${JSON.stringify({
    schema: "control-room.mac-confirmation/v1", planId: index.planId, planDigest, confirmed: true,
  })}\n`);
};
await installAttendedCommitV1({ root, commit, remoteUrl: `file://${remote}`, allowFileRemote: true,
  credentialPath: join(root, "updater-state/github-read.token"),
  identities: { rootUid: process.getuid(), rootGid: process.getgid(), builderUid: process.getuid(),
    builderGid: process.getgid(), serviceGid: process.getgid(), builderAccount: "_crbuild" },
  tools: { git: gitPath, tar: "/usr/bin/tar", helper, node: process.execPath, pnpm: process.execPath,
    buildEntry: fake, bundleEntry: fake }, trustedRuntimeVerifier: async () => ({}),
  builderProcessControl: { async listPids() { return []; }, async hasScheduledEntries() { return false; }, async killPid() {} },
  fetchSteps: [], buildSteps: [{ file: process.execPath, args: [fake, "build", "AUTO", commit] }],
  bundleFetchStep: null, bundleStep: { file: process.execPath, args: [fake, "bundle", "AUTO_BUNDLE", commit] },
  hooks, authorize });
