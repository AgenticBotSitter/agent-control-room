import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectMacosHermesRuntimeCandidateDirectoryV1,
  serializeMacosHermesRuntimeCandidateInspectionV1 } from "../src/installer/v1/macos-hermes-runtime-candidate-inspector";

const refusal = /^Error: macos_hermes_runtime_candidate_inspection_refused$/u;
const expectedPaths = ["LICENSE", "NOTICE", "bin", "bin/hermes", "lib", "lib/runtime.py"];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acr-hermes-candidate-")); await mkdir(join(root, "bin")); await mkdir(join(root, "lib"));
  await writeFile(join(root, "LICENSE"), "Apache-2.0\n"); await writeFile(join(root, "NOTICE"), "Hermes notices\n");
  await writeFile(join(root, "bin", "hermes"), "#!/usr/bin/env python3\nprint('safe')\n"); await writeFile(join(root, "lib", "runtime.py"), "print('runtime')\n");
  await Promise.all([chmod(root, 0o555), chmod(join(root, "bin"), 0o555), chmod(join(root, "lib"), 0o555), chmod(join(root, "LICENSE"), 0o444), chmod(join(root, "NOTICE"), 0o444), chmod(join(root, "bin", "hermes"), 0o555), chmod(join(root, "lib", "runtime.py"), 0o444)]);
  return root;
}
async function inspect(root: string) { return inspectMacosHermesRuntimeCandidateDirectoryV1({ candidateDirectory: root, architecture: "arm64", expectedPaths }); }

test("inspects a disposable public candidate through the existing non-authorizing manifest", async () => {
  const root = await fixture(), result = await inspect(root);
  assert.deepEqual(result.manifest.entries.map(entry => entry.path), expectedPaths);
  assert.equal(result.observations.readyForPackaging, false); assert.equal(result.observations.readyForLaunch, false);
  assert.equal(result.manifest.grantsPackagingAuthority, false); assert.equal(result.manifest.grantsLaunchAuthority, false);
  assert.equal(serializeMacosHermesRuntimeCandidateInspectionV1(result).includes(root), false);
});

test("refuses symlinks, writable files, Nix references and missing notice records", async () => {
  const mutations = [
    async (root: string) => { await chmod(join(root, "lib"), 0o755); await symlink("runtime.py", join(root, "lib", "linked.py")); await chmod(join(root, "lib"), 0o555); },
    async (root: string) => { await chmod(join(root, "lib", "runtime.py"), 0o644); },
    async (root: string) => { await chmod(join(root, "bin", "hermes"), 0o755); await writeFile(join(root, "bin", "hermes"), "#!/nix/store/example/bin/python\n"); await chmod(join(root, "bin", "hermes"), 0o555); },
    async (root: string) => { await chmod(root, 0o755); await rm(join(root, "NOTICE")); await chmod(root, 0o555); },
    async (root: string) => { await chmod(root, 0o755); await rm(join(root, "NOTICE")); await mkdir(join(root, "NOTICE")); await chmod(join(root, "NOTICE"), 0o555); await chmod(root, 0o555); },
  ];
  for (const mutation of mutations) { const root = await fixture(); await mutation(root); await assert.rejects(inspect(root), refusal); }
});

test("refuses escaping fixture Mach-O dependency strings and unreviewed paths", async () => {
  const root = await fixture(), machO = Buffer.alloc(64); machO.writeUInt32BE(0xfeedfacf, 0); Buffer.from("@loader_path/../../escape\0").copy(machO, 4);
  await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), machO); await chmod(join(root, "lib", "runtime.py"), 0o444);
  await assert.rejects(inspect(root), refusal);
  const clean = await fixture(); await chmod(clean, 0o755); await writeFile(join(clean, "extra.txt"), "extra"); await chmod(join(clean, "extra.txt"), 0o444); await chmod(clean, 0o555);
  await assert.rejects(inspect(clean), refusal);
});

test("refuses every thin or universal Mach-O, including relative dependency references, and unsafe input data", async () => {
  const fixtures: Array<Readonly<{ root: string; mutate: (root: string) => Promise<void> }>> = [
    { root: await fixture(), mutate: async root => { const binary = Buffer.alloc(64); binary.writeUInt32BE(0xcafebabe, 0);
      await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), binary); await chmod(join(root, "lib", "runtime.py"), 0o444); } },
    { root: await fixture(), mutate: async root => { const binary = Buffer.alloc(64); binary.writeUInt32BE(0xfeedfacf, 0); Buffer.from("@rpath/not-allowed.dylib\0").copy(binary, 4);
      await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), binary); await chmod(join(root, "lib", "runtime.py"), 0o444); } },
    { root: await fixture(), mutate: async root => { const binary = Buffer.alloc(64); binary.writeUInt32BE(0xfeedfacf, 0); Buffer.from("@loader_path/missing.dylib\0").copy(binary, 4);
      await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), binary); await chmod(join(root, "lib", "runtime.py"), 0o444); } },
    { root: await fixture(), mutate: async root => { const binary = Buffer.alloc(64); binary.writeUInt32BE(0xfeedfacf, 0); Buffer.from("liboutside.dylib\0").copy(binary, 4);
      await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), binary); await chmod(join(root, "lib", "runtime.py"), 0o444); } },
    { root: await fixture(), mutate: async root => { const binary = Buffer.alloc(64); binary.writeUInt32BE(0xfeedfacf, 0); Buffer.from("../outside.dylib\0").copy(binary, 4);
      await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), binary); await chmod(join(root, "lib", "runtime.py"), 0o444); } },
    { root: await fixture(), mutate: async root => { const binary = Buffer.alloc(80); binary.writeUInt32BE(0xfeedfacf, 0); Buffer.from("/usr/lib/../../private/escape.dylib\0").copy(binary, 4);
      await chmod(join(root, "lib", "runtime.py"), 0o644); await writeFile(join(root, "lib", "runtime.py"), binary); await chmod(join(root, "lib", "runtime.py"), 0o444); } },
  ];
  for (const value of fixtures) { await value.mutate(value.root); await assert.rejects(inspect(value.root), refusal); }
  const root = await fixture(), accessor = { candidateDirectory: root, architecture: "arm64", expectedPaths: [...expectedPaths] } as Record<string, unknown>;
  Object.defineProperty(accessor.expectedPaths as unknown as object, "0", { enumerable: true, get() { throw new Error("read"); } });
  await assert.rejects(inspectMacosHermesRuntimeCandidateDirectoryV1(accessor), refusal);
  await assert.rejects(inspectMacosHermesRuntimeCandidateDirectoryV1(new Proxy({ candidateDirectory: root, architecture: "arm64", expectedPaths }, {})), refusal);
});

test("refuses retained setuid, setgid and sticky bits without assuming the temporary volume supports them", async t => {
  let retained = 0;
  for (const requested of [0o4555, 0o2555, 0o1555]) {
    const root = await fixture(), executable = join(root, "bin", "hermes");
    try { await chmod(executable, requested); } catch { continue; }
    const mode = (await lstat(executable)).mode;
    if ((mode & 0o7000) === 0) continue;
    retained += 1; await assert.rejects(inspect(root), refusal);
  }
  if (retained === 0) t.skip("temporary filesystem did not retain any requested special permission bit");
});
