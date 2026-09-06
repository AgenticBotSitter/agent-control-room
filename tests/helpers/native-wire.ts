import assert from "node:assert/strict";
import { nativeNodeRuntimeFixture } from "./native-node-runtime";
import { currentSignal } from "./managed-native-session";

type Base = Awaited<ReturnType<typeof nativeNodeRuntimeFixture>>;
type Runtime = Base["runtime"];
type Wire = Awaited<ReturnType<Base["x"]["manager"]["attachWire"]>>;
type Connection = { node: Runtime; server: Wire; incoming: string[]; outgoing: string[];
  nodeSent: string[]; serverSent: string[]; state: { available: boolean; nodeCloses: number; serverCloses: number } };

/** Actual disposable runtime/server owners. The transport only queues opaque strings;
 * it never parses a frame, selects an operation by type or reads result bytes. */
export async function nativeWireFixture() {
  const f = await nativeNodeRuntimeFixture();
  async function pump(connection: Connection) {
    const received: Awaited<ReturnType<Wire["receive"]>>[] = [];
    for (let turn = 0; turn < 20 && (connection.incoming.length || connection.outgoing.length); turn++) {
      while (connection.outgoing.length) {
        const packet = connection.outgoing.shift(); assert.equal(typeof packet, "string");
        // Privileged fake-node policy/read fixture boundary only; server writes enter roles.
        await f.x.admin(() => connection.node.receiveWire(packet!, currentSignal()));
      }
      const packets = connection.incoming.splice(0);
      received.push(...await Promise.all(packets.map(packet => connection.server.receive(packet, currentSignal()))));
    }
    assert.equal(connection.incoming.length + connection.outgoing.length, 0);
    return received;
  }
  async function connect(mode: "initial" | "recover" = "initial", node = f.runtime) {
    const incoming: string[] = [], outgoing: string[] = [], nodeSent: string[] = [], serverSent: string[] = [];
    const state = { available: true, nodeCloses: 0, serverCloses: 0 };
    const server = await f.x.manager.attachWire(f.config.enrollment.nodeId, {
      async send(packet) { assert.equal(typeof packet, "string"); outgoing.push(packet); serverSent.push(packet); },
      async close() { state.available = false; state.serverCloses++; }, isAvailable: () => state.available,
    }, { mode, task: f.x.request });
    await f.x.admin(() => node.openWire({
      async send(packet) { assert.equal(typeof packet, "string"); incoming.push(packet); nodeSent.push(packet); },
      async close() { state.nodeCloses++; },
    }, "transport:managed-server", currentSignal()));
    const connection: Connection = { node, server, incoming, outgoing, nodeSent, serverSent, state };
    const received = await pump(connection);
    return { connection, received };
  }
  async function dispatch(connection: Connection) {
    await connection.server.stage(f.x.f.identity, f.x.task, currentSignal());
    await connection.server.transmit(f.x.f.identity, f.x.task, currentSignal());
    return pump(connection);
  }
  return { f, connect, dispatch, pump, close: f.close };
}
