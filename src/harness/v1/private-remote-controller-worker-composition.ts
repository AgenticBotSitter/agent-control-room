import { types } from "node:util";
import { isRepositorySimulationDatabaseClientV1, type DatabaseClient } from "../../persistence/database";
import { ServerNodeSession } from "../../node-control/server-node-session";
import { bindTaskExecutionPlannerReadInSessionV1, TaskExecutionPlanner } from "../../web/v1/task-execution-planner";
import { isPrivatePgDatabaseClientV1 } from "../../web/v1/private-pg-database";
import { sha256Digest } from "../../security/canonical-digest";
import { RemoteControllerWorkerMaterializerV1,
  type RemoteControllerWorkerMaterializationReferenceV1 } from "./remote-controller-worker-materializer";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  remoteWorkerEnrollmentSchemaV1, type RemoteWorkerEnrollmentV1 } from "./remote-worker-delivery";

export const PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1 =
  "control-room.private-remote-controller-worker-composition/v1" as const;

const digest = /^sha256:[a-f0-9]{64}$/;
const unavailable = (): never => { throw new Error("private_remote_controller_worker_composition_unavailable"); };
const sessionMethods = ["controllerWorkerDeliveryChannel", "controllerWorkerSessionBinding",
  "stageControllerWorkerDelivery", "sendPreparedControllerWorkerDelivery",
  "acceptControllerWorkerDeliveryReceipt", "recoverControllerWorkerDeliveryReceipt"] as const;
const sessionChannel = ServerNodeSession.prototype.controllerWorkerDeliveryChannel;
const sessionBinding = ServerNodeSession.prototype.controllerWorkerSessionBinding;
const sessionStage = ServerNodeSession.prototype.stageControllerWorkerDelivery;
const sessionSend = ServerNodeSession.prototype.sendPreparedControllerWorkerDelivery;
const sessionAccept = ServerNodeSession.prototype.acceptControllerWorkerDeliveryReceipt;
const sessionRecover = ServerNodeSession.prototype.recoverControllerWorkerDeliveryReceipt;

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
  receiptIntake: Readonly<{
    accept(reference: RemoteControllerWorkerMaterializationReferenceV1,
      raw: string | Uint8Array, recordedAt: unknown): Promise<unknown>;
    recover(reference: RemoteControllerWorkerMaterializationReferenceV1,
      raw: string | Uint8Array, recordedAt: unknown): Promise<unknown>;
  }>;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const compositions = new WeakSet<object>();

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
    const channel = channelFor() ?? unavailable();
    channel.assertCurrent();
    if (channel.tenantId !== value.tenantId || channel.nodeId !== value.nodeId
      || channel.grantsExecutionAuthority !== false) unavailable();

    const db = value.db;
    const planner = bindTaskExecutionPlannerReadInSessionV1(value.planner, db) ?? unavailable();
    const integrityKey = Uint8Array.from(value.integrityKey), tenantId = value.tenantId,
      nodeId = value.nodeId, workerId = value.workerId,
      connectorProfileDigest = value.connectorProfileDigest,
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
        supportedAdapterRevisions, session: Object.freeze({ workerId,
          enrollmentDigest: enrollmentSnapshot.enrollmentDigest, session: boundSession }) });
    } });
    const materializer = new RemoteControllerWorkerMaterializerV1(db, planner, resolver,
      integrityKey, value.clock ?? Date.now);
    const queue = Object.freeze({
      prepare: materializer.prepare.bind(materializer),
      transmit: materializer.transmit.bind(materializer),
    });
    // The receipt API deliberately reconstructs the exact prepared packet
    // from canonical records.  No caller-supplied prepared object can redirect
    // intake to another node/session/delivery.
    const receiptIntake = Object.freeze({
      async accept(reference: RemoteControllerWorkerMaterializationReferenceV1,
        raw: string | Uint8Array, recordedAt: unknown) {
        assertSessionCurrent();
        const prepared = await materializer.prepare(reference);
        assertSessionCurrent();
        return materializer.acceptReceipt(reference, prepared, raw, recordedAt);
      },
      async recover(reference: RemoteControllerWorkerMaterializationReferenceV1,
        raw: string | Uint8Array, recordedAt: unknown) {
        assertSessionCurrent();
        const prepared = await materializer.prepare(reference);
        assertSessionCurrent();
        return materializer.recoverReceipt(reference, prepared, raw, recordedAt);
      },
    });
    const composition = Object.freeze({ schema: PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1,
      materializer: queue, receiptIntake, startsWork: false as const, grantsExecutionAuthority: false as const });
    compositions.add(composition);
    return composition;
  } catch { return unavailable(); }
}

/** Generic startup may accept only this module-private installed composition. */
export function isPrivateRemoteControllerWorkerCompositionV1(value: unknown): value is Composition {
  return !!value && typeof value === "object" && !types.isProxy(value)
    && (value as { schema?: unknown }).schema === PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1
    && compositions.has(value as object);
}

/** Stable non-secret identity for sanitized installation/readiness evidence. */
export function privateRemoteControllerWorkerCompositionDigestV1(value: unknown): string {
  if (!isPrivateRemoteControllerWorkerCompositionV1(value)) unavailable();
  return sha256Digest({ schema: PRIVATE_REMOTE_CONTROLLER_WORKER_COMPOSITION_V1,
    startsWork: false, grantsExecutionAuthority: false });
}
