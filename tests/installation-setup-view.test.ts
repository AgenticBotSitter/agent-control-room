import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";
import * as zod from "zod";
import { runInNewContext } from "node:vm";
import { sha256Digest } from "../src/security/canonical-digest";
import { createInstallationSetupViewV1, parseInstallationSetupViewV1 } from "../src/harness/v1/installation-setup-view";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";

const digest = (value: string) => sha256Digest(value);
test("setup wire parses without Node globals or runtime private-builder imports", async () => {
  const source = await readFile("src/harness/v1/installation-setup-wire.ts", "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const context = { TextEncoder, TextDecoder, exports: {}, require: (name: string) => {
    assert.equal(name, "zod", "wire parser may load only browser-safe validation code"); return zod;
  } };
  runInNewContext(compiled, context);
  const wire = context.exports as { parseInstallationSetupViewV1(value: unknown): unknown };
  const view = createInstallationSetupViewV1({ plan: plan(), localBackupRestoreVerified: false });
  assert.equal(JSON.stringify(wire.parseInstallationSetupViewV1(view)), JSON.stringify(view));
  assert.throws(() => wire.parseInstallationSetupViewV1({ ...view, privatePath: "/fixture/private" }));
});
const plan = () => planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:private-local", adapterId: "connector:local", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:private-local", adapterId: "connector:local", adapterRevision: "0000001" },
    { kind: "remote", workerId: "worker:private-remote", adapterId: "connector:remote", adapterRevision: "0000001" }] });

test("the browser setup view contains only setup facts, never topology identities or fingerprints", () => {
  const topology = plan();
  const view = createInstallationSetupViewV1({ plan: topology, localBackupRestoreVerified: false,
    readiness: createInstallationReadinessV1({ planDigest: topology.planDigest, proofs: [
      { proof: "backup_restore", state: "passed", evidenceDigest: digest("backup") },
    ] }) });
  const serialized = JSON.stringify(view);
  assert.equal(view.mode, "several_computers");
  assert.doesNotMatch(serialized, /worker:private|connector:|sha256:|planDigest|evidenceDigest|readinessDigest/);
  assert.deepEqual(parseInstallationSetupViewV1(view), view);
});

test("the browser parser refuses a raw plan or proof record even beside a valid-looking view", () => {
  const topology = plan();
  assert.throws(() => parseInstallationSetupViewV1({
    ...createInstallationSetupViewV1({ plan: topology, localBackupRestoreVerified: false }),
    plan: topology,
  }));
});
