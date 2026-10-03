import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jsQR from "jsqr";
import { checkGatewayHealthV1, checkHealthV1, checkWebHealthV1, DEFAULT_HEALTH_GATEWAY_PORT_V1, DEFAULT_HEALTH_WEB_PORT_V1,
  HEALTH_RESPONSE_LIMIT_BYTES_V1 } from "../src/updater/v1/install/health.mjs";
import { createQrMatrixV1, initialPasskeyUrlV1, renderInitialPasskeyV1,
  terminalQrTextV1 } from "../src/updater/v1/terminal/qr.mjs";
import { readCodeV1 } from "../src/updater/v1/terminal/read-code.mjs";

const KEY = Buffer.alloc(32, 9), RELEASE_ID = "release-1.2.3", RELEASE = `releases/${RELEASE_ID}`,
  SCHEMA = `sha256:${"a".repeat(64)}`,
  UPDATER_SCHEMA = `sha256:${"b".repeat(64)}`;

function healthValue(nonce, overrides = {}) {
  const value = { schema: "control-room.local-host-health/v1", ready: true, pid: 4242, nonce,
    releaseId: RELEASE_ID, startedAt: "2026-09-30T12:00:00.000Z", ...overrides };
  const material = JSON.stringify({ nonce: value.nonce, pid: value.pid, purpose: "local-host-health/v1",
    ready: value.ready, releaseId: value.releaseId, startedAt: value.startedAt });
  return { ...value, tag: `hmac-sha256:${createHmac("sha256", KEY).update(material).digest("hex")}` };
}

function responseFor(init, overrides = {}) {
  const { nonce } = JSON.parse(init.body);
  return new Response(JSON.stringify(healthValue(nonce, overrides)), { status: 200,
    headers: { "content-type": "application/json" } });
}

/** The gateway's tagged answer to `POST /fleet/v1/local-health` (atk-fa F14). */
function gatewayValue(nonce, overrides = {}) {
  const value = { schema: "control-room.fleet-gateway-health/v1", ready: true, pid: 4343, nonce, ...overrides };
  const material = JSON.stringify({ nonce: value.nonce, pid: value.pid, purpose: "fleet-gateway-health/v1", ready: value.ready });
  return { ...value, tag: `hmac-sha256:${createHmac("sha256", KEY).update(material).digest("hex")}` };
}
const gatewayResponse = (init, overrides) => Response.json(gatewayValue(JSON.parse(init.body).nonce, overrides));

/** The two services the health step probes: the web host's and the gateway's tagged routes. */
function serviceResponse(url, init) {
  if (url.endsWith("/fleet/v1/local-health")) return gatewayResponse(init);
  return responseFor(init);
}

const input = overrides => ({ root: "/private/tmp/control-room-c7", expectedRelease: RELEASE, pgDataId: "data-one",
  schemaDigest: SCHEMA, updaterSchemaDigest: UPDATER_SCHEMA, samples: 3, ...overrides });
const databasePort = async () => ({ healthy: true, schemaDigest: SCHEMA, updaterSchemaDigest: UPDATER_SCHEMA });

test("checkHealthV1 uses the existing web route, the default port, three samples, and the typed M4 database port", async () => {
  const urls = [], databaseCalls = [];
  const result = await checkHealthV1(input(), { readCurrentRelease: async () => RELEASE,
    checkDatabase: async value => { databaseCalls.push(value); return databasePort(); } }, {
    healthProbeKey: KEY, delay: async () => {}, transport: async (url, init) => { urls.push({ url, init });
      return serviceResponse(url, init); },
  });
  assert.deepEqual(result, { healthy: true, samples: 3, schemaDigest: SCHEMA });
  assert.equal(databaseCalls.length, 3); assert.equal(urls.length, 6);
  // Every sample probes BOTH services: the web host, then the gateway (cl-bringup N-H).
  const gateway = urls.filter((_request, index) => index % 2 === 1);
  for (const request of gateway) {
    assert.equal(request.url, `http://127.0.0.1:${DEFAULT_HEALTH_GATEWAY_PORT_V1}/fleet/v1/local-health`);
    assert.equal(request.init.method, "POST"); assert.equal(request.init.redirect, "error");
    assert.deepEqual(Object.keys(JSON.parse(request.init.body)), ["nonce"]);
  }
  for (const request of urls.filter((_request, index) => index % 2 === 0)) {
    assert.equal(request.url, `http://127.0.0.1:${DEFAULT_HEALTH_WEB_PORT_V1}/api/v1/local-host-health`);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.headers.origin, `http://127.0.0.1:${DEFAULT_HEALTH_WEB_PORT_V1}`);
    assert.deepEqual(Object.keys(JSON.parse(request.init.body)), ["nonce"]);
  }
  await assert.rejects(checkHealthV1(input(), { readCurrentRelease: async () => RELEASE }, {}),
    /health_database_port_unavailable/u);
  await assert.rejects(checkHealthV1(input(), { readCurrentRelease: async () => "other-release",
    checkDatabase: databasePort }, {}), /health_release_mismatch/u);
  await assert.rejects(checkHealthV1(input(), { readCurrentRelease: async () => RELEASE,
    checkDatabase: async () => ({ healthy: true, schemaDigest: SCHEMA, updaterSchemaDigest: SCHEMA }) }, {
    healthProbeKey: KEY, delay: async () => {}, transport: async (url, init) => serviceResponse(url, init),
  }), /health_database_refused/u);
  // A gateway that is down, or answers anything but its exact tagged answer - including the
  // plain {ready:true} any local process could give (atk-fa F14) - fails the step.
  for (const gatewayAnswer of [() => { throw new Error("connection refused"); }, () => Response.json({ ready: false }),
    () => Response.json({ ready: true }), () => Response.json({ ready: true, extra: 1 }),
    () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })]) {
    await assert.rejects(checkHealthV1(input({ gatewayPort: 3299 }), { readCurrentRelease: async () => RELEASE,
      checkDatabase: databasePort }, { healthProbeKey: KEY, delay: async () => {},
      transport: async (url, init) => url === "http://127.0.0.1:3299/fleet/v1/local-health" ? gatewayAnswer() : serviceResponse(url, init),
    }), /health_gateway_refused/u);
  }
});

test("gateway health refuses a port equal to the web port, out of range, malformed and over-bound answers", async () => {
  const ok = async (_url, init) => gatewayResponse(init);
  assert.deepEqual(await checkGatewayHealthV1({ gatewayPort: 4000 }, { healthProbeKey: KEY, transport: ok }),
    { ready: true, pid: 4343 });
  for (const value of [{ gatewayPort: DEFAULT_HEALTH_WEB_PORT_V1 }, { gatewayPort: 5000, webPort: 5000 },
    { gatewayPort: 80 }, { gatewayPort: 70_000 }, { gatewayPort: "3211" }, undefined]) {
    await assert.rejects(checkGatewayHealthV1(value, { healthProbeKey: KEY, transport: ok }), /health_gateway_refused/u,
      JSON.stringify(value));
  }
  // Wrong key, wrong nonce, unready, or the old untagged answer: refused.
  for (const answer of [(_url, init) => Response.json({ ...gatewayValue(JSON.parse(init.body).nonce),
    tag: `hmac-sha256:${"0".repeat(64)}` }), (_url, init) => gatewayResponse(init, { nonce: "n".repeat(43) }),
  (_url, init) => gatewayResponse(init, { ready: false }), () => Response.json({ ready: true })]) {
    await assert.rejects(checkGatewayHealthV1({ gatewayPort: 4000 }, { healthProbeKey: KEY, transport: async (url, init) => answer(url, init) }),
      /health_gateway_refused/u);
  }
  const run = answer => checkGatewayHealthV1({ gatewayPort: 4000 }, { healthProbeKey: KEY, transport: async () => answer });
  await assert.rejects(run(new Response("not-json", { headers: { "content-type": "application/json" } })), /health_gateway_refused/u);
  await assert.rejects(run(new Response('{"ready":true}', { headers: { "content-type": "text/plain" } })), /health_gateway_refused/u);
  await assert.rejects(run(new Response("x".repeat(HEALTH_RESPONSE_LIMIT_BYTES_V1 + 1),
    { headers: { "content-type": "application/json" } })), /health_web_response_too_large/u);
});

test("web health refuses absent/wrong HMAC, unready/release drift, malformed and over-bound responses", async () => {
  const run = transport => checkWebHealthV1({ root: input().root, expectedRelease: RELEASE },
    { healthProbeKey: KEY, transport });
  await assert.rejects(run(async (_url, init) => { const value = responseFor(init); const body = await value.json();
    delete body.tag; return Response.json(body); }), /health_web_refused/u);
  await assert.rejects(run(async (_url, init) => { const value = responseFor(init); const body = await value.json();
    body.tag = `hmac-sha256:${"0".repeat(64)}`; return Response.json(body); }), /health_web_refused/u);
  await assert.rejects(run(async (_url, init) => responseFor(init, { ready: false })), /health_web_refused/u);
  await assert.rejects(run(async (_url, init) => responseFor(init, { releaseId: "other-release" })), /health_web_refused/u);
  await assert.rejects(run(async () => new Response("not-json", { headers: { "content-type": "application/json" } })),
    /health_web_refused/u);
  await assert.rejects(run(async () => new Response("x", { headers: { "content-type": "application/json",
    "content-length": String(HEALTH_RESPONSE_LIMIT_BYTES_V1 + 1) } })), /health_web_response_too_large/u);
  await assert.rejects(run(async () => new Response("x".repeat(HEALTH_RESPONSE_LIMIT_BYTES_V1 + 1),
    { headers: { "content-type": "application/json" } })), /health_web_response_too_large/u);
  await assert.rejects(checkWebHealthV1(undefined), /health_web_refused/u);
});

test("health retries cleanly after a dropped/slow failure, stops halfway, and handles a 50-caller burst", async () => {
  let calls = 0;
  const runtime = { healthProbeKey: KEY, transport: async (_url, init) => {
    calls += 1; if (calls === 1) throw new Error("dropped"); return responseFor(init);
  } };
  await assert.rejects(checkWebHealthV1({ root: input().root, expectedRelease: RELEASE }, runtime), /health_web_refused/u);
  assert.equal((await checkWebHealthV1({ root: input().root, expectedRelease: RELEASE }, runtime)).releaseId, RELEASE_ID);
  let sample = 0;
  await assert.rejects(checkHealthV1(input(), { readCurrentRelease: async () => RELEASE, checkDatabase: databasePort }, {
    healthProbeKey: KEY, transport: async (url, init) => serviceResponse(url, init),
    delay: async () => { sample += 1; throw new Error("stop-halfway"); },
  }), /stop-halfway/u);
  assert.equal(sample, 1);
  const burst = await Promise.all(Array.from({ length: 50 }, () => checkWebHealthV1(
    { root: input().root, expectedRelease: RELEASE }, { healthProbeKey: KEY,
      transport: async (_url, init) => responseFor(init) })));
  assert.equal(burst.length, 50); assert.equal(burst.every(value => value.releaseId === RELEASE_ID), true);
});

test("the real loopback transport bounds a dropped and a slow connection", async t => {
  let behavior = "drop";
  const server = createServer((request, response) => {
    if (behavior === "drop") { request.socket.destroy(); return; }
    setTimeout(() => { if (!response.destroyed) Response.json({ late: true }).text().then(body => {
      response.writeHead(200, { "content-type": "application/json" }); response.end(body);
    }); }, 100);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const webPort = server.address().port;
  await assert.rejects(checkWebHealthV1({ root: input().root, expectedRelease: RELEASE, webPort },
    { healthProbeKey: KEY, timeoutMs: 20 }), /health_web_refused/u);
  behavior = "slow";
  await assert.rejects(checkWebHealthV1({ root: input().root, expectedRelease: RELEASE, webPort },
    { healthProbeKey: KEY, timeoutMs: 20 }), /health_web_refused/u);
});

test("health default filesystem ports read the protected key/current link without following substitutions", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-c7-health-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "updater-state"), { recursive: true });
  await mkdir(join(root, "releases", RELEASE_ID), { recursive: true });
  await writeFile(join(root, "updater-state", "health-probe.key"), `${KEY.toString("base64url")}\n`, { mode: 0o600 });
  await symlink(RELEASE, join(root, "current"));
  const result = await checkHealthV1(input({ root }), { checkDatabase: databasePort }, { delay: async () => {},
    transport: async (url, init) => serviceResponse(url, init) });
  assert.equal(result.healthy, true);
  await rm(join(root, "updater-state", "health-probe.key"));
  await assert.rejects(checkWebHealthV1({ root, expectedRelease: RELEASE }, {
    transport: async (_url, init) => responseFor(init),
  }), /health_probe_key_refused/u);
});

function decodedMatrix(matrix) {
  const quiet = 4, scale = 5, side = (matrix.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4); pixels.fill(255);
  for (let row = 0; row < matrix.length; row += 1) for (let column = 0; column < matrix.length; column += 1) {
    if (!matrix[row][column]) continue;
    for (let y = 0; y < scale; y += 1) for (let x = 0; x < scale; x += 1) {
      const offset = (((row + quiet) * scale + y) * side + (column + quiet) * scale + x) * 4;
      pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0; pixels[offset + 3] = 255;
    }
  }
  return jsQR(pixels, side, side, { inversionAttempts: "dontInvert" })?.data;
}

test("initial-mode terminal QR decodes to the typed fallback and always carries the fresh owner code", () => {
  const registrationSecret = "R".repeat(43), ownerCode = "O".repeat(43), rpId = "control.example.ts.net";
  const url = initialPasskeyUrlV1({ rpId, ownerCode, registrationSecret });
  assert.equal(decodedMatrix(createQrMatrixV1(url)), url, "an independent decoder must recover the exact URL");
  const writes = [], rendered = renderInitialPasskeyV1({ rpId, ownerCode, registrationSecret },
    { write: value => writes.push(value) });
  assert.equal(rendered.url, url); assert.match(writes[0], /[▀▄█]/u); assert.match(writes.join(""), new RegExp(url, "u"));
  assert.equal(new URL(url).hash, `#code=${ownerCode}&reg=${registrationSecret}`);
  const qrText = terminalQrTextV1(url); assert.match(qrText, /[▀▄█]/u);
  assert.equal(new Set(qrText.slice(0, -1).split("\n").map(line => line.length)).size, 1,
    "the right quiet zone is retained");
  assert.throws(() => initialPasskeyUrlV1({ rpId, registrationSecret }), /passkey_registration_url_refused/u);
});

test("readCode requires a tty, normalizes valid input, and restores raw mode after every refusal and SIGINT", async () => {
  const modes = [], writes = [];
  assert.equal(await readCodeV1({ isTTY: true, write: value => writes.push(value), readLine: async () => "ab12cd\r",
    setRawMode: value => modes.push(value) }), "AB12CD");
  assert.deepEqual(modes, [true, false]);
  for (const value of ["short", "ABC-12", "\u0003"]) {
    const restored = [];
    await assert.rejects(readCodeV1({ isTTY: true, write() {}, readLine: async () => value,
      setRawMode: mode => restored.push(mode) }), /updater_passkey_code_(?:refused|interrupted)/u);
    assert.deepEqual(restored, [true, false]);
  }
  await assert.rejects(readCodeV1({ isTTY: false, write() {}, readLine: async () => "ABC123", setRawMode() {} }),
    /updater_passkey_code_terminal_required/u);
  const signals = new EventEmitter(), interruptedModes = [];
  const interrupted = readCodeV1({ isTTY: true, write() {}, readLine: async signal => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), setRawMode: value => interruptedModes.push(value) }, { signals });
  queueMicrotask(() => signals.emit("SIGINT"));
  await assert.rejects(interrupted, /updater_passkey_code_interrupted/u);
  assert.deepEqual(interruptedModes, [true, false]); assert.equal(signals.listenerCount("SIGINT"), 0);
});

async function ptyRun(t, mode) {
  const child = spawn("/usr/bin/expect", [join(process.cwd(), "tests/support/read-code-pty.expect"), process.execPath,
    join(process.cwd(), "tests/support/read-code-pty.mjs"), mode], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => chunks.push(chunk));
  const cleanup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null); assert.equal(code, 0, Buffer.concat(chunks).toString("utf8"));
    return Buffer.concat(chunks).toString("utf8").replaceAll("\r", "");
  } finally { cleanup(); }
}

test("readCode works through a real pseudo-tty for wrong/right input, later reads, and Ctrl-C", async t => {
  const wrongRight = await ptyRun(t, "wrong-right");
  assert.match(wrongRight, /WRONG:updater_passkey_code_refused/u);
  assert.match(wrongRight, /RIGHT:ABC123/u); assert.match(wrongRight, /LATER:later/u);
  const interrupted = await ptyRun(t, "interrupt");
  assert.match(interrupted, /INTERRUPTED:updater_passkey_code_interrupted/u);
});


test("A2-06 gateway health refuses duplicate readiness keys, including escaped spelling", async () => {
  // Merged with atk-fa F14: the duplicate key now rides on an otherwise valid tagged answer.
  const duplicated = (init, prefix) => {
    const body = JSON.stringify(gatewayValue(JSON.parse(init.body).nonce));
    return new Response(`{${prefix},${body.slice(1)}`, { headers: { 'content-type': 'application/json' } });
  };
  for (const prefix of ['"ready":false', '"re\\u0061dy":false']) {
    const results = await Promise.allSettled(Array.from({ length: 50 }, () =>
      checkGatewayHealthV1({ gatewayPort: 4000 }, { healthProbeKey: KEY, transport: async (_url, init) =>
        duplicated(init, prefix) })));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'health_gateway_refused'));
  }
  assert.deepEqual(await checkGatewayHealthV1({ gatewayPort: 4000 }, { healthProbeKey: KEY, transport: async (_url, init) =>
    gatewayResponse(init) }), { ready: true, pid: 4343 });
});

test("a local process squatting on the health ports, or redirecting them, never passes the health step", async t => {
  // atk-fa F14, over real sockets: a fake answering {"ready":true} on the gateway port and a
  // gateway port that 307-redirects to such a fake were both ACCEPTED.
  const listen = handler => new Promise(resolveServer => {
    const server = createServer(handler); server.listen(0, "127.0.0.1", () => resolveServer(server)); });
  const squatter = await listen((_request, response) => {
    response.setHeader("content-type", "application/json"); response.end('{"ready":true}'); });
  const redirector = await listen((_request, response) => { response.statusCode = 307;
    response.setHeader("location", `http://127.0.0.1:${squatter.address().port}/fleet/v1/local-health`); response.end(); });
  t.after(() => { for (const server of [squatter, redirector]) { server.closeAllConnections(); server.close(); } });
  for (const server of [squatter, redirector]) {
    await assert.rejects(checkGatewayHealthV1({ gatewayPort: server.address().port }, { healthProbeKey: KEY }),
      /health_gateway_refused/u);
    await assert.rejects(checkWebHealthV1({ root: input().root, webPort: server.address().port, expectedRelease: RELEASE },
      { healthProbeKey: KEY }), /health_web_refused/u);
  }
});
