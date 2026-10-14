// FLAKE-PORT-01: connect(2) can connect a Linux loopback probe to itself
// when the kernel chooses the destination port as its ephemeral source port.
import assert from "node:assert/strict";
import net, { Socket, type NetConnectOpts, type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { assertPortAvailable, portIsOccupied } from "./support/attack-kit/real-postgres";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("FLAKE-PORT-01: a closed Linux port self-connection is not a foreign listener", async t => {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation); // A real bind/close proves there is no foreign listener.
  const original = net.createConnection;
  let connected = 0;
  const sockets: Socket[] = [];
  t.mock.method(net, "createConnection", (options: NetConnectOpts) => {
    let socket: Socket;
    if (process.platform === "linux") {
      // Force the kernel's ephemeral-port choice without faking the socket.
      socket = original({ ...options, localPort: port });
      socket.once("connect", () => {
        assert.equal(socket.localPort, port);
        assert.equal(socket.remotePort, port);
        assert.equal(socket.localAddress, "127.0.0.1");
        assert.equal(socket.remoteAddress, "127.0.0.1");
        connected += 1;
      });
    } else {
      // Replay the real Linux v22.23.3 capture: connect, both endpoints
      // 127.0.0.1:59866. Darwin rejects that connect with EINVAL, so this
      // replay proves the decision only; Linux runs the real kernel path.
      socket = new Socket();
      Object.defineProperties(socket, {
        localPort: { value: port }, remotePort: { value: port },
        localAddress: { value: "127.0.0.1" }, remoteAddress: { value: "127.0.0.1" },
      });
      queueMicrotask(() => { connected += 1; socket.emit("connect"); });
    }
    sockets.push(socket);
    return socket;
  });
  syncBuiltinESMExports();
  try {
    await assert.doesNotReject(assertPortAvailable(port, [port]),
      "a socket connected only to itself must leave the closed port available");
    assert.equal(await portIsOccupied(port), false);
    assert.equal(connected, 2, "both assertions reached a successful self-connect");
    assert.equal(sockets.every(socket => socket.destroyed), true, "every probe socket was destroyed");
  } finally {
    for (const socket of sockets) socket.destroy();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("FLAKE-PORT-01: a foreign TCP listener is refused until it releases the port", async () => {
  const peers = new Set<Socket>();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  const port = await listen(server);
  try {
    assert.equal(await portIsOccupied(port), true);
    await assert.rejects(assertPortAvailable(port, [port]),
      { name: "PortOccupiedError", message: `refusing_occupied_port:${port}` });
    // A burst at the listener backlog must preserve the foreign-port refusal.
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => assertPortAvailable(port, [port])));
    assert.equal(results.length, 50);
    for (const result of results) {
      assert.equal(result.status, "rejected", "every concurrent caller refused the foreign listener");
      if (result.status === "rejected") assert.equal(result.reason.message, `refusing_occupied_port:${port}`);
    }
  } finally {
    for (const socket of peers) socket.destroy();
    await close(server);
  }
  await assert.doesNotReject(assertPortAvailable(port, [port]), "retry succeeds after the real listener closes");
});

test("FLAKE-PORT-01: the same port on a different local address is still a foreign listener", async t => {
  const server = net.createServer(socket => socket.end());
  const port = await listen(server);
  const original = net.createConnection;
  const sockets: Socket[] = [];
  t.mock.method(net, "createConnection", (options: NetConnectOpts) => {
    let socket: Socket;
    if (process.platform === "linux") {
      socket = original({ ...options, localAddress: "127.0.0.2", localPort: port });
      socket.once("connect", () => {
        assert.equal(socket.localPort, socket.remotePort);
        assert.notEqual(socket.localAddress, socket.remoteAddress);
      });
    } else {
      // Replay the real Linux capture with equal ports and different addresses:
      // local 127.0.0.2:33827, remote 127.0.0.1:33827, event connect.
      socket = new Socket();
      Object.defineProperties(socket, {
        localPort: { value: port }, remotePort: { value: port },
        localAddress: { value: "127.0.0.2" }, remoteAddress: { value: "127.0.0.1" },
      });
      queueMicrotask(() => socket.emit("connect"));
    }
    sockets.push(socket);
    return socket;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(assertPortAvailable(port, [port]),
      { name: "PortOccupiedError", message: `refusing_occupied_port:${port}` },
      "matching port numbers alone must never exempt a foreign listener");
  } finally {
    for (const socket of sockets) socket.destroy();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await close(server);
  }
});

test("FLAKE-PORT-01: invalid and unauthorized ports are refused before any TCP probe", async t => {
  let probes = 0;
  t.mock.method(net, "createConnection", () => { probes += 1; throw new Error("unauthorized_probe"); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(assertPortAvailable(0, [59866]), /attack_kit_port_invalid:0/);
    await assert.rejects(assertPortAvailable(59866, []), /attack_kit_allowed_ports_required/);
    await assert.rejects(assertPortAvailable(59866, [59867]), /attack_kit_port_outside_block:59866/);
    assert.equal(probes, 0, "authority checks precede all network access");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
