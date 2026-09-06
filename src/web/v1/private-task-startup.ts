import { assertNoSecretMaterial } from "../../security";
import { localId } from "../../harness/v1/native-run-identifiers";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase, verifyNativeResultDatabase, verifyNativeEvidenceDatabase, verifyNativeSessionDatabase } from "./private-database-preflight";
import { validatePrivateStartupConfiguration, type PrivateStartupConfiguration } from "./private-startup";
import { installPrivateApplication } from "./private-process";
import { createPrivateTaskApplication } from "./private-task-application";
import { nativeTaskTemplateSchema } from "./task-execution-planner";
import { validateTaskAssignmentRoutes, validateNativeApprovalEnrollments } from "./task-assignment-coordinator";
import type { TaskCoordinatorConfiguration, TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";
import { captureTaskQualityConfiguration, validateTaskQualityKeys } from "./task-quality-coordinator";
import { captureNativeEvidenceSettings, type NativeEvidenceSettings } from "./native-evidence-receiver";
import { timingSafeEqual } from "node:crypto";
import { captureManagedNativeSessionSettings, type ManagedNativeSessionSettings } from "./managed-native-sessions";
import { captureNativeHttpSettings } from "./native-http-host";
import type { DatabaseSession } from "../../persistence/database";
import type { NativeTaskSubmission } from "../../persistence/native-task-submission";
import { composePrivateTaskWorkerApplication } from "./private-task-worker-application";
import type { NativeQueueWorkerStartupConfiguration } from "./native-queue-worker-startup";

type OwnedQueueWorker = { close(): Promise<void>; status(): { accepting: boolean } };

export type PrivateTaskStartupConfiguration = {
  web: PrivateStartupConfiguration;
  coordinator: Pick<TaskCoordinatorConfiguration, "planning" | "routes" | "approvals" | "quality" | "revisionPlanning" | "nativeHttp"> & {
    nativeQueue?: true;
    nativeQueueRecovery?: true;
    /** Explicit local composition; no default worker factory or deployment activation. */
    queueWorker?: { database: PrivatePostgresConfiguration; concurrency?: number };
    database: PrivatePostgresConfiguration; resultDatabase?: PrivatePostgresConfiguration;
    evidence?: NativeEvidenceSettings & { database: PrivatePostgresConfiguration };
    sessions?: ManagedNativeSessionSettings & { database: PrivatePostgresConfiguration } };
};
function configuration(input: PrivateTaskStartupConfiguration) {
  try {
    const web = validatePrivateStartupConfiguration(input.web);
    localId.parse(web.tenantId); localId.parse(web.workspaceId);
    const database = validatePrivatePostgresConfiguration(input.coordinator.database);
    if (database.host !== web.database.host || database.port !== web.database.port || database.database !== web.database.database
      || database.username === web.database.username) throw new Error();
    const key = (value: Uint8Array) => { if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(); return Uint8Array.from(value); };
    const p = input.coordinator.planning, template = nativeTaskTemplateSchema.parse(p.template);
    assertNoSecretMaterial(template);
    const read = p.checkpoints.read.bind(p.checkpoints);
    const denied = (): never => { throw new Error("private_task_checkpoint_write_denied"); };
    const planning = { template, integrityKey: key(p.integrityKey), reviewIntegrityKey: key(p.reviewIntegrityKey),
      checkpoints: Object.freeze({ read, initialize: denied, advance: denied }),
      ...(p.ideaIntegrityKey ? { ideaIntegrityKey: key(p.ideaIntegrityKey) } : {}) };
    const routes = validateTaskAssignmentRoutes(input.coordinator.routes), a = input.coordinator.approvals;
    if (a && (typeof a.store?.acceptInSession !== "function" || typeof a.store?.readInSession !== "function")) throw new Error();
    const approvals = a ? { enrollments: validateNativeApprovalEnrollments(a.enrollments, web.tenantId, routes), store: a.store } : undefined;
    const nativeQueue = input.coordinator.nativeQueue;
    if (nativeQueue !== undefined && (nativeQueue !== true || !approvals)) throw new Error();
    const nativeQueueRecovery = input.coordinator.nativeQueueRecovery;
    if (nativeQueueRecovery !== undefined && (nativeQueueRecovery !== true || !nativeQueue)) throw new Error();
    const quality = input.coordinator.quality ? captureTaskQualityConfiguration(input.coordinator.quality) : undefined;
    if (quality) validateTaskQualityKeys(quality, planning.reviewIntegrityKey, web.tasks);
    const resultDatabase = input.coordinator.resultDatabase ? validatePrivatePostgresConfiguration(input.coordinator.resultDatabase) : undefined;
    if (resultDatabase && (!quality || resultDatabase.host !== database.host || resultDatabase.port !== database.port
      || resultDatabase.database !== database.database || [database.username, web.database.username].includes(resultDatabase.username))) throw new Error();
    const e = input.coordinator.evidence;
    const evidence = e ? { ...captureNativeEvidenceSettings(e), database: validatePrivatePostgresConfiguration(e.database) } : undefined;
    if (evidence && (!quality || !resultDatabase || evidence.database.host !== database.host || evidence.database.port !== database.port
      || evidence.database.database !== database.database || [database.username, web.database.username, resultDatabase.username].includes(evidence.database.username)
      || evidence.storage.storageClass !== quality.results.storageClass || !timingSafeEqual(evidence.storage.integrityKey, quality.results.integrityKey)
      || evidence.enrollments.some(value => value.tenantId !== web.tenantId)
      || new Set(evidence.enrollments.map(value => value.nodeId)).size !== evidence.enrollments.length)) throw new Error();
    const revisionPlanning = input.coordinator.revisionPlanning;
    if (revisionPlanning !== undefined && (revisionPlanning !== true || !quality)) throw new Error();
    const s = input.coordinator.sessions;
    const sessions = s ? { ...captureManagedNativeSessionSettings(s), database: validatePrivatePostgresConfiguration(s.database) } : undefined;
    if (sessions && (!evidence || !approvals || typeof approvals.store.receiveDeliveryReceipt !== "function"
      || sessions.database.host !== database.host || sessions.database.port !== database.port || sessions.database.database !== database.database
      || [web.database.username, database.username, resultDatabase!.username, evidence.database.username].includes(sessions.database.username)
      || sessions.nodes.some(node => node.tenantId !== web.tenantId || !evidence.enrollments.some(e => e.nodeId === node.nodeId)))) throw new Error();
    const nativeHttp = input.coordinator.nativeHttp ? captureNativeHttpSettings(input.coordinator.nativeHttp) : undefined;
    if (nativeHttp && (!sessions || nativeHttp.peers.some(peer => !sessions.nodes.some(node => node.nodeId === peer.nodeId)))) throw new Error();
    const w = input.coordinator.queueWorker;
    const queueWorker = w ? { database: validatePrivatePostgresConfiguration(w.database), concurrency: w.concurrency ?? 1 } : undefined;
    if (queueWorker && (!nativeQueue || !sessions || queueWorker.database.host !== database.host
      || queueWorker.database.port !== database.port || queueWorker.database.database !== database.database
      || [web.database.username, database.username, resultDatabase!.username, evidence!.database.username, sessions.database.username].includes(queueWorker.database.username)
      || !Number.isSafeInteger(queueWorker.concurrency) || queueWorker.concurrency < 1 || queueWorker.concurrency > 8)) throw new Error();
    return { web, database, planning, routes, approvals, quality, revisionPlanning, resultDatabase, evidence, sessions, nativeHttp, nativeQueue, nativeQueueRecovery, queueWorker };
  } catch { throw new Error("private_task_startup_config_invalid"); }
}

/** Trusted server-only startup. Import is inert; explicit start is the first possible pool effect.
 * All configured logins must pass their independent fixed gates against one primary before mounting.
 * Never opens a listener, provisions SQL or loads credentials. Explicit queueWorker
 * composition can pick up already-approved work; ordinary startup cannot.
 */
export function createPrivateTaskBootstrap(dependencies: {
  openDatabase: (config: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  install: typeof installPrivateApplication; clock?: () => number;
  /** Trusted pinned-package factory; no default implementation or package loading. */
  prepareNativeSubmission?: (db: DatabaseSession) => Promise<NativeTaskSubmission & { close(): Promise<void> }>;
  /** Normally bound to the verified worker bootstrap; never supplied by a request. */
  startNativeWorker?: (config: NativeQueueWorkerStartupConfiguration) => Promise<OwnedQueueWorker>;
}) {
  const prepareSubmission = dependencies.prepareNativeSubmission?.bind(dependencies);
  const startWorker = dependencies.startNativeWorker?.bind(dependencies);
  let started = false;
  return Object.freeze({ async start(input: PrivateTaskStartupConfiguration, signal?: AbortSignal) {
    if (started) throw new Error("private_task_startup_already_attempted");
    started = true;
    if (signal?.aborted) throw new Error("private_task_startup_canceled");
    const config = configuration(input);
    if (config.nativeQueue && !prepareSubmission) throw new Error("private_task_startup_config_invalid");
    if (config.queueWorker && !startWorker) throw new Error("private_task_startup_config_invalid");
    const queue = config.nativeQueue ? { nativeQueue: true as const,
      ...(config.nativeQueueRecovery ? { nativeQueueRecovery: true as const } : {}) } : undefined;
    let submission: (NativeTaskSubmission & { close(): Promise<void> }) | undefined;
    let abandoned = false, preparationUncertain = false;
    const acquired: TaskCoordinatorDatabase[] = [];
    const resources = new Set<TaskCoordinatorDatabase>();
    let application: Awaited<ReturnType<typeof createPrivateTaskApplication>> | undefined;
    let worker: OwnedQueueWorker | undefined;
    let workerUncertain = false;
    const startupAbort = new AbortController();
    const cancelStartup = () => { abandoned = true; startupAbort.abort(); };
    const requireActive = () => { if (abandoned || signal?.aborted) throw new Error("private_task_startup_canceled"); };
    signal?.addEventListener("abort", cancelStartup, { once: true });
    // Own every returned resource immediately; memoized bounded close tolerates construction failure
    // before or after ownership transfers to the combined application, without a second pool close.
    function open(database: PrivatePostgresConfiguration) {
      requireActive();
      const raw = dependencies.openDatabase(database);
      if (resources.has(raw)) throw new Error("private_task_startup_shared_resource");
      resources.add(raw);
      let closing: Promise<void> | undefined;
      const close = raw.close.bind(raw);
      const owned = Object.freeze({ client: raw.client, isAvailable: raw.isAvailable.bind(raw), close: () => {
        closing ??= (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("private_task_startup_cleanup_uncertain")), 5000);
          })]); } finally { clearTimeout(timer); }
        })();
        return closing;
      } });
      acquired.push(owned); requireActive(); return owned;
    }
    try {
      const clock = dependencies.clock ?? Date.now;
      const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error();
      const web = open(config.web.database);
      await verifyPrivateDatabase(web.client, config.web.database, config.web, now, queue);
      requireActive();
      const coordinator = open(config.database);
      if (web.client === coordinator.client) throw new Error();
      await verifyTaskCoordinatorDatabase(coordinator.client, config.database, config.web, now, queue);
      requireActive();
      const resultDatabase = config.resultDatabase ? open(config.resultDatabase) : undefined;
      if (resultDatabase) {
        if ([web.client, coordinator.client].includes(resultDatabase.client)) throw new Error();
        await verifyNativeResultDatabase(resultDatabase.client, config.resultDatabase!, config.web, now, queue);
        requireActive();
      }
      const evidenceDatabase = config.evidence ? open(config.evidence.database) : undefined;
      if (evidenceDatabase) {
        if ([web.client, coordinator.client, resultDatabase!.client].includes(evidenceDatabase.client)) throw new Error();
        await verifyNativeEvidenceDatabase(evidenceDatabase.client, config.evidence!.database, config.web, now, queue);
        requireActive();
      }
      if (!web.isAvailable() || !coordinator.isAvailable() || resultDatabase && !resultDatabase.isAvailable()
        || evidenceDatabase && !evidenceDatabase.isAvailable()) throw new Error();
      const sessionDatabase = config.sessions ? open(config.sessions.database) : undefined;
      if (sessionDatabase) {
        if ([web.client, coordinator.client, resultDatabase!.client, evidenceDatabase!.client].includes(sessionDatabase.client)) throw new Error();
        await verifyNativeSessionDatabase(sessionDatabase.client, config.sessions!.database, config.web, now, queue);
        requireActive();
      }
      if ([web, coordinator, resultDatabase, evidenceDatabase, sessionDatabase].some(pool => pool && !pool.isAvailable())) throw new Error();
      if (queue) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = Promise.resolve().then(() => { requireActive(); return prepareSubmission!({ query: async (sql, values) => {
          if (abandoned || !coordinator.isAvailable()) throw new Error("native_task_submission_unavailable");
          return coordinator.client.query(sql, values);
        } }); }).then(async raw => {
          if (!raw || typeof raw.close !== "function") { preparationUncertain = true; throw new Error(); }
          let closing: Promise<void> | undefined;
          const closeRaw = raw.close.bind(raw);
          const close = () => closing ??= (async () => {
            let closeTimer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([Promise.resolve().then(closeRaw), new Promise<never>((_, reject) => {
              closeTimer = setTimeout(() => reject(new Error("private_task_startup_cleanup_uncertain")), 5000);
            })]); } finally { clearTimeout(closeTimer); }
          })();
          // Acquire cleanup before validating the operation, even for a malformed factory result.
          submission = { enqueueInSession: raw.enqueueInSession?.bind(raw), close };
          if (abandoned || typeof submission.enqueueInSession !== "function") { await close(); throw new Error(); }
          if (config.nativeQueueRecovery) {
            const recover = raw.recoverUnsentInSession;
            if (typeof recover !== "function") { await close(); throw new Error(); }
            submission.recoverUnsentInSession = recover.bind(raw);
          }
          return submission;
        }).catch(error => {
          // A rejected factory may have acquired a client internally; without a
          // returned cleanup handle its disposition cannot be proven here.
          if (!submission) preparationUncertain = true;
          throw error;
        });
        try { await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abandoned = true; preparationUncertain = true; reject(new Error()); }, 5000);
        })]); } finally { clearTimeout(timer); }
      }
      requireActive();
      application = await createPrivateTaskApplication({ ...config.web, database: web, clock }, {
        scope: { tenantId: config.web.tenantId, workspaceId: config.web.workspaceId }, database: coordinator,
        planning: config.planning, routes: config.routes, approvals: config.approvals, quality: config.quality,
        revisionPlanning: config.revisionPlanning, resultDatabase, clock,
        evidence: evidenceDatabase ? { ...config.evidence!, database: evidenceDatabase } : undefined,
        sessions: sessionDatabase ? { ...config.sessions!, database: sessionDatabase } : undefined,
        nativeHttp: config.nativeHttp,
        nativeSubmission: submission,
      });
      requireActive();
      if (!application.isReady()) throw new Error();
      if (config.queueWorker) {
        if (!application.queueDelivery) throw new Error();
        const workerConfig = config.queueWorker, deliver = application.queueDelivery, verifyRecovery = application.queueRecovery?.verify;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = Promise.resolve().then(() => { requireActive(); return startWorker!({ ...workerConfig,
          application: { host: config.database.host, port: config.database.port, database: config.database.database,
            loginNames: [config.web.database.username, config.database.username, config.resultDatabase!.username,
              config.evidence!.database.username, config.sessions!.database.username] },
          deliver: async (reference, signal) => {
            if (abandoned) throw new Error("native_task_delivery_unresolved");
            return deliver(reference, AbortSignal.any([signal, startupAbort.signal]));
          },
          ...(verifyRecovery ? { async verifyRecovery(reference, ordinal, signal) {
            if (abandoned) throw new Error("native_task_delivery_unresolved");
            await verifyRecovery(reference, ordinal, AbortSignal.any([signal, startupAbort.signal]));
            if (abandoned) throw new Error("native_task_delivery_unresolved");
          } } : {}),
        }); }).then(async raw => {
          if (!raw || typeof raw.close !== "function") { workerUncertain = true; throw new Error(); }
          const closeRaw = raw.close.bind(raw); let closing: Promise<void> | undefined;
          const close = () => closing ??= (async () => {
            let closeTimer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([Promise.resolve().then(closeRaw), new Promise<never>((_, reject) => {
              closeTimer = setTimeout(() => reject(new Error()), 5000);
            })]); } finally { clearTimeout(closeTimer); }
          })();
          // Own cleanup before reading other factory members, including getters.
          worker = { close, status: () => ({ accepting: false }) };
          const status = raw.status;
          if (abandoned || typeof status !== "function") { await close(); throw new Error(); }
          worker = Object.freeze({ close, status: status.bind(raw) });
          return worker;
        }).catch(error => { if (!worker) workerUncertain = true; throw error; });
        try { await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abandoned = true; workerUncertain = true; reject(new Error()); }, 30_000);
        })]); } finally { clearTimeout(timer); }
      }
      const installed = worker ? composePrivateTaskWorkerApplication(application, worker) : application;
      requireActive();
      if (!installed.isReady()) throw new Error();
      dependencies.install(installed);
      requireActive();
      // Optional narrow commands reach only trusted server composition, never raw SQL/keys.
      return Object.freeze({ isReady: installed.isReady, close: installed.close,
        ...(application.queueDelivery ? { queueDelivery: application.queueDelivery } : {}),
        ...(application.submission ? { submission: application.submission } : {}),
        ...(application.queueRecovery ? { queueRecovery: application.queueRecovery } : {}),
        ...(application.quality ? { quality: application.quality } : {}),
        ...(application.revisions ? { revisions: application.revisions } : {}),
        ...(application.results ? { results: application.results } : {}),
        ...(application.evidence ? { evidence: application.evidence } : {}),
        ...(application.nativeHttp ? { nativeHttp: application.nativeHttp } : {}),
        ...(application.connections ? { connections: application.connections } : {}) });
    } catch {
      abandoned = true;
      startupAbort.abort();
      const workerCleanup = worker ? await Promise.allSettled([worker.close()]) : [];
      const appCleanup = application ? await Promise.allSettled([application.close()]) : [];
      const producerCleanup = submission ? await Promise.allSettled([submission.close()]) : [];
      const results = application ? [] : await Promise.allSettled(acquired.map(pool => pool.close()));
      if (preparationUncertain || workerUncertain || [...workerCleanup, ...appCleanup, ...producerCleanup, ...results].some(result => result.status === "rejected")) throw new Error("private_task_startup_cleanup_uncertain");
      throw new Error("private_task_startup_prerequisites_failed");
    } finally { signal?.removeEventListener("abort", cancelStartup); }
  } });
}
const production = createPrivateTaskBootstrap({ openDatabase: createPrivatePostgresDatabase, install: installPrivateApplication });
export const startPrivateTaskApplication = production.start;
