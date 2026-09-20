import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InstallationTopologySummary } from "../private-app/app/installation-topology-summary";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { sha256Digest } from "../src/security/canonical-digest";

test("setup summary describes one installation and never offers a live operation", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" },
      { kind: "remote", workerId: "worker:remote", adapterId: "connector:remote-v1", adapterRevision: "00570550" }] });
  const html = renderToStaticMarkup(createElement(InstallationTopologySummary, { plan }));
  assert.match(html, /Several computers/);
  assert.match(html, /one database and one scheduler/);
  assert.match(html, /two-computer delivery check/);
  assert.doesNotMatch(html, /<button|<form|<input|worker:remote|sha256:/);
});

test("setup summary shows an honest proof checklist rather than a live worker", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("backup") },
    { proof: "local_owner_qualification", state: "not_started" },
    { proof: "local_runner_bridge", state: "not_started" },
  ] });
  const html = renderToStaticMarkup(createElement(InstallationTopologySummary, { plan, readiness }));
  assert.match(html, /Setup is still in progress/);
  assert.match(html, /Passed:.*backup-and-restore check/);
  assert.match(html, /Not started:.*owner-attended local worker check/);
  assert.match(html, /Not started:.*owner-attended local runner check/);
  assert.doesNotMatch(html, /<button|<form|<input|worker:local|sha256:/);
});
