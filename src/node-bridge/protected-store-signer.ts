import { canonicalJson, sha256Digest } from "../security";
import { frameSigningMaterial, signedNodeFrameSchema, type SignedNodeFrame, type UnsignedNodeFrame } from "../node-protocol/v1";
import { ProtectedStoreError, type NodePrivateKeyStore } from "../node-policy/v1";
import type { BridgeFrameSigner } from "./bridge";

export class ProtectedStoreFrameSigner implements BridgeFrameSigner {
  constructor(private readonly store: NodePrivateKeyStore) {}

  async sign(frame: UnsignedNodeFrame): Promise<SignedNodeFrame> {
    if (this.store.reference().keyId !== frame.keyId) throw new ProtectedStoreError("invalid_configuration");
    const withPlaceholder = {
      ...frame,
      bodyDigest: sha256Digest(frame.body),
      signature: Buffer.alloc(64).toString("base64url"),
    } as SignedNodeFrame;
    const material = frameSigningMaterial(withPlaceholder);
    const signature = await this.store.sign(Buffer.from(canonicalJson(material)));
    if (signature.byteLength !== 64) throw new ProtectedStoreError("corrupt");
    return signedNodeFrameSchema.parse({
      ...material,
      signature: Buffer.from(signature).toString("base64url"),
    }) as SignedNodeFrame;
  }
}
