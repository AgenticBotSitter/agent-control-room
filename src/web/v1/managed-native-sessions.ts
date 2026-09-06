import { z } from "zod";
import { ServerNodeSession, captureServerNodeSessionConfig, type ServerNodeSessionConfig, type ServerNodeSessionPorts } from "../../node-control/server-node-session";
import { DatabaseNodeKeyResolver, DatabaseReplayGuard, FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator } from "../../node-protocol/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import type { VerifiedWebIdentity } from "./access-verifier";
import type { TaskAssignmentCoordinator } from "./task-assignment-coordinator";
import type { NativeApprovalPacketStore } from "./native-approval-packet-store";
import type { NativeEvidenceReceiver } from "./native-evidence-receiver";
import { captureNativeEvidenceInput, nativeEvidenceRegistrationSchema } from "./native-evidence-receiver";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";

export type ManagedNativeSessionSettings = {
  nodes: readonly ServerNodeSessionConfig[];
  sign: ServerNodeSessionPorts["sign"];
};
export function captureManagedNativeSessionSettings(input: ManagedNativeSessionSettings) {
  if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 32 || typeof input.sign !== "function")
    throw new Error("native_sessions_config_invalid");
  const nodes = input.nodes.map(captureServerNodeSessionConfig);
  if (new Set(nodes.map(node => node.nodeId)).size !== nodes.length) throw new Error("native_sessions_config_invalid");
  return Object.freeze({ nodes, sign: input.sign.bind(input) });
}
export type NativeSessionTransport = { send(raw: string): Promise<void>; close(): Promise<void>; isAvailable(): boolean };
const taskSchema = z.object({ projectId: localId, jobId: localId, inputDigest: digestSchema, packetDigest: digestSchema }).strict();
type Task = z.infer<typeof taskSchema>;
type Routes = {
  stage: TaskAssignmentCoordinator["stageQueuedNativeDelivery"];
  transmit: TaskAssignmentCoordinator["transmitQueuedNativeDelivery"];
  receipt: (session: ServerNodeSession, raw: string | Uint8Array, signal: AbortSignal) => ReturnType<NativeApprovalPacketStore["receiveDeliveryReceipt"]>;
  progress: NativeEvidenceReceiver["receive"];
  recover?: NativeEvidenceReceiver["recover"];
};
type Record = {
  nodeId: string; session?: ServerNodeSession; transport: NativeSessionTransport;
  closed: boolean; busy: boolean; signal?: AbortSignal; closing?: Promise<void>;
};
const fail = (): never => { throw new Error("native_session_unavailable"); };

/** Supplied-transport ownership, not a listener. All handles are scoped to one session generation. */
export class ManagedNativeSessions {
  private readonly settings: ReturnType<typeof captureManagedNativeSessionSettings>;
  private readonly records = new Map<string, Record>();
  private readonly owned = new Set<Record>();
  private readonly transports = new WeakSet<object>();
  private readonly limiter = new FixedWindowProtocolRateLimiter(120, 60, 64);
  private readonly routes: Routes;
  private closed = false;
  private uncertain = false;
  private highWater = -Infinity;
  private closing?: Promise<void>;
  constructor(private readonly db: DatabaseClient, settings: ManagedNativeSessionSettings,
    private readonly scope: { tenantId: string; workspaceId: string }, routes: Routes,
    private readonly admit: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly available: () => void, private readonly clock: () => number = Date.now) {
    this.settings = captureManagedNativeSessionSettings(settings);
    if (this.settings.nodes.some(node => node.tenantId !== scope.tenantId)) throw new Error("native_sessions_config_invalid");
    this.routes = Object.freeze({ stage: routes.stage.bind(routes), transmit: routes.transmit.bind(routes),
      receipt: routes.receipt.bind(routes), progress: routes.progress.bind(routes), recover: routes.recover?.bind(routes) });
  }
  private current(record?: Record) {
    this.available();
    const now = this.clock();
    if (this.closed || this.uncertain || !Number.isSafeInteger(now) || now < 0 || now < this.highWater) return fail();
    this.highWater = now;
    if (record && (record.closed || this.records.get(record.nodeId) !== record || record.signal?.aborted)) return fail();
    try { if (record && !record.transport.isAvailable()) return fail(); } catch { return fail(); }
  }
  private database(record: Record): DatabaseClient {
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
      this.current(record); const value = await tx.query<T>(sql, params); this.current(record); return value;
    } });
    const db: DatabaseClient = { query: (sql, params) => db.transaction(tx => tx.query(sql, params)),
      transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: async (work, check) => {
        this.current(record); const value = await this.db.transactionWithPreCommitCheck(tx => work(wrap(tx)),
          () => { this.current(record); check(); this.current(record); });
        this.current(record); return value;
      } };
    return db;
  }
  private closeRecord(record: Record): Promise<void> {
    if (record.closing) return record.closing;
    record.closed = true; record.session?.disconnect();
    if (this.records.get(record.nodeId) === record) this.records.delete(record.nodeId);
    record.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(record.transport.close), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), 5000);
      })]); this.owned.delete(record); }
      catch { this.uncertain = true; throw new Error("native_session_close_uncertain"); }
      finally { clearTimeout(timer); }
    })();
    return record.closing;
  }
  private operation<T>(record: Record, signal: AbortSignal, work: (session: ServerNodeSession) => Promise<T>) {
    if (!(signal instanceof AbortSignal) || signal.aborted || record.busy) return Promise.reject(new Error("native_session_unavailable"));
    this.current(record); record.busy = true; record.signal = signal;
    const aborted = () => record.session?.disconnect();
    signal.addEventListener("abort", aborted, { once: true });
    return this.admit(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.current(record);
        const result = await Promise.race([work(record.session!), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { record.session?.disconnect(); record.closed = true; reject(new Error()); }, 10_000);
        })]);
        this.current(record); return result;
      } catch {
        await this.closeRecord(record); throw new Error("native_session_operation_uncertain");
      } finally { clearTimeout(timer); }
    }).finally(() => { record.busy = false; record.signal = undefined; signal.removeEventListener("abort", aborted); });
  }
  attach(nodeId: string, input: NativeSessionTransport) {
    this.current(); localId.parse(nodeId);
    const config = this.settings.nodes.find(node => node.nodeId === nodeId);
    if (!config || !input || this.transports.has(input)
      || [input.send, input.close, input.isAvailable].some(fn => typeof fn !== "function")) return Promise.reject(new Error("native_session_unavailable"));
    const transport = Object.freeze({ send: input.send.bind(input), close: input.close.bind(input), isAvailable: input.isAvailable.bind(input) });
    this.transports.add(input);
    const prior = this.records.get(nodeId), record: Record = { nodeId, transport, closed: false, busy: false };
    // Replace immediately, before any asynchronous cleanup: retained old handles cannot act.
    prior?.session?.disconnect(); this.records.set(nodeId, record); this.owned.add(record);
    return this.admit(async () => {
      try {
        if (prior) await this.closeRecord(prior);
        this.current(record);
        const db = this.database(record), keys = new DatabaseNodeKeyResolver(db), replay = new DatabaseReplayGuard(db);
        const authentication = new NodeProtocolAuthenticator({ resolve: async input => {
          this.current(record);
          if (input.tenantId !== config.tenantId || input.actorId !== config.nodeId || input.keyId !== config.nodeKeyId || input.senderKind !== "node") return undefined;
          return keys.resolve(input);
        } }, { consume: async (frame, now) => {
          this.current(record);
          if (frame.tenantId !== config.tenantId || frame.actorId !== config.nodeId || frame.keyId !== config.nodeKeyId) return fail();
          return replay.consume(frame, now);
        } }, this.limiter);
        record.session = new ServerNodeSession(config, { authentication,
          clock: () => { this.current(record); return this.clock(); },
          sign: async frame => { this.current(record); const result = await this.settings.sign(frame); this.current(record); return result; },
          send: async raw => { this.current(record); await transport.send(raw); this.current(record); },
        });
        const frame = (raw: string | Uint8Array) => {
          if (typeof raw !== "string" && !(raw instanceof Uint8Array)
            || (typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > config.maxFrameBytes) return fail();
          return typeof raw === "string" ? raw : Uint8Array.from(raw);
        };
        const task = (mode: "stage" | "transmit", identity: VerifiedWebIdentity, value: Task, signal: AbortSignal) => {
          const actor = { ...identity }, request = taskSchema.parse(value);
          return this.operation(record, signal, async session => this.routes[mode](actor, request.projectId, request.jobId,
            request.inputDigest, request.packetDigest, session, signal));
        };
        return Object.freeze({ nodeId, grantsExecutionAuthority: false as const,
          hello: (raw: string | Uint8Array, signal: AbortSignal) => { const copy = frame(raw); return this.operation(record, signal, session => session.acceptHello(copy)); },
          reconcile: (raw: string | Uint8Array, signal: AbortSignal) => { const copy = frame(raw); return this.operation(record, signal, session => session.receive(copy)); },
          stage: (identity: VerifiedWebIdentity, value: Task, signal: AbortSignal) => task("stage", identity, value, signal),
          transmit: (identity: VerifiedWebIdentity, value: Task, signal: AbortSignal) => task("transmit", identity, value, signal),
          receipt: (raw: string | Uint8Array, signal: AbortSignal) => { const copy = frame(raw); return this.operation(record, signal, session => this.routes.receipt(session, copy, signal)); },
          recover: (value: z.infer<typeof nativeEvidenceRegistrationSchema>, signal: AbortSignal) => {
            const copy = nativeEvidenceRegistrationSchema.parse(value);
            return this.operation(record, signal, session => this.routes.recover ? this.routes.recover(session, copy, signal) : Promise.reject(new Error("native_recovery_unavailable")));
          },
          progress: (raw: string | Uint8Array, bytes: Uint8Array | undefined, signal: AbortSignal) => {
            const copy = captureNativeEvidenceInput(raw, bytes);
            return this.operation(record, signal, session => this.routes.progress(session, copy.raw, copy.bytes, signal));
          },
          close: () => this.closeRecord(record),
        });
      } catch { await this.closeRecord(record); throw new Error("native_session_attach_failed"); }
    }).catch(async () => {
      const cleanup = await Promise.allSettled([this.closeRecord(record), ...(prior ? [this.closeRecord(prior)] : [])]);
      if (cleanup.some(result => result.status === "rejected")) throw new Error("native_session_close_uncertain");
      throw new Error("native_session_attach_failed");
    });
  }
  isAvailable(): boolean { return !this.closed && !this.uncertain; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.owned].map(record => this.closeRecord(record)));
      if (this.uncertain || results.some(result => result.status === "rejected")) throw new Error("native_sessions_close_uncertain");
    })();
    return this.closing;
  }
}
