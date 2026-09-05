import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { NATIVE_DELIVERY_FEATURE } from "../harness/v1/native-delivery";
import { sha256Digest } from "../security";
import { NodeProtocolAuthenticator, NODE_PROTOCOL_V1, NODE_PROTOCOL_MAX_FRAME_BYTES,
  signedNodeFrameSchema, verifyNodeFrameSignature, type NodeMessageBodyMap,
  type SignedNodeFrame, type UnsignedNodeFrame } from "../node-protocol/v1";

const configSchema = z.object({
  tenantId: z.string().min(3).max(256), nodeId: z.string().min(3).max(256),
  nodeKeyId: z.string().min(3).max(256), serverId: z.string().min(3).max(256),
  serverKeyId: z.string().min(3).max(256), serverPublicKeySpki: z.string().min(16).max(4096),
  transportIdentity: z.string().min(3).max(256), features: z.array(z.string().min(1).max(128)).max(64),
  maxFrameBytes: z.number().int().min(4096).max(NODE_PROTOCOL_MAX_FRAME_BYTES),
  heartbeatIntervalSeconds: z.number().int().min(5).max(120),
  operationTimeoutMs: z.number().int().min(10).max(5000).default(5000),
}).strict();

export type ServerNodeSessionConfig = z.input<typeof configSchema>;
export interface ServerNodeSessionPorts {
  authentication: NodeProtocolAuthenticator;
  sign(frame: UnsignedNodeFrame): Promise<SignedNodeFrame>;
  send(frameJson: string): Promise<void>;
  clock(): number;
}

export interface ServerNativeChannel {
  readonly tenantId: string;
  readonly nodeId: string;
  readonly nodeKeyId: string;
  readonly connectionId: string;
  readonly maxFrameBytes: number;
  readonly expiresAt: string;
  readonly grantsExecutionAuthority: false;
  assertCurrent(): void;
}

/** One explicitly owned transport session. No listener, key loading or task dispatch. */
export class ServerNodeSession {
  private readonly config: z.output<typeof configSchema>;
  private state: "new" | "negotiating" | "reconciling" | "ready" | "closed" = "new";
  private busy = false;
  private highWater = -Infinity;
  private deadline = Infinity;
  private connectionId?: string;
  private maxFrameBytes = NODE_PROTOCOL_MAX_FRAME_BYTES;
  private features: string[] = [];
  private outboundSequence = 0;
  private readonly outboundIds = new Set<string>();

  constructor(config: ServerNodeSessionConfig, private readonly ports: ServerNodeSessionPorts) {
    this.config = configSchema.parse(config);
    this.maxFrameBytes = this.config.maxFrameBytes;
    this.ports = Object.freeze({ ...ports });
  }

  disconnect(): void { this.state = "closed"; }

  private now(): number {
    const now = this.ports.clock();
    if (!Number.isSafeInteger(now) || now < this.highWater || now >= this.deadline || this.state === "closed") {
      this.disconnect();
      throw new Error("Server node session is no longer current");
    }
    this.highWater = now;
    return now;
  }

  private async bounded(operation: () => Promise<void>): Promise<void> {
    this.now();
    if (this.busy) throw new Error("Server node session already has an unresolved operation");
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.disconnect(); reject(new Error("Server node session operation is uncertain")); }, this.config.operationTimeoutMs);
      })]);
      this.now();
    } catch (error) { this.disconnect(); throw error; }
    finally { if (timer) clearTimeout(timer); this.busy = false; }
  }

  private async authenticate(raw: string | Uint8Array): Promise<SignedNodeFrame> {
    const { frame, delivery } = await this.ports.authentication.verify(raw, {
      expectedDirection: "node_to_server", receivedAt: new Date(this.now()).toISOString(),
      transportIdentity: this.config.transportIdentity, maxFrameBytes: this.maxFrameBytes,
      ...(this.connectionId ? { expectedConnectionId: this.connectionId } : {}),
    });
    this.now();
    if (frame.tenantId !== this.config.tenantId || frame.actorId !== this.config.nodeId ||
        frame.keyId !== this.config.nodeKeyId || delivery !== "accepted") throw new Error("Server node session identity or replay mismatch");
    return frame;
  }

  async acceptHello(raw: string | Uint8Array): Promise<void> {
    if (this.state !== "new") throw new Error("Server node session cannot repeat a handshake");
    this.state = "negotiating";
    await this.bounded(async () => {
      const frame = await this.authenticate(raw);
      if (frame.type !== "connection.hello" || frame.sequence !== 1 ||
          !frame.body.supportedProtocols.includes(NODE_PROTOCOL_V1)) throw new Error("Server node session requires a supported hello");
      this.connectionId = frame.connectionId;
      this.deadline = Math.min(Date.parse(frame.expiresAt), this.now() + 300_000);
      this.now();
      this.maxFrameBytes = Math.min(this.config.maxFrameBytes, frame.body.requestedMaxFrameBytes);
      const offeredFeatures = frame.body.features;
      this.features = [...new Set(this.config.features.filter((feature) => offeredFeatures.includes(feature)))];
      await this.send("connection.accepted", {
        selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: [...this.features], maxFrameBytes: this.maxFrameBytes,
        heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds, serverTime: new Date(this.now()).toISOString(),
      }, frame.messageId);
      await this.send("node.reconciliation.request", {
        lastAcknowledgedNodeSequence: frame.sequence, requestedAttemptIds: [...frame.body.unresolvedAttemptIds],
      });
      this.state = "reconciling";
    });
  }

  async receive(raw: string | Uint8Array): Promise<void> {
    if (this.state !== "reconciling" && this.state !== "ready") throw new Error("Server node session is not accepting reconciliation");
    await this.bounded(async () => {
      const frame = await this.authenticate(raw);
      if (frame.type === "protocol.ack") {
        if (frame.body.acknowledgedMessageIds.some((id) => !this.outboundIds.has(id)) ||
            frame.body.highestContiguousSequence > this.outboundSequence) throw new Error("Server node acknowledgement mismatch");
        return;
      }
      if (frame.type !== "node.reconciliation.report" || this.state !== "reconciling") throw new Error("Server node session expected reconciliation report");
      if (frame.body.lastAcknowledgedServerSequence !== this.outboundSequence) throw new Error("Server reconciliation does not cover this handshake");
      this.state = "ready";
      await this.send("protocol.ack", { acknowledgedMessageIds: [frame.messageId], highestContiguousSequence: frame.sequence, disposition: "accepted" });
    });
  }

  nativeDeliveryChannel(): ServerNativeChannel | undefined {
    try { this.now(); } catch { return undefined; }
    if (this.busy || this.state !== "ready" || !this.connectionId || !this.features.includes(NATIVE_DELIVERY_FEATURE)) return undefined;
    return Object.freeze({ tenantId: this.config.tenantId, nodeId: this.config.nodeId, nodeKeyId: this.config.nodeKeyId,
      connectionId: this.connectionId, maxFrameBytes: this.maxFrameBytes, expiresAt: new Date(this.deadline).toISOString(),
      grantsExecutionAuthority: false as const,
      assertCurrent: () => { this.now(); if (this.busy || this.state !== "ready") throw new Error("Server native channel is unavailable"); },
    });
  }

  private async send<T extends "connection.accepted" | "node.reconciliation.request" | "protocol.ack">(type: T, body: NodeMessageBodyMap[T], causationId?: string): Promise<void> {
    const frame = { protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
      tenantId: this.config.tenantId, actorId: this.config.serverId, keyId: this.config.serverKeyId,
      connectionId: this.connectionId!, sequence: ++this.outboundSequence, messageId: `message:${randomUUID()}`,
      correlationId: `correlation:${randomUUID()}`, ...(causationId ? { causationId } : {}),
      sentAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.deadline).toISOString(),
      nonce: randomBytes(24).toString("base64url"), type, body } as UnsignedNodeFrame<T>;
    const signed = signedNodeFrameSchema.parse(await this.ports.sign(structuredClone(frame))) as SignedNodeFrame;
    this.now();
    const { signature, bodyDigest, ...unsigned } = signed;
    if (!signature || bodyDigest !== sha256Digest(frame.body) || sha256Digest(unsigned) !== sha256Digest(frame) ||
        !verifyNodeFrameSignature(signed, this.config.serverPublicKeySpki)) throw new Error("Server signer changed handshake content");
    const json = JSON.stringify(signed);
    if (Buffer.byteLength(json) > this.maxFrameBytes) throw new Error("Negotiated server frame limit exceeded");
    await this.ports.send(json);
    this.now();
    this.outboundIds.add(signed.messageId);
  }
}

/** Owned by the single server process; never a distributed connection registry. */
export class ServerNodeSessionRegistry {
  private readonly sessions = new Map<string, ServerNodeSession>();

  constructor(private readonly capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) throw new Error("Invalid server session capacity");
  }

  replace(config: ServerNodeSessionConfig, ports: ServerNodeSessionPorts): ServerNodeSession {
    const snapshot = configSchema.parse(config);
    const key = JSON.stringify([snapshot.tenantId, snapshot.nodeId]);
    if (!this.sessions.has(key) && this.sessions.size >= this.capacity) throw new Error("Server session capacity exhausted");
    const session = new ServerNodeSession(snapshot, ports);
    this.sessions.get(key)?.disconnect();
    this.sessions.set(key, session);
    return session;
  }

  release(session: ServerNodeSession): void {
    session.disconnect();
    for (const [key, current] of this.sessions) if (current === session) this.sessions.delete(key);
  }

  close(): void {
    for (const session of this.sessions.values()) session.disconnect();
    this.sessions.clear();
  }
}
