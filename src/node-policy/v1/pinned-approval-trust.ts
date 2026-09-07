import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { pinnedOwnerKeySchema, ownerSignedTrustBundleSchema } from "./schemas";
import { ProtectedStoreError, type ApprovalTrustStore } from "./stores";
import type { SqliteNodeSecurityStateRepository } from "./persistent-security-state";
import type { ResolvedApprovalKeyV1 } from "./types";

const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const approvalPinSetSchema = z.object({
  schema: z.literal("control-room.owner-approval-pins/v1"),
  tenantId: z.string().min(1).max(200), nodeId: z.string().min(1).max(200), nodeClass: z.string().min(1).max(200),
  validFrom: instant, validUntil: instant,
  keys: z.array(pinnedOwnerKeySchema).min(1).max(16),
}).strict();
export type ApprovalPinSet = z.infer<typeof approvalPinSetSchema>;
const fail = (): never => { throw new ProtectedStoreError("invalid_configuration"); };
function material(spki: string) {
  const bytes = Buffer.from(spki, "base64url");
  if (bytes.toString("base64url") !== spki) return fail();
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !key.export({ type: "spki", format: "der" }).equals(bytes)) return fail();
  return { bytes, fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

/** Out-of-band owner configuration only. No private key, signer, network update, file loader or
 * automatic rotation. Supervisor must replace/close this object when changing owner pin configuration.
 */
export class PinnedApprovalTrustStore implements ApprovalTrustStore {
  private readonly pins: ApprovalPinSet;
  private readonly publicKeys = new Map<string, Uint8Array>();
  private readonly loadServerTrust: SqliteNodeSecurityStateRepository["loadTrustBundle"];
  private readonly clock: () => number;
  private closed = false;
  private highWater = -1;
  private active = 0;
  private readonly pending = new Set<() => void>();
  constructor(value: unknown, deps: { security: Pick<SqliteNodeSecurityStateRepository, "loadTrustBundle">; clock?: () => number }) {
    try {
      this.pins = approvalPinSetSchema.parse(value);
      if (this.pins.validUntil <= this.pins.validFrom) fail();
      const fingerprints = new Set<string>();
      for (const pin of this.pins.keys) {
        const key = material(pin.spki);
        if (pin.fingerprint !== key.fingerprint || fingerprints.has(key.fingerprint) || this.publicKeys.has(pin.keyId)) fail();
        fingerprints.add(key.fingerprint); this.publicKeys.set(pin.keyId, new Uint8Array(key.bytes));
      }
      this.loadServerTrust = deps.security.loadTrustBundle.bind(deps.security); this.clock = deps.clock ?? Date.now;
    } catch { throw new ProtectedStoreError("invalid_configuration"); }
  }
  binding() { return Object.freeze({ tenantId: this.pins.tenantId, nodeId: this.pins.nodeId, nodeClass: this.pins.nodeClass }); }
  /** Recheck immutable pin lifetime/disposal without an asynchronous trust read. */
  assertAvailable(): void { this.time(); }
  private time() {
    const now = this.clock();
    if (this.closed || !Number.isSafeInteger(now) || now < 0 || now < this.highWater) fail();
    this.highWater = now;
    if (now < this.pins.validFrom || now >= this.pins.validUntil) fail();
    return now;
  }
  async resolveApprovalKey(keyId: string): Promise<Uint8Array | undefined> {
    this.time(); const bytes = this.publicKeys.get(keyId); if (!bytes) return undefined;
    if (this.active >= 8) return fail(); this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined, started = false;
    try {
      const deadline = Math.min(this.pins.validUntil, this.time() + 5000);
      const work = (async () => {
        const bundle = ownerSignedTrustBundleSchema.parse(await this.loadServerTrust());
        this.time(); if (this.time() >= deadline) return fail();
        if (bundle.body.tenantId !== this.pins.tenantId || bundle.body.nodeClass !== this.pins.nodeClass) return fail();
        // The validated repository preserves retired/revoked keys in every subsequent bundle.
        // Neither a new name for old server material nor reuse of a server key ID is owner approval.
        const fingerprints = new Set(this.pins.keys.map(pin => pin.fingerprint));
        if (bundle.body.keys.some(key => this.publicKeys.has(key.keyId) || fingerprints.has(material(key.spki).fingerprint))) return fail();
        return new Uint8Array(bytes);
      })();
      started = true; void work.then(() => { this.active--; }, () => { this.active--; });
      return await Promise.race([work, new Promise<never>((_, reject) => {
        cancel = () => reject(new ProtectedStoreError("disposed")); this.pending.add(cancel);
        timer = setTimeout(() => { this.close(); }, Math.max(1, deadline - this.time()));
      })]);
    } catch { throw new ProtectedStoreError("invalid_configuration"); }
    finally { clearTimeout(timer); if (cancel) this.pending.delete(cancel); if (!started) this.active--; }
  }
  close() { this.closed = true; for (const cancel of this.pending) cancel(); this.pending.clear(); }
}

/** Scope-check the node's configured trust before adapting it to start/recovery evaluation input. */
export async function resolvePinnedApprovalKey(store: PinnedApprovalTrustStore,
  expected: { tenantId: string; nodeId: string; nodeClass: string }, keyId: string): Promise<ResolvedApprovalKeyV1 | undefined> {
  const binding = store.binding();
  if (binding.tenantId !== expected.tenantId || binding.nodeId !== expected.nodeId || binding.nodeClass !== expected.nodeClass) return fail();
  const bytes = await store.resolveApprovalKey(keyId);
  return bytes ? { keyId, publicKeySpki: Buffer.from(bytes).toString("base64url") } : undefined;
}
