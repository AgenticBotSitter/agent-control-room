import { types } from "node:util";
import { isRepositorySimulationDatabaseClientV1, type DatabaseClient } from "../../persistence/database";
import { ServerNodeSession, type ControllerWorkerResultReturnFrameV1 } from "../../node-control/server-node-session";
import { bindTaskExecutionPlannerReadInSessionV1, TaskExecutionPlanner } from "../../web/v1/task-execution-planner";
import { isPrivatePgDatabaseClientV1 } from "../../web/v1/private-pg-database";
import { sha256Digest } from "../../security/canonical-digest";
import { readControllerWorkerDeliveryReceiptV1 } from "./controller-worker-delivery-receipt-store";
import { CONTROLLER_WORKER_PROGRESS_RETURN_V1 } from "./controller-worker-result-return";
import { RemoteControllerWorkerMaterializerV1,
  type RemoteControllerWorkerMaterializationReferenceV1 } from "./remote-controller-worker-materializer";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  remoteWorkerEnrollmentSchemaV1, type RemoteWorkerEnrollmentV1 } from "./remote-worker-delivery";
import { readCurrentRemoteWorkerEnrollmentV1 } from "./remote-worker-enrollment-store";

export const PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1 =
  "control-room.private-remote-controller-worker-composition/v1" as const;

const digest = /^sha256:[a-f0-9]{64}$/;
const unavailable = (): never => { throw new Error("private_remote_controller_worker_composition_unavailable"); };
const sessionMethods = ["controllerWorkerDeliveryChannel", "controllerWorkerSessionBinding",
  "stageControllerWorkerDelivery", "sendPreparedControllerWorkerDelivery",
  "acceptControllerWorkerDeliveryReceipt", "recoverControllerWorkerDeliveryReceipt",
  "receiveControllerWorkerResultReturn"] as const;
const sessionChannel = ServerNodeSession.prototype.controllerWorkerDeliveryChannel;
const sessionBinding = ServerNodeSession.prototype.controllerWorkerSessionBinding;
const sessionStage = ServerNodeSession.prototype.stageControllerWorkerDelivery;
const sessionSend = ServerNodeSession.prototype.sendPreparedControllerWorkerDelivery;
const sessionAccept = ServerNodeSession.prototype.acceptControllerWorkerDeliveryReceipt;
const sessionRecover = ServerNodeSession.prototype.recoverControllerWorkerDeliveryReceipt;
const sessionReceiveResult = ServerNodeSession.prototype.receiveControllerWorkerResultReturn;

function isConcreteDatabaseClient(value: unknown): value is DatabaseClient {
  return isPrivatePgDatabaseClientV1(value) || isRepositorySimulationDatabaseClientV1(value);
}

function isExactInstalledSession(value: unknown): value is ServerNodeSession {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && Object.getPrototypeOf(value) === ServerNodeSession.prototype
    && sessionMethods.every(name => Object.getOwnPropertyDescriptor(value, name) === undefined);
}

type Composition = Readonly<{
  schema: typeof PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1;
  materializer: Readonly<Pick<RemoteControllerWorkerMaterializerV1, "prepare" | "transmit">>;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const compositions = new WeakSet<object>();
const receiptIntakes = new WeakMap<object, Readonly<{
  accept(raw: string | Uint8Array): Promise<unknown>;
  recover(raw: string | Uint8Array): Promise<unknown>;
}>>();
const resultIntakes = new WeakMap<object, Readonly<{
  receive(raw: string | Uint8Array): Promise<unknown>;
}>>();

/**
 * The only remote-delivery value that may cross from the installed remote
 * composition into generic operator assembly.  It deliberately carries no
 * session, enrollment, resolver, receipt intake, or execution authority.
 */
export type PrivateRemoteControllerWorkerQueueCapabilityV1 = Readonly<{
  materializer: Readonly<Pick<RemoteControllerWorkerMaterializerV1, "prepare" | "transmit">>;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const queueCapabilities = new WeakSet<object>();

/**
 * One opaque, installed-session-only receipt ingress.  It intentionally has
 * no materialization reference, session, timestamp, resolver, or queue API:
 * those are captured from the exact branded composition and its protected
 * pending delivery state.  It remains receipt-only and cannot execute work.
 */
export type PrivateRemoteControllerWorkerReceiptIngressCapabilityV1 = Readonly<{
  accept(raw: string | Uint8Array): Promise<unknown>;
  recover(raw: string | Uint8Array): Promise<unknown>;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const receiptIngressCapabilities = new WeakSet<object>();
const capturedReceiptIngresses = new WeakSet<object>();

/**
 * Branded installed-only generic result ingress. Its one method returns
 * authenticated inert evidence, never a canonical task result or lifecycle
 * transition. A reviewed publisher remains a separate missing authority.
 */
export type PrivateRemoteControllerWorkerResultIngressCapabilityV1 = Readonly<{
  receive(raw: string | Uint8Array): Promise<unknown>;
  startsWork: false;
  grantsExecutionAuthority: false;
  permitsRetry: false;
  publishesResult: false;
}>;

const resultIngressCapabilities = new WeakSet<object>();
const capturedResultIngresses = new WeakSet<object>();

/**
 * Installation-owned current enrollment fence. Identity and adapter revision
 * are immutable; the only state transition is enrolled -> revoked. The live
 * installer must drive that transition from its protected canonical
 * enrollment source before it releases or replaces an enrolled session.
 */
export class PrivateRemoteControllerWorkerEnrollmentStateV1 {
  readonly #identity: Readonly<{ workerId: string; adapterId: string; adapterRevision: string; enrollmentId: string }>;
  #current: RemoteWorkerEnrollmentV1;
  constructor(value: unknown) {
    const enrollment = remoteWorkerEnrollmentSchemaV1.parse(value);
    if (enrollment.state !== "enrolled" || enrollment.adapterId !== CONTROLLER_WORKER_REMOTE_ADAPTER_V1) unavailable();
    this.#identity = Object.freeze({ workerId: enrollment.workerId, adapterId: enrollment.adapterId,
      adapterRevision: enrollment.adapterRevision, enrollmentId: enrollment.enrollmentId });
    this.#current = Object.freeze(structuredClone(enrollment));
    Object.freeze(this);
  }
  current(): RemoteWorkerEnrollmentV1 { return this.#current; }
  revoke(value: unknown): void {
    const next = remoteWorkerEnrollmentSchemaV1.parse(value), identity = this.#identity;
    if (this.#current.state !== "enrolled" || next.state !== "revoked"
      || next.workerId !== identity.workerId || next.adapterId !== identity.adapterId
      || next.adapterRevision !== identity.adapterRevision || next.enrollmentId !== identity.enrollmentId
      || next.enrolledAt !== this.#current.enrolledAt || next.revokedAt === null) unavailable();
    this.#current = Object.freeze(structuredClone(next));
  }
}

/**
 * Binds one current, authenticated signed-node session to the existing
 * canonical remote materializer and PostgreSQL receipt store.  This is an
 * installation composition, not a browser or task-plan factory: callers
 * cannot choose an endpoint, worker, enrollment, session, or receipt target.
 *
 * A reconnect creates a new composition around the replacement
 * `ServerNodeSession`.  The old composition then fails its captured channel
 * fence.  Receipt recovery still loads the original signed dispatch from the
 * existing canonical intent and never sends the task again.
 */
export function createPrivateRemoteControllerWorkerCompositionV1(value: {
  db: DatabaseClient;
  planner: TaskExecutionPlanner;
  integrityKey: Uint8Array;
  tenantId: string;
  nodeId: string;
  connectorProfileDigest: string;
  capabilityDigest: string;
  releaseBindingDigest: string;
  enrollmentState: PrivateRemoteControllerWorkerEnrollmentStateV1;
  supportedAdapterRevisions: readonly string[];
  workerId: string;
  session: ServerNodeSession;
  clock?: () => number;
}): Composition {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value)
      || !isConcreteDatabaseClient(value.db)
      || !(value.integrityKey instanceof Uint8Array) || value.integrityKey.length !== 32
      || !isExactInstalledSession(value.session)
      || !(value.enrollmentState instanceof PrivateRemoteControllerWorkerEnrollmentStateV1)
      || types.isProxy(value.enrollmentState)
      || Object.getPrototypeOf(value.enrollmentState) !== PrivateRemoteControllerWorkerEnrollmentStateV1.prototype
      || typeof value.clock !== "undefined" && typeof value.clock !== "function"
      || !digest.test(value.connectorProfileDigest)
      || !digest.test(value.capabilityDigest) || !digest.test(value.releaseBindingDigest)
      || !Array.isArray(value.supportedAdapterRevisions)
      || value.supportedAdapterRevisions.length < 1 || value.supportedAdapterRevisions.length > 32
      || value.supportedAdapterRevisions.some(revision => typeof revision !== "string"
        || revision.length < 7 || revision.length > 180)
      || new Set(value.supportedAdapterRevisions).size !== value.supportedAdapterRevisions.length) unavailable();
    const enrollmentCurrent = value.enrollmentState.current.bind(value.enrollmentState);
    const enrollment = remoteWorkerEnrollmentSchemaV1.parse(enrollmentCurrent());
    if (enrollment.state !== "enrolled" || enrollment.workerId !== value.workerId
      || enrollment.adapterId !== CONTROLLER_WORKER_REMOTE_ADAPTER_V1
      || !value.supportedAdapterRevisions.includes(enrollment.adapterRevision)) unavailable();
    const session = value.session;
    const channelFor = sessionChannel.bind(session);
    const bindingFor = sessionBinding.bind(session);
    const stage = sessionStage.bind(session);
    const send = sessionSend.bind(session);
    const accept = sessionAccept.bind(session);
    const recover = sessionRecover.bind(session);
    const receiveResult = sessionReceiveResult.bind(session);
    const channel = channelFor() ?? unavailable();
    channel.assertCurrent();
    if (channel.tenantId !== value.tenantId || channel.nodeId !== value.nodeId
      || channel.grantsExecutionAuthority !== false) unavailable();

    const db = value.db;
    const planner = bindTaskExecutionPlannerReadInSessionV1(value.planner, db) ?? unavailable();
    const integrityKey = Uint8Array.from(value.integrityKey), tenantId = value.tenantId,
      nodeId = value.nodeId, workerId = value.workerId,
      connectorProfileDigest = value.connectorProfileDigest,
      capabilityDigest = value.capabilityDigest, releaseBindingDigest = value.releaseBindingDigest,
      supportedAdapterRevisions = Object.freeze([...value.supportedAdapterRevisions]);
    const enrollmentSnapshot = Object.freeze(structuredClone(enrollment));
    const boundConnectionId = channel.connectionId, boundNodeKeyId = channel.nodeKeyId;
    const boundSession = Object.freeze({ controllerWorkerDeliveryChannel: channelFor,
      stageControllerWorkerDelivery: stage, sendPreparedControllerWorkerDelivery: send,
      acceptControllerWorkerDeliveryReceipt: accept, recoverControllerWorkerDeliveryReceipt: recover });
    const assertSessionCurrent = () => {
      const current = bindingFor() ?? unavailable();
      const currentEnrollment = enrollmentCurrent();
      current.assertCurrent();
      if (current.tenantId !== tenantId || current.nodeId !== nodeId
        || current.nodeKeyId !== boundNodeKeyId || current.connectionId !== boundConnectionId
        || current.grantsExecutionAuthority !== false || currentEnrollment.state !== "enrolled"
        || currentEnrollment.enrollmentDigest !== enrollmentSnapshot.enrollmentDigest) unavailable();
    };
    const resolver = Object.freeze({ async resolve(request: {
      tenantId: string; nodeId: string; adapterId: string; requiredCapability: string; connectorProfileDigest: string;
    }) {
      assertSessionCurrent();
      if (request.tenantId !== tenantId || request.nodeId !== nodeId
        || request.adapterId !== CONTROLLER_WORKER_REMOTE_ADAPTER_V1
        || request.requiredCapability !== CONTROLLER_WORKER_REMOTE_CAPABILITY_V1
        || request.connectorProfileDigest !== connectorProfileDigest) unavailable();
      return Object.freeze({ nodeId, workerId, adapterId: enrollmentSnapshot.adapterId,
        adapterRevision: enrollmentSnapshot.adapterRevision, enrollment: enrollmentSnapshot,
        enrollmentAuthority: Object.freeze({ nodeKeyId: boundNodeKeyId, capabilityDigest, releaseBindingDigest }),
        supportedAdapterRevisions, session: Object.freeze({ workerId,
          enrollmentDigest: enrollmentSnapshot.enrollmentDigest, session: boundSession }) });
    } });
    const materializer = new RemoteControllerWorkerMaterializerV1(db, planner, resolver,
      integrityKey, value.clock ?? Date.now);
    let pendingReference: RemoteControllerWorkerMaterializationReferenceV1 | undefined;
    const capturePendingReference = (reference: RemoteControllerWorkerMaterializationReferenceV1) => {
      const next = Object.freeze({ ...reference });
      if (pendingReference && sha256Digest(pendingReference) !== sha256Digest(next)) unavailable();
      pendingReference = next;
    };
    // Only canonical materializer methods may establish pending receipt state.
    // The eventual ingress never receives this locator from its caller.
    const queue = Object.freeze({
      async prepare(reference: RemoteControllerWorkerMaterializationReferenceV1) {
        const prepared = await materializer.prepare(reference);
        capturePendingReference(reference);
        return prepared;
      },
      async transmit(reference: RemoteControllerWorkerMaterializationReferenceV1, prepared: unknown, signal?: AbortSignal) {
        capturePendingReference(reference);
        return materializer.transmit(reference, prepared, signal);
      },
    });
    // The receipt API deliberately reconstructs the exact prepared packet
    // from canonical records.  No caller-supplied prepared object can redirect
    // intake to another node/session/delivery.
    let receiptUse: "accept" | "recover" | undefined;
    const receiptIntake = Object.freeze({
      async accept(raw: string | Uint8Array) {
        if (receiptUse) unavailable(); receiptUse = "accept";
        const reference = pendingReference ?? unavailable();
        assertSessionCurrent();
        const prepared = await materializer.prepare(reference);
        assertSessionCurrent();
        return materializer.acceptReceipt(reference, prepared, raw, new Date((value.clock ?? Date.now)()).toISOString());
      },
      async recover(raw: string | Uint8Array) {
        if (receiptUse) unavailable(); receiptUse = "recover";
        const reference = pendingReference ?? unavailable();
        assertSessionCurrent();
        const prepared = await materializer.prepare(reference);
        assertSessionCurrent();
        return materializer.recoverReceipt(reference, prepared, raw, new Date((value.clock ?? Date.now)()).toISOString());
      },
    });
    let lastResultSequence = 0;
    let lastProgressPercent = 0;
    let terminalReturnDigest: string | undefined;
    const resultIntake = Object.freeze({
      async receive(raw: string | Uint8Array) {
        const reference = pendingReference ?? unavailable();
        assertSessionCurrent();
        return receiveResult(raw, async (frame: ControllerWorkerResultReturnFrameV1, resultChannel) => {
          resultChannel.assertCurrent();
          assertSessionCurrent();
          const body = frame.body;
          const result = await db.transaction(async tx => {
            await readCurrentRemoteWorkerEnrollmentV1(tx, integrityKey, {
              tenantId, workerId, nodeId, nodeKeyId: boundNodeKeyId,
              adapterId: enrollmentSnapshot.adapterId, adapterRevision: enrollmentSnapshot.adapterRevision,
              capabilityDigest, enrollmentId: enrollmentSnapshot.enrollmentId,
              enrollmentDigest: enrollmentSnapshot.enrollmentDigest, releaseBindingDigest,
              now: new Date((value.clock ?? Date.now)()).toISOString(),
            });
            const canonical = await readControllerWorkerDeliveryReceiptV1(tx, integrityKey, reference);
            if (!canonical || canonical.receipt.disposition === "rejected"
              || sha256Digest(canonical.receipt) !== sha256Digest(body.deliveryReceipt)
              || body.deliveryReceipt.receiptDigest !== canonical.receipt.receiptDigest
              || body.deliveryReceipt.deliveryId !== canonical.delivery.deliveryId
              || body.deliveryReceipt.deliveryDigest !== canonical.delivery.deliveryDigest
              || body.identity.tenantId !== canonical.delivery.identity.tenantId
              || body.identity.projectId !== canonical.delivery.identity.projectId
              || body.identity.jobId !== canonical.delivery.identity.jobId
              || body.identity.attemptId !== canonical.delivery.identity.attemptId
              || body.identity.runId !== canonical.delivery.identity.runId
              || body.identity.nodeId !== canonical.delivery.identity.nodeId
              || body.identity.workerId !== canonical.delivery.worker.workerId
              || body.enrollmentDigest !== enrollmentSnapshot.enrollmentDigest
              || body.connectionId !== resultChannel.connectionId
              || resultChannel.tenantId !== tenantId || resultChannel.nodeId !== nodeId
              || resultChannel.nodeKeyId !== boundNodeKeyId
              || Date.parse(body.occurredAt) < Date.parse(canonical.receipt.receivedAt)) unavailable();
            if (body.schema === CONTROLLER_WORKER_PROGRESS_RETURN_V1) {
              if (terminalReturnDigest || body.sequence !== lastResultSequence + 1 || body.progressPercent < lastProgressPercent) unavailable();
              lastResultSequence = body.sequence;
              lastProgressPercent = body.progressPercent;
              return Object.freeze({ kind: "progress" as const, sequence: body.sequence,
                eventDigest: body.returnDigest, replayed: false as const });
            }
            if (terminalReturnDigest) {
              if (terminalReturnDigest !== body.returnDigest || body.sequence !== lastResultSequence) unavailable();
              return Object.freeze({ kind: "terminal" as const, sequence: body.sequence,
                eventDigest: body.returnDigest, replayed: true as const });
            }
            if (body.sequence !== lastResultSequence + 1) unavailable();
            lastResultSequence = body.sequence;
            terminalReturnDigest = body.returnDigest;
            return Object.freeze({ kind: "terminal" as const, sequence: body.sequence,
              eventDigest: body.returnDigest, replayed: false as const });
          });
          assertSessionCurrent();
          resultChannel.assertCurrent();
          return Object.freeze({ ...result, authenticated: true as const, recordsCompletion: false as const,
            releasesCapacity: false as const, permitsRetry: false as const, publishesResult: false as const,
            startsWork: false as const, grantsExecutionAuthority: false as const });
        });
      },
    });
    const composition = Object.freeze({ schema: PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1,
      materializer: queue, startsWork: false as const, grantsExecutionAuthority: false as const });
    compositions.add(composition);
    receiptIntakes.set(composition, receiptIntake);
    resultIntakes.set(composition, resultIntake);
    return composition;
  } catch { return unavailable(); }
}

/** Generic startup may accept only this module-private installed composition. */
export function isPrivateRemoteControllerWorkerCompositionV1(value: unknown): value is Composition {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && (value as { schema?: unknown }).schema === PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1
    && compositions.has(value as object);
}

/**
 * Source-only custody adapter for generic operator assembly.  A caller must
 * first hold this module's installed composition brand; structural objects,
 * proxies, and copied compositions cannot manufacture a queue capability.
 * The returned value retains only bound prepare/transmit methods and is inert.
 */
export function capturePrivateRemoteControllerWorkerQueueCapabilityV1(value: unknown):
PrivateRemoteControllerWorkerQueueCapabilityV1 {
  const composition = isPrivateRemoteControllerWorkerCompositionV1(value) ? value : unavailable();
  const materializer = composition.materializer;
  const capability = Object.freeze({ materializer: Object.freeze({
    prepare: materializer.prepare.bind(materializer),
    transmit: materializer.transmit.bind(materializer),
  }), startsWork: false as const, grantsExecutionAuthority: false as const });
  queueCapabilities.add(capability);
  return capability;
}

/** Generic startup accepts only a capability minted by the adapter above. */
export function isPrivateRemoteControllerWorkerQueueCapabilityV1(value: unknown):
value is PrivateRemoteControllerWorkerQueueCapabilityV1 {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && queueCapabilities.has(value as object)
    && (value as { startsWork?: unknown }).startsWork === false
    && (value as { grantsExecutionAuthority?: unknown }).grantsExecutionAuthority === false;
}

/**
 * Release the separately branded ingress exactly once for an exact installed
 * composition.  Generic queue assembly cannot obtain it, and a copied,
 * proxied, replayed, or replacement-session composition cannot manufacture it.
 */
export function capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(value: unknown):
PrivateRemoteControllerWorkerReceiptIngressCapabilityV1 {
  const composition = isPrivateRemoteControllerWorkerCompositionV1(value) ? value : unavailable();
  if (capturedReceiptIngresses.has(composition)) unavailable();
  const intake = receiptIntakes.get(composition) ?? unavailable();
  capturedReceiptIngresses.add(composition);
  const capability = Object.freeze({ accept: intake.accept.bind(intake), recover: intake.recover.bind(intake),
    startsWork: false as const, grantsExecutionAuthority: false as const });
  receiptIngressCapabilities.add(capability);
  return capability;
}

/** Installed frame mounting accepts only the exact capability above. */
export function isPrivateRemoteControllerWorkerReceiptIngressCapabilityV1(value: unknown):
value is PrivateRemoteControllerWorkerReceiptIngressCapabilityV1 {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && receiptIngressCapabilities.has(value as object)
    && (value as { startsWork?: unknown }).startsWork === false
    && (value as { grantsExecutionAuthority?: unknown }).grantsExecutionAuthority === false;
}

/**
 * Mint one receiver for the exact installed composition. The receiver checks
 * its own branded `this`, so detached methods, structural copies and proxies
 * cannot reuse its captured authority.
 */
export function capturePrivateRemoteControllerWorkerResultIngressCapabilityV1(value: unknown):
PrivateRemoteControllerWorkerResultIngressCapabilityV1 {
  const composition = isPrivateRemoteControllerWorkerCompositionV1(value) ? value : unavailable();
  if (capturedResultIngresses.has(composition)) unavailable();
  const intake = resultIntakes.get(composition) ?? unavailable();
  capturedResultIngresses.add(composition);
  const capability: PrivateRemoteControllerWorkerResultIngressCapabilityV1 = Object.freeze({
    async receive(this: object, raw: string | Uint8Array) {
      if (!resultIngressCapabilities.has(this)) unavailable();
      return intake.receive(raw);
    },
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, publishesResult: false as const,
  });
  resultIngressCapabilities.add(capability);
  return capability;
}

/** Generic installation assembly accepts only the exact receiver above. */
export function isPrivateRemoteControllerWorkerResultIngressCapabilityV1(value: unknown):
value is PrivateRemoteControllerWorkerResultIngressCapabilityV1 {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && resultIngressCapabilities.has(value as object)
    && (value as { startsWork?: unknown }).startsWork === false
    && (value as { grantsExecutionAuthority?: unknown }).grantsExecutionAuthority === false
    && (value as { permitsRetry?: unknown }).permitsRetry === false
    && (value as { publishesResult?: unknown }).publishesResult === false;
}

/** Stable non-secret identity for sanitized installation/readiness evidence. */
export function privateRemoteControllerWorkerCompositionDigestV1(value: unknown): string {
  if (!isPrivateRemoteControllerWorkerCompositionV1(value)) unavailable();
  return sha256Digest({ schema: PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1,
    startsWork: false, grantsExecutionAuthority: false });
}
