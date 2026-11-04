import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, isAbsolute } from "node:path";

// Release assembly refuses an output directory inside the release root by design.
// When the inherited TMPDIR sits inside the checkout, use a sibling of the checkout instead.
// `base` defaults to the inherited TMPDIR; tests inject it to exercise synthetic layouts
// without changing the process-wide TMPDIR.
export async function releaseFixtureTemp(repository: string, prefix: string, base: string = tmpdir()) {
  const root = await realpath(repository), canonicalBase = await realpath(base);
  const path = relative(root, canonicalBase);
  const nested = path === "" || (!path.startsWith("..") && !isAbsolute(path));
  return realpath(await mkdtemp(nested ? join(dirname(root), `${basename(root)}-${prefix}`) : join(canonicalBase, prefix)));
}

export type FixtureCleanupOwner = { after(fn: () => unknown): void };

// Allocates a release fixture root and hands its removal to `owner` before any
// fallible setup runs, so a later setup exception cannot leak the root.
export async function ownedReleaseFixtureTemp(owner: FixtureCleanupOwner, repository: string, prefix: string,
  base?: string) {
  const root = await releaseFixtureTemp(repository, prefix, base);
  owner.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Test-only seams for a consumer's local releaseSource(). Defaults are the real operations.
export type ReleaseSourceSeams = {
  repository?: string;
  tempBase?: string;
  assemble?: (input: { releaseRoot: string; outputDirectory: string }) => Promise<unknown>;
  stage?: (input: { ownerAttended: true; releaseDirectory: string; installRoot: string }) =>
    Promise<{ version: string }>;
  prepare?: (input: { releaseRoot: string; expectedDigest?: string }) => Promise<any>;
};

const exists = (path: string) => stat(path).then(() => true, () => false);
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

// Drives one consumer's real releaseSource() with injected assembly/staging failures and a
// captured cleanup registrar, for TMPDIR outside and nested under a synthetic repository.
export async function verifyReleaseFixtureCleanupOwnership(
  t: FixtureCleanupOwner,
  releaseSource: (owner: FixtureCleanupOwner, seams?: ReleaseSourceSeams) => Promise<{ root: string }>,
  assembleReal: (input: { releaseRoot: string; outputDirectory: string }) => Promise<unknown>,
) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "acr-fixture-layout-")));
  const observed: string[] = [];
  // Backstop for exact observed roots only, so a failing (red) run leaves nothing behind.
  t.after(async () => {
    for (const root of observed) await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const repository = join(scratch, "repo");
  const layouts = { outside: join(scratch, "tmp-outside"), nested: join(repository, "tmp") };
  await mkdir(layouts.outside, { recursive: true });
  await mkdir(layouts.nested, { recursive: true });

  // The real assembler still refuses an output nested in its release root.
  const nestedOutput = join(layouts.nested, "refused-output");
  await assert.rejects(assembleReal({ releaseRoot: repository, outputDirectory: nestedOutput }));
  assert.equal(await exists(nestedOutput), false);

  for (const [layout, tempBase] of Object.entries(layouts)) {
    const checkRoot = (root: string) => {
      assert.equal(inside(repository, root), false, `${layout}: root must be outside the synthetic repository`);
      assert.equal(dirname(root), layout === "nested" ? scratch : layouts.outside, `${layout}: root parent`);
    };
    for (const failAt of ["assembly", "staging"] as const) {
      const sentinel = new Error(`synthetic ${failAt} failure`);
      const hooks: Array<() => unknown> = [];
      let root = "";
      const seams: ReleaseSourceSeams = {
        repository, tempBase,
        assemble: async input => {
          root = dirname(input.outputDirectory); observed.push(root);
          if (failAt === "assembly") throw sentinel;
          await mkdir(input.outputDirectory);
        },
        stage: async () => { throw sentinel; },
        prepare: async () => { throw new Error("preparation must not run after a setup failure"); },
      };
      await assert.rejects(releaseSource({ after: fn => { hooks.push(fn); } }, seams), error => error === sentinel);
      assert.notEqual(root, "", `${layout}/${failAt}: root allocated`);
      checkRoot(root);
      assert.equal(await exists(root), true, `${layout}/${failAt}: root exists until teardown`);
      assert.equal(hooks.length, 1, `${layout}/${failAt}: exactly one cleanup registered`);
      for (const hook of hooks.reverse()) await hook();
      assert.equal(await exists(root), false, `${layout}/${failAt}: owned root removed by teardown`);
    }

    // Positive case: a successful setup keeps its root alive until the registered teardown runs.
    const hooks: Array<() => unknown> = [];
    const seams: ReleaseSourceSeams = {
      repository, tempBase,
      assemble: async input => { observed.push(dirname(input.outputDirectory)); await mkdir(input.outputDirectory); },
      stage: async input => { await mkdir(join(input.installRoot, "versions", "0.0.0-synthetic"), { recursive: true });
        return { version: "0.0.0-synthetic" }; },
      prepare: async () => ({ bundle: { digest: "synthetic" } }),
    };
    const source = await releaseSource({ after: fn => { hooks.push(fn); } }, seams);
    checkRoot(source.root);
    assert.equal(await exists(join(source.root, "install")), true, `${layout}/success: root alive after setup`);
    assert.equal(hooks.length, 1, `${layout}/success: exactly one cleanup registered`);
    for (const hook of hooks.reverse()) await hook();
    assert.equal(await exists(source.root), false, `${layout}/success: root removed by teardown`);
  }
}
