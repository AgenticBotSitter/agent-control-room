import { createPublicKey, verify } from "node:crypto";

export interface OwnerSigningProtocol {
  on(event: "error" | "close" | "end", listener: () => void): unknown;
  off(event: "error" | "close" | "end", listener: () => void): unknown;
  sign(key: Buffer, bytes: Buffer, callback: (error: unknown, signature?: Buffer) => void): unknown;
}

/** One supplied, owned channel; no acquisition, credentials or owner-consent claim.
 * The caller must establish owner consent and exact material before invoking sign.
 * Closing the channel does not prove an upstream signing operation was cancelled.
 */
export function createBoundedOwnerSignature(options: {
  protocol: OwnerSigningProtocol; close: () => void;
  publicKeySpki: string; timeoutMs: number;
}) {
  const invalid = () => new Error("owner_signature_unavailable");
  const key = createPublicKey({ key: Buffer.from(options.publicKeySpki, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !Number.isInteger(options.timeoutMs)
    || options.timeoutMs < 1 || options.timeoutMs > 30_000) throw invalid();
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw invalid();
  // Fixed public-key encoding only; agent message framing belongs to ssh2.
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw invalid();
  const sshKey = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), raw]);
  const protocol = options.protocol, close = options.close, timeoutMs = options.timeoutMs;
  const send = protocol.sign.bind(protocol);
  let attempted = false;
  return Object.freeze({ sign(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    if (attempted) return Promise.reject(invalid());
    attempted = true;
    return new Promise((resolve, reject) => {
      let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
      const body = bytes.byteLength <= 24_576 ? Buffer.from(bytes) : Buffer.alloc(0);
      const deadline = performance.now() + timeoutMs;
      const finish = (signature?: Uint8Array) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal.removeEventListener("abort", fail);
        // Keep listeners through close, which can synchronously emit an error.
        try { close(); } catch { signature = undefined; }
        for (const event of ["error", "close", "end"] as const) {
          try { protocol.off(event, fail); } catch { signature = undefined; }
        }
        if (signal.aborted) signature = undefined;
        if (signature) resolve(signature); else reject(invalid());
      };
      const fail = () => finish();
      try {
        for (const event of ["error", "close", "end"] as const) protocol.on(event, fail);
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted || !body.length || body.length > 24_576) return fail();
        timer = setTimeout(fail, timeoutMs);
        send(Buffer.from(sshKey), Buffer.from(body), (error, signature) => {
          if (settled) return;
          try {
            if (error || !signature || signature.length !== 64 || signal.aborted || performance.now() >= deadline
              || !verify(null, body, key, signature)) return fail();
            finish(Uint8Array.from(signature));
          } catch { fail(); }
        });
      } catch { fail(); }
    });
  } });
}
