import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConfiguration, readProtectedFile } from "../deploy/github-app/operator-config.mjs";
import { parseArguments, readProtectedConfiguration, runGitHubWorkerBroker, validateConfigurationPath } from "../scripts/run-github-worker-broker.mjs";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acr-github-broker-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (name, value) => {
    const path = join(directory, name); await writeFile(path, value, { mode: 0o600 }); return path;
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const paths = {
    settings: await write("settings.json", JSON.stringify({
      schema: "control-room.github-broker-settings/v1", appId: 4960037, installationId: 162066346,
      repository: "AgenticBotSitter/agent-control-room", port: 3211,
      database: { host: "127.0.0.1", port: 5432, database: "control_room",
        username: "control_room_github_broker", majorVersion: 17 },
    })),
    key: await write("key.pem", privateKey.export({ type: "pkcs8", format: "pem" })),
    webhook: await write("webhook", "w".repeat(48)),
    worker: await write("worker", "r".repeat(48)),
    database: await write("database", "d".repeat(32)),
  };
  return { directory, paths, env: {
    ACR_GITHUB_BROKER_SETTINGS_FILE: paths.settings,
    ACR_GITHUB_APP_PRIVATE_KEY_FILE: paths.key,
    ACR_GITHUB_WEBHOOK_SECRET_FILE: paths.webhook,
    ACR_GITHUB_WORKER_READ_SECRET_FILE: paths.worker,
    ACR_GITHUB_DATABASE_PASSWORD_FILE: paths.database,
  } };
}

test("operator configuration reads protected files, validates the key offline and prepares an inert service", async t => {
  const { env } = await fixture(t);
  let captured; let signingCount = 0;
  const service = { start: async () => {}, close: async () => {} };
  const result = await createConfiguration({ signal: new AbortController().signal, env, trustedOwnerUid: process.getuid(), runtime: {
    createGitHubAppJwt(credentials) {
      signingCount += 1; assert.equal(credentials.appId, "4960037");
      assert.match(credentials.privateKeyPem, /BEGIN PRIVATE KEY/u); return "offline.jwt.signature";
    },
    async prepareGitHubBrokerPrivateService(configuration) { captured = configuration; return service; },
  } });
  assert.equal(result, service); assert.equal(signingCount, 1);
  assert.equal(captured.database.password, "d".repeat(32));
  assert.equal(captured.webhookSecret, "w".repeat(48));
  assert.equal(captured.authorizeWorker({ headers: { authorization: `Bearer ${"r".repeat(48)}` } }), true);
  assert.equal(captured.authorizeWorker({ headers: { authorization: `Bearer ${"x".repeat(48)}` } }), false);
  assert.equal(captured.authorizeWorker({ headers: {} }), false);
});

test("operator configuration refuses missing, shared, linked, malformed and aborted inputs", async t => {
  const { directory, paths, env } = await fixture(t);
  const runtime = { createGitHubAppJwt() { return "jwt"; }, async prepareGitHubBrokerPrivateService() {
    return { start: async () => {}, close: async () => {} };
  } };
  await chmod(paths.webhook, 0o644);
  await assert.rejects(createConfiguration({ signal: new AbortController().signal, env, runtime, trustedOwnerUid: process.getuid() }),
    /github_broker_operator_configuration_invalid/u);
  await chmod(paths.webhook, 0o600);
  const link = join(directory, "webhook-link"); await symlink(paths.webhook, link);
  await assert.rejects(createConfiguration({ signal: new AbortController().signal,
    env: { ...env, ACR_GITHUB_WEBHOOK_SECRET_FILE: link }, runtime, trustedOwnerUid: process.getuid() }), /operator_configuration_invalid/u);
  await writeFile(paths.settings, "{}", { mode: 0o600 });
  await assert.rejects(createConfiguration({ signal: new AbortController().signal, env, runtime, trustedOwnerUid: process.getuid() }),
    /operator_configuration_invalid/u);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(createConfiguration({ signal: aborted.signal, env, runtime, trustedOwnerUid: process.getuid() }), /operator_configuration_invalid/u);
});

test("owner-file validation rejects noncanonical or oversized content", async t => {
  const { directory, paths } = await fixture(t);
  const options = { maxBytes: 1024, trustedOwnerUid: process.getuid() };
  assert.equal(await readProtectedFile(paths.worker, options), "r".repeat(48));
  await assert.rejects(readProtectedFile("relative", options), /operator_configuration_invalid/u);
  await assert.rejects(readProtectedFile(paths.worker, { ...options, maxBytes: 8 }), /operator_configuration_invalid/u);
  const link = join(directory, "worker-link"); await symlink(paths.worker, link);
  await assert.rejects(readProtectedFile(link, options), /operator_configuration_invalid/u);
});

test("protected reads reject a file that changes after it is opened", async () => {
  let calls = 0; let closed = 0;
  const metadata = { isFile: () => true, uid: 0n, mode: 0o100640n, size: 48n,
    dev: 1n, ino: 2n, mtimeNs: 3n };
  const openFile = async () => ({
    async stat() { calls += 1; return calls === 1 ? metadata : { ...metadata, mtimeNs: 4n }; },
    async readFile() { return "r".repeat(48); }, async close() { closed += 1; },
  });
  await assert.rejects(readProtectedFile("/protected/secret", { maxBytes: 1024, openFile }),
    /operator_configuration_invalid/u);
  assert.equal(closed, 1);
  calls = 0; closed = 0;
  await assert.rejects(readProtectedConfiguration("/protected/operator.mjs", { openFile }),
    /github_broker_configuration_invalid/u);
  assert.equal(closed, 1);
});

test("launcher accepts only one protected operator module", async t => {
  const { directory } = await fixture(t);
  const operator = join(directory, "operator.mjs"); await writeFile(operator, "export {};", { mode: 0o600 });
  assert.deepEqual(parseArguments(["--configuration", operator]), { configurationPath: operator, checkOnly: false });
  assert.deepEqual(parseArguments(["--check", "--configuration", operator]), { configurationPath: operator, checkOnly: true });
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  for (const input of [[], ["--configuration", "relative.mjs"], ["--configuration", "/tmp/config.json"],
    ["--configuration", operator, "--force"]]) assert.throws(() => parseArguments(input));
  await validateConfigurationPath(operator, { trustedOwnerUid: process.getuid() });
  await chmod(operator, 0o644);
  await validateConfigurationPath(operator, { trustedOwnerUid: process.getuid() });
  await chmod(operator, 0o664);
  await assert.rejects(validateConfigurationPath(operator, { trustedOwnerUid: process.getuid() }), /github_broker_configuration_invalid/u);
  await chmod(operator, 0o600);
  assert.equal(await readProtectedConfiguration(operator, { trustedOwnerUid: process.getuid() }), "export {};");
});

test("check-only validates and closes without opening a listener", async t => {
  const { directory } = await fixture(t);
  const operatorPath = join(directory, "operator.mjs"); await writeFile(operatorPath, "export {};", { mode: 0o600 });
  const signals = new EventEmitter(); const reports = []; let started = 0; let closed = 0;
  const result = await runGitHubWorkerBroker(["--check", "--configuration", operatorPath], {
    signals, report: value => reports.push(value), reportError: value => reports.push(value),
    async loadOperator() { return { schema: "control-room.github-broker-operator/v1",
      async createConfiguration() { return { async start() { started += 1; }, async close() { closed += 1; } }; } }; },
    async loadRelease() { return {}; },
  });
  assert.equal(result, 0); assert.equal(started, 0); assert.equal(closed, 1);
  assert.deepEqual(reports, ["Control Room GitHub worker broker configuration check passed; no listener was opened."]);
});

test("launcher starts once, reports readiness, and closes on the supervisor signal", async t => {
  const { directory } = await fixture(t);
  const operatorPath = join(directory, "operator.mjs"); await writeFile(operatorPath, "export {};", { mode: 0o600 });
  const signals = new EventEmitter(); const reports = []; let started = 0; let closed = 0;
  const service = { async start() { started += 1; setImmediate(() => signals.emit("SIGTERM")); },
    async close() { closed += 1; } };
  const result = await runGitHubWorkerBroker(["--configuration", operatorPath], {
    signals, report: value => reports.push(value), reportError: value => reports.push(value),
    async loadOperator() { return { schema: "control-room.github-broker-operator/v1",
      async createConfiguration() { return service; } }; },
    async loadRelease() { return {}; },
  });
  assert.equal(result, 0); assert.equal(started, 1); assert.equal(closed, 1);
  assert.deepEqual(reports, ["Control Room GitHub worker broker ready on private loopback.",
    "Control Room GitHub worker broker closed."]);
});

test("a stop arriving during listener startup cannot be lost", async t => {
  const { directory } = await fixture(t);
  const operatorPath = join(directory, "operator.mjs"); await writeFile(operatorPath, "export {};", { mode: 0o600 });
  const signals = new EventEmitter(); let closed = 0;
  const result = await Promise.race([
    runGitHubWorkerBroker(["--configuration", operatorPath], {
      signals, report() {}, reportError() {},
      async loadOperator() { return { schema: "control-room.github-broker-operator/v1",
        async createConfiguration() { return { async start() { signals.emit("SIGTERM"); },
          async close() { closed += 1; } }; } }; },
      async loadRelease() { return {}; },
    }),
    new Promise(resolve => setTimeout(() => resolve("timed-out"), 250)),
  ]);
  assert.equal(result, 1); assert.equal(closed, 1);
});

test("systemd package contains paths only, drops privilege and has a bounded restart policy", async () => {
  const unit = await readFile(new URL("../deploy/github-app/agent-control-room-github-worker-broker.service", import.meta.url), "utf8");
  const environment = await readFile(new URL("../deploy/github-app/github-worker-broker.env.example", import.meta.url), "utf8");
  assert.match(unit, /^User=control-room$/mu); assert.match(unit, /^Group=control-room$/mu);
  assert.match(unit, /^Restart=on-failure$/mu); assert.match(unit, /^NoNewPrivileges=yes$/mu);
  assert.match(unit, /^LimitCORE=0$/mu); assert.match(unit, /^CapabilityBoundingSet=$/mu);
  assert.match(unit, /^ProtectSystem=strict$/mu); assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/mu);
  assert.doesNotMatch(unit + environment, /BEGIN PRIVATE KEY|Bearer |password=|webhook.{0,20}[A-Za-z0-9]{32}/iu);
  for (const name of ["PRIVATE_KEY_FILE", "WEBHOOK_SECRET_FILE", "WORKER_READ_SECRET_FILE", "DATABASE_PASSWORD_FILE"])
    assert.match(environment, new RegExp(`ACR_GITHUB_[A-Z_]*${name}=`));
});
