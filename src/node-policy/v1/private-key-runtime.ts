import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { keyReferenceSchema } from "./schemas";
import { ProtectedStoreError, type NodePrivateKeyStore } from "./stores";
import type { Clock } from "./clock";
import { keyAvailabilityStates, type KeyAvailabilityState, type KeyAvailabilityV1, type KeyReferenceV1 } from "./types";

const availabilityFailures = new Set<KeyAvailabilityState>([
  "locked","interaction_required","missing","corrupt","permission_denied","unavailable_platform",
]);

export abstract class MemoryBackedNodePrivateKeyStore implements NodePrivateKeyStore {
  private activeKey?: KeyObject;
  private disposed = false;
  protected readonly keyReference: KeyReferenceV1;

  protected constructor(reference: KeyReferenceV1, protected readonly clock: Clock) {
    const parsed = keyReferenceSchema.safeParse(reference);
    if (!parsed.success || parsed.data.algorithm !== "Ed25519") throw new ProtectedStoreError("invalid_configuration");
    this.keyReference = parsed.data;
  }

  reference(): KeyReferenceV1 {
    this.requireActive();
    return { ...this.keyReference };
  }

  async availability(): Promise<KeyAvailabilityV1> {
    this.requireActive();
    let state: KeyAvailabilityState;
    try {
      state = await this.probeAvailability();
      if (!(keyAvailabilityStates as readonly string[]).includes(state)) throw new ProtectedStoreError("unavailable_platform");
    } catch (error) {
      if (error instanceof ProtectedStoreError && availabilityFailures.has(error.code as KeyAvailabilityState)) {
        state = error.code as KeyAvailabilityState;
      } else {
        throw new ProtectedStoreError("unavailable_platform");
      }
    }
    return { state,keyReferenceId: this.keyReference.referenceId,observedAt: this.clock.now() };
  }

  async unlock(): Promise<void> {
    this.requireActive();
    let pkcs8: Uint8Array | undefined;
    try {
      pkcs8 = await this.loadPkcs8();
      const key = createPrivateKey({ key: Buffer.from(pkcs8),format: "der",type: "pkcs8" });
      if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new ProtectedStoreError("corrupt");
      this.activeKey = key;
    } catch (error) {
      this.activeKey = undefined;
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("corrupt");
    } finally {
      pkcs8?.fill(0);
    }
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    this.requireActive();
    if (!this.activeKey) throw new ProtectedStoreError("key_not_unlocked");
    try {
      return new Uint8Array(cryptoSign(null,Buffer.from(bytes),this.activeKey));
    } catch {
      throw new ProtectedStoreError("corrupt");
    }
  }

  async lock(): Promise<void> {
    this.requireActive();
    this.activeKey = undefined;
  }

  async dispose(): Promise<void> {
    this.activeKey = undefined;
    this.disposed = true;
  }

  protected abstract probeAvailability(): Promise<KeyAvailabilityState>;
  protected abstract loadPkcs8(): Promise<Uint8Array>;

  protected requireActive(): void {
    if (this.disposed) throw new ProtectedStoreError("disposed");
  }
}
