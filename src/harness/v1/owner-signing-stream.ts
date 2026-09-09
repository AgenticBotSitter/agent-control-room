import type { Duplex } from "node:stream";
import type { OwnerSigningProtocol } from "./bounded-owner-signature";
import type { OwnedOwnerSigningConnection } from "./owned-owner-signature";

/** Takes ownership of an already-created stream, including pending connection.
 * The caller supplies explicit connection readiness and the selected ssh2
 * AgentProtocol factory. No socket discovery, key enumeration or custom framing.
 * destroy() requests local teardown; it does not certify OS close or remote cancel.
 */
export function ownOwnerSigningStream(options: {
  stream: Duplex; connected: Promise<void>; signal: AbortSignal;
  createProtocol(): Duplex & OwnerSigningProtocol;
}): OwnedOwnerSigningConnection {
  const { stream, signal, createProtocol } = options;
  let protocol: (Duplex & OwnerSigningProtocol) | undefined;
  let closed = false, closeFailed = false;
  let rejectReady!: (error: Error) => void;
  const unavailable = () => new Error("owner_signature_unavailable");
  const ready = new Promise<OwnerSigningProtocol>((resolve, reject) => {
    rejectReady = reject;
    // Observe late connection rejection even after the owner has cancelled.
    Promise.resolve(options.connected).then(() => {
      if (closed || signal.aborted || stream.destroyed || stream.readableEnded || stream.writableEnded) return fail();
      try {
        protocol = createProtocol();
        protocol.on("error", fail); protocol.on("end", fail); protocol.on("close", fail);
        // A synchronous factory can trigger cancellation before returning its
        // object, after close has already destroyed the acquisition stream.
        if (closed) {
          try { protocol.destroy(); } catch { closeFailed = true; }
          return fail();
        }
        if (closed || signal.aborted || protocol.destroyed) return fail();
        protocol.pipe(stream).pipe(protocol);
        if (closed || signal.aborted) return fail();
        resolve(protocol);
      } catch { fail(); }
    }, () => fail());
  });
  // Readiness can fail synchronously before its caller attaches an observer.
  void ready.catch(() => {});
  function close() {
    if (closed) { if (closeFailed) throw unavailable(); return; }
    closed = true; signal.removeEventListener("abort", fail);
    rejectReady(unavailable());
    // Retain error observers through asynchronous stream destruction. The owned
    // objects and their handlers are collectible together after references drop.
    let failed = false;
    try { if (protocol) { protocol.unpipe(stream); stream.unpipe(protocol); } } catch { failed = true; }
    try { protocol?.destroy(); } catch { failed = true; }
    try { stream.destroy(); } catch { failed = true; }
    closeFailed = failed;
    if (failed) throw unavailable();
  }
  function fail() { rejectReady(unavailable()); try { close(); } catch { /* readiness stays refused */ } }
  stream.on("error", fail); stream.on("end", fail); stream.on("close", fail);
  signal.addEventListener("abort", fail, { once: true });
  if (signal.aborted) fail();
  return Object.freeze({ ready, close });
}
