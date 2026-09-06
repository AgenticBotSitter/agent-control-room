import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { nativeNodeRuntimeFixture } from "./native-node-runtime";
import { createNativeHttpHost } from "../../src/web/v1/native-http-host";
import { createNativeHttpNodeHost, type NativeHttpClient } from "../../src/node-bridge/native-http-host";
import { nativeHttpJson, nativeHttpLimits, nativeHttpResponseSchema,
  type NativeHttpRequest } from "../../src/harness/v1/native-http-exchange";
import { currentSignal } from "./managed-native-session";

/** No network or credential operations: Request/Response and an explicitly synthetic TLS
 * peer replace the physical HTTP hop. Packet bodies are opaque to this exchange fixture. */
export async function nativeHttpFixture() {
  const f = await nativeNodeRuntimeFixture(), origin = "https://control-room.example.test";
  const rawCertificate = Buffer.from("synthetic-machine-certificate-bytes-not-a-real-certificate");
  const certificateDigest = `sha256:${createHash("sha256").update(rawCertificate).digest("hex")}`;
  const socket = (raw = rawCertificate, authorized = true) => ({ encrypted: true, authorized, destroyed: false,
    getPeerCertificate: () => ({ raw }),
  }) as unknown as TLSSocket;
  const server = createNativeHttpHost({ origin, connections: f.x.manager,
    peers: [{ nodeId: f.config.enrollment.nodeId, certificateDigest, task: f.x.request }],
    isReady: () => true, isPeerCurrent: () => true, clock: f.x.f.clock });
  const nodeHosts: ReturnType<typeof createNativeHttpNodeHost>[] = [];
  async function request(command: NativeHttpRequest, signal = currentSignal(), peer = socket()) {
    const body = nativeHttpJson(command);
    return server.handle(new Request(`${origin}${nativeHttpLimits.path}`, { method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body }), peer);
  }
  function createClient() {
    const commands: NativeHttpRequest[] = [], responses: { status: number; body: string }[] = [];
    let closed = false, closes = 0, loseNextResponse = false;
    const client: NativeHttpClient = {
      async exchange(command, signal) {
        if (closed || signal.aborted) throw new Error("synthetic_http_client_unavailable");
        commands.push(structuredClone(command));
        // Serialize through the actual server body collector; no wire decoding or result injection.
        const response = await request(command, signal), body = await response.text();
        responses.push({ status: response.status, body });
        if (loseNextResponse) { loseNextResponse = false; throw new Error("synthetic_lost_http_response"); }
        if (closed || signal.aborted || response.status !== 200) throw new Error("synthetic_http_client_unavailable");
        return nativeHttpResponseSchema.parse(JSON.parse(body));
      },
      async close() { if (!closed) { closed = true; closes++; } },
    };
    return { client, commands, responses, closes: () => closes,
      loseResponse: () => { loseNextResponse = true; },
      connection: () => {
        assert.ok(responses.length); return nativeHttpResponseSchema.parse(JSON.parse(responses[0].body)).connection;
      },
    };
  }
  function create(node = f.runtime) {
    const fixture = createClient();
    const host = createNativeHttpNodeHost(node, fixture.client, () => {}); nodeHosts.push(host);
    return { ...fixture, host, node };
  }
  return { f, server, create, createClient, request, socket,
    close: async () => {
      let failed = false;
      for (const host of nodeHosts) { try { await host.close(); } catch { failed = true; } }
      try { await server.close(); } catch { failed = true; }
      await f.close(); if (failed) throw new Error("synthetic_http_fixture_cleanup_uncertain");
    },
  };
}
