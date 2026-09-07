import { assertNoSecretMaterial, digestMatches } from "../../security";
import { verifyNodeFrameSignature } from "./crypto";
import { nodeToServerTypes, serverToNodeTypes, signedNodeFrameSchema } from "./schemas";
import {
  NODE_PROTOCOL_MAX_CLOCK_SKEW_SECONDS,
  NODE_PROTOCOL_MAX_FRAME_BYTES,
  NODE_PROTOCOL_MAX_LIFETIME_SECONDS,
  type ProtocolDirection,
  type ProtocolRateLimitGuard,
  type ReplayGuard,
  type SignedNodeFrame,
  type TrustedKeyResolver,
} from "./types";
import { NODE_PROTOCOL_SUPPORTED_VERSIONS } from "./types";

export type ProtocolAuthenticationCode = "malformed_frame" | "unsupported_version" | "expired" | "unauthenticated" | "forbidden" | "replayed" | "rate_limited";

export class ProtocolAuthenticationError extends Error {
  constructor(readonly code: ProtocolAuthenticationCode) {
    super(`Node protocol frame rejected: ${code}`);
    this.name = "ProtocolAuthenticationError";
  }
}

function reject(code: ProtocolAuthenticationCode): never {
  throw new ProtocolAuthenticationError(code);
}

export interface VerifyFrameOptions {
  expectedDirection: ProtocolDirection;
  receivedAt?: string;
  maxFrameBytes?: number;
  maxClockSkewSeconds?: number;
  maxLifetimeSeconds?: number;
  transportIdentity: string;
  expectedConnectionId?: string;
}

export interface AuthenticatedFrameResult {
  frame: SignedNodeFrame;
  delivery: "accepted" | "duplicate";
}

export class NodeProtocolAuthenticator {
  constructor(
    private readonly keys: TrustedKeyResolver,
    private readonly replay: ReplayGuard,
    private readonly rateLimit: ProtocolRateLimitGuard,
  ) {}

  async verify(raw: string | Uint8Array, options: VerifyFrameOptions): Promise<AuthenticatedFrameResult> {
    const maxBytes = options.maxFrameBytes ?? NODE_PROTOCOL_MAX_FRAME_BYTES;
    const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
    if (bytes > maxBytes) reject("malformed_frame");

    let input: unknown;
    try {
      input = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      reject("malformed_frame");
    }

    if (input && typeof input === "object" && "protocol" in input && typeof (input as { protocol?: unknown }).protocol === "string") {
      const offeredProtocol = (input as { protocol: string }).protocol;
      if (!NODE_PROTOCOL_SUPPORTED_VERSIONS.some((known) => known === offeredProtocol)) reject("unsupported_version");
    }

    const parsed = signedNodeFrameSchema.safeParse(input);
    if (!parsed.success) reject("malformed_frame");
    const frame = parsed.data as SignedNodeFrame;
    if (options.expectedConnectionId && frame.connectionId !== options.expectedConnectionId) reject("forbidden");
    if (frame.direction !== options.expectedDirection) reject("forbidden");
    const allowed = frame.direction === "node_to_server" ? nodeToServerTypes : serverToNodeTypes;
    if (!allowed.has(frame.type)) reject("forbidden");

    const receivedMs = Date.parse(options.receivedAt ?? new Date().toISOString());
    const sentMs = Date.parse(frame.sentAt);
    const expiresMs = Date.parse(frame.expiresAt);
    const skewMs = (options.maxClockSkewSeconds ?? NODE_PROTOCOL_MAX_CLOCK_SKEW_SECONDS) * 1_000;
    const lifetimeMs = (options.maxLifetimeSeconds ?? NODE_PROTOCOL_MAX_LIFETIME_SECONDS) * 1_000;
    if (!Number.isFinite(receivedMs) || receivedMs > expiresMs || sentMs > receivedMs + skewMs || expiresMs - sentMs > lifetimeMs) reject("expired");
    try {
      await this.rateLimit.consume({
        transportIdentity: options.transportIdentity,
        tenantId: frame.tenantId,
        actorId: frame.actorId,
        direction: frame.direction,
        receivedAt: new Date(receivedMs).toISOString(),
      });
    } catch {
      reject("rate_limited");
    }
    if (!digestMatches(frame.body, frame.bodyDigest)) reject("unauthenticated");
    try {
      assertNoSecretMaterial(frame.body, "protocol body");
    } catch {
      reject("forbidden");
    }

    const key = await this.keys.resolve({ tenantId: frame.tenantId, actorId: frame.actorId, senderKind: frame.senderKind, keyId: frame.keyId });
    if (!key || key.tenantId !== frame.tenantId || key.actorId !== frame.actorId || key.senderKind !== frame.senderKind || key.keyId !== frame.keyId) reject("unauthenticated");
    if (key.state !== "active" || ["pending_enrollment", "quarantined", "revoked"].includes(key.principalState)) reject("forbidden");
    const keyValidFrom = Date.parse(key.validFrom);
    const keyValidUntil = key.validUntil ? Date.parse(key.validUntil) : undefined;
    if (!Number.isFinite(keyValidFrom) || (keyValidUntil !== undefined && !Number.isFinite(keyValidUntil))
      || receivedMs < keyValidFrom || (keyValidUntil !== undefined && receivedMs >= keyValidUntil)) reject("unauthenticated");
    try {
      if (!verifyNodeFrameSignature(frame, key.publicKeySpki)) reject("unauthenticated");
    } catch {
      reject("unauthenticated");
    }

    let delivery: "accepted" | "duplicate";
    try {
      delivery = await this.replay.consume(frame, new Date(receivedMs).toISOString());
    } catch {
      reject("replayed");
    }
    return { frame, delivery };
  }
}
