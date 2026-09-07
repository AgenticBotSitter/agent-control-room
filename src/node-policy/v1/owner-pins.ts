import { createHash, createPublicKey } from "node:crypto";
import { ownerPinSetSchema } from "./schemas";
import { ProtectedStoreError } from "./stores";
import type { OwnerPinSetV1, PinnedOwnerKeyV1 } from "./types";

function validatePin(pin: PinnedOwnerKeyV1): PinnedOwnerKeyV1 {
  try {
    const der = Buffer.from(pin.spki, "base64url");
    const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("wrong algorithm");
    const fingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    if (fingerprint !== pin.fingerprint) throw new Error("fingerprint mismatch");
    return { ...pin };
  } catch {
    throw new ProtectedStoreError("invalid_configuration");
  }
}

export class PinnedOwnerTrust {
  private readonly ceilingKey: PinnedOwnerKeyV1;
  private readonly trustRootKey: PinnedOwnerKeyV1;
  private readonly shrinkKeys: Map<string, PinnedOwnerKeyV1>;

  constructor(input: OwnerPinSetV1) {
    const parsed = ownerPinSetSchema.safeParse(input);
    if (!parsed.success) throw new ProtectedStoreError("invalid_configuration");
    this.ceilingKey = validatePin(parsed.data.ceilingProvisioningKey);
    this.trustRootKey = validatePin(parsed.data.serverTrustRootKey);
    this.shrinkKeys = new Map(parsed.data.trustShrinkKeys.map((key) => {
      const validated = validatePin(key);
      return [validated.keyId, validated];
    }));
  }

  ceilingProvisioningKey(keyId: string): PinnedOwnerKeyV1 | undefined {
    return keyId === this.ceilingKey.keyId ? { ...this.ceilingKey } : undefined;
  }

  serverTrustRootKey(keyId: string): PinnedOwnerKeyV1 | undefined {
    return keyId === this.trustRootKey.keyId ? { ...this.trustRootKey } : undefined;
  }

  trustShrinkKey(keyId: string): PinnedOwnerKeyV1 | undefined {
    const key = this.shrinkKeys.get(keyId);
    return key ? { ...key } : undefined;
  }
}
