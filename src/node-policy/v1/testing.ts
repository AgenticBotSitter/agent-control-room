import { sign as cryptoSign, type KeyObject } from "node:crypto";
import { ownerSignedTrustBundleSchema } from "./schemas";
import { ProtectedStoreError, type ApprovalTrustStore, type NodePrivateKeyStore, type ServerTrustStore } from "./stores";
import { NODE_POLICY_CONTRACT_V1, type KeyAvailabilityState, type KeyAvailabilityV1, type KeyReferenceV1, type OwnerSignedTrustBundleV1 } from "./types";
import { requireCanonicalClockInstant, type Clock } from "./clock";

export interface StoreCallRecord {
  action: "reference" | "availability" | "unlock" | "sign" | "lock" | "dispose" | "current_epoch" | "resolve_server_key" | "apply_bundle" | "resolve_approval_key";
  occurredAt: string;
  keyId?: string;
  epoch?: number;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export class MutableTestClock implements Clock {
  private instant: string;

  constructor(initialInstant: string) {
    this.instant = requireCanonicalClockInstant(initialInstant);
  }

  now(): string {
    return this.instant;
  }

  set(instant: string): void {
    this.instant = requireCanonicalClockInstant(instant);
  }

  advanceMilliseconds(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Clock advance must be a nonnegative safe integer");
    this.instant = new Date(Date.parse(this.instant) + milliseconds).toISOString();
  }
}

export class DeterministicNodePrivateKeyStoreFake implements NodePrivateKeyStore {
  private backingKey?: KeyObject;
  private activeKey?: KeyObject;
  private availabilityState: KeyAvailabilityState;
  private disposed = false;
  private readonly calls: StoreCallRecord[] = [];

  constructor(
    private readonly keyReference: KeyReferenceV1,
    private readonly clock: Clock,
    privateKey: KeyObject,
    initialAvailability: KeyAvailabilityState = "available",
  ) {
    if (keyReference.contractVersion !== NODE_POLICY_CONTRACT_V1 || keyReference.provider !== "memory_test" || keyReference.mode !== "test") {
      throw new ProtectedStoreError("invalid_configuration");
    }
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new ProtectedStoreError("invalid_configuration");
    this.backingKey = privateKey;
    this.availabilityState = initialAvailability;
  }

  reference(): KeyReferenceV1 {
    this.record("reference");
    return { ...this.keyReference };
  }

  async availability(): Promise<KeyAvailabilityV1> {
    this.requireNotDisposed();
    this.record("availability");
    return { state: this.availabilityState, keyReferenceId: this.keyReference.referenceId, observedAt: this.clock.now() };
  }

  async unlock(): Promise<void> {
    this.requireNotDisposed();
    this.record("unlock");
    if (this.availabilityState !== "available") throw new ProtectedStoreError(this.availabilityState);
    if (!this.backingKey) throw new ProtectedStoreError("missing");
    this.activeKey = this.backingKey;
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    this.requireNotDisposed();
    this.record("sign");
    if (this.availabilityState !== "available") throw new ProtectedStoreError(this.availabilityState);
    if (!this.activeKey) throw new ProtectedStoreError("key_not_unlocked");
    return cloneBytes(cryptoSign(null, Buffer.from(bytes), this.activeKey));
  }

  async lock(): Promise<void> {
    this.requireNotDisposed();
    this.record("lock");
    this.activeKey = undefined;
  }

  async dispose(): Promise<void> {
    this.record("dispose");
    this.activeKey = undefined;
    this.backingKey = undefined;
    this.disposed = true;
  }

  setAvailability(state: KeyAvailabilityState): void {
    this.requireNotDisposed();
    this.availabilityState = state;
    if (state !== "available") this.activeKey = undefined;
  }

  history(): StoreCallRecord[] {
    return this.calls.map((call) => ({ ...call }));
  }

  private requireNotDisposed(): void {
    if (this.disposed) throw new ProtectedStoreError("disposed");
  }

  private record(action: StoreCallRecord["action"]): void {
    this.calls.push({ action, occurredAt: this.clock.now() });
  }
}

export type TrustBundleVerifier = (bundle: OwnerSignedTrustBundleV1) => boolean | Promise<boolean>;

export class DeterministicServerTrustStoreFake implements ServerTrustStore {
  private epoch: number;
  private keys: Map<string, Uint8Array>;
  private readonly calls: StoreCallRecord[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly verifyBundle: TrustBundleVerifier,
    initial: { epoch?: number; keys?: ReadonlyMap<string, Uint8Array> } = {},
  ) {
    this.epoch = initial.epoch ?? 0;
    this.keys = new Map([...(initial.keys ?? [])].map(([keyId, key]) => [keyId, cloneBytes(key)]));
  }

  async currentEpoch(): Promise<number> {
    this.record("current_epoch");
    return this.epoch;
  }

  async resolveServerKey(keyId: string): Promise<Uint8Array | undefined> {
    this.record("resolve_server_key", keyId);
    const key = this.keys.get(keyId);
    return key ? cloneBytes(key) : undefined;
  }

  async applyOwnerSignedBundle(bundle: OwnerSignedTrustBundleV1): Promise<void> {
    const parsed = ownerSignedTrustBundleSchema.safeParse(bundle);
    if (!parsed.success) throw new ProtectedStoreError("invalid_bundle");
    const validated = parsed.data;
    this.record("apply_bundle", undefined, validated.body.epoch);
    let accepted = false;
    try {
      accepted = await this.verifyBundle(validated);
    } catch {
      throw new ProtectedStoreError("invalid_bundle");
    }
    if (!accepted) throw new ProtectedStoreError("invalid_bundle");
    if (validated.body.epoch <= this.epoch) throw new ProtectedStoreError("rollback_detected");
    this.epoch = validated.body.epoch;
    this.keys = new Map(validated.body.keys
      .filter((key) => key.state === "active")
      .map((key) => [key.keyId, new Uint8Array(Buffer.from(key.spki, "base64url"))]));
  }

  history(): StoreCallRecord[] {
    return this.calls.map((call) => ({ ...call }));
  }

  private record(action: StoreCallRecord["action"], keyId?: string, epoch?: number): void {
    this.calls.push({ action, occurredAt: this.clock.now(), ...(keyId ? { keyId } : {}), ...(epoch === undefined ? {} : { epoch }) });
  }
}

export class DeterministicApprovalTrustStoreFake implements ApprovalTrustStore {
  private readonly keys: Map<string, Uint8Array>;
  private readonly calls: StoreCallRecord[] = [];

  constructor(private readonly clock: Clock, keys: ReadonlyMap<string, Uint8Array> = new Map()) {
    this.keys = new Map([...keys].map(([keyId, key]) => [keyId, cloneBytes(key)]));
  }

  async resolveApprovalKey(keyId: string): Promise<Uint8Array | undefined> {
    this.calls.push({ action: "resolve_approval_key", occurredAt: this.clock.now(), keyId });
    const key = this.keys.get(keyId);
    return key ? cloneBytes(key) : undefined;
  }

  history(): StoreCallRecord[] {
    return this.calls.map((call) => ({ ...call }));
  }
}
