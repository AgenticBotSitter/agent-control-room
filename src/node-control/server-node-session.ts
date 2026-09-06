import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { NATIVE_DELIVERY_FEATURE, nativeTaskDispatchBodySchema, matchNativeTaskDispatchReceipt, type NativeTaskDispatchBody } from "../harness/v1/native-delivery";
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
export const captureServerNodeSessionConfig = (input: ServerNodeSessionConfig) => configSchema.parse(input);
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

export interface NativeEnvelopeChannel extends ServerNativeChannel {
  readonly serverId: string;
  readonly serverKeyId: string;
  readonly serverPublicKeySpki: string;
}

/** One explicitly owned supplied transport session. No listener or key loading. */
export class ServerNodeSession {
  private readonly config: z.output<typeof configSchema>;
  private state: "new" | "negotiating" | "reconciling" | "ready" | "prepared" | "transmitting" | "sent" | "receipted" | "recovered" | "closed" = "new";
  private preparedFrame?: SignedNodeFrame<"harness.native.dispatch">;
  private recoveredFrame?: SignedNodeFrame<"harness.native.dispatch">;
  private nativeDeliveryRecorded = false;
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

  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    this.now();
    if (this.busy) throw new Error("Server node session already has an unresolved operation");
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.disconnect(); reject(new Error("Server node session operation is uncertain")); }, this.config.operationTimeoutMs);
      })]);
      this.now();
      return value;
    } catch (error) { this.disconnect(); throw error; }
    finally { if (timer) clearTimeout(timer); this.busy = false; }
  }

  private async authenticate(raw: string | Uint8Array, maxFrameBytes = this.maxFrameBytes): Promise<SignedNodeFrame> {
    const { frame, delivery } = await this.ports.authentication.verify(raw, {
      expectedDirection: "node_to_server", receivedAt: new Date(this.now()).toISOString(),
      transportIdentity: this.config.transportIdentity, maxFrameBytes: Math.min(this.maxFrameBytes, maxFrameBytes),
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
      this.now();
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
      this.now();
      this.state = "reconciling";
    });
  }

  async receive(raw: string | Uint8Array): Promise<void> {
    // A delayed handshake ACK may follow explicit staging or receipt, and a retained
    // outbox may place progress before its final ACK. Only ACKs are allowed outside
    // reconciliation; accepting one never changes delivery or execution state.
    if (!["reconciling", "ready", "prepared", "sent", "receipted", "recovered"].includes(this.state)) throw new Error("Server node session is not accepting reconciliation");
    await this.bounded(async () => {
      const frame = await this.authenticate(raw);
      this.now();
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

  /** Trusted coordinator transaction only. A reserved sequence cannot be reused or transmitted here. */
  async stageNativeDispatch<T>(commit: (sign: (body: NativeTaskDispatchBody, deadline: number) => Promise<SignedNodeFrame<"harness.native.dispatch">>, channel: NativeEnvelopeChannel) => Promise<T>): Promise<T> {
    const available = this.nativeDeliveryChannel();
    if (!available) throw new Error("Native delivery channel unavailable");
    return this.bounded(async () => {
      let signed = false;
      let reserved: SignedNodeFrame<"harness.native.dispatch"> | undefined;
      const assertCurrent = () => { this.now(); if (this.state !== "ready") throw new Error("Native envelope reservation is unavailable"); };
      const channel = Object.freeze({ ...available, serverId: this.config.serverId, serverKeyId: this.config.serverKeyId,
        serverPublicKeySpki: this.config.serverPublicKeySpki, assertCurrent });
      const value = await commit(async (input, deadline) => {
        assertCurrent();
        if (signed) throw new Error("Native envelope already reserved");
        signed = true;
        const body = nativeTaskDispatchBodySchema.parse(input);
        if (body.request.tenantId !== this.config.tenantId || body.request.nodeId !== this.config.nodeId ||
            !Number.isSafeInteger(deadline) || deadline <= this.now()) throw new Error("Native envelope scope or deadline mismatch");
        const frame = await this.signFrame("harness.native.dispatch", body, undefined, Math.min(deadline, body.start.deadline));
        assertCurrent(); reserved = structuredClone(frame); return frame;
      }, channel);
      assertCurrent();
      if (!signed || !reserved) throw new Error("Native envelope transaction did not reserve a frame");
      this.preparedFrame = reserved;
      this.state = "prepared";
      return value;
    });
  }

  /** Trusted coordinator callback must commit a unique transmission intent before this sends once. */
  async sendPreparedNativeDispatch<T>(commit: (frame: SignedNodeFrame<"harness.native.dispatch">, channel: NativeEnvelopeChannel) => Promise<{ value: T; assertFresh(): void }>) {
    if (this.state !== "prepared" || !this.preparedFrame) throw new Error("No prepared native envelope is available");
    const frame = structuredClone(this.preparedFrame);
    return this.bounded(async () => {
      const assertCurrent = () => {
        if (this.now() >= Date.parse(frame.expiresAt) || this.state !== "prepared") throw new Error("Prepared native transmission is unavailable");
      };
      assertCurrent();
      const channel: NativeEnvelopeChannel = Object.freeze({ tenantId: this.config.tenantId, nodeId: this.config.nodeId,
        nodeKeyId: this.config.nodeKeyId, connectionId: this.connectionId!, maxFrameBytes: this.maxFrameBytes,
        expiresAt: new Date(this.deadline).toISOString(), grantsExecutionAuthority: false,
        serverId: this.config.serverId, serverKeyId: this.config.serverKeyId, serverPublicKeySpki: this.config.serverPublicKeySpki, assertCurrent });
      const result = await commit(structuredClone(frame), channel);
      assertCurrent(); result.assertFresh(); assertCurrent();
      // No awaited work between consuming the local slot and entering the transport.
      this.state = "transmitting";
      await this.ports.send(JSON.stringify(frame));
      this.now();
      this.state = "sent";
      return { receipt: result.value, transportResult: "returned_without_receipt" as const, deliveryConfirmed: false as const };
    });
  }

  /** Authenticated intake evidence only. Trusted callback must commit before this reports recording.
   * The host serializes transport callbacks after send settles; no retry or receipt acknowledgement here. */
  async acceptNativeReceipt<T>(raw: string | Uint8Array, commit: (receipt: SignedNodeFrame<"harness.native.dispatch.receipt">,
    dispatch: SignedNodeFrame<"harness.native.dispatch">, assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (this.state !== "sent" || !this.preparedFrame) throw new Error("Native receipt has no sent envelope");
    const dispatch = structuredClone(this.preparedFrame);
    return this.bounded(async () => {
      const frame = await this.authenticate(raw);
      if (frame.type !== "harness.native.dispatch.receipt") throw new Error("Expected native receipt, not transport acknowledgement");
      matchNativeTaskDispatchReceipt(frame.body, dispatch);
      const assertCurrent = () => {
        const now = this.now();
        if (this.state !== "sent" || now >= Date.parse(frame.expiresAt) || Date.parse(frame.body.recordedAt) > now
          || Date.parse(frame.body.recordedAt) < Date.parse(dispatch.sentAt)) throw new Error("Native receipt window unavailable");
      };
      assertCurrent();
      const value = await commit(structuredClone(frame), dispatch, assertCurrent);
      assertCurrent(); this.nativeDeliveryRecorded = frame.body.disposition === "recorded"; this.state = "receipted";
      return value;
    });
  }

  /** Trusted durable-evidence lookup only. Restores observation, never a send/start slot.
   * The historical frame is not transmitted, re-signed or assigned the new connection ID. */
  async recoverNativeDelivery(resolve: (channel: NativeEnvelopeChannel) => Promise<SignedNodeFrame<"harness.native.dispatch">>): Promise<void> {
    const available = this.nativeDeliveryChannel();
    if (!available || !this.features.includes("harness.native.snapshot.v1")) throw new Error("Native recovery channel unavailable");
    await this.bounded(async () => {
      const assertCurrent = () => { this.now(); if (this.state !== "ready") throw new Error("Native recovery unavailable"); };
      const channel = Object.freeze({ ...available, serverId: this.config.serverId, serverKeyId: this.config.serverKeyId,
        serverPublicKeySpki: this.config.serverPublicKeySpki, assertCurrent });
      const frame = signedNodeFrameSchema.parse(await resolve(channel));
      assertCurrent();
      if (frame.type !== "harness.native.dispatch" || frame.direction !== "server_to_node"
        || frame.tenantId !== this.config.tenantId || frame.body.request.tenantId !== this.config.tenantId
        || frame.body.request.nodeId !== this.config.nodeId || frame.actorId !== this.config.serverId
        || frame.keyId !== this.config.serverKeyId || frame.connectionId === this.connectionId
        || !verifyNodeFrameSignature(frame, this.config.serverPublicKeySpki)) throw new Error("Native recovery evidence mismatch");
      this.recoveredFrame = structuredClone(frame);
      this.state = "recovered";
    });
  }

  /** Persist authenticated progress for this exact delivered task before acknowledging it.
   * The trusted store callback must apply assertCurrent inside its transaction before commit.
   * A failed/lost acknowledgement closes this session; it does not permit re-execution. */
  async acceptNativeSnapshot<T>(raw: string | Uint8Array, commit: (
    frame: SignedNodeFrame<"harness.native.snapshot">, assertCurrent: () => void,
  ) => Promise<T>): Promise<T> {
    if (!(this.state === "receipted" && this.nativeDeliveryRecorded && this.preparedFrame
      || this.state === "recovered" && this.recoveredFrame)
      || !this.features.includes("harness.native.snapshot.v1")) throw new Error("Native progress requires recorded delivery and negotiated support");
    const dispatch = structuredClone(this.recoveredFrame ?? this.preparedFrame!);
    return this.bounded(async () => {
      const frame = await this.authenticate(raw, 16_384);
      if (frame.type !== "harness.native.snapshot") throw new Error("Expected native progress");
      const body = frame.body, request = dispatch.body.request;
      if (body.projectId !== request.projectId || body.jobId !== request.jobId || body.attemptId !== request.attemptId
        || body.bindingDigest !== dispatch.body.bindingDigest || Date.parse(body.observedAt) > Date.parse(frame.sentAt))
        throw new Error("Native progress task mismatch");
      const assertCurrent = () => {
        if (this.now() >= Date.parse(frame.expiresAt) || this.state !== "receipted" && this.state !== "recovered") throw new Error("Native progress unavailable");
      };
      assertCurrent();
      const value = await commit(structuredClone(frame), assertCurrent);
      assertCurrent();
      await this.send("protocol.ack", { acknowledgedMessageIds: [frame.messageId],
        highestContiguousSequence: frame.sequence, disposition: "accepted" }, frame.messageId);
      assertCurrent(); return value;
    });
  }

  private async send<T extends "connection.accepted" | "node.reconciliation.request" | "protocol.ack">(type: T, body: NodeMessageBodyMap[T], causationId?: string): Promise<void> {
    const signed = await this.signFrame(type, body, causationId);
    this.now();
    await this.ports.send(JSON.stringify(signed));
    this.now();
    this.outboundIds.add(signed.messageId);
  }

  private async signFrame<T extends "connection.accepted" | "node.reconciliation.request" | "protocol.ack" | "harness.native.dispatch">(type: T, body: NodeMessageBodyMap[T], causationId?: string, deadline = this.deadline): Promise<SignedNodeFrame<T>> {
    const frame = { protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
      tenantId: this.config.tenantId, actorId: this.config.serverId, keyId: this.config.serverKeyId,
      connectionId: this.connectionId!, sequence: ++this.outboundSequence, messageId: `message:${randomUUID()}`,
      correlationId: `correlation:${randomUUID()}`, ...(causationId ? { causationId } : {}),
      sentAt: new Date(this.now()).toISOString(), expiresAt: new Date(Math.min(this.deadline, deadline)).toISOString(),
      nonce: randomBytes(24).toString("base64url"), type, body } as UnsignedNodeFrame<T>;
    const signed = signedNodeFrameSchema.parse(await this.ports.sign(structuredClone(frame))) as SignedNodeFrame;
    this.now();
    const { signature, bodyDigest, ...unsigned } = signed;
    if (!signature || bodyDigest !== sha256Digest(frame.body) || sha256Digest(unsigned) !== sha256Digest(frame) ||
        !verifyNodeFrameSignature(signed, this.config.serverPublicKeySpki)) throw new Error("Server signer changed handshake content");
    const json = JSON.stringify(signed);
    if (Buffer.byteLength(json) > this.maxFrameBytes) throw new Error("Negotiated server frame limit exceeded");
    return signed as SignedNodeFrame<T>;
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
