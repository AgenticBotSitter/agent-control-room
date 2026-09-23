import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activatePrivateVps } from "../scripts/activate-private-vps.mjs";

const configuration = Object.freeze({
  databaseName: "control_room", tenantId: "tenant:activation", workspaceId: "workspace:activation",
  identityId: "identity:activation", grantId: "grant:activation", displayName: "Synthetic owner",
  expectedOwnerSubjectDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const ownerInput = Object.freeze({ configuration, assertion: "synthetic-private-assertion",
  trust: { issuer: "https://access.example.invalid", audience: "test-app" },
  database: { database: "control_room", password: "synthetic-private-password" } });
const prepared = Object.freeze({ mode: "website-only", port: 3210, configuration: { web: {
  database: { database: "control_room" }, tenantId: configuration.tenantId, workspaceId: configuration.workspaceId,
  ownerIdentityId: configuration.identityId, issuer: ownerInput.trust.issuer, audience: ownerInput.trust.audience,
} } });

async function protectedPath(directory, name) {
  const path = join(directory, name); await writeFile(path, "// test-only", { mode: 0o600 }); await chmod(path, 0o600); return path;
}

test("activation is inert for help or invalid arguments", async () => {
  const reports = [], errors = [];
  const runtime = { loadOperator: () => assert.fail("operator must not load"), bootstrap: () => assert.fail("bootstrap must not run"),
    check: () => assert.fail("check must not run"), start: () => assert.fail("start must not run"), report: value => reports.push(value), reportError: value => errors.push(value) };
  assert.equal(await activatePrivateVps(["--help"], runtime), 0);
  assert.equal(await activatePrivateVps([], runtime), 1);
  assert.equal(reports.length, 2); assert.equal(errors.length, 1);
});

test("activation validates both protected inputs before bootstrap and never reports private values", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cr-private-activation-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownerPath = await protectedPath(directory, "owner.mjs"), runtimePath = await protectedPath(directory, "runtime.mjs");
  const reports = [], errors = [], order = [];
  const runtime = { async loadOperator(path) {
      order.push(`load:${path === ownerPath ? "owner" : "runtime"}`);
      return path === ownerPath ? { schema: "control-room.private-owner-bootstrap-configuration/v1", async createConfiguration() { return ownerInput; } }
        : { schema: "control-room.private-vps-configuration/v1", async createConfiguration() { return prepared; } };
    }, async bootstrap() { order.push("bootstrap"); return 0; }, async check() { order.push("check"); return 0; },
    async start() { order.push("start"); return 0; }, report: value => reports.push(value), reportError: value => errors.push(value) };
  const args = ["--owner-bootstrap-configuration", ownerPath, "--configuration", runtimePath, "--start"];
  assert.equal(await activatePrivateVps(args, runtime), 0);
  assert.deepEqual(order, ["load:owner", "load:runtime", "bootstrap", "check", "start"]);
  assert.equal(errors.length, 0);
  assert.doesNotMatch([...reports, ...errors].join("\n"), /synthetic-private|test-app|access\.example/);
});

test("mismatch and failed stages stop before later effects", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cr-private-activation-stop-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownerPath = await protectedPath(directory, "owner.mjs"), runtimePath = await protectedPath(directory, "runtime.mjs");
  const args = ["--owner-bootstrap-configuration", ownerPath, "--configuration", runtimePath, "--start"];
  for (const mode of ["mismatch", "bootstrap", "check", "start"]) {
    const calls = [], output = [];
    const runtime = { async loadOperator(path) {
        return path === ownerPath ? { schema: "control-room.private-owner-bootstrap-configuration/v1", async createConfiguration() { return ownerInput; } }
          : { schema: "control-room.private-vps-configuration/v1", async createConfiguration() {
            return mode === "mismatch" ? { ...prepared, configuration: { web: { ...prepared.configuration.web, ownerIdentityId: "identity:wrong" } } } : prepared;
          } };
      }, async bootstrap() { calls.push("bootstrap"); return mode === "bootstrap" ? 1 : 0; },
      async check() { calls.push("check"); return mode === "check" ? 1 : 0; },
      async start() { calls.push("start"); return mode === "start" ? 1 : 0; }, report: value => output.push(value), reportError: value => output.push(value) };
    assert.equal(await activatePrivateVps(args, runtime), 1, mode);
    assert.deepEqual(calls, mode === "mismatch" ? [] : mode === "bootstrap" ? ["bootstrap"]
      : mode === "check" ? ["bootstrap", "check"] : ["bootstrap", "check", "start"]);
    assert.doesNotMatch(output.join("\n"), /synthetic-private|test-app|access\.example/);
  }
});
