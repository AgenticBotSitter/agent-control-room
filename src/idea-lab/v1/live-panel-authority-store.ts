import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import {
  hmacSha256Tag,
  parseRollbackCheckpointV1,
  rollbackCheckpointDigestV1,
  sha256Digest,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security";
import {
  dataMethodV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
} from "../../security/host-value";
import { parseIdeaLabSessionV1 } from "./contracts";
import type { IdeaLabProviderSessionEvidenceV1 } from "./coordinator";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  ideaLabLivePanelAdmissionSchemaV1,
  parseIdeaLabLivePanelAdmissionV1,
  type IdeaLabLivePanelAdmissionAuthorityV1,
  type IdeaLabLivePanelAdmissionV1,
} from "./live-panel-admission";
import { capturedIdeaTimeMillisecondsV1, capturedIdeaTimeStringV1, ideaAuthTagSchemaV1, ideaDigestSchemaV1,
  ideaIdSchemaV1, ideaTimeSchemaV1 } from "./schemas";
import type { IdeaLabSessionV1 } from "./types";

export const IDEA_LAB_NATIVE_RECEIPT_DECISION_V1 = "control-room-idea-lab-native-receipt-decision/v1" as const;
export const IDEA_LAB_LIVE_ADMISSION_DECISION_V1 = "control-room-idea-lab-live-admission-decision/v1" as const;
export const IDEA_LAB_LIVE_AUTHORITY_EVENT_V1 = "control-room-idea-lab-live-authority-event/v1" as const;

const authTagSchema = ideaAuthTagSchemaV1;
const nativeDecisionSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_NATIVE_RECEIPT_DECISION_V1),
  decisionId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  action: z.enum(["accept", "revoke"]),
  nativeReceiptDigest: ideaDigestSchemaV1,
  runtimeVersion: z.string().min(1).max(40),
  runtimeRevision: z.string().min(7).max(80),
  adapterId: ideaIdSchemaV1,
  adapterVersion: z.string().min(1).max(40),
  compatibilityEvidenceDigest: ideaDigestSchemaV1,
  runtimeManifestDigest: ideaDigestSchemaV1,
  protectedValueCustodyMode: z.enum(["harness_native", "host_broker"]),
  protectedValueCustodyEvidenceDigest: ideaDigestSchemaV1,
  architectIdentityDigest: ideaDigestSchemaV1,
  independentReviewDigest: ideaDigestSchemaV1,
  strongFactorEvidenceDigest: ideaDigestSchemaV1,
  previousDecisionDigest: ideaDigestSchemaV1.nullable(),
  decidedAt: ideaTimeSchemaV1,
  nativeQualified: z.boolean(),
  grantsExecutionAuthority: z.literal(false),
  decisionDigest: ideaDigestSchemaV1,
  decisionAuthTag: authTagSchema,
}).strict();

const admissionDecisionSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_LIVE_ADMISSION_DECISION_V1),
  decisionId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  action: z.enum(["seal", "revoke"]),
  admissionId: ideaIdSchemaV1,
  admissionDigest: ideaDigestSchemaV1,
  runId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1,
  sessionDigest: ideaDigestSchemaV1,
  windowId: ideaIdSchemaV1,
  ownerDecisionDigest: ideaDigestSchemaV1,
  strongFactorEvidenceDigest: ideaDigestSchemaV1,
  nativeReceiptDigest: ideaDigestSchemaV1,
  previousDecisionDigest: ideaDigestSchemaV1.nullable(),
  decidedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  livePanelContactPermitted: z.boolean(),
  grantsProjectCreationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  decisionDigest: ideaDigestSchemaV1,
  decisionAuthTag: authTagSchema,
}).strict();

const nativeDecisionInputSchema = nativeDecisionSchema.omit({
  contractVersion: true,
  nativeQualified: true,
  grantsExecutionAuthority: true,
  decisionDigest: true,
  decisionAuthTag: true,
});

const consumptionSchema = z.object({
  contractVersion: z.literal("control-room-idea-lab-live-admission-consumption/v1"),
  tenantId: ideaIdSchemaV1,
  admissionId: ideaIdSchemaV1,
  admissionDigest: ideaDigestSchemaV1,
  admissionDecisionDigest: ideaDigestSchemaV1,
  runId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1,
  sessionDigest: ideaDigestSchemaV1,
  windowId: ideaIdSchemaV1,
  nativeReceiptDigest: ideaDigestSchemaV1,
  consumedAt: ideaTimeSchemaV1,
  exactReplayInert: z.literal(true),
  grantsProjectCreationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  consumptionDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabNativeReceiptDecisionV1 = z.infer<typeof nativeDecisionSchema>;
export type IdeaLabLiveAdmissionDecisionV1 = z.infer<typeof admissionDecisionSchema>;
type IdeaLabAdmissionConsumptionV1 = z.infer<typeof consumptionSchema>;
type AuthorityPayload = IdeaLabNativeReceiptDecisionV1 | IdeaLabLiveAdmissionDecisionV1 | IdeaLabAdmissionConsumptionV1;
type EventKind = "native_receipt_accepted" | "native_receipt_revoked" | "admission_sealed" | "admission_revoked" | "admission_consumed";

interface AuthorityRow {
  tenant_id: string;
  revision: number | string;
  event_kind: EventKind;
  subject_id: string;
  native_receipt_digest: string;
  admission_id: string | null;
  admission_digest: string | null;
  window_id: string | null;
  run_id: string | null;
  previous_record_digest: string | null;
  record_digest: string;
  record_auth_tag: string;
  payload: unknown;
  occurred_at: string | Date;
}

interface VerifiedState {
  rows: AuthorityRow[];
  receipt: Map<string, IdeaLabNativeReceiptDecisionV1>;
  admission: Map<string, IdeaLabLiveAdmissionDecisionV1>;
  admissionIds: Map<string, IdeaLabLiveAdmissionDecisionV1>;
  admissionRuns: Map<string, IdeaLabLiveAdmissionDecisionV1>;
  consumptions: Map<string, IdeaLabAdmissionConsumptionV1>;
  windows: Map<string, IdeaLabAdmissionConsumptionV1>;
  consumedRuns: Map<string, IdeaLabAdmissionConsumptionV1>;
  latestRecordDigest: string | null;
}

function protectedKey(value: Uint8Array): Uint8Array {
  const exact = exactHostUint8ArrayV1(value, 32);
  if (!exact || exact.byteLength !== 32) throw new IdeaLabErrorV1("invalid_input");
  return exact.copy();
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function without<T extends Record<string, unknown>>(value: T, ...keys: string[]): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function signed<T extends Record<string, unknown>>(material: T, key: Uint8Array, digestKey: string, authKey: string): T {
  const digest = sha256Digest(material), withDigest = { ...material, [digestKey]: digest };
  return { ...withDigest, [authKey]: hmacSha256Tag(key, withDigest) } as T;
}

function verifySigned(value: Record<string, unknown>, key: Uint8Array, digestKey: string, authKey: string): void {
  const digest = value[digestKey], tag = value[authKey];
  const material = without(value, digestKey, authKey), withDigest = { ...material, [digestKey]: digest };
  if (typeof digest !== "string" || typeof tag !== "string" || sha256Digest(material) !== digest
    || !same(hmacSha256Tag(key, withDigest), tag)) throw new IdeaLabErrorV1("integrity_failed");
}

export function buildIdeaLabNativeReceiptDecisionV1(input: Omit<IdeaLabNativeReceiptDecisionV1,
  "contractVersion" | "nativeQualified" | "grantsExecutionAuthority" | "decisionDigest" | "decisionAuthTag">,
architectKeyBytes: Uint8Array): IdeaLabNativeReceiptDecisionV1 {
  const parsedInput = parseExactIdeaLabV1(nativeDecisionInputSchema, input);
  const material = {
    contractVersion: IDEA_LAB_NATIVE_RECEIPT_DECISION_V1,
    ...parsedInput,
    nativeQualified: parsedInput.action === "accept",
    grantsExecutionAuthority: false as const,
  };
  return parseNativeDecision(signed(material, protectedKey(architectKeyBytes), "decisionDigest", "decisionAuthTag"));
}

function parseNativeDecision(value: unknown, architectKeyBytes?: Uint8Array): IdeaLabNativeReceiptDecisionV1 {
  const parsed = parseExactIdeaLabV1(nativeDecisionSchema, value);
  if ((parsed.action === "accept") !== parsed.nativeQualified
    || (parsed.action === "accept") !== (parsed.previousDecisionDigest === null)) throw new IdeaLabErrorV1("integrity_failed");
  if (architectKeyBytes) verifySigned(parsed, architectKeyBytes, "decisionDigest", "decisionAuthTag");
  return parsed;
}

function exactAdmission(value: unknown): IdeaLabLivePanelAdmissionV1 {
  const parsed = parseExactIdeaLabV1(ideaLabLivePanelAdmissionSchemaV1, value);
  if (sha256Digest(without(parsed, "admissionDigest")) !== parsed.admissionDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

export function buildIdeaLabLiveAdmissionDecisionV1(input: {
  decisionId: string;
  action: "seal" | "revoke";
  admission: IdeaLabLivePanelAdmissionV1;
  previousDecisionDigest: string | null;
  decidedAt: string;
}, admissionKeyBytes: Uint8Array): IdeaLabLiveAdmissionDecisionV1 {
  const captured = exactHostDataSnapshotV1(input,
    ["decisionId", "action", "admission", "previousDecisionDigest", "decidedAt"]);
  if (!captured) throw new IdeaLabErrorV1("invalid_input");
  const admission = exactAdmission(captured.admission);
  const action = z.enum(["seal", "revoke"]).parse(captured.action);
  const material = {
    contractVersion: IDEA_LAB_LIVE_ADMISSION_DECISION_V1,
    decisionId: ideaIdSchemaV1.parse(captured.decisionId),
    tenantId: admission.tenantId,
    action,
    admissionId: admission.admissionId,
    admissionDigest: admission.admissionDigest,
    runId: admission.runId,
    sessionId: admission.sessionId,
    sessionDigest: admission.sessionDigest,
    windowId: admission.ownerWindow.windowId,
    ownerDecisionDigest: admission.ownerWindow.decisionDigest,
    strongFactorEvidenceDigest: admission.ownerWindow.strongFactorEvidenceDigest,
    nativeReceiptDigest: admission.runtime.nativeQualificationReceiptDigest,
    previousDecisionDigest: captured.previousDecisionDigest === null ? null
      : ideaDigestSchemaV1.parse(captured.previousDecisionDigest),
    decidedAt: ideaTimeSchemaV1.parse(captured.decidedAt),
    expiresAt: admission.expiresAt,
    livePanelContactPermitted: action === "seal",
    grantsProjectCreationAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  return parseAdmissionDecision(signed(material, protectedKey(admissionKeyBytes), "decisionDigest", "decisionAuthTag"));
}

function parseAdmissionDecision(value: unknown, admissionKeyBytes?: Uint8Array): IdeaLabLiveAdmissionDecisionV1 {
  const parsed = parseExactIdeaLabV1(admissionDecisionSchema, value);
  if ((parsed.action === "seal") !== parsed.livePanelContactPermitted
    || (parsed.action === "seal") !== (parsed.previousDecisionDigest === null)
    || capturedIdeaTimeMillisecondsV1(parsed.decidedAt)! >= capturedIdeaTimeMillisecondsV1(parsed.expiresAt)!) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  if (admissionKeyBytes) verifySigned(parsed, admissionKeyBytes, "decisionDigest", "decisionAuthTag");
  return parsed;
}

function parseConsumption(value: unknown): IdeaLabAdmissionConsumptionV1 {
  const parsed = parseExactIdeaLabV1(consumptionSchema, value);
  if (sha256Digest(without(parsed, "consumptionDigest")) !== parsed.consumptionDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

function payloadFor(kind: EventKind, value: unknown, architectKey: Uint8Array, admissionKey: Uint8Array): AuthorityPayload {
  if (kind === "native_receipt_accepted" || kind === "native_receipt_revoked") return parseNativeDecision(value, architectKey);
  if (kind === "admission_sealed" || kind === "admission_revoked") return parseAdmissionDecision(value, admissionKey);
  return parseConsumption(value);
}

function eventMaterial(row: Omit<AuthorityRow, "record_digest" | "record_auth_tag" | "occurred_at"> & { occurred_at: string }) {
  return {
    contractVersion: IDEA_LAB_LIVE_AUTHORITY_EVENT_V1,
    tenantId: row.tenant_id,
    revision: Number(row.revision),
    eventKind: row.event_kind,
    subjectId: row.subject_id,
    nativeReceiptDigest: row.native_receipt_digest,
    admissionId: row.admission_id,
    admissionDigest: row.admission_digest,
    windowId: row.window_id,
    runId: row.run_id,
    previousRecordDigest: row.previous_record_digest,
    payload: row.payload,
    occurredAt: row.occurred_at,
  };
}

function checkpointMaterial(scope: string, revision: number, recordCount: number, stateDigest: string) {
  return { schema: "control-room-rollback-checkpoint/v1" as const, scope, revision, recordCount, stateDigest };
}

export class IdeaLabLivePanelAuthorityStoreV1 implements IdeaLabLivePanelAdmissionAuthorityV1 {
  readonly #db: DatabaseClient;
  readonly #stateKey: Uint8Array;
  readonly #checkpointKey: Uint8Array;
  readonly #architectKey: Uint8Array;
  readonly #admissionKey: Uint8Array;
  readonly #checkpointRead: (scope: string) => RollbackCheckpointV1 | undefined;
  readonly #checkpointInitialize: (checkpoint: RollbackCheckpointV1) => void;
  readonly #checkpointAdvance: (expectedDigest: string, checkpoint: RollbackCheckpointV1) => void;

  constructor(db: DatabaseClient, keys: Readonly<{
    stateKey: Uint8Array;
    checkpointKey: Uint8Array;
    architectKey: Uint8Array;
    admissionKey: Uint8Array;
  }>, checkpoint: RollbackCheckpointStoreV1) {
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !dataMethodV1(db, "query")
      || !dataMethodV1(db, "transactionWithPreCommitCheck") || !checkpoint || typeof checkpoint !== "object"
      || isHostProxyV1(checkpoint)) throw new IdeaLabErrorV1("invalid_input");
    const capturedKeys = exactHostDataSnapshotV1(keys, ["stateKey", "checkpointKey", "architectKey", "admissionKey"]);
    if (!capturedKeys) throw new IdeaLabErrorV1("invalid_input");
    const read = dataMethodV1(checkpoint, "read"), initialize = dataMethodV1(checkpoint, "initialize"),
      advance = dataMethodV1(checkpoint, "advance");
    if (!read || !initialize || !advance) throw new IdeaLabErrorV1("invalid_input");
    this.#db = db;
    this.#stateKey = protectedKey(capturedKeys.stateKey as Uint8Array);
    this.#checkpointKey = protectedKey(capturedKeys.checkpointKey as Uint8Array);
    this.#architectKey = protectedKey(capturedKeys.architectKey as Uint8Array);
    this.#admissionKey = protectedKey(capturedKeys.admissionKey as Uint8Array);
    this.#checkpointRead = (scope) => Reflect.apply(read, checkpoint, [scope]) as RollbackCheckpointV1 | undefined;
    this.#checkpointInitialize = (value) => { Reflect.apply(initialize, checkpoint, [value]); };
    this.#checkpointAdvance = (expected, value) => { Reflect.apply(advance, checkpoint, [expected, value]); };
    Object.freeze(this);
  }

  #scope(tenantId: string): string { return `idea-lab-live-authority:${tenantId}`; }

  #checkpointFor(tenantId: string, state: VerifiedState): RollbackCheckpointV1 {
    const material = checkpointMaterial(this.#scope(tenantId), state.rows.length, state.rows.length,
      sha256Digest(state.rows.map((row) => row.record_digest)));
    return parseRollbackCheckpointV1({ ...material, stateAuthTag: hmacSha256Tag(this.#checkpointKey, material) });
  }

  #verifyCheckpoint(tenantId: string, state: VerifiedState): RollbackCheckpointV1 | undefined {
    const raw = this.#checkpointRead(this.#scope(tenantId));
    if (state.rows.length === 0) {
      if (raw) throw new IdeaLabErrorV1("integrity_failed");
      return undefined;
    }
    if (!raw) throw new IdeaLabErrorV1("integrity_failed");
    let current: RollbackCheckpointV1;
    try { current = parseRollbackCheckpointV1(raw); }
    catch { throw new IdeaLabErrorV1("integrity_failed"); }
    const expected = this.#checkpointFor(tenantId, state);
    if (current.scope !== expected.scope || current.revision !== expected.revision
      || current.recordCount !== expected.recordCount || current.stateDigest !== expected.stateDigest
      || !same(current.stateAuthTag, expected.stateAuthTag)) throw new IdeaLabErrorV1("integrity_failed");
    return current;
  }

  async #rows(session: DatabaseSession, tenantId: string): Promise<AuthorityRow[]> {
    const result = await session.query<AuthorityRow>(`SELECT tenant_id,revision,event_kind,subject_id,native_receipt_digest,
      admission_id,admission_digest,window_id,run_id,previous_record_digest,record_digest,record_auth_tag,payload,occurred_at
      FROM control_idea_live_authority_events WHERE tenant_id=$1 ORDER BY revision`, [tenantId]);
    return result.rows;
  }

  #verifyRows(rows: AuthorityRow[], tenantId: string): VerifiedState {
    const receipt = new Map<string, IdeaLabNativeReceiptDecisionV1>();
    const admission = new Map<string, IdeaLabLiveAdmissionDecisionV1>();
    const admissionIds = new Map<string, IdeaLabLiveAdmissionDecisionV1>();
    const admissionRuns = new Map<string, IdeaLabLiveAdmissionDecisionV1>();
    const consumptions = new Map<string, IdeaLabAdmissionConsumptionV1>();
    const windows = new Map<string, IdeaLabAdmissionConsumptionV1>();
    const consumedRuns = new Map<string, IdeaLabAdmissionConsumptionV1>();
    let previous: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!, revision = Number(row.revision);
      const occurredAt = capturedIdeaTimeStringV1(row.occurred_at);
      if (!occurredAt) throw new IdeaLabErrorV1("integrity_failed");
      const material = eventMaterial({ ...row, occurred_at: occurredAt });
      if (row.tenant_id !== tenantId || revision !== index + 1 || row.previous_record_digest !== previous
        || sha256Digest(material) !== row.record_digest
        || !same(hmacSha256Tag(this.#stateKey, { ...material, recordDigest: row.record_digest }), row.record_auth_tag)) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      const payload = payloadFor(row.event_kind, row.payload, this.#architectKey, this.#admissionKey);
      if (payload.tenantId !== tenantId || row.native_receipt_digest !== payload.nativeReceiptDigest) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      if (row.event_kind === "native_receipt_accepted" || row.event_kind === "native_receipt_revoked") {
        const decision = payload as IdeaLabNativeReceiptDecisionV1, prior = receipt.get(decision.nativeReceiptDigest);
        if (row.subject_id !== decision.nativeReceiptDigest || row.event_kind !== (decision.action === "accept"
          ? "native_receipt_accepted" : "native_receipt_revoked")
          || (!prior && decision.action !== "accept") || (prior && (prior.action === "revoke"
            || decision.action !== "revoke" || decision.previousDecisionDigest !== prior.decisionDigest))) {
          throw new IdeaLabErrorV1("integrity_failed");
        }
        receipt.set(decision.nativeReceiptDigest, decision);
      } else if (row.event_kind === "admission_sealed" || row.event_kind === "admission_revoked") {
        const decision = payload as IdeaLabLiveAdmissionDecisionV1, prior = admission.get(decision.admissionDigest);
        const native = receipt.get(decision.nativeReceiptDigest);
        if (row.subject_id !== decision.admissionDigest || row.admission_id !== decision.admissionId
          || row.admission_digest !== decision.admissionDigest || row.window_id !== decision.windowId || row.run_id !== decision.runId
          || row.event_kind !== (decision.action === "seal" ? "admission_sealed" : "admission_revoked")
          || (!prior && (decision.action !== "seal" || !native || native.action !== "accept"
            || admissionIds.has(decision.admissionId) || admissionRuns.has(decision.runId)))
          || (prior && (prior.action === "revoke" || decision.action !== "revoke"
            || decision.previousDecisionDigest !== prior.decisionDigest))) throw new IdeaLabErrorV1("integrity_failed");
        admission.set(decision.admissionDigest, decision);
        admissionIds.set(decision.admissionId, decision); admissionRuns.set(decision.runId, decision);
      } else {
        const consumed = payload as IdeaLabAdmissionConsumptionV1, decision = admission.get(consumed.admissionDigest),
          native = receipt.get(consumed.nativeReceiptDigest);
        if (row.subject_id !== consumed.admissionDigest || row.admission_id !== consumed.admissionId
          || row.admission_digest !== consumed.admissionDigest || row.window_id !== consumed.windowId || row.run_id !== consumed.runId
          || !decision || decision.action !== "seal" || decision.decisionDigest !== consumed.admissionDecisionDigest
          || !native || native.action !== "accept" || consumptions.has(consumed.admissionDigest)
          || windows.has(consumed.windowId) || consumedRuns.has(consumed.runId)) {
          throw new IdeaLabErrorV1("integrity_failed");
        }
        consumptions.set(consumed.admissionDigest, consumed); windows.set(consumed.windowId, consumed);
        consumedRuns.set(consumed.runId, consumed);
      }
      previous = row.record_digest;
    }
    return { rows, receipt, admission, admissionIds, admissionRuns, consumptions, windows, consumedRuns,
      latestRecordDigest: previous };
  }

  async #verified(tenantId: string): Promise<{ state: VerifiedState; checkpoint?: RollbackCheckpointV1 }> {
    const state = this.#verifyRows(await this.#rows(this.#db, tenantId), tenantId);
    return { state, checkpoint: this.#verifyCheckpoint(tenantId, state) };
  }

  async #append(tenantId: string, kind: EventKind, payload: AuthorityPayload): Promise<void> {
    const before = await this.#verified(tenantId);
    let pendingCheckpoint: RollbackCheckpointV1 | undefined;
    await this.#db.transactionWithPreCommitCheck(async (tx) => {
      const current = this.#verifyRows(await this.#rows(tx, tenantId), tenantId);
      if (current.rows.length !== before.state.rows.length || current.latestRecordDigest !== before.state.latestRecordDigest) {
        throw new IdeaLabErrorV1("state_conflict");
      }
      const revision = current.rows.length + 1;
      const isNative = kind.startsWith("native_receipt_");
      const admissionPayload = isNative ? undefined : payload as IdeaLabLiveAdmissionDecisionV1 | IdeaLabAdmissionConsumptionV1;
      const row = {
        tenant_id: tenantId,
        revision,
        event_kind: kind,
        subject_id: isNative ? payload.nativeReceiptDigest : admissionPayload!.admissionDigest,
        native_receipt_digest: payload.nativeReceiptDigest,
        admission_id: isNative ? null : admissionPayload!.admissionId,
        admission_digest: isNative ? null : admissionPayload!.admissionDigest,
        window_id: isNative ? null : admissionPayload!.windowId,
        run_id: isNative ? null : admissionPayload!.runId,
        previous_record_digest: current.latestRecordDigest,
        payload,
        occurred_at: "consumedAt" in payload ? payload.consumedAt : payload.decidedAt,
      };
      const material = eventMaterial(row);
      const recordDigest = sha256Digest(material), recordAuthTag = hmacSha256Tag(this.#stateKey, { ...material, recordDigest });
      const persisted: AuthorityRow = { ...row, record_digest: recordDigest, record_auth_tag: recordAuthTag };
      const nextState = this.#verifyRows([...current.rows, persisted], tenantId);
      pendingCheckpoint = this.#checkpointFor(tenantId, nextState);
      await tx.query(`INSERT INTO control_idea_live_authority_events(tenant_id,revision,event_kind,subject_id,
        native_receipt_digest,admission_id,admission_digest,window_id,run_id,previous_record_digest,record_digest,
        record_auth_tag,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`, [
        tenantId, revision, kind, row.subject_id, row.native_receipt_digest, row.admission_id, row.admission_digest,
        row.window_id, row.run_id, row.previous_record_digest, recordDigest, recordAuthTag, JSON.stringify(payload), row.occurred_at,
      ]);
      return undefined;
    }, () => {
      if (!pendingCheckpoint) throw new IdeaLabErrorV1("integrity_failed");
      try {
        if (!before.checkpoint) this.#checkpointInitialize(pendingCheckpoint);
        else this.#checkpointAdvance(rollbackCheckpointDigestV1(before.checkpoint), pendingCheckpoint);
      } catch { throw new IdeaLabErrorV1("integrity_failed"); }
    });
  }

  async recordNativeReceiptDecision(value: unknown): Promise<IdeaLabNativeReceiptDecisionV1> {
    const decision = parseNativeDecision(value, this.#architectKey), verified = await this.#verified(decision.tenantId);
    const prior = verified.state.receipt.get(decision.nativeReceiptDigest);
    if (prior?.decisionDigest === decision.decisionDigest) return prior;
    if ((!prior && decision.action !== "accept") || (prior && (prior.action === "revoke" || decision.action !== "revoke"
      || decision.previousDecisionDigest !== prior.decisionDigest))) throw new IdeaLabErrorV1("state_conflict");
    await this.#append(decision.tenantId, decision.action === "accept" ? "native_receipt_accepted" : "native_receipt_revoked", decision);
    return decision;
  }

  async recordAdmissionDecision(value: unknown): Promise<IdeaLabLiveAdmissionDecisionV1> {
    const decision = parseAdmissionDecision(value, this.#admissionKey), verified = await this.#verified(decision.tenantId);
    const prior = verified.state.admission.get(decision.admissionDigest);
    if (prior?.decisionDigest === decision.decisionDigest) return prior;
    const native = verified.state.receipt.get(decision.nativeReceiptDigest);
    if ((!prior && (decision.action !== "seal" || !native || native.action !== "accept"
      || verified.state.admissionIds.has(decision.admissionId) || verified.state.admissionRuns.has(decision.runId)))
      || (prior && (prior.action === "revoke" || decision.action !== "revoke"
        || decision.previousDecisionDigest !== prior.decisionDigest))) throw new IdeaLabErrorV1("state_conflict");
    await this.#append(decision.tenantId, decision.action === "seal" ? "admission_sealed" : "admission_revoked", decision);
    return decision;
  }

  async consume(input: Readonly<{
    admission: IdeaLabLivePanelAdmissionV1;
    session: IdeaLabSessionV1;
    evidence: readonly IdeaLabProviderSessionEvidenceV1[];
    now: string;
  }>): Promise<boolean> {
    let admission: IdeaLabLivePanelAdmissionV1, session: IdeaLabSessionV1, observedAt: string;
    try {
      const captured = exactHostDataSnapshotV1(input, ["admission", "session", "evidence", "now"]);
      const evidence = captured ? exactHostDataArrayV1(captured.evidence, 6) : undefined;
      if (!captured || !evidence) return false;
      session = parseIdeaLabSessionV1(captured.session);
      const candidate = exactAdmission(captured.admission);
      observedAt = ideaTimeSchemaV1.parse(captured.now);
      admission = parseIdeaLabLivePanelAdmissionV1(candidate, session,
        evidence as IdeaLabProviderSessionEvidenceV1[], candidate.runId, observedAt);
    } catch { return false; }
    const verified = await this.#verified(admission.tenantId), decision = verified.state.admission.get(admission.admissionDigest),
      native = verified.state.receipt.get(admission.runtime.nativeQualificationReceiptDigest),
      replay = verified.state.consumptions.get(admission.admissionDigest), windowUse = verified.state.windows.get(admission.ownerWindow.windowId),
      runUse = verified.state.consumedRuns.get(admission.runId);
    if (!decision || decision.action !== "seal" || !native || native.action !== "accept"
      || decision.admissionId !== admission.admissionId || decision.runId !== admission.runId
      || decision.sessionId !== admission.sessionId || decision.sessionDigest !== admission.sessionDigest
      || decision.windowId !== admission.ownerWindow.windowId || decision.ownerDecisionDigest !== admission.ownerWindow.decisionDigest
      || decision.strongFactorEvidenceDigest !== admission.ownerWindow.strongFactorEvidenceDigest
      || decision.nativeReceiptDigest !== admission.runtime.nativeQualificationReceiptDigest
      || native.runtimeVersion !== admission.runtime.runtimeVersion || native.runtimeRevision !== admission.runtime.runtimeRevision
      || native.adapterId !== admission.runtime.adapterId || native.adapterVersion !== admission.runtime.adapterVersion
      || native.compatibilityEvidenceDigest !== admission.runtime.compatibilityEvidenceDigest
      || native.runtimeManifestDigest !== admission.runtime.runtimeManifestDigest
      || native.protectedValueCustodyMode !== admission.runtime.protectedValueCustodyMode
      || native.protectedValueCustodyEvidenceDigest !== admission.runtime.protectedValueCustodyEvidenceDigest
      || capturedIdeaTimeMillisecondsV1(observedAt)! >= capturedIdeaTimeMillisecondsV1(decision.expiresAt)!) return false;
    if (replay) return replay.runId === admission.runId && replay.windowId === admission.ownerWindow.windowId;
    if (windowUse || runUse) return false;
    const material = {
      contractVersion: "control-room-idea-lab-live-admission-consumption/v1" as const,
      tenantId: admission.tenantId,
      admissionId: admission.admissionId,
      admissionDigest: admission.admissionDigest,
      admissionDecisionDigest: decision.decisionDigest,
      runId: admission.runId,
      sessionId: session.sessionId,
      sessionDigest: session.sessionDigest,
      windowId: admission.ownerWindow.windowId,
      nativeReceiptDigest: admission.runtime.nativeQualificationReceiptDigest,
      consumedAt: observedAt,
      exactReplayInert: true as const,
      grantsProjectCreationAuthority: false as const,
      grantsExecutionAuthority: false as const,
    };
    const consumed = consumptionSchema.parse({ ...material, consumptionDigest: sha256Digest(material) });
    try { await this.#append(admission.tenantId, "admission_consumed", consumed); }
    catch (error) { if (error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict") return false; throw error; }
    return true;
  }

  async verify(tenantId: string): Promise<Readonly<{
    revision: number;
    acceptedNativeReceiptCount: number;
    activeAdmissionCount: number;
    consumedAdmissionCount: number;
    stateDigest: string;
  }>> {
    ideaIdSchemaV1.parse(tenantId);
    const verified = await this.#verified(tenantId);
    return Object.freeze({
      revision: verified.state.rows.length,
      acceptedNativeReceiptCount: [...verified.state.receipt.values()].filter((item) => item.action === "accept").length,
      activeAdmissionCount: [...verified.state.admission.values()].filter((item) => item.action === "seal").length,
      consumedAdmissionCount: verified.state.consumptions.size,
      stateDigest: sha256Digest(verified.state.rows.map((row) => row.record_digest)),
    });
  }
}

export const IDEA_LAB_LIVE_AUTHORITY_STORE_DISABLED_V1 = Object.freeze({
  state: "disabled_pending_external_checkpoint_and_architect_keys" as const,
  databaseConfigured: false as const,
  checkpointConfigured: false as const,
  architectReceiptKeyConfigured: false as const,
  admissionKeyConfigured: false as const,
  acceptedNativeReceiptCount: 0 as const,
  consumedAdmissionCount: 0 as const,
  providerContacted: false as const,
  grantsExecutionAuthority: false as const,
});
