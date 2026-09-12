import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { openPrivateOwnerAgentConnection } from "../src/harness/v1/private-owner-agent-connection";
import { createPrivateOwnerAgentEndpoint, type OwnerAgentEndpointIdentity } from "../src/harness/v1/private-owner-agent-endpoint";

test("explicit owner endpoint refuses unsafe paths, permissions, identity changes and cancellation", async () => {
  const socketPath = "/synthetic-owner/agent/socket", parent = "/synthetic-owner/agent";
  const directory: OwnerAgentEndpointIdentity = { canonicalPath: parent, kind: "directory", uid: 123,
    mode: 0o700, device: 1, inode: 2 };
  const socket: OwnerAgentEndpointIdentity = { canonicalPath: socketPath, kind: "socket", uid: 123,
    mode: 0o600, device: 1, inode: 3 };
  for (const path of ["relative/socket", "/socket", "/a/../b/socket", "/a//socket", "/a\\socket", "/a/\0socket"]) {
    assert.throws(() => createPrivateOwnerAgentEndpoint({ socketPath: path, ownerUid: 123 }, async () => socket));
  }
  for (const change of [{ mode: 0o660 }, { mode: 0o644 }, { mode: 0o4600 }, { uid: 456 },
    { kind: "other" as const }, { canonicalPath: "/different/socket" }, { inode: 0 }]) {
    const endpoint = createPrivateOwnerAgentEndpoint({ socketPath, ownerUid: 123 }, async path => path === parent ? directory : { ...socket, ...change });
    await assert.rejects(endpoint.prepare(new AbortController().signal), /owner_agent_endpoint_unavailable/);
  }
  let currentDirectory = directory, currentSocket = socket, calls = 0;
  const endpoint = createPrivateOwnerAgentEndpoint({ socketPath, ownerUid: 123 }, async path => {
    calls++; return path === parent ? currentDirectory : currentSocket;
  });
  const abort = new AbortController();
  const checked = await endpoint.prepare(abort.signal); await checked.recheck();
  currentSocket = { ...socket, inode: 4 }; await assert.rejects(checked.recheck());
  currentSocket = socket; currentDirectory = { ...directory, mode: 0o770 }; await assert.rejects(checked.recheck());
  currentDirectory = { ...directory, inode: 8 }; await assert.rejects(checked.recheck());
  currentDirectory = directory; abort.abort(); const before = calls;
  await assert.rejects(checked.recheck()); assert.equal(calls, before);
  const cancelled = new AbortController(); let release!: (value: OwnerAgentEndpointIdentity) => void;
  let lateCalls = 0;
  const delayed = createPrivateOwnerAgentEndpoint({ socketPath, ownerUid: 123 }, async () => {
    lateCalls++; return new Promise(resolve => { release = resolve; });
  });
  const pending = delayed.prepare(cancelled.signal); cancelled.abort(); release(directory);
  await assert.rejects(pending); assert.equal(lateCalls, 1);
});

test("connection rechecks the endpoint before exposing the signing protocol", async () => {
  for (const mode of ["valid", "changed", "cancelled"] as const) {
    let inode = 3, opens = 0, protocols = 0, release!: () => void;
    const abort = new AbortController(), stream = new PassThrough();
    const protocol = Object.assign(new PassThrough(), { sign() {} });
    const endpoint = createPrivateOwnerAgentEndpoint({ socketPath: "/synthetic/agent/socket", ownerUid: 123 }, async path => ({
      canonicalPath: path, kind: path.endsWith("socket") ? "socket" : "directory", uid: 123,
      mode: path.endsWith("socket") ? 0o600 : 0o700, device: 1, inode: path.endsWith("socket") ? inode : 2,
    }));
    const connection = openPrivateOwnerAgentConnection({ endpoint, signal: abort.signal,
      openStream(path) { assert.equal(path, endpoint.socketPath); opens++; return { stream,
        connected: new Promise<void>(resolve => { release = resolve; }) }; },
      createProtocol() { protocols++; return protocol; } });
    const refused = mode === "valid" ? undefined : assert.rejects(connection.ready);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(opens, 1);
    if (mode === "changed") inode++;
    if (mode === "cancelled") abort.abort();
    release();
    if (mode === "valid") assert.equal(await connection.ready, protocol); else await refused;
    assert.equal(protocols, mode === "valid" ? 1 : 0);
    connection.close(); assert.equal(stream.destroyed, true); protocol.destroy();
  }
});

test("parent replacement during inspection is not an admitted endpoint", async () => {
  let calls = 0;
  const endpoint = createPrivateOwnerAgentEndpoint({ socketPath: "/synthetic/agent/socket", ownerUid: 123 }, async path => {
    calls++;
    return { canonicalPath: path, kind: path.endsWith("socket") ? "socket" : "directory", uid: 123,
      mode: path.endsWith("socket") ? 0o600 : 0o700, device: 1, inode: calls };
  });
  await assert.rejects(endpoint.prepare(new AbortController().signal)); assert.equal(calls, 3);
});
