import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createInstallationSetupViewV1, parseInstallationSetupViewV1 } from "../src/harness/v1/installation-setup-view";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";

const digest = (value: string) => sha256Digest(value);
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
