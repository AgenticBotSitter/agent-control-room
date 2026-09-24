import { randomBytes, randomUUID } from "node:crypto";
import { NATIVE_DELIVERY_FEATURE } from "../harness/v1/native-delivery";
import { CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1,
  controllerWorkerNodeReceiptRecoverySchemaV1 } from "../harness/v1/controller-worker-node-delivery";
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
import type { CodexActivationIntakeHandlerV1 } from './codex-activation-handler';
import type { ControllerWorkerDeliveryIntakeHandlerV1 } from "./controller-worker-delivery-handler";
import { CODEX_ACTIVATION_FEATURE } from '../harness/codex-v1/activation-contract';
import { CODEX_RESULT_RETURN_FEATURE_V1, codexResultReturnBodySchemaV1,
  type CodexResultReturnBodyV1, type CodexResultReturnFrameV1,
  type CodexResultReturnReceiptFrameV1 } from '../harness/codex-v1/result-return';
import { nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "../harness/v1/native-observation";
import { CODEX_CURRENT_ADMISSION_READ_FEATURE_V1, codexCurrentAdmissionReadRequestSchemaV1,
  type CodexCurrentAdmissionReadRequestV1 } from "../harness/codex-v1/current-admission-read-contract";
import { codexApprovalPacketDigestV1 } from "../web/v1/codex-task-queue";

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
export interface CodexActivationChannel extends NativeDeliveryChannel {}
export interface CodexResultReturnChannel extends NativeDeliveryChannel {}
export interface ControllerWorkerDeliveryChannel extends NativeDeliveryChannel {}

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
  private codexResultWaiter?: {
    messageId: string;
    generation: number;
    resolve(receipt: CodexResultReturnReceiptFrameV1): void;
    reject(error: Error): void;
  };
  private codexAdmissionWaiter?: {
    requestMessageId: string;
    queueId: string;
    generation: number;
    resolve(response: SignedNodeFrame<"harness.codex.current-admission.read.response">): void;
    reject(error: Error): void;
  };

  constructor(
    private readonly identity: BridgeIdentity,
    private readonly journal: SqliteBridgeJournal,
    private readonly signer: BridgeFrameSigner,
    private readonly serverAuthenticator: Pick<NodeProtocolAuthenticator, "verify">,
    private readonly idFactory: () => string = randomUUID,
    private readonly commandHandler?: BridgeCommandHandler,
    private readonly nativeHandler?: NativeDispatchIntakeHandler,
    private readonly codexHandler?: CodexDispatchIntakeHandlerV1,
    private readonly codexActivationHandler?: CodexActivationIntakeHandlerV1,
    private readonly controllerWorkerHandler?: ControllerWorkerDeliveryIntakeHandlerV1,
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

  controllerWorkerDeliveryChannel(): ControllerWorkerDeliveryChannel | undefined {
    const status = this.statusValue;
    if (!this.connectionReconciled || status.state !== "online" || status.lastSafeErrorCode || !this.transport
      || !status.connectionId || !status.maxFrameBytes
      || !this.identity.features.includes(CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1)
      || !status.enabledFeatures?.includes(CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1)) return undefined;
    const generation = this.connectionGeneration, transport = this.transport;
    return Object.freeze({ tenantId: this.identity.tenantId, nodeId: this.identity.nodeId,
      connectionId: status.connectionId, maxFrameBytes: status.maxFrameBytes,
      grantsExecutionAuthority: false as const,
      assertCurrent: () => {
        if (!this.connectionReconciled || generation !== this.connectionGeneration || transport !== this.transport
          || this.statusValue.state !== "online" || this.statusValue.lastSafeErrorCode
          || this.statusValue.connectionId !== status.connectionId
          || !this.statusValue.enabledFeatures?.includes(CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1)) {
          throw new Error("Controller worker delivery channel is no longer current");
        }
      },
    });
  }

  /** Report an already journaled receipt over a new authenticated connection.
   * This never passes a packet back through delivery intake or starts work. */
  async recoverControllerWorkerReceipt(queueId: string, now: string): Promise<void> {
    const channel = this.controllerWorkerDeliveryChannel();
    if (!channel || !this.identity.features.includes(CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1)
      || !this.statusValue.enabledFeatures?.includes(CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1)) {
      throw new Error("Controller worker receipt recovery unavailable");
    }
    channel.assertCurrent();
    const saved = this.journal.acceptedControllerWorkerDelivery(queueId);
    if (!saved || !Number.isFinite(Date.parse(now)) || Date.parse(now) >= Date.parse(saved.frame.expiresAt)
      || Date.parse(now) < Date.parse(saved.receipt.receivedAt)
      || saved.frame.tenantId !== channel.tenantId || saved.frame.body.delivery.identity.nodeId !== channel.nodeId) {
      throw new Error("Controller worker receipt recovery unavailable");
    }
    const dispatch = saved.frame;
    const body = controllerWorkerNodeReceiptRecoverySchemaV1.parse({
      schema: "control-room.controller-worker-node-receipt-recovery/v1",
      scope: { projectId: dispatch.body.delivery.identity.projectId, jobId: dispatch.body.delivery.identity.jobId,
        attemptId: dispatch.body.delivery.identity.attemptId }, dispatchFrameDigest: sha256Digest(dispatch),
      receipt: { schema: "control-room.controller-worker-node-dispatch-receipt/v1", queueId,
        dispatchMessageId: dispatch.messageId, dispatchBodyDigest: dispatch.bodyDigest,
        enrollmentDigest: dispatch.body.enrollmentDigest, receipt: saved.receipt },
    });
    channel.assertCurrent();
    await this.sendBody("controller.worker.delivery.receipt.recovery", body, true, now,
      dispatch.correlationId, dispatch.messageId, false);
    channel.assertCurrent();
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

  codexActivationChannel(): CodexActivationChannel | undefined {
    const status = this.statusValue;
    if (!this.connectionReconciled || status.state !== 'online' || status.lastSafeErrorCode || !this.transport
      || !status.connectionId || !status.maxFrameBytes || !this.identity.features.includes(CODEX_ACTIVATION_FEATURE)
      || !status.enabledFeatures?.includes(CODEX_ACTIVATION_FEATURE)) return undefined;
    const generation = this.connectionGeneration, transport = this.transport;
    return Object.freeze({ tenantId: this.identity.tenantId, nodeId: this.identity.nodeId,
      connectionId: status.connectionId, maxFrameBytes: status.maxFrameBytes,
      grantsExecutionAuthority: false as const,
      assertCurrent: () => {
        if (!this.connectionReconciled || generation !== this.connectionGeneration || transport !== this.transport
          || this.statusValue.state !== 'online' || this.statusValue.lastSafeErrorCode
          || this.statusValue.connectionId !== status.connectionId
          || !this.statusValue.enabledFeatures?.includes(CODEX_ACTIVATION_FEATURE)) {
          throw new Error('Codex activation channel is no longer current');
        }
      },
    });
  }

  codexResultReturnChannel(): CodexResultReturnChannel | undefined {
    const status = this.statusValue;
    if (!this.connectionReconciled || status.state !== 'online' || status.lastSafeErrorCode || !this.transport
      || !status.connectionId || !status.maxFrameBytes
      || !this.identity.features.includes(CODEX_RESULT_RETURN_FEATURE_V1)
      || !status.enabledFeatures?.includes(CODEX_RESULT_RETURN_FEATURE_V1)) return undefined;
    const generation = this.connectionGeneration, transport = this.transport;
    return Object.freeze({ tenantId: this.identity.tenantId, nodeId: this.identity.nodeId,
      connectionId: status.connectionId, maxFrameBytes: status.maxFrameBytes,
      grantsExecutionAuthority: false as const,
      assertCurrent: () => {
        if (!this.connectionReconciled || generation !== this.connectionGeneration || transport !== this.transport
          || this.statusValue.state !== 'online' || this.statusValue.lastSafeErrorCode
          || this.statusValue.connectionId !== status.connectionId
          || !this.statusValue.enabledFeatures?.includes(CODEX_RESULT_RETURN_FEATURE_V1)) {
          throw new Error('Codex result return channel is no longer current');
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
    const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
    if (this.statusValue.maxFrameBytes && rawBytes > this.statusValue.maxFrameBytes) {
      this.statusValue = { ...this.statusValue, lastSafeErrorCode: "protocol_rejected" };
      if (this.codexAdmissionWaiter) this.failTransport();
      throw new Error("Server frame exceeds the negotiated limit");
    }
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
      if (this.codexAdmissionWaiter) this.failTransport();
      throw error;
    }
    if (generation !== this.connectionGeneration) throw new Error("Bridge connection changed during authentication");
    const { frame, delivery } = verified;
    const priorStatus = this.journal.inboundStatus(frame.messageId);

    if (frame.type === "controller.worker.delivery") {
      try {
        const channel = this.controllerWorkerDeliveryChannel();
        if (delivery !== "accepted" || !channel || !this.controllerWorkerHandler)
          throw new Error("Controller worker intake channel unavailable");
        const receipt = await this.controllerWorkerHandler.accept(frame, channel);
        channel.assertCurrent();
        this.journal.markInboundProcessed(frame.messageId, receipt.receipt.receivedAt);
        await this.sendBody("controller.worker.delivery.receipt", receipt, true,
          receipt.receipt.receivedAt, frame.correlationId, frame.messageId);
        channel.assertCurrent(); return;
      } catch (error) { if (generation === this.connectionGeneration) this.failTransport(); throw error; }
    }

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

    if (delivery === "duplicate" && priorStatus === "processed"
      && frame.type !== "harness.codex.current-admission.read.response") {
      await this.sendAcknowledgement(frame, "duplicate", now);
      return;
    }

    if (frame.type === 'harness.codex.dispatch.activation') {
      try {
        const channel = this.codexActivationChannel();
        if (!channel || !this.codexActivationHandler
          || (delivery !== 'accepted' && !(delivery === 'duplicate' && priorStatus === 'received')))
          throw new Error('Codex activation intake unavailable');
        await this.codexActivationHandler.accept(frame, channel);
        channel.assertCurrent();
        this.journal.markInboundProcessed(frame.messageId, now);
        await this.sendAcknowledgement(frame, delivery === 'duplicate' ? 'duplicate' : 'accepted', now);
        channel.assertCurrent();
        return;
      } catch (error) { if (generation === this.connectionGeneration) this.failTransport(); throw error; }
    }

    if (frame.type === 'harness.codex.result.return.receipt') {
      try {
        const channel = this.codexResultReturnChannel();
        if (delivery !== 'accepted' || !channel) throw new Error('Codex result return receipt unavailable');
        channel.assertCurrent();
        const receipt = this.journal.recordCodexResultReturnReceipt(
          frame as CodexResultReturnReceiptFrameV1, now);
        channel.assertCurrent();
        this.journal.markInboundProcessed(frame.messageId, now);
        const waiter = this.codexResultWaiter;
        if (waiter && waiter.generation === generation
          && waiter.messageId === receipt.body.returnMessageId) waiter.resolve(receipt);
        return;
      } catch (error) { if (generation === this.connectionGeneration) this.failTransport(); throw error; }
    }

    if (frame.type === "harness.codex.current-admission.read.response") {
      try {
        const waiter = this.codexAdmissionWaiter;
        if (delivery !== "accepted" || !waiter || waiter.generation !== generation
          || frame.causationId !== waiter.requestMessageId || frame.body.queueId !== waiter.queueId
          || !this.statusValue.enabledFeatures?.includes(CODEX_CURRENT_ADMISSION_READ_FEATURE_V1)) {
          throw new Error("Codex current-admission response unavailable");
        }
        this.journal.recordCodexCurrentAdmissionExchangeResponse(frame, now);
        this.journal.markInboundProcessed(frame.messageId, now);
        waiter.resolve(frame);
        return;
      } catch (error) { if (generation === this.connectionGeneration) this.failTransport(); throw error; }
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

  /** One exact, queue-bound, non-executing current-admission exchange. The
   * journal reservation and sent marker precede the sole transport write;
   * timeout, abort, disconnect, or write uncertainty permanently burns it. */
  async exchangeCodexCurrentAdmission(bodyValue: CodexCurrentAdmissionReadRequestV1,
    now: string, expiresAt: string, signal: AbortSignal, responseTimeoutMs = 5_000): Promise<Readonly<{
      request: SignedNodeFrame<"harness.codex.current-admission.read">;
      response: SignedNodeFrame<"harness.codex.current-admission.read.response">;
    }>> {
    const generation = this.connectionGeneration;
    const pending = await this.serializeSend(async () => {
      const body = codexCurrentAdmissionReadRequestSchemaV1.parse(bodyValue);
      if (!(signal instanceof AbortSignal) || signal.aborted || !Number.isSafeInteger(responseTimeoutMs)
        || responseTimeoutMs < 1 || responseTimeoutMs > 30_000 || this.codexAdmissionWaiter
        || this.statusValue.state !== "online"
        || !this.identity.features.includes(CODEX_CURRENT_ADMISSION_READ_FEATURE_V1)
        || !this.statusValue.enabledFeatures?.includes(CODEX_CURRENT_ADMISSION_READ_FEATURE_V1)) {
        throw new Error("Codex current-admission exchange unavailable");
      }
      const connectionId = this.requireConnection(), transport = this.requireTransport();
      const activation = this.journal.acceptedCodexActivation(body.queueId);
      const delivery = this.journal.acceptedCodexDelivery(body.queueId);
      if (!activation || !delivery || activation.frame.connectionId !== connectionId
        || body.projectId !== activation.frame.body.projectId || body.jobId !== activation.frame.body.jobId
        || body.attemptId !== activation.frame.body.attemptId || body.nodeId !== activation.frame.body.nodeId
        || body.inputDigest !== activation.frame.body.inputDigest
        || body.packetDigest !== codexApprovalPacketDigestV1(delivery.frame.body)
        || body.activationFrameDigest !== sha256Digest(activation.frame)
        || body.currentAdmissionDigest !== activation.frame.body.currentAdmissionDigest) {
        throw new Error("Codex current-admission queue binding unavailable");
      }
      const sentAt = Date.parse(now), deadline = Date.parse(expiresAt);
      if (!Number.isFinite(sentAt) || new Date(sentAt).toISOString() !== now
        || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt || deadline <= sentAt
        || deadline > Date.parse(activation.frame.expiresAt)) {
        throw new Error("Codex current-admission exchange time invalid");
      }
      const unsigned: UnsignedNodeFrame<"harness.codex.current-admission.read"> = {
        protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
        tenantId: this.identity.tenantId, actorId: this.identity.nodeId, keyId: this.identity.keyId,
        connectionId, sequence: this.journal.nextOutboundSequence(connectionId),
        messageId: `message:codex-admission:${this.idFactory()}`,
        correlationId: `correlation:codex-admission:${this.idFactory()}`,
        sentAt: now, expiresAt, nonce: body.challengeNonce,
        type: "harness.codex.current-admission.read", body,
      };
      const materialDigest = sha256Digest(unsigned);
      const signed = signedNodeFrameSchema.parse(await this.signer.sign(unsigned));
      if (signed.type !== "harness.codex.current-admission.read") throw new Error("Codex admission signer changed type");
      const { signature, bodyDigest, ...material } = signed;
      if (!signature || bodyDigest !== sha256Digest(body) || sha256Digest(material) !== materialDigest
        || Buffer.byteLength(JSON.stringify(signed), "utf8") > (this.statusValue.maxFrameBytes ?? 0)) {
        throw new Error("Codex admission signer changed the prepared frame");
      }
      const request = signed as SignedNodeFrame<"harness.codex.current-admission.read">;
      this.journal.reserveCodexCurrentAdmissionExchange(request, now);
      let resolve!: (response: SignedNodeFrame<"harness.codex.current-admission.read.response">) => void;
      let reject!: (error: Error) => void;
      const response = new Promise<SignedNodeFrame<"harness.codex.current-admission.read.response">>((res, rej) => {
        resolve = res; reject = rej;
      });
      void response.catch(() => {});
      this.codexAdmissionWaiter = { requestMessageId: request.messageId, queueId: body.queueId,
        generation, resolve, reject };
      const onAbort = () => reject(new Error("Codex current-admission response unavailable"));
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(onAbort, responseTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer); signal.removeEventListener("abort", onAbort);
        if (this.codexAdmissionWaiter?.requestMessageId === request.messageId) this.codexAdmissionWaiter = undefined;
      };
      this.journal.markCodexCurrentAdmissionExchangeSent(request.messageId, now);
      try {
        const write = transport.send(JSON.stringify(request));
        void write.catch(() => {});
        await Promise.race([write, response.then(() => undefined)]);
        if (generation !== this.connectionGeneration) throw new Error("Codex admission connection changed");
        return { request, response, cleanup };
      } catch (error) {
        cleanup();
        if (generation === this.connectionGeneration) this.failTransport();
        throw error;
      }
    });
    try {
      const response = await pending.response;
      if (generation !== this.connectionGeneration) throw new Error("Codex admission connection changed");
      return Object.freeze({ request: pending.request, response });
    } catch (error) {
      this.codexAdmissionWaiter?.reject(new Error("Codex current-admission response unavailable"));
      if (generation === this.connectionGeneration) this.failTransport();
      throw error;
    } finally {
      pending.cleanup();
    }
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

  /** Consumes exactly one durable current-connection send slot for an already
   * projected result. The sent marker is committed before transport I/O; any
   * failure or crash therefore remains ambiguous and cannot be retried. */
  async sendCodexResultReturn(queueId: string, input: CodexResultReturnBodyV1,
    now: string, signal: AbortSignal, receiptTimeoutMs = 5_000,
    currentTime: () => string = () => new Date().toISOString()): Promise<CodexResultReturnReceiptFrameV1> {
    const generation = this.connectionGeneration;
    const pending = await this.serializeSend(async () => {
      if (generation !== this.connectionGeneration) throw new Error('Codex result connection changed while queued');
      if (!(signal instanceof AbortSignal) || signal.aborted || !Number.isSafeInteger(receiptTimeoutMs)
        || receiptTimeoutMs < 1 || receiptTimeoutMs > 30_000 || this.codexResultWaiter) {
        throw new Error('Codex result return operation unavailable');
      }
      const channel = this.codexResultReturnChannel();
      if (!channel) throw new Error('Codex result return channel unavailable');
      channel.assertCurrent();
      const activation = this.journal.acceptedCodexActivation(queueId);
      const body = codexResultReturnBodySchemaV1.parse(input);
      if (!activation || activation.frame.connectionId !== channel.connectionId
        || activation.frame.body.queueId !== queueId
        || activation.frame.body.runId !== body.identity.runId
        || activation.frame.body.activationId !== body.activation.activationId
        || activation.frame.body.activationDigest !== body.activation.activationDigest
        || activation.frame.body.connectorProfileDigest !== body.connector.profileDigest
        || body.publication.connection.connectionId !== channel.connectionId
        || body.identity.tenantId !== channel.tenantId || body.identity.nodeId !== channel.nodeId
        || body.returnedAt !== now) throw new Error('Codex result return binding unavailable');
      const validUntil = Date.parse(body.physicalQualification.validUntil);
      const expiresAtMs = Math.min(Date.parse(addSeconds(now, 300)), validUntil);
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.parse(now)) {
        throw new Error('Codex result qualification expired');
      }
      const connectionId = channel.connectionId, transport = this.requireTransport();
      const sequence = this.journal.nextOutboundSequence(connectionId);
      const unsigned: UnsignedNodeFrame<'harness.codex.result.return'> = {
        protocol: NODE_PROTOCOL_V1, direction: 'node_to_server', senderKind: 'node',
        tenantId: this.identity.tenantId, actorId: this.identity.nodeId, keyId: this.identity.keyId,
        connectionId, sequence, messageId: `message:${this.idFactory()}`,
        correlationId: `correlation:${body.returnId}`, causationId: body.activation.activationId,
        nonce: randomBytes(24).toString('base64url'), sentAt: now,
        expiresAt: new Date(expiresAtMs).toISOString(), type: 'harness.codex.result.return', body,
      };
      const unsignedDigest = sha256Digest(unsigned);
      const signed = await this.signer.sign(unsigned);
      const assertSendCurrent = () => {
        channel.assertCurrent();
        if (signal.aborted) throw new Error('Codex result return operation unavailable');
        const fresh = currentTime();
        const freshMs = Date.parse(fresh);
        if (!Number.isFinite(freshMs) || new Date(freshMs).toISOString() !== fresh
          || freshMs < Date.parse(now) || freshMs >= expiresAtMs) {
          throw new Error('Codex result qualification expired');
        }
        return fresh;
      };
      const preparedAt = assertSendCurrent();
      const frame = signedNodeFrameSchema.parse(signed);
      if (frame.type !== 'harness.codex.result.return') throw new Error('Codex result signer type changed');
      const { signature, bodyDigest, ...signedMaterial } = frame;
      if (!signature || bodyDigest !== sha256Digest(body) || sha256Digest(signedMaterial) !== unsignedDigest
        || Buffer.byteLength(JSON.stringify(frame), 'utf8') > channel.maxFrameBytes) {
        throw new Error('Codex result signer changed the prepared frame');
      }
      const resultFrame = frame as CodexResultReturnFrameV1;
      this.journal.prepareCodexResultReturn(resultFrame, activation.frame, preparedAt, channel.assertCurrent);
      const sentAt = assertSendCurrent();
      // This is intentionally before send. A write to the transport is not an
      // observable exactly-once boundary; durable uncertainty must win.
      this.journal.markCodexResultReturnSent(resultFrame.messageId, sentAt);
      let resolveReceipt!: (receipt: CodexResultReturnReceiptFrameV1) => void;
      let rejectReceipt!: (error: Error) => void;
      const receipt = new Promise<CodexResultReturnReceiptFrameV1>((resolve, reject) => {
        resolveReceipt = resolve; rejectReceipt = reject;
      });
      void receipt.catch(() => {});
      this.codexResultWaiter = { messageId: resultFrame.messageId, generation,
        resolve: resolveReceipt, reject: rejectReceipt };
      const abort = () => rejectReceipt(new Error('Codex result return receipt unavailable'));
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, receiptTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (this.codexResultWaiter?.messageId === resultFrame.messageId) this.codexResultWaiter = undefined;
      };
      try {
        assertSendCurrent();
        const write = transport.send(JSON.stringify(resultFrame));
        // A receipt proves that the peer received the frame even if the transport
        // adapter never settles its write promise. The same timeout/abort promise
        // bounds both the write and the receipt wait.
        void write.catch(() => {});
        await Promise.race([write, receipt.then(() => undefined)]);
        channel.assertCurrent();
        return { receipt, channel, cleanup };
      } catch (error) {
        cleanup();
        if (generation === this.connectionGeneration) this.failTransport();
        throw error;
      }
    });
    // Receipt intake may itself need the send queue (for example, an earlier
    // protocol acknowledgement can flush a native snapshot). Keep the single
    // waiter and current-connection fence, but do not hold that queue here.
    try {
      const accepted = await pending.receipt;
      pending.channel.assertCurrent();
      return Object.freeze(structuredClone(accepted));
    } catch (error) {
      if (generation === this.connectionGeneration) this.failTransport();
      throw error;
    } finally { pending.cleanup(); }
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
    this.codexAdmissionWaiter?.reject(new Error('Codex current-admission connection closed'));
    this.codexAdmissionWaiter = undefined;
    this.codexResultWaiter?.reject(new Error('Codex result return connection closed'));
    this.codexResultWaiter = undefined;
    this.connectionGeneration += 1;
    this.connectionReconciled = false;
    const transport = this.transport;
    this.transport = undefined;
    this.transportIdentity = undefined;
    this.statusValue = { state: "stopped", reconnectAttempt: 0 };
    if (transport) await transport.close();
  }

  async disconnected(): Promise<number> {
    this.codexAdmissionWaiter?.reject(new Error('Codex current-admission connection disconnected'));
    this.codexAdmissionWaiter = undefined;
    this.codexResultWaiter?.reject(new Error('Codex result return connection disconnected'));
    this.codexResultWaiter = undefined;
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
        || pending.frame.type === 'harness.codex.dispatch.receipt'
        || pending.frame.type === "controller.worker.delivery.receipt"
        || pending.frame.type === "controller.worker.delivery.receipt.recovery"
        || pending.frame.type === 'harness.codex.result.return'
        || pending.frame.type === "harness.codex.current-admission.read") continue;
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
      || type === "controller.worker.delivery.receipt"
      || type === "controller.worker.delivery.receipt.recovery"
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
    this.codexAdmissionWaiter?.reject(new Error('Codex current-admission transport unavailable'));
    this.codexAdmissionWaiter = undefined;
    this.codexResultWaiter?.reject(new Error('Codex result return transport unavailable'));
    this.codexResultWaiter = undefined;
    this.connectionGeneration += 1;
    this.connectionReconciled = false;
    const reconnectAttempt = this.statusValue.reconnectAttempt + 1;
    this.statusValue = { state: "backing_off", reconnectAttempt, lastSafeErrorCode: "transport_unavailable" };
  }
}
