import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CONNECTOR_REDIRECT_REFUSED_V1, ConnectorRedirectRefusedV1, connectorFetchV1 } from "../scripts/fleet/connector-http.mjs";
import { createClient, join as joinConnector, serveMcp } from "../scripts/fleet/connector.mjs";

// The connector's gateway transport replaced Node's fetch, so every property a
// caller relies on is pinned here against a raw socket server: the bytes on the
// wire are written by hand, never by node:http, so the server cannot share a
// framing bug with the client it is testing.

const WORKER = `fleet-worker:${"a".repeat(32)}`;
const SECRET = `crf_${"A".repeat(43)}`, PENDING = `crf_${"P".repeat(43)}`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const pattern = (size, seed = 7) => {
  const bytes = Buffer.alloc(size);
  for (let index = 0, state = seed; index < size; index++) { state = (state * 1103515245 + 12345) >>> 0; bytes[index] = state >>> 24; }
  return bytes;
};
const listen = server => new Promise(done => server.listen(0, "127.0.0.1", () => done(server.address().port)));

/** A loopback server that parses each request itself and hands the socket to
 * `answer`, which writes the reply byte for byte. */
async function rawServer(t, answer) {
  const requests = [], sockets = new Set();
  const server = createNetServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let received = Buffer.alloc(0), answered = false;
    socket.on("data", chunk => {
      if (answered) return;
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = received.subarray(0, end).toString("latin1");
      const [line, ...lines] = head.split("\r\n");
      const headers = {};
      for (const entry of lines) {
        const colon = entry.indexOf(":");
        headers[entry.slice(0, colon).trim().toLowerCase()] = entry.slice(colon + 1).trim();
      }
      const length = Number(headers["content-length"] ?? 0);
      if (received.length < end + 4 + length) return;
      answered = true;
      const request = { line, head, headers, path: line.split(" ")[1], body: received.subarray(end + 4, end + 4 + length),
        port: socket.remotePort };
      requests.push(request);
      answer(socket, request);
    });
  });
  const port = await listen(server);
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(done => server.close(() => done())); });
  return { url: `http://127.0.0.1:${port}`, requests, sockets };
}

const head = (status, headers = {}, reason = "Reason") =>
  Buffer.from(`HTTP/1.1 ${status} ${reason}\r\n${Object.entries(headers).map(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`).join("")).join("")}\r\n`, "latin1");
const reply = (socket, status, headers, body = Buffer.alloc(0)) =>
  socket.end(Buffer.concat([head(status, { connection: "close", ...headers }), Buffer.from(body)]));

test("CONNHTTP-01: a content-length reply arrives whole, with fetch's status, headers and body", { timeout: 60_000 }, async t => {
  const body = pattern(200 * 1024);
  const gateway = await rawServer(t, socket => reply(socket, 201, { "Content-Length": body.length, "X-Mixed-Case": "Kept",
    "Set-Cookie": ["first=1", "second=2"], "Content-Type": "application/octet-stream" }, body));
  const response = await connectorFetchV1(`${gateway.url}/bytes`);
  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.statusText, "Reason");
  assert.equal(response.headers.get("x-mixed-case"), "Kept");
  assert.equal(response.headers.get("X-MIXED-CASE"), "Kept");
  assert.equal(response.headers.get("content-length"), String(body.length));
  assert.deepEqual(response.headers.getSetCookie(), ["first=1", "second=2"]);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(body));
  // Two deliberate differences from fetch, which no caller reads: a Response
  // built by hand has type "default" and no URL. A caller that starts reading
  // either must change this transport first.
  assert.equal(response.type, "default");
  assert.equal(response.url, "");
});

test("CONNHTTP-02: a chunked reply is reassembled from its chunks", { timeout: 60_000 }, async t => {
  const parts = [pattern(1, 1), pattern(70 * 1024, 2), pattern(3, 3), pattern(130 * 1024, 4)];
  const gateway = await rawServer(t, socket => {
    socket.write(head(200, { "transfer-encoding": "chunked", connection: "close" }));
    for (const part of parts) socket.write(Buffer.concat([Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from("\r\n")]));
    socket.end("0\r\n\r\n");
  });
  const response = await connectorFetchV1(`${gateway.url}/chunked`);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(Buffer.concat(parts)));
});

test("CONNHTTP-03: a close-delimited reply over 64 KiB is read to its end", { timeout: 60_000 }, async t => {
  const body = pattern(1024 * 1024 + 17);
  const gateway = await rawServer(t, socket => {
    socket.write(head(200, { connection: "close" }));
    socket.end(body);
  });
  const response = await connectorFetchV1(`${gateway.url}/close`);
  assert.equal(response.headers.get("content-length"), null);
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(received.length, body.length);
  assert.equal(digest(received), digest(body));
});

test("CONNHTTP-04: a body that stops early is an error, never a short success", { timeout: 60_000 }, async t => {
  const total = 200 * 1024, body = pattern(total);
  // Boundary cuts around the 64 KiB buffering target, plus a fixed-seed sweep.
  const cuts = [0, 1, 65535, 65536, 65537, total - 1];
  for (let index = 0, state = 0x5eed; index < 8; index++) { state = (state * 1103515245 + 12345) >>> 0; cuts.push(state % total); }
  const plan = cuts.flatMap(cut => [{ cut, framing: "content-length" }, { cut, framing: "chunked" }]);
  let next = 0;
  const gateway = await rawServer(t, socket => {
    const { cut, framing } = plan[next++];
    if (framing === "content-length") {
      socket.write(head(200, { "content-length": total, connection: "close" }));
      socket.end(body.subarray(0, cut));
    } else {
      socket.write(head(200, { "transfer-encoding": "chunked", connection: "close" }));
      if (cut > 0) socket.write(Buffer.concat([Buffer.from(`${cut.toString(16)}\r\n`), body.subarray(0, cut), Buffer.from("\r\n")]));
      socket.end(); // the terminating zero-length chunk never arrives
    }
  });
  for (const { cut, framing } of plan) {
    const response = await connectorFetchV1(`${gateway.url}/cut`);
    await assert.rejects(response.arrayBuffer(), error => error instanceof TypeError && error.message === "terminated",
      `${framing} cut at ${cut} of ${total} must error`);
  }
  assert.equal(next, plan.length);
});

test("CONNHTTP-05: a reply longer than its content-length never yields the extra bytes", { timeout: 60_000 }, async t => {
  const declared = pattern(10, 5), extra = pattern(10, 6);
  const gateway = await rawServer(t, socket => {
    socket.end(Buffer.concat([head(200, { "content-length": declared.length, connection: "close" }), declared, extra]));
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await connectorFetchV1(`${gateway.url}/long`);
    // Either the declared bytes exactly, or an error: the bytes past the
    // declared length are never part of a successful body.
    const received = await response.arrayBuffer().then(value => Buffer.from(value), error => error);
    if (received instanceof Error) assert.ok(received instanceof TypeError, String(received));
    else assert.deepEqual(received, declared);
  }
});

test("CONNHTTP-06: null-body statuses and HEAD resolve with no body", { timeout: 60_000 }, async t => {
  const statuses = [204, 205, 304, 200];
  let next = 0;
  const gateway = await rawServer(t, socket => {
    const status = statuses[next++];
    reply(socket, status, status === 200 ? { "content-length": 5 } : {});
  });
  for (const status of [204, 205, 304]) {
    const response = await connectorFetchV1(`${gateway.url}/empty`);
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), "");
  }
  const headed = await connectorFetchV1(`${gateway.url}/head`, { method: "HEAD" });
  assert.equal(headed.status, 200);
  assert.equal(headed.body, null);
  assert.equal(gateway.requests.at(-1).line, "HEAD /head HTTP/1.1");
});

test("CONNHTTP-07: a refusal status passes through with its body and retry-after", { timeout: 60_000 }, async t => {
  const body = Buffer.from(JSON.stringify({ ok: false, error: "rate_limited" }));
  const gateway = await rawServer(t, socket => reply(socket, 429,
    { "content-type": "application/json", "content-length": body.length, "Retry-After": "7" }, body));
  const response = await connectorFetchV1(`${gateway.url}/limited`);
  assert.equal(response.status, 429);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(await response.json(), { ok: false, error: "rate_limited" });
});

test("CONNHTTP-08: the request carries the caller's method, headers and body on its own connection", { timeout: 60_000 }, async t => {
  const gateway = await rawServer(t, socket => reply(socket, 200, { "content-length": 0 }));
  await connectorFetchV1(`${gateway.url}/text?q=1`, { method: "POST", body: "héllo", headers: { "X-Control-Room-Worker": WORKER } });
  await connectorFetchV1(`${gateway.url}/json`, { method: "POST", body: "{}", headers: { "content-type": "application/json", accept: "application/json" } });
  await connectorFetchV1(`${gateway.url}/bytes`, { method: "PUT", body: new Uint8Array([1, 2, 3]) });
  await connectorFetchV1(`${gateway.url}/empty-post`, { method: "POST" });
  await connectorFetchV1(`${gateway.url}/get`, { headers: new Headers({ Authorization: `Bearer ${SECRET}` }) });
  const [text, json, bytes, emptyPost, get] = gateway.requests;
  assert.equal(text.line, "POST /text?q=1 HTTP/1.1");
  assert.equal(text.headers["content-length"], "6");
  assert.equal(text.body.toString("utf8"), "héllo");
  assert.equal(text.headers["content-type"], "text/plain;charset=UTF-8");
  assert.equal(text.headers["x-control-room-worker"], WORKER);
  assert.equal(text.headers.accept, "*/*");
  assert.equal(json.headers["content-type"], "application/json");
  assert.equal(json.headers.accept, "application/json");
  assert.deepEqual([...bytes.body], [1, 2, 3]);
  assert.equal(bytes.line, "PUT /bytes HTTP/1.1");
  assert.equal(emptyPost.headers["content-length"], "0");
  assert.equal(get.headers["content-length"], undefined);
  assert.equal(get.headers.authorization, `Bearer ${SECRET}`);
  for (const request of gateway.requests) {
    // One reply per connection, which is the gateway's rule, and none of the
    // headers Node's fetch adds (it always sends sec-fetch-mode).
    assert.equal(request.headers.connection, "close");
    assert.equal(request.headers["sec-fetch-mode"], undefined);
    assert.equal(request.headers["accept-encoding"], undefined);
  }
  assert.equal(new Set(gateway.requests.map(request => request.port)).size, gateway.requests.length);
});

test("CONNHTTP-09: every redirect is refused with its status, where fetch's redirect: error refuses, and its location is never contacted", { timeout: 60_000 }, async t => {
  const elsewhere = await rawServer(t, socket => reply(socket, 200, { "content-length": 2 }, "ok"));
  const cases = [[300, true], [301, true], [301, false], [302, true], [302, false], [303, true], [304, false], [307, true], [308, true]];
  const gateway = await rawServer(t, (socket, request) => {
    const [, status, located] = /^\/(\d+)-(\d)$/u.exec(request.path);
    reply(socket, Number(status), { "content-length": 0, ...(located === "1" ? { location: `${elsewhere.url}/stolen` } : {}) });
  });
  for (const [status, located] of cases) {
    const url = `${gateway.url}/${status}-${located ? 1 : 0}`;
    const init = { redirect: "error", headers: { authorization: `Bearer ${SECRET}` } };
    // The independent expectation: what Node's own fetch decides for the same reply.
    const fetchRefused = await fetch(url, init).then(response => { void response.body?.cancel(); return false; },
      error => error instanceof TypeError && error.cause?.message === "unexpected redirect");
    const outcome = await connectorFetchV1(url, init).then(response => response, error => error);
    if (fetchRefused) {
      assert.ok(outcome instanceof ConnectorRedirectRefusedV1, `${status} location=${located} must be refused`);
      assert.ok(outcome instanceof TypeError);
      assert.equal(outcome.name, "ConnectorRedirectRefusedV1");
      assert.equal(outcome.code, CONNECTOR_REDIRECT_REFUSED_V1);
      assert.equal(outcome.status, status);
      assert.equal(outcome.message, "fetch failed");
      assert.equal(outcome.cause?.message, "unexpected redirect");
    } else {
      assert.ok(!(outcome instanceof Error), `${status} is not a redirect status: ${outcome}`);
      assert.equal(outcome.status, status);
    }
  }
  // The pinned outcome of that comparison, so a change in Node's fetch cannot
  // quietly move what this test expects.
  const refusedStatuses = [];
  for (const [status, located] of cases) {
    const outcome = await connectorFetchV1(`${gateway.url}/${status}-${located ? 1 : 0}`).then(() => null, error => error);
    if (outcome?.code === CONNECTOR_REDIRECT_REFUSED_V1) refusedStatuses.push(`${status}${located ? "" : "-bare"}`);
  }
  assert.deepEqual(refusedStatuses, ["301", "301-bare", "302", "302-bare", "303", "307", "308"]);
  assert.equal(elsewhere.requests.length, 0, "the credential never reaches the redirect's location");
});

test("CONNHTTP-10: there is no redirect mode but refusal, and asking for one sends nothing", { timeout: 60_000 }, async t => {
  const gateway = await rawServer(t, socket => reply(socket, 200, { "content-length": 0 }));
  for (const redirect of ["follow", "manual", "", null]) {
    await assert.rejects(connectorFetchV1(`${gateway.url}/mode`, { redirect }), error => error instanceof TypeError
      && error.message === "fetch failed" && /the connector refuses every redirect/u.test(error.cause?.message ?? ""), String(redirect));
  }
  assert.equal(gateway.requests.length, 0);
  assert.equal((await connectorFetchV1(`${gateway.url}/default`)).status, 200);
  assert.equal((await connectorFetchV1(`${gateway.url}/error`, { redirect: "error" })).status, 200);
});

test("CONNHTTP-11: a network failure is fetch's TypeError with the socket code in its cause", { timeout: 60_000 }, async t => {
  const closed = createNetServer();
  const port = await listen(closed);
  await new Promise(done => closed.close(done));
  await assert.rejects(connectorFetchV1(`http://127.0.0.1:${port}/`), error => error instanceof TypeError
    && error.message === "fetch failed" && error.cause?.code === "ECONNREFUSED");
  const resetting = await rawServer(t, socket => socket.destroy());
  await assert.rejects(connectorFetchV1(`${resetting.url}/`), error => error instanceof TypeError
    && error.message === "fetch failed" && error.cause?.code === "ECONNRESET");
  const garbage = await rawServer(t, socket => socket.end("not http at all\r\n\r\n"));
  await assert.rejects(connectorFetchV1(`${garbage.url}/`), error => error instanceof TypeError && error.message === "fetch failed");
  for (const [bad, cause] of [["ftp://127.0.0.1/", /^unsupported protocol ftp:$/u],
    [`http://user:pass@127.0.0.1:${port}/`, /^credentials in the URL$/u], ["not a url", /Invalid URL/u]])
    await assert.rejects(connectorFetchV1(bad), error => error instanceof TypeError && error.message === "fetch failed"
      && cause.test(error.cause?.message ?? ""), bad);
});

test("CONNHTTP-12: a TLS failure is a TypeError and the request never leaves the machine", { timeout: 60_000 }, async t => {
  // A plain-text server behind an https:// address: the handshake fails.
  const heard = [];
  const plain = createNetServer(socket => {
    socket.on("error", () => {});
    socket.on("data", chunk => heard.push(chunk));
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
  });
  const plainPort = await listen(plain);
  t.after(() => new Promise(done => plain.close(() => done())));
  await assert.rejects(connectorFetchV1(`https://127.0.0.1:${plainPort}/`, { headers: { authorization: `Bearer ${SECRET}` } }),
    error => error instanceof TypeError && error.message === "fetch failed" && typeof error.cause?.code === "string");
  assert.equal(Buffer.concat(heard).includes(SECRET), false, "the credential is never sent in the clear");
  // A self-signed certificate: verification is on, as it was for fetch.
  const root = await mkdtemp(join(tmpdir(), "connector-http-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "2", "-subj", "/CN=127.0.0.1"], { encoding: "utf8" });
  assert.equal(made.status, 0, `openssl must make the fixture certificate: ${made.error ?? made.stderr}`);
  let served = 0;
  const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
    served += 1; response.end("secret");
  });
  tls.on("tlsClientError", () => {});
  const port = await listen(tls);
  t.after(() => new Promise(done => { tls.closeAllConnections?.(); tls.close(() => done()); }));
  await assert.rejects(connectorFetchV1(`https://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${SECRET}` } }),
    error => error instanceof TypeError && error.message === "fetch failed"
      && ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.cause?.code), "self-signed must be refused");
  assert.equal(served, 0);
});

test("CONNHTTP-13: an abort before sending, before headers or mid-body rejects with the signal's reason", { timeout: 60_000 }, async t => {
  const reason = new Error("caller gave up");
  const before = new AbortController(); before.abort(reason);
  const idle = await rawServer(t, () => {});
  await assert.rejects(connectorFetchV1(`${idle.url}/never`, { signal: before.signal }), error => error === reason);
  await new Promise(done => setTimeout(done, 50));
  assert.equal(idle.requests.length, 0, "an aborted signal sends nothing");

  const waiting = new AbortController();
  const pending = connectorFetchV1(`${idle.url}/headers`, { signal: waiting.signal });
  while (idle.requests.length === 0) await new Promise(done => setTimeout(done, 5));
  const closed = new Promise(done => { for (const socket of idle.sockets) socket.once("close", done); });
  waiting.abort(reason);
  await assert.rejects(pending, error => error === reason);
  await closed; // the connection is released, not left open

  const body = pattern(256 * 1024);
  const halfway = await rawServer(t, socket => {
    socket.write(head(200, { "content-length": body.length, connection: "close" }));
    socket.write(body.subarray(0, 1024));
  });
  const midway = new AbortController();
  const response = await connectorFetchV1(`${halfway.url}/mid`, { signal: midway.signal });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  midway.abort(reason);
  await assert.rejects(reader.read(), error => error === reason);
});

test("CONNHTTP-14: a timeout signal rejects with its TimeoutError", { timeout: 60_000 }, async t => {
  const idle = await rawServer(t, () => {});
  const started = Date.now();
  await assert.rejects(connectorFetchV1(`${idle.url}/slow`, { signal: AbortSignal.timeout(150) }),
    error => error?.name === "TimeoutError");
  assert.ok(Date.now() - started < 10_000);
});

test("CONNHTTP-15: a slow reader holds back a 32 MiB close-delimited body and still receives every byte", { timeout: 60_000 }, async t => {
  const total = 32 * 1024 * 1024, chunk = 64 * 1024, body = pattern(total, 11);
  const sender = { sent: 0, waitingForDrain: false, finished: false };
  const gateway = await rawServer(t, socket => {
    socket.write(head(200, { connection: "close" }));
    let offset = 0;
    const pump = () => {
      while (offset < total) {
        const piece = body.subarray(offset, offset + chunk);
        offset += piece.length;
        const flowing = socket.write(piece, error => { if (!error) sender.sent += piece.length; });
        if (!flowing) { sender.waitingForDrain = true; socket.once("drain", () => { sender.waitingForDrain = false; pump(); }); return; }
      }
      socket.end(() => { sender.finished = true; });
    };
    pump();
  });
  const response = await connectorFetchV1(`${gateway.url}/large`);
  const reader = response.body.getReader();
  const first = await reader.read();
  // Stop reading. Wait for the sender to stall: its count stops moving.
  let last = -1, steady = 0;
  for (let waited = 0; waited < 15_000 && steady < 4; waited += 100) {
    await new Promise(done => setTimeout(done, 100));
    steady = sender.sent === last ? steady + 1 : 0;
    last = sender.sent;
  }
  assert.equal(sender.finished, false, "an unread body must not be drained into memory");
  assert.equal(sender.waitingForDrain, true, "the sender must be held back by the unread body");
  assert.ok(sender.sent < total / 2, `only socket buffers may be in flight, sent ${sender.sent} of ${total}`);
  const parts = [Buffer.from(first.value)];
  for (;;) { const next = await reader.read(); if (next.done) break; parts.push(Buffer.from(next.value)); }
  const received = Buffer.concat(parts);
  assert.equal(received.length, total);
  assert.equal(digest(received), digest(body));
});

test("CONNHTTP-16: the gateway client enforces each route's reply limit over this transport", { timeout: 60_000 }, async t => {
  const claimsLimit = 8 * 1024 * 1024, meLimit = 512 * 1024;
  const json = size => {
    const shell = JSON.stringify({ ok: true, result: { pad: "" } });
    return Buffer.from(JSON.stringify({ ok: true, result: { pad: "x".repeat(size - shell.length) } }));
  };
  const bodies = { "/fleet/v1/claims": [json(claimsLimit + 1), json(claimsLimit)], "/fleet/v1/me": [json(meLimit + 1)] };
  const gateway = await rawServer(t, (socket, request) => {
    const body = bodies[request.path].shift();
    socket.write(head(200, { "content-type": "application/json", connection: "close" }));
    socket.end(body);
  });
  // No fetcher: the production default carries these requests.
  const client = createClient({ server: gateway.url, workerId: WORKER, secret: SECRET });
  await assert.rejects(client.claims(), error => error.code === "response_too_large");
  const result = await client.claims();
  assert.equal(JSON.stringify({ ok: true, result }).length, claimsLimit);
  await assert.rejects(client.me(), error => error.code === "response_too_large");
  assert.equal(gateway.requests.length, 3);
  for (const request of gateway.requests) assert.equal(request.headers["sec-fetch-mode"], undefined, "the default must be this transport");
});

test("CONNHTTP-17: the gateway client reports a redirect as a typed refusal, never as a lost connection", { timeout: 60_000 }, async t => {
  const elsewhere = await rawServer(t, socket => reply(socket, 200, { "content-length": 0 }));
  const gateway = await rawServer(t, socket => reply(socket, 302, { "content-length": 0, location: `${elsewhere.url}/me` }));
  const client = createClient({ server: gateway.url, workerId: WORKER, secret: SECRET });
  await assert.rejects(client.me(), error => error instanceof ConnectorRedirectRefusedV1
    && error.code === CONNECTOR_REDIRECT_REFUSED_V1 && error.status === 302);
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].headers["sec-fetch-mode"], undefined, "the default must be this transport");
  assert.equal(elsewhere.requests.length, 0);
});

test("CONNHTTP-18: join refuses a redirecting release preflight without redeeming its code", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-http-join-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const elsewhere = await rawServer(t, socket => reply(socket, 200, { "content-length": 0 }));
  const gateway = await rawServer(t, socket => reply(socket, 307, { "content-length": 0, location: `${elsewhere.url}/enroll` }));
  await assert.rejects(joinConnector({ server: gateway.url, code: `crj_${"C".repeat(43)}`, workerKind: "codex",
    configPath: join(root, "bots", "worker.json"), expectedReleaseTrust: null }),
  error => error.code === CONNECTOR_REDIRECT_REFUSED_V1 && error.status === 307);
  assert.deepEqual(gateway.requests.map(request => request.line), ["GET /fleet/v1/connector-manifest.json HTTP/1.1"]);
  assert.equal(elsewhere.requests.length, 0);
});

test("CONNHTTP-19: an MCP session answers a redirecting gateway with a refusal and its status, and keeps both secrets home", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-http-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace"), configPath = join(root, "credentials", "bot.json");
  await mkdir(workspaceRoot); await mkdir(join(root, "credentials"));
  const elsewhere = await rawServer(t, socket => reply(socket, 200, { "content-length": 0 }));
  const gateway = await rawServer(t, socket => reply(socket, 302, { "content-length": 0, location: `${elsewhere.url}/fleet/v1/me` }));
  const profile = { schema: "control-room.fleet-connector/v1", server: gateway.url, workerId: WORKER, secret: SECRET,
    pendingSecret: PENDING, credentialExpiresAt: "2099-01-01T00:00:00.000Z" };
  await writeFile(configPath, JSON.stringify(profile), { mode: 0o600 });
  const input = new PassThrough(), chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const replies = () => chunks.join("").split("\n").filter(Boolean).map(value => JSON.parse(value));
  // No fetcher: the MCP recovery path over the production transport.
  const serving = serveMcp({ configPath, workspaceRoot, input, output });
  const send = value => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  const answered = async count => { while (replies().length < count) await new Promise(done => setTimeout(done, 10)); };
  send({ id: 1, method: "tools/call", params: { name: "list_eligible_work", arguments: {} } });
  await answered(1);
  send({ id: 2, method: "tools/call", params: { name: "list_eligible_work", arguments: {} } });
  await answered(2);
  send({ id: 3, method: "ping" });
  await answered(3);
  input.end();
  await serving;
  const [first, second, ping] = replies();
  for (const answer of [first, second]) {
    assert.equal(answer.result?.isError, true, JSON.stringify(answer));
    assert.equal(answer.result.content[0].text, "Control Room refused the request (redirect_refused, HTTP 302).");
  }
  assert.deepEqual(ping, { jsonrpc: "2.0", id: 3, result: {} });
  // A redirect is not an answer about the credential: each call asks again
  // with the current secret, the pending secret is never tried, and the
  // redirect's location never hears from this machine.
  assert.equal(gateway.requests.length, 2);
  for (const request of gateway.requests) {
    assert.equal(request.line, "GET /fleet/v1/me HTTP/1.1");
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(request.headers["sec-fetch-mode"], undefined, "the default must be this transport");
  }
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).pendingSecret, PENDING, "the profile is left as it was");
});
