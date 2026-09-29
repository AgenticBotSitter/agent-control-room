import { createHmac } from "node:crypto";

/** Derives a domain-separated event-integrity key from installation-held key
 * material. The returned key is supplied only to the canonical store; browser
 * and HTTP layers receive a read-only source interface. */
export function deriveProjectEventIntegrityKeyV1(root: Uint8Array): Uint8Array {
  if (!(root instanceof Uint8Array) || root.byteLength !== 32) throw new Error("project_event_key_invalid");
  return new Uint8Array(createHmac("sha256", root).update("control-room/project-events/v1\0integrity").digest());
}
