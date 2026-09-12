import { randomBytes, randomUUID } from "node:crypto";
import { NATIVE_DELIVERY_FEATURE } from "../harness/v1/native-delivery";
import { CODEX_DELIVERY_FEATURE } from '../harness/codex-v1/delivery-contract';
import { sha256Digest } from "../security";
import {
  NODE_PROTOCOL_MAX_FRAME_BYTES,
  NODE_PROTOCOL_V1,
  NodeProtocolAuthenticator,
  signedNodeFrameSchema,
  type ConnectionAcceptedBody,
  type HeartbeatBody,
  type JobEventBody,
  type NodeMessageBodyMap,
  type NodeMessageType,
  type ReconciliationReportBody,
  type SignedNodeFrame,
  type UnsignedNodeFrame,
} from "../node-protocol/v1";
import { SqliteBridgeJournal } from "./journal";
import type { BridgeCommandHandler } from "./admission-handler";
import type { NativeDispatchIntakeHandler } from "./native-dispatch-handler";
import type { CodexDispatchIntakeHandlerV1 } from './codex-dispatch-handler';
import { nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "../harness/v1/native-observation";

export type BridgeState = "stopped" | "connecting" | "authenticating" | "reconciling" | "online" | "backing_off" | "draining";

export interface BridgeTransport {
  send(frameJson: string): Promise<void>;
  close(): Promise<void>;
}

export interface BridgeIncomingTransport extends BridgeTransport {
  incoming(): AsyncIterable<string | Uint8Array>;
}

export interface BridgeFrameSigner {
  sign(frame: UnsignedNodeFrame): Promise<SignedNodeFrame>;
}

export interface BridgeIdentity {
  tenantId: string;
  nodeId: string;
  keyId: string;
  features: readonly string[];
}

export interface BridgeStatus {
  state: BridgeState;
  connectionId?: string;
  reconnectAttempt: number;
  lastSafeErrorCode?: "transport_unavailable" | "protocol_rejected";
  heartbeatIntervalSeconds?: number;
  nextHeartbeatAt?: string;
  enabledFeatures?: string[];
  maxFrameBytes?: number;
}

/** Negotiated channel state only: not liveness, owner approval, or execution authority. */
export interface NativeDeliveryChannel {
  readonly tenantId: string;
  readonly nodeId: string;
  readonly connectionId: string;
  readonly maxFrameBytes: number;
  readonly grantsExecutionAuthority: false;
  assertCurrent(): void;
}

export interface CodexDeliveryChannel extends NativeDeliveryChannel {}

export interface OpenBridgeOptions {
  now: string;
  transportIdentity: string;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1_000).toISOString();
}

export class PortableNodeBridge {
  private statusValue: BridgeStatus = { state: "stopped", reconnectAttempt: 0 };
  private transport?: BridgeTransport;
  private transportIdentity?: string;
  private sendQueue: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;
  private connectionReconciled = false;

  constructor(
    private readonly identity: BridgeIdentity,
    private readonly journal: SqliteBridgeJournal,
    private readonly signer: BridgeFrameSigner,
    private readonly serverAuthenticator: Pick<NodeProtocolAuthenticator, "verify">,
    private readonly idFactory: () => string = randomUUID,
    private readonly commandHandler?: BridgeCommandHandler,
    private readonly nativeHandler?: NativeDispatchIntakeHandler,
    private readonly codexHandler?: CodexDispatchIntakeHandlerV1,
  ) {
    this.identity = Object.freeze({ ...identity, features: Object.freeze([...identity.features]) });
    this.serverAuthenticator = Object.freeze({ verify: serverAuthenticator.verify.bind(serverAuthenticator) });
  }

  nativeDeliveryChannel(): NativeDeliveryChannel | undefined {
    const status = this.statusValue;
    if (!this.connectionReconciled || status.state !== "online" || status.lastSafeErrorCode || !this.transport ||
        !status.connectionId || !status.maxFrameBytes ||
        !this.identity.features.includes(NATIVE_DELIVERY_FEATURE) ||
        !status.enabledFeatures?.includes(NATIVE_DELIVERY_FEATURE)) return undefined;
    const generation = this.connectionGeneration;
    const transport = this.transport;
    return Object.freeze({
      tenantId: this.identity.tenantId, nodeId: this.identity.nodeId,
      connectionId: status.connectionId, maxFrameBytes: status.maxFrameBytes,
      grantsExecutionAuthority: false as const,
      assertCurrent: () => {
        if (!this.connectionReconciled || generation !== this.connectionGeneration || transport !== this.transport ||
            this.statusValue.state !== "online" || this.statusValue.lastSafeErrorCode ||
            this.statusValue.connectionId !== status.connectionId ||
            !this.statusValue.enabledFeatures?.includes(NATIVE_DELIVERY_FEATURE)) {
          throw new Error("Native delivery channel is no longer current");
        }
      },
    });
  }

  codexDeliveryChannel(): CodexDeliveryChannel | undefined {
    const status = this.statusValue;
    if (!this.connectionReconciled || status.state !== 'online' || status.lastSafeErrorCode || !this.transport
      || !status.connectionId || !status.maxFrameBytes || !this.identity.features.includes(CODEX_DELIVERY_FEATURE)
      || !status.enabledFeatures?.includes(CODEX_DELIVERY_FEATURE)) return undefined;
    const generation = this.connectionGeneration, transport = this.transport;
    return Object.freeze({ tenantId: this.identity.tenantId, nodeId: this.identity.nodeId,
      connectionId: status.connectionId, maxFrameBytes: status.maxFrameBytes,
      grantsExecutionAuthority: false as const,
      assertCurrent: () => {
        if (!this.connectionReconciled || generation !== this.connectionGeneration || transport !== this.transport
          || this.statusValue.state !== 'online' || this.statusValue.lastSafeErrorCode
          || this.statusValue.connectionId !== status.connectionId
          || !this.statusValue.enabledFeatures?.includes(CODEX_DELIVERY_FEATURE)) {
          throw new Error('Codex delivery channel is no longer current');
        }
      },
    });
  }

  status(): BridgeStatus {
    return { ...this.statusValue, ...(this.statusValue.enabledFeatures ? { enabledFeatures: [...this.statusValue.enabledFeatures] } : {}) };
  }

  reconnectDelayMilliseconds(): number {
    const exponent = Math.min(this.statusValue.reconnectAttempt, 8);
    return Math.min(60_000, 500 * (2 ** exponent));
  }

  async run(transport: BridgeIncomingTransport, options: OpenBridgeOptions, now: () => string): Promise<number> {
    await this.open(transport, options);
    try {
      for await (const frame of transport.incoming()) await this.receive(frame, now());
    } catch (error) {
      await this.disconnected();
      throw error;
    }
    return this.disconnected();
  }

  async open(transport: BridgeTransport, options: OpenBridgeOptions): Promise<void> {
    if (!["stopped", "backing_off"].includes(this.statusValue.state)) throw new Error("Bridge is already connected or connecting");
    const connectionId = `connection:${this.idFactory()}`;
    this.connectionGeneration += 1;
    this.connectionReconciled = false;
    this.transport = transport;
    this.transportIdentity = options.transportIdentity;
    this.statusValue = { ...this.statusValue, state: "connecting", connectionId, lastSafeErrorCode: undefined };
    try {
      const unresolved = this.journal.unresolvedAttempts();
      await this.sendBody("connection.hello", {
        supportedProtocols: [NODE_PROTOCOL_V1],
        features: [...this.identity.features],
        requestedMaxFrameBytes: NODE_PROTOCOL_MAX_FRAME_BYTES,
        lastAcknowledgedServerSequence: this.journal.highestInboundSequence(),
        unresolvedAttemptIds: unresolved.map((attempt) => attempt.attemptId),
      }, true, options.now);
      this.statusValue = { ...this.statusValue, state: "authenticating" };
    } catch (error) {
      this.failTransport();
      try { await transport.close(); } catch { /* transport is already failed */ }
      this.transport = undefined;
      this.transportIdentity = undefined;
      throw error;
    }
  }

  async receive(raw: string | Uint8Array, now: string): Promise<void> {
    const generation = this.connectionGeneration;
    const connectionId = this.requireConnection();
    const transportIdentity = this.transportIdentity;
    if (!transportIdentity) throw new Error("Bridge transport identity is unavailable");
    let verified;
    try {
      verified = await this.serverAuthenticator.verify(raw, {
        expectedDirection: "server_to_node",
        receivedAt: now,
        transportIdentity,
        expectedConnectionId: connectionId,
      });
    } catch (error) {
      this.statusValue = { ...this.statusValue, lastSafeErrorCode: "protocol_rejected" };
      throw error;
    }
    if (generation !== this.connectionGeneration) throw new Error("Bridge connection changed during authentication");
    const { frame, delivery } = verified;
    const priorStatus = this.journal.inboundStatus(frame.messageId);

    if (frame.type === "harness.native.dispatch") {
      try {
        const channel = this.nativeDeliveryChannel();
        if (delivery !== "accepted" || !channel || !this.nativeHandler) throw new Error("Native intake channel unavailable");
        const receipt = await this.nativeHandler.accept(frame, channel);
        channel.assertCurrent();
        this.journal.markInboundProcessed(frame.messageId, receipt.recordedAt);
        await this.sendBody("harness.native.dispatch.receipt", receipt, true, receipt.recordedAt, frame.correlationId, frame.messageId);
        channel.assertCurrent();
        return;
      } catch (error) { if (generation === this.connectionGeneration) this.failTransport(); throw error; }
    }

    if (frame.type === 'harness.codex.dispatch') {
      try {
        const channel = this.codexDeliveryChannel();
        if (delivery !== 'accepted' || !channel || !this.codexHandler) throw new Error('Codex intake channel unavailable');
        const receipt = await this.codexHandler.accept(frame, channel);
        channel.assertCurrent();
        this.journal.markInboundProcessed(frame.messageId, receipt.recordedAt);
        await this.sendBody('harness.codex.dispatch.receipt', receipt, true,
          receipt.recordedAt, frame.correlationId, frame.messageId);
        channel.assertCurrent(); return;
      } catch (error) { if (generation === this.connectionGeneration) this.failTransport(); throw error; }
    }

    if (frame.type === "protocol.ack") {
      if (delivery === "duplicate" && priorStatus === "processed") return;
      this.journal.acknowledge(frame.body.acknowledgedMessageIds, now);
      this.journal.markInboundProcessed(frame.messageId, now);
      await this.flushNativeSnapshots(now);
      return;
    }

    if (delivery === "duplicate" && priorStatus === "processed") {
      await this.sendAcknowledgement(frame, "duplicate", now);
      return;
    }

    switch (frame.type) {
      case "connection.accepted":
        this.acceptConnection(frame.body, frame.causationId, now);
        this.statusValue = { ...this.statusValue, state: "reconciling", reconnectAttempt: 0 };
        break;
      case "node.reconciliation.request":
        if (this.statusValue.state !== "reconciling") throw new Error("Reconciliation arrived in the wrong state");
        await this.sendReconciliationReport(now);
        if (generation !== this.connectionGeneration) throw new Error("Bridge connection changed during reconciliation");
        this.connectionReconciled = true;
        this.statusValue = {
          ...this.statusValue,
          state: "online",
          reconnectAttempt: 0,
          ...(this.statusValue.heartbeatIntervalSeconds
            ? { nextHeartbeatAt: addSeconds(now, this.statusValue.heartbeatIntervalSeconds) }
            : {}),
        };
        await this.flushPriorConnections(now);
        await this.flushJobEvents(now);
        await this.flushNativeSnapshots(now);
        break;
      case "job.offer":
      case "job.lease.grant":
      case "job.lease.renewed":
      case "job.cancel":
        if (!this.commandHandler || !await this.commandHandler.handle(frame, now)) this.journal.recordCommand(frame, now);
        break;
      case "node.operation.request": {
        const handled = this.commandHandler && await this.commandHandler.handle(frame, now);
        if (generation !== this.connectionGeneration) throw new Error("Bridge connection changed during node operation");
        if (!handled) {
          this.journal.recordCommand(frame, now);
          break;
        }
        const response = this.commandHandler?.response?.(frame.messageId);
        if (!response) throw new Error("Handled node operation did not produce a durable acknowledgement");
        await this.sendBody("node.operation.ack", response, true, now, frame.correlationId, frame.messageId);
        if (generation !== this.connectionGeneration) throw new Error("Bridge connection changed during node acknowledgement");
        if (response.disposition === "applied") {
          this.connectionGeneration += 1;
          this.statusValue = { ...this.statusValue, state: response.operation === "request_resume"
            ? (this.connectionReconciled ? "online" : "reconciling") : "draining" };
        }
        break;
      }
      case "protocol.error":
        this.statusValue = { ...this.statusValue, lastSafeErrorCode: "protocol_rejected" };
        break;
      default:
        throw new Error(`Unexpected server message ${frame.type}`);
    }
    this.journal.markInboundProcessed(frame.messageId, now);
    await this.sendAcknowledgement(frame, delivery === "duplicate" ? "duplicate" : "accepted", now);
  }

  async heartbeat(body: HeartbeatBody, now: string): Promise<"staged" | "duplicate" | "coalesced"> {
    if (this.statusValue.state !== "online" && this.statusValue.state !== "draining") throw new Error("Bridge is not online");
    return this.sendBody("node.heartbeat", body, false, now);
  }

  /** The node journal remains the snapshot source across disconnects. Publication uses the existing
   * signed/acknowledged outbox; sending the same snapshot in a new frame never starts native work. */
  async publishNativeSnapshot(input: NativeTaskSnapshotBody, now: string): Promise<"recorded" | "duplicate"> {
    if (!this.identity.features.includes("harness.native.snapshot.v1")) throw new Error("native_snapshot_transport_not_ready");
    const body = nativeTaskSnapshotBodySchema.parse(input);
    if (Date.parse(body.observedAt) > Date.parse(now)) throw new Error("native_snapshot_time_invalid");
    const disposition = this.journal.appendNativeSnapshot(body, now);
    await this.flushNativeSnapshots(now);
    return disposition;
  }

  async flushNativeSnapshots(now: string): Promise<number> {
    if (!["online", "draining"].includes(this.statusValue.state)
      || !this.statusValue.enabledFeatures?.includes("harness.native.snapshot.v1")) return 0;
    return this.serializeSend(async () => {
      if (this.journal.nativeSnapshotAcknowledgementExpired(this.requireConnection(), now)) {
        // A new connection removes uncertainty about a missing old protocol sequence. Reconciliation
        // re-envelopes the durable body; no new native run/provider request is involved.
        await this.disconnected();
        return 0;
      }
      let sent = 0;
      for (const body of this.journal.pendingNativeSnapshots()) {
        await this.sendBodyNow("harness.native.snapshot", body, true, now, `correlation:native:${sha256Digest(body.attemptId).slice(7)}`, undefined, true);
        sent++;
      }
      return sent;
    });
  }

  async flushJobEvents(now: string): Promise<number> {
    if (this.statusValue.state !== "online" && this.statusValue.state !== "draining") throw new Error("Bridge is not online");
    return this.serializeSend(async () => {
      let sent = 0;
      for (const pending of this.journal.pendingJobEvents()) {
        await this.sendJobEventNow(pending.event, pending.messageId, now);
        sent += 1;
      }
      return sent;
    });
  }

  async tick(now: string, snapshot: () => Promise<HeartbeatBody>): Promise<boolean> {
    const interval = this.statusValue.heartbeatIntervalSeconds;
    const due = this.statusValue.nextHeartbeatAt;
    if (!interval || !due || !["online", "draining"].includes(this.statusValue.state) || Date.parse(now) < Date.parse(due)) return false;
    await this.heartbeat(await snapshot(), now);
    await this.flushNativeSnapshots(now);
    if (["online", "draining"].includes(this.statusValue.state)) this.statusValue = { ...this.statusValue, nextHeartbeatAt: addSeconds(now, interval) };
    return true;
  }

  async close(): Promise<void> {
    this.connectionGeneration += 1;
    this.connectionReconciled = false;
    const transport = this.transport;
    this.transport = undefined;
    this.transportIdentity = undefined;
    this.statusValue = { state: "stopped", reconnectAttempt: 0 };
    if (transport) await transport.close();
  }

  async disconnected(): Promise<number> {
    this.connectionGeneration += 1;
    this.connectionReconciled = false;
    const transport = this.transport;
    this.transport = undefined;
    this.transportIdentity = undefined;
    const reconnectAttempt = this.statusValue.reconnectAttempt + 1;
    this.statusValue = { state: "backing_off", reconnectAttempt, lastSafeErrorCode: "transport_unavailable" };
    if (transport) await transport.close();
    return this.reconnectDelayMilliseconds();
  }

  private acceptConnection(body: ConnectionAcceptedBody, causationId: string | undefined, now: string): void {
    if (this.statusValue.state !== "authenticating") throw new Error("Connection acceptance arrived in the wrong state");
    if (body.selectedProtocol !== NODE_PROTOCOL_V1 || body.maxFrameBytes > NODE_PROTOCOL_MAX_FRAME_BYTES) throw new Error("Server negotiated an invalid connection contract");
    if (body.enabledFeatures.some((feature) => !this.identity.features.includes(feature))) throw new Error("Server enabled an unsupported bridge feature");
    if (causationId) this.journal.acknowledge([causationId], now);
    this.statusValue = { ...this.statusValue, maxFrameBytes: body.maxFrameBytes, heartbeatIntervalSeconds: body.heartbeatIntervalSeconds, enabledFeatures: [...body.enabledFeatures] };
  }

  private async sendReconciliationReport(now: string): Promise<void> {
    const attempts = this.journal.unresolvedAttempts();
    const body: ReconciliationReportBody = {
      lastAcknowledgedServerSequence: this.journal.highestInboundSequence(this.requireConnection()),
      attempts: attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        leaseId: attempt.leaseId,
        leaseEpoch: attempt.leaseEpoch,
        state: attempt.state,
        lastEventSequence: attempt.lastEventSequence,
        checkpointIds: attempt.checkpointIds,
      })),
    };
    await this.sendBody("node.reconciliation.report", body, true, now);
  }

  private async sendAcknowledgement(frame: SignedNodeFrame, disposition: "accepted" | "duplicate", now: string): Promise<void> {
    await this.sendBody("protocol.ack", {
      acknowledgedMessageIds: [frame.messageId],
      highestContiguousSequence: frame.sequence,
      disposition,
    }, true, now, frame.correlationId, frame.messageId, false);
  }

  private async flushPriorConnections(now: string): Promise<void> {
    const current = this.requireConnection();
    this.journal.expireBefore(now);
    this.journal.requeueNativeSnapshotsForConnection(current);
    this.journal.retireSupersededControlFrames(current);
    for (const pending of this.journal.pendingOutbound(current)) {
      // Delivery-receipt uncertainty is reconciled explicitly; never replay it over a replacement connection.
      if (pending.frame.type === "harness.native.dispatch.receipt"
        || pending.frame.type === 'harness.codex.dispatch.receipt') continue;
      try {
        await this.requireTransport().send(JSON.stringify(pending.frame));
        this.journal.markSent(pending.frame.messageId, now);
      } catch (error) {
        this.failTransport();
        throw error;
      }
    }
  }

  private async sendBody<TType extends NodeMessageType>(
    type: TType,
    body: NodeMessageBodyMap[TType],
    essential: boolean,
    now: string,
    correlationId = `correlation:${this.idFactory()}`,
    causationId?: string,
    trackAcknowledgement = true,
  ): Promise<"staged" | "duplicate" | "coalesced"> {
    const generation = this.connectionGeneration;
    return this.serializeSend(() => {
      if (generation !== this.connectionGeneration) throw new Error("Bridge connection changed while send was queued");
      return this.sendBodyNow(type, body, essential, now, correlationId, causationId, trackAcknowledgement);
    });
  }

  private async sendBodyNow<TType extends NodeMessageType>(
    type: TType,
    body: NodeMessageBodyMap[TType],
    essential: boolean,
    now: string,
    correlationId: string,
    causationId: string | undefined,
    trackAcknowledgement: boolean,
  ): Promise<"staged" | "duplicate" | "coalesced"> {
    const connectionId = this.requireConnection();
    const generation = this.connectionGeneration;
    const transport = this.requireTransport();
    const sequence = this.journal.nextOutboundSequence(connectionId);
    const unsigned = {
      protocol: NODE_PROTOCOL_V1,
      direction: "node_to_server",
      messageId: `message:${this.idFactory()}`,
      correlationId,
      ...(causationId ? { causationId } : {}),
      tenantId: this.identity.tenantId,
      actorId: this.identity.nodeId,
      senderKind: "node",
      keyId: this.identity.keyId,
      connectionId,
      sequence,
      sentAt: now,
      expiresAt: addSeconds(now, 300),
      nonce: randomBytes(24).toString("base64url"),
      type,
      body,
    } as UnsignedNodeFrame<TType>;
    const materialDigest = type === "harness.native.dispatch.receipt" || type === 'harness.codex.dispatch.receipt'
      ? sha256Digest(unsigned) : undefined;
    const frame = await this.signer.sign(unsigned) as SignedNodeFrame<TType>;
    if (generation !== this.connectionGeneration || transport !== this.transport) throw new Error("Bridge connection changed during signing");
    if (materialDigest) {
      const { signature, bodyDigest, ...material } = signedNodeFrameSchema.parse(frame);
      if (!signature || bodyDigest !== sha256Digest(body) || sha256Digest(material) !== materialDigest
        || Buffer.byteLength(JSON.stringify(frame)) > (this.statusValue.maxFrameBytes ?? 0)) throw new Error("Delivery receipt signer changed the negotiated frame");
    }
    const disposition = frame.type === "harness.native.snapshot"
      ? this.journal.stageNativeSnapshotOutbound(frame as SignedNodeFrame<"harness.native.snapshot">, now)
      : this.journal.stageOutbound(frame, essential, now);
    if (disposition === "coalesced") return disposition;
    try {
      await transport.send(JSON.stringify(frame));
      this.journal.markSent(frame.messageId, now);
      if (!trackAcknowledgement) this.journal.acknowledge([frame.messageId], now);
      return disposition;
    } catch (error) {
      if (generation === this.connectionGeneration) this.failTransport();
      throw error;
    }
  }

  private async sendJobEventNow(event: JobEventBody, messageId: string, now: string): Promise<void> {
    const connectionId = this.requireConnection();
    const sequence = this.journal.nextOutboundSequence(connectionId);
    const unsigned: UnsignedNodeFrame<"job.event"> = {
      protocol: NODE_PROTOCOL_V1,
      direction: "node_to_server",
      messageId,
      correlationId: `correlation:attempt:${event.attemptId}`,
      tenantId: this.identity.tenantId,
      actorId: this.identity.nodeId,
      senderKind: "node",
      keyId: this.identity.keyId,
      connectionId,
      sequence,
      sentAt: now,
      expiresAt: addSeconds(now, 300),
      nonce: randomBytes(24).toString("base64url"),
      type: "job.event",
      body: event,
    };
    const frame = await this.signer.sign(unsigned) as SignedNodeFrame<"job.event">;
    this.journal.stageJobEventOutbound(frame, event.attemptId, event.sequence, now);
    try {
      await this.requireTransport().send(JSON.stringify(frame));
      this.journal.markSent(frame.messageId, now);
    } catch (error) {
      this.failTransport();
      throw error;
    }
  }

  private serializeSend<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sendQueue.then(operation, operation);
    this.sendQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireConnection(): string {
    if (!this.statusValue.connectionId) throw new Error("Bridge has no active connection");
    return this.statusValue.connectionId;
  }

  private requireTransport(): BridgeTransport {
    if (!this.transport) throw new Error("Bridge transport is unavailable");
    return this.transport;
  }

  private failTransport(): void {
    this.connectionGeneration += 1;
    this.connectionReconciled = false;
    const reconnectAttempt = this.statusValue.reconnectAttempt + 1;
    this.statusValue = { state: "backing_off", reconnectAttempt, lastSafeErrorCode: "transport_unavailable" };
  }
}
