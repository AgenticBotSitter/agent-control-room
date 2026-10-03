import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { buildFleetConnectorReleaseFromVerifiedSourceV1 } from "../scripts/build-fleet-connector.mjs";
import { generateInstallationReleaseKeyV1 } from "../scripts/release-signing.mjs";
import { signAttendedConnectorReleaseV1 } from "../src/updater/v1/install/connector-release.mjs";
import { verifyAttendedBuildOutputV1 } from "../src/updater/v1/attended-source.mjs";

const commit = "a".repeat(40), uid = process.geteuid();
const { loadFleetConnectorReleaseV1 } = await tsImport("../scripts/run-fleet-gateway.ts", import.meta.url);
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "connrel-")));
  t.after(async () => {
    async function thaw(path) {
      const info = await lstat(path).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink()) {
        await chmod(path, 0o700); for (const name of await readdir(path)) await thaw(join(path, name));
      }
    }
    await thaw(base); await rm(base, { recursive: true, force: true });
  });
  const protectedRoot = join(base, "Protected"); await mkdir(protectedRoot, { mode: 0o750 });
  const key = await generateInstallationReleaseKeyV1({ protectedRoot, versionFloor: "0.0.0" }, { expectedUid: uid });
  const output = join(base, "output"), root = join(output, "dist-vps/server/fleet/release");
  await buildFleetConnectorReleaseFromVerifiedSourceV1({ root, builtFrom: commit, releaseTrust: key.trust });
  const files = [];
  for (const name of await readdir(root)) {
    const path = join(root, name), bytes = await readFile(path); await chmod(path, 0o400);
    files.push({ path: `dist-vps/server/fleet/release/${name}`, sha256: sha256(bytes), mode: 0o400, bytes: bytes.length });
  }
  const manifest = { schema: "control-room.attended-build-manifest/v1", commit, version: "1.2.3",
    fileCount: files.length, byteCount: files.reduce((sum, item) => sum + item.bytes, 0), files };
  await writeFile(join(output, "RELEASE_MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
  return { base, output, root, key, input: { output, commit, trust: key.trust, privateKeyPath: key.privateKeyPath } };
}
const sign = (input, options = {}) => signAttendedConnectorReleaseV1(input, { expectedUid: uid, ...options });

test("connrel signs with the installation key, retries byte-identically, and records every shipped byte", async t => {
  const f = await fixture(t);
  await sign(f.input);
  const signed = await readFile(join(f.root, "connector-release.json"));
  const build = await readFile(join(f.output, "RELEASE_MANIFEST.json"));
  await sign(f.input);
  assert.deepEqual(await readFile(join(f.root, "connector-release.json")), signed);
  assert.deepEqual(await readFile(join(f.output, "RELEASE_MANIFEST.json")), build);
  const loaded = await loadFleetConnectorReleaseV1(f.root, f.key.trust);
  assert.equal(loaded.manifest.builtFrom, commit);
  const verified = await verifyAttendedBuildOutputV1(f.output, { commit });
  assert.equal(verified.fileCount, 3);
});

test("connrel refuses bad provenance, bundle or manifest tampering, wrong signing key and missing data", async t => {
  const f = await fixture(t), manifestPath = join(f.root, "manifest.json"), original = await readFile(manifestPath);
  await assert.rejects(sign({ ...f.input, output: "relative" }));
  await assert.rejects(sign({ ...f.input, commit: "bad" }));
  await assert.rejects(sign({ ...f.input, commit: "b".repeat(40) }));
  const manifest = JSON.parse(original);
  for (const change of [value => { value.schema = "bad"; }, value => { value.file = "../../outside"; },
    value => { value.size += 1; }, value => { value.sha256 = "0".repeat(64); }]) {
    const damaged = { ...manifest }; change(damaged); await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, JSON.stringify(damaged)); await chmod(manifestPath, 0o400);
    await assert.rejects(sign(f.input));
  }
  await chmod(manifestPath, 0o600); await writeFile(manifestPath, original); await chmod(manifestPath, 0o400);
  const other = join(f.base, "other/Protected"); await mkdir(other, { recursive: true, mode: 0o750 });
  const wrong = await generateInstallationReleaseKeyV1({ protectedRoot: other, versionFloor: "0.0.0" }, { expectedUid: uid });
  await assert.rejects(sign({ ...f.input, privateKeyPath: wrong.privateKeyPath }), /release_signing_refused/u);
  await assert.rejects(sign({ ...f.input, trust: wrong.trust }), /attended_connector_release_refused/u);
  await assert.rejects(lstat(join(f.root, "connector-release.json")), { code: "ENOENT" });
  const bundlePath = join(f.root, manifest.file), bytes = await readFile(bundlePath);
  await chmod(bundlePath, 0o600); const flipped = Buffer.from(bytes); flipped[flipped.length - 1] ^= 1;
  await writeFile(bundlePath, flipped); await chmod(bundlePath, 0o400); await assert.rejects(sign(f.input));
  await rm(bundlePath); await assert.rejects(sign(f.input));
});

test("connrel refuses replaced existing advertisement, missing recorded advertisement and corrupt build record", async t => {
  const f = await fixture(t); await sign(f.input);
  const path = join(f.root, "connector-release.json"), original = await readFile(path);
  await chmod(path, 0o600); await writeFile(path, "tampered\n"); await chmod(path, 0o400);
  await assert.rejects(sign(f.input)); assert.equal(await readFile(path, "utf8"), "tampered\n");
  await chmod(path, 0o600); await writeFile(path, original); await chmod(path, 0o400);
  const buildPath = join(f.output, "RELEASE_MANIFEST.json"), build = JSON.parse(await readFile(buildPath));
  const saved = JSON.stringify(build);
  const record = build.files.find(item => item.path.endsWith("connector-release.json")); record.bytes += 1;
  await chmod(buildPath, 0o600); await writeFile(buildPath, JSON.stringify(build)); await chmod(buildPath, 0o400);
  await assert.rejects(sign(f.input));
  for (const change of [
    value => { value.files.find(item => item.path.endsWith("connector-release.json")).sha256 = `sha256:${"0".repeat(64)}`; },
    value => { value.files.push({ ...value.files.find(item => item.path.endsWith("connector-release.json")) }); },
    value => { value.files.find(item => item.path.endsWith("connector-release.json")).bytes += 1; },
  ]) {
    const damaged = JSON.parse(saved); change(damaged);
    // Keep aggregate counts valid so only signed-record identity can refuse.
    damaged.fileCount = damaged.files.length;
    damaged.byteCount = damaged.files.reduce((sum, item) => sum + item.bytes, 0);
    await chmod(buildPath, 0o600); await writeFile(buildPath, JSON.stringify(damaged)); await chmod(buildPath, 0o400);
    await assert.rejects(sign(f.input), /attended_connector_release_refused/u);
  }
  await chmod(buildPath, 0o600); await writeFile(buildPath, saved); await chmod(buildPath, 0o400);
  await rm(path); await assert.rejects(sign(f.input));
  await writeFile(path, original, { mode: 0o400 });
  for (const change of [value => { value.schema = "bad"; }, value => { value.commit = "b".repeat(40); },
    value => { value.files = {}; }]) {
    const damaged = JSON.parse(saved); change(damaged);
    await chmod(buildPath, 0o600); await writeFile(buildPath, JSON.stringify(damaged)); await chmod(buildPath, 0o400);
    await assert.rejects(sign(f.input));
  }
});

test("connrel refuses symlink, hardlink, writable and foreign-owned custody", async t => {
  const f = await fixture(t), path = join(f.root, "manifest.json");
  await chmod(path, 0o600); await assert.rejects(sign(f.input)); await chmod(path, 0o400);
  await link(path, join(f.base, "hardlink")); await assert.rejects(sign(f.input)); await rm(join(f.base, "hardlink"));
  await rename(path, join(f.base, "held")); await symlink(join(f.base, "held"), path);
  await assert.rejects(sign(f.input)); await rm(path); await rename(join(f.base, "held"), path);
  await chmod(f.root, 0o777); await assert.rejects(sign(f.input)); await chmod(f.root, 0o700);
  await assert.rejects(signAttendedConnectorReleaseV1(f.input, { expectedUid: uid + 1 }));
  await rename(f.root, `${f.root}-held`); await symlink(`${f.root}-held`, f.root); await assert.rejects(sign(f.input));
  await rm(f.root); await rename(`${f.root}-held`, f.root);
  await chmod(f.output, 0o777); await assert.rejects(sign(f.input)); await chmod(f.output, 0o700);
  const alias = join(f.base, "alias"); await symlink(f.output, alias);
  await assert.rejects(sign({ ...f.input, output: alias }));
});

test("connrel stops halfway, recovers on retry, and excludes a burst of fifty concurrent callers", async t => {
  const f = await fixture(t);
  for (const stage of ["before_publish", "advertisement_written"]) {
    await assert.rejects(sign(f.input, { fault: at => { if (at === stage) throw new Error("stopped"); } }), /stopped/u);
    await assert.rejects(lstat(join(f.output, ".connector-signing.lock")), { code: "ENOENT" });
  }
  await sign(f.input); await verifyAttendedBuildOutputV1(f.output, { commit });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = sign(f.input, { fault: async at => { if (at === "before_publish") { entered(); await held; } } });
  await started;
  try {
    const burst = await Promise.allSettled(Array.from({ length: 50 }, () => sign(f.input)));
    assert.equal(burst.filter(item => item.status === "rejected" && /attended_connector_release_busy/u.test(item.reason.message)).length, 50);
  } finally { release(); await first; }
  await sign(f.input); await verifyAttendedBuildOutputV1(f.output, { commit });
});

test("F3-22: killed signer is recoverable on the same held output", async t => {
  const { spawn } = await import("node:child_process");
  const f = await fixture(t);
  const module = new URL("../src/updater/v1/install/connector-release.mjs", import.meta.url).href;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", `
    import { signAttendedConnectorReleaseV1 } from ${JSON.stringify(module)};
    await signAttendedConnectorReleaseV1(JSON.parse(process.argv[1]), {expectedUid:${uid},
      fault:async stage=>{if(stage==="before_publish"){console.log("locked");setInterval(()=>{},1000);await new Promise(()=>{});}}});
  `, JSON.stringify(f.input)], {detached:true,stdio:["ignore","pipe","pipe"]});
  const closed = new Promise(resolve=>worker.once("close",resolve));
  try {
    await new Promise((resolve,reject)=>{worker.stdout.once("data",resolve);worker.once("exit",()=>reject(new Error("signer exited before lock")));});
    worker.kill("SIGKILL"); await closed;
    assert.ok(await lstat(join(f.output,".connector-signing.lock")),"the kill leaves a real lock name");
    await sign(f.input);
    await verifyAttendedBuildOutputV1(f.output,{commit});
    await assert.rejects(lstat(join(f.output,".connector-signing.lock")),{code:"ENOENT"});
  } finally {
    try {process.kill(-worker.pid,"SIGKILL");}catch{} await closed;
  }
});


// ---------------------------------------------------------------------------------------------
// R4C-08: held signing must refuse a malformed manifest, not throw a raw TypeError.
test("R4C-08: held signing refuses malformed manifests and counts with the release refusal", async t => {
  const f = await fixture(t);
  const manifestPath = join(f.root, "manifest.json"), buildPath = join(f.output, "RELEASE_MANIFEST.json");
  const manifestOriginal = await readFile(manifestPath), buildOriginal = await readFile(buildPath);
  const rewrite = async (path, bytes) => { await chmod(path, 0o600); await writeFile(path, bytes); await chmod(path, 0o400); };

  // These all threw raw TypeError/SyntaxError out of the signer, or -- worse --
  // signed and published: `fileCount += 1` on the string "two" wrote "two1",
  // so the build record no longer counted anything and the refusal was invisible.
  const cases = {
    'a null connector manifest': [manifestPath, "null"],
    'broken connector manifest JSON': [manifestPath, "{"],
    'a null build manifest': [buildPath, "null"],
    'broken build manifest JSON': [buildPath, "{"],
    'a string build file count': [buildPath, null, { fileCount: "two" }],
    'a null build file count': [buildPath, null, { fileCount: null }],
    'a negative build file count': [buildPath, null, { fileCount: -1 }],
    'a fractional build file count': [buildPath, null, { fileCount: 1.5 }],
    'a string build byte count': [buildPath, null, { byteCount: "big" }],
    'a negative build byte count': [buildPath, null, { byteCount: -1 }],
    'a null file member': [buildPath, null, { files: [null] }],
    'a string file member': [buildPath, null, { files: ["x"] }],
    'a file member without a path': [buildPath, null, { files: [{ mode: 0o400 }] }],
    'a file member with a bad mode': [buildPath, null, { files: [{ path: "x", mode: "r--", bytes: 1, sha256: `sha256:${createHash('sha256').update(Buffer.alloc(1)).digest('hex')}` }] }],
    'a file member with a bad digest': [buildPath, null, { files: [{ path: "x", mode: 0o400, bytes: 1, sha256: "nope" }] }],
    'a file member with negative bytes': [buildPath, null, { files: [{ path: "x", mode: 0o400, bytes: -1, sha256: `sha256:${createHash('sha256').update(Buffer.alloc(1)).digest('hex')}` }] }],
    'a non-array files member': [buildPath, null, { files: {} }],
    'a string connector manifest size': [manifestPath, null, { size: "10" }],
  };
  for (const [label, [path, raw, patch]] of Object.entries(cases)) {
    if (raw !== null) await rewrite(path, raw);
    else {
      const original = path === manifestPath ? manifestOriginal : buildOriginal;
      const value = { ...JSON.parse(original), ...patch };
      await rewrite(path, `${JSON.stringify(value, null, 2)}\n`);
    }
    // The refusal is the release's own, so the caller sees one controlled error
    // type rather than a crash from JSON.parse or from `null.path`.
    await assert.rejects(sign(f.input), /attended_connector_release_refused/u, label);
    // Nothing was signed or published by a rejected manifest.
    await assert.rejects(lstat(join(f.root, "connector-release.json")), { code: "ENOENT" }, label);
    await rewrite(path, path === manifestPath ? manifestOriginal : buildOriginal);
  }
  // No signing lock or temporary file survives a rejected manifest, and a good
  // manifest still signs afterwards.
  await assert.rejects(lstat(join(f.output, ".connector-signing.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.output, "RELEASE_MANIFEST.json.tmp")), { code: "ENOENT" });
  await sign(f.input);
  const built = JSON.parse(await readFile(buildPath));
  assert.equal(built.fileCount, built.files.length, "the count stays a number and matches its members");
  assert.ok(built.files.some(item => item.path.endsWith("connector-release.json")),
    "the signed advertisement is recorded");
});
