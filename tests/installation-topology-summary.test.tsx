import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InstallationTopologySummary } from "../private-app/app/installation-topology-summary";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
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
