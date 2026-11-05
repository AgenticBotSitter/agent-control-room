import { LoopProviderServiceV1 } from "./loop-provider-service";
import { parseLoopSettingsV1 } from "./loop-policy-compose";
import { LoopPolicyServiceV1, rethrowLoopPolicyErrorV1, type LoopPolicySnapshotV1 } from "./loop-policy-service";
import { LoopCandidatePublisherV1, type LoopCandidateConfigurationV1 } from "../../improve-control-room/v1/loop-candidate-publisher";
import { createImproveControlRoomLoopFinalizerV1, finalizationEnabledV1, loopFinalizationTargetSchemaV1,
  rememberLoopFinalizationFailureV1, effectiveLoopFinalizationReasonV1, loopFinalizationFailureReasonV1, LoopFinalizationFailureV1,
  verifyFinalizationInspectionV1, verifyFinalizationRecordV1, type LoopFinalizationPortV1, type LoopFinalizationTargetV1 } from "./improve-control-room-loop-finalization";
import { loopMonitoringAttentionV1, type LoopMonitoringStatusV1 } from "./improve-control-room-loop-monitoring";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { databaseSqlStateIsAnyV1, type DatabaseClient, type DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { ImproveControlRoomDeskServiceV1 } from "../../improve-control-room/v1/service";
import { loopBridgeBindingSchemaV1, loopBridgeBodiesV1, loopBridgeOperationSchemaV1, loopBridgeOutcomeSchemaV1,
  loopBridgeReceiptSchemaV1, loopImprovementStatusSchemaV1, type LoopBridgeBindingV1, type LoopBridgeOperationV1, type LoopBridgeOutcomeV1 } from "../../improve-control-room/v1/schemas";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { currentLoopGate, loopAttentionSourceSchemaV1, loopDecisionStatusSchemaV1, loopApprovalDocumentSchemaV1,
  loopImprovementDecisionsSchemaV1, unavailableLoopGate, loopDocumentBinding, type LoopDecisionStatusV1, type LoopAttentionItemV1 } from "./improve-control-room-loop-attention-wire";
import { LoopIntakeRefusalV1, loopIntakeRefusalEvidenceV1, loopIntakeRefusalReasonsV1, loopRecoveryBindingSchemaV1, loopOwnedIntakeBindingSchemaV1, loopIntakeCustodySchemaV1,
  loopIntakeDriverBindingSchemaV1, loopIntakeDriverObservationSchemaV1, equalIntakeReceipt, loopByteHashV1, normalizeLoopProviderRoutesV1, loopProviderRouteSchemaV1, type LoopStartAdmissionV1, type LoopAdapterV1, type LoopEngineStatusV1 } from "./improve-control-room-loop-adapter";

import { loopRecoveryCursorSchemaV1, loopRecoveryTargetSchemaV1, type LoopRecoveryPortV1, type LoopRecoveryTargetV1, type LoopRecoveryCursorV1 } from "./improve-control-room-loop-recovery";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/);
const keySchema = z.string().regex(/^[A-Za-z0-9:_-]{16,100}$/);
const rowSchema = z.object({ tenant_id: id, command_id: z.string().regex(/^loop-command:[a-f0-9]{32}$/),
  entry_kind: z.enum(["claim", "result"]), request_id: id, project_id: id, owner_identity_id: id,
  operation: loopBridgeOperationSchemaV1, idempotency_key: keySchema, binding: loopBridgeBindingSchemaV1,
  result: loopBridgeOutcomeSchemaV1.nullable(), record_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  auth_tag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/), created_at: z.string().datetime(),
}).strict();
type Row = z.infer<typeof rowSchema>;
const purpose = "loop-improvement-command/v1";
const sweepLimit = 16;
// Covers bounded intake dispatch and its result/link commit; reads never renew it.
const intakeStatusBoundMs = 120_000;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameTag = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const conflict = () => new WebAccessError("conflict");
const unavailable = () => new Error("loop_bridge_contract_unavailable");
/** The loop desk verifies legacy pipeline templates and requests with the loop
 * key, so a composition with pipelines must use one key for both. */
export const loopKeyMatchesLegacyKeyV1 = (loopKey: Uint8Array, legacyKey: Uint8Array) =>
  loopKey.length === legacyKey.length && timingSafeEqual(loopKey, legacyKey);
export type LoopBridgeConfigurationV1 = { integrityKey: Uint8Array; adapter: LoopAdapterV1; policy?: LoopPolicyServiceV1; providers?:LoopProviderServiceV1; admissionFreshnessMs?: number; loopCandidates?: LoopCandidateConfigurationV1 };
type Lineage = Awaited<ReturnType<ImproveControlRoomDeskServiceV1["loopBridgeLineage"]>>;

/** Owner authority and an append-only, signed one-attempt journal. A committed
 * claim is never retried as execution, even after a lost process or response. */
export class ImproveControlRoomLoopServiceV1 {
  readonly #desk: ImproveControlRoomDeskServiceV1;
  readonly #key: Uint8Array;
  readonly #adapter: LoopAdapterV1;
  readonly #freshness: number;
  readonly #policy: LoopPolicyServiceV1;
  readonly #providers:LoopProviderServiceV1 | undefined;
  readonly #publisher: LoopCandidatePublisherV1;
  readonly #monitoring = new WeakMap<LoopDecisionStatusV1, LoopMonitoringStatusV1>();
  readonly #swept = new Set<string>();
  readonly #sweepCursor = new Map<string, string>();
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    configuration: LoopBridgeConfigurationV1, private readonly clock: () => number = Date.now) {
    if (!(configuration.integrityKey instanceof Uint8Array) || configuration.integrityKey.length !== 32) throw unavailable();
    this.#key = Uint8Array.from(configuration.integrityKey); this.#adapter = configuration.adapter;
    this.#providers = configuration.providers;
    this.#policy = configuration.policy ?? new LoopPolicyServiceV1(db, scope, this.#adapter, clock, this.#providers);
    this.#freshness = configuration.admissionFreshnessMs ?? 5000;
    if (!Number.isSafeInteger(this.#freshness) || this.#freshness < 1 || this.#freshness > 5000) throw unavailable();
    this.#desk = new ImproveControlRoomDeskServiceV1(db, scope, this.#key, undefined, clock, this.#adapter.contract, configuration.loopCandidates);
    this.#publisher = new LoopCandidatePublisherV1(this.#desk, configuration.loopCandidates ?? {
      source: {toolingRevision:this.#adapter.toolingRevision,schemaDigest:this.#adapter.schemaDigest,readVerifiedCompletion:async()=>{throw unavailable();}},
      repository:{observe:async()=>{throw unavailable();}} });
  }
  #material(row: Row) { const { record_digest: _digest, auth_tag: _tag, ...material } = row; return material; }
  #verify(raw: Row) {
    let row: Row;
    try { row = rowSchema.parse({ ...raw, created_at: new Date(raw.created_at).toISOString() }); } catch { throw new Error("loop_command_integrity_failed"); }
    const material = this.#material(row);
    if (row.tenant_id !== this.scope.tenantId || sha256Digest(material) !== row.record_digest
      || !sameTag(hmacSha256Tag(this.#key, { purpose, record: material }), row.auth_tag)
      || row.operation !== "start" && Object.hasOwn(row.binding,"paidPin")
      || (row.entry_kind === "claim") !== (row.result === null)
      || !loopBridgeBodiesV1[row.operation].safeParse(row.binding.body).success
      || (row.result && Buffer.byteLength(JSON.stringify(row.result), "utf8") > 65536)) throw new Error("loop_command_integrity_failed");
    return row;
  }
  async #insert(tx: DatabaseSession, value: Omit<Row, "record_digest" | "auth_tag">) {
    const row = this.#verify({ ...value, record_digest: sha256Digest(value),
      auth_tag: hmacSha256Tag(this.#key, { purpose, record: value }) });
    await tx.query(`INSERT INTO control_loop_improvement_commands
      (tenant_id,command_id,entry_kind,request_id,project_id,owner_identity_id,operation,idempotency_key,binding,result,record_digest,auth_tag,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
    [row.tenant_id, row.command_id, row.entry_kind, row.request_id, row.project_id, row.owner_identity_id, row.operation,
      row.idempotency_key, JSON.stringify(row.binding), row.result === null ? null : JSON.stringify(row.result), row.record_digest, row.auth_tag, row.created_at]);
    return row;
  }
  async #readResult(tx: DatabaseSession, claim: Row) {
    return (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
      WHERE tenant_id=$1 AND command_id=$2 AND entry_kind='result'`, [claim.tenant_id, claim.command_id])).rows[0];
  }
  #verifyResult(raw: Row | undefined, claim: Row) {
    if (!raw) return undefined;
    const row = this.#verify(raw);
    for (const name of ["tenant_id", "command_id", "request_id", "project_id", "owner_identity_id", "operation", "idempotency_key", "binding"] as const)
      if (!equal(row[name], claim[name])) throw new Error("loop_command_integrity_failed");
    return row;
  }
  async #result(tx: DatabaseSession, claim: Row) {
    return this.#verifyResult(await this.#readResult(tx, claim), claim);
  }
  #intakeEngineBinding(claim:Row) {
    // Custody is authenticated by the signed journal row. Derive the tools
    // admission envelope without changing the persisted command schema.
    return loopOwnedIntakeBindingSchemaV1.parse({...claim.binding,...this.scope,projectId:claim.project_id,
      requestId:claim.request_id,ownerIdentityId:claim.owner_identity_id,settingsDigest:claim.binding.settingsSha256});
  }
  #pins(binding: LoopBridgeBindingV1, operation: LoopBridgeOperationV1) {
    if (binding.adapterId !== this.#adapter.adapterId || binding.toolingRevision !== this.#adapter.toolingRevision
      || binding.schemaDigest !== this.#adapter.schemaDigest) throw unavailable();
  }
  #run(lineage: Lineage) {
    if (!lineage.link) throw conflict();
    const run = this.#adapter.contract.decodeRunIdentity({ adapterId: lineage.link.adapter_id, loopRunId: lineage.link.loop_run_id,
      toolingRevision: lineage.link.tooling_revision, a2SchemaVersion: Number(lineage.link.a2_schema_version) });
    if (run.adapterId !== this.#adapter.adapterId || run.toolingRevision !== this.#adapter.toolingRevision
      || run.loopRunId !== lineage.link.loop_run_id) throw unavailable();
    return run;
  }
  #current(status: LoopEngineStatusV1, lineage: Lineage, body: Record<string, unknown>, confirmed: boolean, allowStopped = false) {
    if (body.expectedVersion !== Number(lineage.input.version) || body.expectedRevision !== status.revision
      || status.run.loopRunId !== this.#run(lineage).loopRunId || status.settingsSha256 !== lineage.input.settings_sha256) throw conflict();
    if (confirmed) {
      const authorization = lineage.authorization;
      if (!authorization || !status.confirmation || status.confirmation.who !== "owner"
        || status.confirmation.sha256 !== lineage.input.request_sha256 || loopByteHashV1(status.description) !== lineage.input.request_sha256
        || !equal(status.inputVersion, status.confirmation.input_version)
        || !equal(authorization.a2_input_version, status.inputVersion) || !equal(authorization.confirmation, status.confirmation)
        || authorization.a2_settings_digest !== status.settingsDigest || !allowStopped && status.state === "stopped"
        || !this.#adapter.contract.matchesSavedInput(status.run, { revision: status.revision, inputVersion: status.inputVersion,
          settingsDigest: status.settingsDigest, confirmation: status.confirmation }, { description: lineage.input.description,
          settingsText: lineage.input.settings_text, requestSha256: lineage.input.request_sha256, settingsSha256: lineage.input.settings_sha256 })) throw conflict();
    }
  }
  #receipt(claim: Row, result: Row | undefined, replayed: boolean) {
    return loopBridgeReceiptSchemaV1.parse({ schemaVersion: 1, requestId: claim.request_id,
      localVersion: claim.binding.localVersion, commandId: claim.command_id, state: result?.result?.state ?? "uncertain",
      replayed, engineRevision: result?.result?.revision ?? null, error: result?.result?.error ?? (result ? null : "LAUNCH_UNCERTAIN") });
  }
  /** No browser/session identity is constructed here. This narrow port is
   * bound to the already verified web database and signed creator lineage. */
  recoveryPort(): LoopRecoveryPortV1 {
    return Object.freeze({ scan: (cursor, limit) => this.#scanRecovery(cursor, limit),
      reconcile: (target, signal) => this.#reconcileRecovery(target, signal) });
  }
  async #scanRecovery(cursor: LoopRecoveryCursorV1, limit: number) {
    if (limit !== 8) throw unavailable();
    const after = cursor === null ? null : loopRecoveryCursorSchemaV1.parse(cursor);
    const rows = (await this.db.query<Row & { recovery_has_more: boolean }>(`SELECT c.*,
      lead(c.command_id) OVER (ORDER BY c.created_at,c.command_id) IS NOT NULL AS recovery_has_more FROM (
      SELECT DISTINCT ON (c.request_id) c.* FROM control_loop_improvement_commands c
      JOIN control_loop_improvement_requests r ON r.tenant_id=c.tenant_id AND r.id=c.request_id
        AND r.project_id=c.project_id AND r.owner_identity_id=c.owner_identity_id
      JOIN projects p ON p.tenant_id=r.tenant_id AND p.id=r.project_id
      JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      JOIN control_identities i ON i.tenant_id=r.tenant_id AND i.id=r.owner_identity_id
      WHERE c.tenant_id=$1 AND p.workspace_id=$2 AND c.entry_kind='claim'
        AND h.lifecycle='active' AND p.payload->'presentation'->>'templateId'='control-room'
        AND i.actor_type='human' AND i.state='active'
        AND (EXISTS (SELECT 1 FROM control_loop_improvement_commands s WHERE s.tenant_id=c.tenant_id
          AND s.request_id=c.request_id AND s.operation='start' AND s.entry_kind='claim')
          OR EXISTS (SELECT 1 FROM control_loop_improvement_commands s WHERE s.tenant_id=c.tenant_id
            AND s.request_id=c.request_id AND s.operation IN ('intake','confirm') AND s.entry_kind='claim'
            AND NOT EXISTS (SELECT 1 FROM control_loop_improvement_commands e WHERE e.tenant_id=s.tenant_id
              AND e.command_id=s.command_id AND e.entry_kind='result'))
          OR (c.operation='intake' AND EXISTS (SELECT 1 FROM control_loop_improvement_commands e
            WHERE e.tenant_id=c.tenant_id AND e.command_id=c.command_id AND e.entry_kind='result'
              AND e.result->>'state'='accepted')
            AND EXISTS (SELECT 1 FROM control_loop_improvement_run_links l
              WHERE l.tenant_id=c.tenant_id AND l.request_id=c.request_id)
            AND NOT EXISTS (SELECT 1 FROM control_loop_improvement_commands a
              WHERE a.tenant_id=c.tenant_id AND a.request_id=c.request_id AND a.operation IN ('confirm','start','stop'))))
      ORDER BY c.request_id,CASE WHEN c.operation='intake' THEN 0 ELSE 1 END,c.created_at,c.command_id
    ) c WHERE ($3::timestamptz IS NULL OR (c.created_at,c.command_id)>($3::timestamptz,$4::text))
    ORDER BY c.created_at,c.command_id LIMIT 8`,
    [this.scope.tenantId,this.scope.workspaceId,after?.createdAt ?? null,after?.commandId ?? null])).rows;
    const targets: LoopRecoveryTargetV1[] = [];
    for (const { recovery_has_more: _more, ...raw } of rows) {
      try {
        const row = this.#verify(raw); this.#pins(row.binding,row.operation);
        await this.db.transaction(tx => this.#desk.loopBridgeLineage(tx,row.project_id,row.request_id,row.owner_identity_id));
        targets.push(loopRecoveryTargetSchemaV1.parse({projectId:row.project_id,requestId:row.request_id,ownerIdentityId:row.owner_identity_id}));
      } catch { /* Invalid evidence is never repaired or adopted. */ }
    }
    const last = rows.at(-1);
    return { targets, nextCursor: last?.recovery_has_more ? loopRecoveryCursorSchemaV1.parse({createdAt:new Date(last.created_at).toISOString(),commandId:last.command_id}) : null };
  }
  async #recoverySnapshot(tx: DatabaseSession, target: LoopRecoveryTargetV1) {
    // Share the same identity serialization as owner mutation/result append.
    const actor = (await tx.query(`SELECT id FROM control_identities WHERE tenant_id=$1 AND id=$2
      AND actor_type='human' AND state='active' FOR UPDATE`,[this.scope.tenantId,target.ownerIdentityId])).rows[0];
    if (!actor) throw unavailable();
    const project = (await tx.query(`SELECT p.id FROM projects p JOIN control_manual_project_heads h
      ON h.tenant_id=p.tenant_id AND h.project_id=p.id WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3
      AND h.lifecycle='active' AND p.payload->'presentation'->>'templateId'='control-room' FOR SHARE OF p,h`,
    [this.scope.tenantId,this.scope.workspaceId,target.projectId])).rows[0];
    if (!project) throw unavailable();
    const grants = (await tx.query<{expires_at:string|null;revoked_at:string|null;allowed_actions:string[];project_ids:string[];risk_ceiling:string;role_key:string}>(
      `SELECT * FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE`,[this.scope.tenantId,target.ownerIdentityId])).rows;
    const authorized = () => grants.some(g => g.role_key==='owner' && !g.revoked_at && (!g.expires_at || Date.parse(g.expires_at)>this.clock())
      && ['high','critical'].includes(g.risk_ceiling) && (g.allowed_actions.includes('*') || g.allowed_actions.includes('tasks.propose'))
      && (g.project_ids.includes('*') || g.project_ids.includes(target.projectId)));
    if (!authorized()) throw unavailable();
    const lineage = await this.#desk.loopBridgeLineage(tx,target.projectId,target.requestId,target.ownerIdentityId);
    const rows = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands WHERE tenant_id=$1 AND request_id=$2
      ORDER BY created_at,command_id,entry_kind`,[this.scope.tenantId,target.requestId])).rows.map(raw => this.#verify(raw));
    for (const row of rows) {
      if (row.project_id!==target.projectId || row.owner_identity_id!==target.ownerIdentityId) throw unavailable();
      this.#pins(row.binding,row.operation);
    }
    const claims = rows.filter(row => row.entry_kind==='claim');
    const results = new Map(claims.map(claim => [claim.command_id,this.#verifyResult(rows.find(row => row.entry_kind==='result' && row.command_id===claim.command_id),claim)]));
    if (!authorized()) throw unavailable();
    return {lineage,claims,results,authorized};
  }
  async #reconcileRecovery(raw: LoopRecoveryTargetV1, signal: AbortSignal): ReturnType<LoopRecoveryPortV1['reconcile']> {
    const target=loopRecoveryTargetSchemaV1.parse(raw);
    const blocked={state:'blocked' as const};
    if (signal.aborted) return blocked;
    let snapshot=await this.db.transaction(tx=>this.#recoverySnapshot(tx,target));
    for (const claim of snapshot.claims) {
      if (signal.aborted) return blocked;
      if (snapshot.results.get(claim.command_id)) continue;
      // Intake/confirm result commits also create lineage. Only authenticated
      // exact replay through #complete may perform that atomic transaction.
      if (claim.operation==='intake' || claim.operation==='confirm') return blocked;
      if (!this.#adapter.inspectRecovery) return blocked;
      const observation=await this.#adapter.inspectRecovery(claim.binding.loopRunId,{commandId:claim.command_id,bindingDigest:sha256Digest(claim.binding)});
      const receipt=observation.receipt;
      if (!receipt || receipt.commandId!==claim.command_id || receipt.bindingDigest!==sha256Digest(claim.binding)) return blocked;
      if (observation.run.loopRunId!==claim.binding.loopRunId || observation.run.adapterId!==claim.binding.adapterId
        || observation.run.toolingRevision!==claim.binding.toolingRevision || observation.run.a2SchemaVersion!==claim.binding.a2SchemaVersion) return blocked;
      const outcome=loopBridgeOutcomeSchemaV1.parse({state:receipt.state,revision:observation.revision,adapterId:claim.binding.adapterId,
        loopRunId:claim.binding.loopRunId,toolingRevision:claim.binding.toolingRevision,evidenceDigest:receipt.evidenceDigest,error:receipt.error});
      await this.db.transaction(async tx=>{
        const current=await this.#recoverySnapshot(tx,target);
        const saved=current.claims.find(row=>row.command_id===claim.command_id);
        if (!saved || !equal(saved,claim) || signal.aborted) throw unavailable();
        const prior=current.results.get(claim.command_id);if(prior)return prior;
        if (!current.authorized()) throw unavailable();
        return this.#insert(tx,{...this.#material(saved),entry_kind:'result',result:outcome,created_at:new Date(this.clock()).toISOString()});
      });
      await this.#releaseCommandFiles(claim);
    }
    snapshot=await this.db.transaction(tx=>this.#recoverySnapshot(tx,target));
    if (!snapshot.claims.some(row=>row.operation==='start')) return this.#advanceIntake(target,snapshot,signal);
    if (!this.#adapter.inspectRecovery || !this.#adapter.recover) return blocked;
    const starts=snapshot.claims.filter(row=>row.operation==='start'),start=starts[0];
    if (starts.length!==1 || !start || snapshot.results.get(start.command_id)?.result?.state!=='accepted'
      || snapshot.claims.some(row=>row.operation==='stop' && !snapshot.results.get(row.command_id))) return blocked;
    const local=snapshot.lineage,b=start.binding;
    if (!local.authorization || !local.link || b.authorizationId!==local.authorization.id || b.runLinkId!==local.link.id
      || b.localVersion!==Number(local.input.version) || b.requestSha256!==local.input.request_sha256
      || b.settingsSha256!==local.input.settings_sha256 || !equal(b.inputVersion,local.authorization.a2_input_version)
      || b.loopRunId!==this.#run(local).loopRunId) return blocked;
    const status=await this.#adapter.status(b.loopRunId);
    this.#current(status,local,{expectedVersion:Number(local.input.version),expectedRevision:status.revision},true);
    // A fresh verified status is enough to refuse terminal work. No terminal
    // cache: later owner activity is still discovered through the same scan.
    if (['stopped','finished','refused'].includes(status.state)) return blocked;
    const observation=await this.#adapter.inspectRecovery(b.loopRunId);
    if (observation.mode!=='runnable' || observation.action===null || observation.revision!==status.revision
      || !equal(observation.run,status.run) || !['none','ended'].includes(observation.driver.state)) return {state:observation.driver.state==='live'?'busy':'idle'};
    const binding=loopRecoveryBindingSchemaV1.parse({schemaVersion:1,...this.scope,projectId:target.projectId,ownerIdentityId:target.ownerIdentityId,
      requestId:target.requestId,runLinkId:local.link.id,localVersion:b.localVersion,authorizationId:local.authorization.id,
      startCommandId:start.command_id,startBindingDigest:sha256Digest(b),run:status.run,inputVersion:status.inputVersion,
      requestSha256:b.requestSha256,settingsSha256:b.settingsSha256,settingsDigest:status.settingsDigest,
      expectedRevision:observation.revision,schemaDigest:this.#adapter.schemaDigest,action:observation.action});
    // Re-read authority, lineage and Stop after observational I/O; the reviewed
    // capability provides the final atomic A2 Stop/input/ownership fence.
    await this.db.transaction(async tx=>{
      const current=await this.#recoverySnapshot(tx,target);
      if (!equal(current.lineage,local) || current.claims.some(row=>row.operation==='stop' && !current.results.get(row.command_id))
        || signal.aborted || !current.authorized()) throw unavailable();
    });
    if (signal.aborted) return blocked;
    const result=await this.#adapter.recover(binding);
    return result.kind==='started'?{state:'started',child:result.child}:{state:result.kind==='busy'?'busy':'blocked'};
  }
  async #advanceIntake(target:LoopRecoveryTargetV1,snapshot:{lineage:Lineage;claims:Row[];results:Map<string,Row|undefined>;authorized:()=>boolean},signal:AbortSignal) {
    const blocked={state:"blocked" as const},driver=this.#adapter.intakeDriver;
    if(!driver||signal.aborted)return blocked;
    try{if(driver.enabled()!==true)return blocked;}catch{return blocked;}
    const local=snapshot.lineage,intakes=snapshot.claims.filter(row=>row.operation==='intake'),claim=intakes[0];
    if(intakes.length!==1||!claim||snapshot.results.get(claim.command_id)?.result?.state!=="accepted"
      ||!local.link||local.authorization||snapshot.claims.some(row=>['confirm','start','stop'].includes(row.operation)))return blocked;
    const parsed=loopOwnedIntakeBindingSchemaV1.safeParse(this.#intakeEngineBinding(claim));
    if(!parsed.success)return blocked;
    const b=parsed.data;
    if(b.tenantId!==this.scope.tenantId||b.workspaceId!==this.scope.workspaceId||b.projectId!==target.projectId
      ||b.requestId!==target.requestId||b.ownerIdentityId!==target.ownerIdentityId||b.localVersion!==Number(local.input.version)
      ||b.requestSha256!==local.input.request_sha256||b.settingsSha256!==local.input.settings_sha256
      ||b.settingsDigest!==b.settingsSha256||b.runLinkId!==null||b.authorizationId!==null
      ||b.loopRunId!==this.#run(local).loopRunId)return blocked;
    const status=await this.#adapter.status(b.loopRunId);
    if(status.state!=="draft"||status.confirmation||status.approval||status.question
      ||!equal(status.run,this.#run(local))||status.settingsSha256!==b.settingsSha256
      ||status.settingsDigest!==b.settingsDigest||loopByteHashV1(status.description)!==b.requestSha256
      ||!status.receipts.some(r=>r.commandId===claim.command_id&&r.bindingDigest===sha256Digest(b)&&r.state==='accepted'))return blocked;
    const raw=await driver.inspect(b.loopRunId);
    if(Buffer.byteLength(JSON.stringify(raw),"utf8")>65536)throw unavailable();
    const o=loopIntakeDriverObservationSchemaV1.parse(raw);
    if(!equal(o.run,status.run)||o.revision!==status.revision||!equal(o.inputVersion,status.inputVersion)
      ||o.requestSha256!==b.requestSha256||o.settingsSha256!==b.settingsSha256)return blocked;
    if(o.mode==='unavailable')return blocked;
    const receipt=o.receipt;
    const binding=loopIntakeDriverBindingSchemaV1.parse({schemaVersion:1,...loopIntakeCustodySchemaV1.parse({
      ...this.scope,projectId:target.projectId,requestId:target.requestId,ownerIdentityId:target.ownerIdentityId,
      localVersion:b.localVersion,settingsDigest:b.settingsDigest}),runLinkId:local.link.id,run:status.run,
      expectedRevision:receipt?.expected_revision??o.revision,inputVersion:o.inputVersion,
      requestSha256:b.requestSha256,settingsSha256:b.settingsSha256,intakeCommandId:claim.command_id,
      intakeBinding:b,intakeBindingDigest:sha256Digest(b),completedResult:receipt?.completed_result??o.completedResult});
    if(receipt){
      if(!equalIntakeReceipt(binding,receipt)||receipt.binding_digest!==sha256Digest(binding)
        ||receipt.command_id!==`loop-command:${sha256Digest(binding).slice(7,39)}`||receipt.revision!==o.revision)return blocked;
      return {state:"idle" as const};
    }
    // Serialize with owner Confirm/Stop and competing recovery owners. Tools
    // independently rechecks its mutation fence and persists receipt + effect.
    return this.db.transaction(async tx=>{
      const current=await this.#recoverySnapshot(tx,target);
      if(signal.aborted||!current.authorized()||!equal(JSON.parse(JSON.stringify(current.lineage)),JSON.parse(JSON.stringify(local)))||!equal(current.claims,snapshot.claims)
        ||!equal([...current.results],[...snapshot.results])||driver.enabled()!==true)return blocked;
      // Another owner may have consumed the result while we waited for the
      // identity lock. Accept only its exact saved receipt; never advance twice.
      const latest=loopIntakeDriverObservationSchemaV1.parse(await driver.inspect(b.loopRunId));
      if(latest.mode==='advanced'){
        const saved=latest.receipt;
        return saved&&equalIntakeReceipt(binding,saved)&&saved.binding_digest===sha256Digest(binding)
          &&saved.command_id===`loop-command:${sha256Digest(binding).slice(7,39)}`?{state:"idle" as const}:blocked;
      }
      if(latest.mode!=='completed'||!equal(latest,o)||signal.aborted)return blocked;
      const result=await driver.advance(binding);
      if(result.kind!=="advanced")return blocked;
      if(!equalIntakeReceipt(binding,result.receipt)||result.receipt.binding_digest!==sha256Digest(binding)
        ||!equal(result.observation.receipt,result.receipt)||!equal(result.observation.run,binding.run))throw unavailable();
      return {state:"idle" as const};
    });
  }
  viewDesk(identity: VerifiedWebIdentity, projectId: string) {
    if (!id.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    return this.#desk.viewLoopDesk(identity, projectId);
  }
  async status(identity: VerifiedWebIdentity, projectId: string, requestId: string) {
    return (await this.#statusWithEngine(identity,projectId,requestId)).view;
  }
  async #statusWithEngine(identity: VerifiedWebIdentity, projectId: string, requestId: string) {
    if (!id.safeParse(projectId).success || !id.safeParse(requestId).success) throw new WebAccessError("invalid_request");
    // Authorization and signed lineage are checked before any external read. GET never adopts or reconciles.
    const { lineage, startClaim, startResult, mayWrite, pending, intakeClaim, intakeResult } = await this.#desk.loopBridgeTransaction(identity, projectId, false, async ({ tx, actor, lineage: reader }) => {
      const lineage = await reader.loopBridgeLineage(tx, projectId, requestId, actor.id);
      const raw = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
        WHERE tenant_id=$1 AND request_id=$2 AND operation='start' AND entry_kind='claim'`, [this.scope.tenantId, requestId])).rows[0];
      const startClaim = raw ? this.#verify(raw) : undefined;
      const pendingRaw = this.#adapter.inspectRecovery ? (await tx.query<Row>(`SELECT c.* FROM control_loop_improvement_commands c
        WHERE c.tenant_id=$1 AND c.request_id=$2 AND c.entry_kind='claim' AND c.operation IN ('confirm','stop','approve','answer')
          AND NOT EXISTS (SELECT 1 FROM control_loop_improvement_commands r WHERE r.tenant_id=c.tenant_id
            AND r.command_id=c.command_id AND r.entry_kind='result')
        ORDER BY CASE WHEN c.operation='stop' THEN 0 ELSE 1 END,c.created_at,c.command_id LIMIT 1`,
      [this.scope.tenantId,requestId])).rows[0] : undefined;
      const pending = pendingRaw ? this.#verify(pendingRaw) : undefined;
      if (pending) {
        this.#pins(pending.binding,pending.operation);
        if (pending.project_id!==projectId || pending.owner_identity_id!==actor.id) throw unavailable();
      }
      const intakeRaw = !lineage.link ? (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
        WHERE tenant_id=$1 AND request_id=$2 AND operation='intake' AND entry_kind='claim'`, [this.scope.tenantId, requestId])).rows[0] : undefined;
      const intakeClaim = intakeRaw ? this.#verify(intakeRaw) : undefined;
      if (intakeClaim) {
        this.#pins(intakeClaim.binding, "intake");
        if (intakeClaim.project_id !== projectId || intakeClaim.owner_identity_id !== actor.id) throw unavailable();
      }
      const mayWrite = actor.can("tasks.propose", projectId, true, "high");
      return { lineage, pending, startClaim, startResult: startClaim ? await this.#result(tx, startClaim) : undefined, mayWrite,
        intakeClaim, intakeResult: intakeClaim ? await this.#result(tx, intakeClaim) : undefined };
    });
    if (!lineage.link && !startClaim && intakeClaim) {
      const b = intakeClaim.binding;
      if (b.localVersion !== Number(lineage.input.version) || b.requestSha256 !== lineage.input.request_sha256
        || b.settingsSha256 !== lineage.input.settings_sha256 || b.runLinkId !== null || b.authorizationId !== null) throw unavailable();
      const outcome = intakeResult?.result;
      const refused = outcome?.state === "refused";
      const age = this.clock() - Date.parse(intakeClaim.created_at);
      const inProgress = !refused && age >= 0 && age < intakeStatusBoundMs;
      const code = refused ? (Object.keys(loopIntakeRefusalReasonsV1) as (keyof typeof loopIntakeRefusalReasonsV1)[])
        .find(code => loopIntakeRefusalEvidenceV1(intakeClaim.command_id, intakeClaim.binding, code) === outcome!.evidenceDigest) ?? "REFUSED" : inProgress ? "INTAKE_IN_PROGRESS" : "INTAKE_TIMEOUT";
      const message = refused ? loopIntakeRefusalReasonsV1[code as keyof typeof loopIntakeRefusalReasonsV1]
        : inProgress ? "Intake in progress." : "Intake could not be confirmed within two minutes.";
      // This is local intake status, not an observed engine run. No A2 read,
      // run link, Start authority, or Stop is possible for this request.
      const progress = { step: null, completed: 0, attention: inProgress ? "none" as const : "blocked" as const };
      const display = loopImprovementStatusSchemaV1.parse({ schemaVersion: 1, projectId, requestId,
        localVersion: lineage.view.currentVersion, description: lineage.view.description,
        requestSha256: lineage.view.requestSha256, settingsSha256: lineage.view.settingsSha256, runLinkId: null,
        engineRevision: outcome?.revision ?? 0, state: inProgress ? null : "blocked", startState: "not_started", confirmationCurrent: false,
        canStart: false, canStop: false, progress: null, attention: { code, message, nextAction: refused ? "Correct the configuration, then prepare a new request. No work was started."
          : inProgress ? "Wait while the saved request is linked. This status is limited to two minutes from intake."
          : "Reload this page to check whether your request is ready. If it is still not linked, use Prepare request to try again." },
        observedAt: new Date(this.clock()).toISOString() });
      const engine: LoopEngineStatusV1 = { run: { adapterId: intakeClaim.binding.adapterId, loopRunId: intakeClaim.binding.loopRunId,
        toolingRevision: intakeClaim.binding.toolingRevision, a2SchemaVersion: 1 }, revision: outcome?.revision ?? 0,
        inputVersion: intakeClaim.binding.localVersion, state: inProgress ? "draft" : "refused", description: lineage.view.description,
        settingsSha256: lineage.view.settingsSha256, settingsDigest: lineage.view.settingsSha256,
        confirmation: null, approval: null, question: null, progress, receipts: [] };
      return { engine, view: loopDecisionStatusSchemaV1.parse({ schemaVersion: 1, request: lineage.view, display,
        decisions: { gate: inProgress ? null : { kind: "blocked", code: "UNAVAILABLE", message }, observedAt: display.observedAt },
        engine: { revision: engine.revision, state: engine.state, draft: engine.description, requestSha256: lineage.view.requestSha256,
          settingsSha256: engine.settingsSha256, inputVersion: engine.inputVersion, confirmation: null, approval: null, question: null, progress, identity: "unverified" } }) };
    }
    const current = await this.#adapter.status(this.#run(lineage).loopRunId);
    let confirmationCurrent = false;
    try { this.#current(current, lineage, { expectedVersion: Number(lineage.input.version), expectedRevision: current.revision }, true, true); confirmationCurrent = true; }
    catch (error) { if (!(error instanceof WebAccessError)) throw error; }
    const startOutcome = startResult?.result;
    const startState = !startClaim || startOutcome?.state === "refused" ? "not_started" : !startResult ? "uncertain"
      : startOutcome?.state === "accepted" ? "started" : "dispatched";
    const state = current.state === "draft" ? null : current.state === "stopped" ? "stopped" : current.state === "finished" ? "candidate_ready"
      : startOutcome?.state === "refused" || current.state === "refused" || current.progress.attention === "blocked" ? "blocked"
      : current.state === "waiting" || startOutcome?.state === "waiting" && current.state === "ready" ? current.approval ? "waiting_approval" : current.question ? "waiting_question" : "waiting_owner" : current.state;
    let attention = startOutcome?.state === "refused" ? { code: startOutcome.error ?? "REFUSED",
      message: startOutcome.error === "INELIGIBLE" ? "Start was refused because the configured lineup is ineligible." : "The saved Start command was refused.",
      nextAction: "Review the saved run and its configuration before requesting further work." }
      : startState === "uncertain" ? { code: "LAUNCH_UNCERTAIN", message: "Start could not be confirmed.", nextAction: "Check status or Stop this owned run." }
      : state === "blocked" ? { code: current.decisions?.gate?.kind === "blocked" ? current.decisions.gate.code : "BLOCKED",
        message: current.decisions?.gate?.kind === "blocked" ? current.decisions.gate.message : "The saved run is blocked.",
        nextAction: "Review the saved run before continuing." }
      : state?.startsWith("waiting_") ? { code: state.toUpperCase(), message: "The saved run needs attention.", nextAction: "An owner decision is needed before work can continue." } : null;
    let recoveryInputChanged = false;
    let recoveryTerminal = ["stopped", "finished"].includes(current.state);
    let recoveryUnavailable = !!pending || !!this.#adapter.inspectRecovery && !!startClaim && !recoveryTerminal
      && (startState === "uncertain" || !mayWrite || !confirmationCurrent);
    if (startClaim && this.#adapter.inspectRecovery && !['stopped','finished'].includes(current.state)) {
      try {
        const recovery = await this.#adapter.inspectRecovery(current.run.loopRunId);
        const recoveryCurrent = recovery.revision === current.revision && equal(recovery.run,current.run);
        recoveryInputChanged = recoveryCurrent && recovery.mode === 'input_changed';
        recoveryTerminal = recoveryCurrent && ['stopped','terminal'].includes(recovery.mode);
        recoveryUnavailable ||= recovery.revision !== current.revision || !equal(recovery.run,current.run) || ['uncertain','input_changed','unavailable'].includes(recovery.mode) || recoveryTerminal;
      } catch { recoveryUnavailable = true; }
    }
    if (pending?.operation === 'stop') attention = { code: 'LAUNCH_UNCERTAIN',
      message: current.state === 'stopped' ? 'Stop is saved; termination could not be verified.' : 'Stop could not be confirmed.',
      nextAction: 'Ask the lead to check this saved run before continuing.' };
    else if (recoveryInputChanged) attention = { code: 'INPUT_CHANGED', message: 'The saved run inputs have changed.',
      nextAction: 'Ask the lead to check this saved run before continuing.' };
    else if (recoveryUnavailable) attention = { code: 'UNAVAILABLE', message: 'Recovery could not be verified.',
      nextAction: 'Ask the lead to check this saved run before continuing.' };
    if (current.state === "refused" && current.decisions?.gate?.kind === "blocked" && !pending && !recoveryInputChanged) {
      attention = { code: "REFUSED", message: current.decisions.gate.message,
        nextAction: startClaim ? "Ask the lead to check this step before retrying. Refresh status or stop this run if Stop is available."
          : "Check the project settings, then use Prepare request to retry with a new request. No candidate work was started." };
    }
    // Keep actionable route health guidance when a step is also blocked.
    if (!recoveryTerminal && !pending && !recoveryInputChanged && current.monitoring) attention = loopMonitoringAttentionV1(current.monitoring) ?? attention;
    // Reading signed history does not apply the new composition consent guard.
    const route=loopProviderRouteSchemaV1.safeParse(JSON.parse(lineage.input.settings_text).providerRoute);
    const display = loopImprovementStatusSchemaV1.parse({ schemaVersion: 1, projectId, requestId, ...(route.success?{providerRoute:route.data}:{}),
      localVersion: lineage.view.currentVersion, description: lineage.view.description,
      requestSha256: lineage.view.requestSha256, settingsSha256: lineage.view.settingsSha256, runLinkId: lineage.view.runLink?.runLinkId ?? null,
      engineRevision: current.revision, state, startState, confirmationCurrent,
      canStart: mayWrite && !startClaim && confirmationCurrent && startState === "not_started" && state === "ready" && this.#adapter.available("start"),
      // Stop accepts any signed Start claim, including a refused one (see mutate).
      canStop: !recoveryTerminal && mayWrite && !!startClaim && !!lineage.link && !["stopped", "finished"].includes(current.state) && this.#adapter.available("stop"),
      progress: current.progress.step === null ? null : { stepId: current.progress.step, role: current.progress.role ?? null, attempt: current.progress.attempt ?? null,
        requestedModel: current.progress.requestedModel ?? null, observedModel: current.progress.observedModel ?? null,
        identityVerified: current.progress.identityVerified === true && !!current.progress.observedModel, repairCount: current.progress.repairCount ?? null },
      attention, observedAt: new Date(this.clock()).toISOString() });
    const projected = loopDecisionStatusSchemaV1.parse({ schemaVersion: 1, request: lineage.view, display,
      decisions: loopImprovementDecisionsSchemaV1.parse(recoveryTerminal ? { gate: null, observedAt: display.observedAt } : recoveryUnavailable ? { gate: recoveryInputChanged ? { kind: 'blocked', code: 'INPUT_CHANGED', message: 'The saved run inputs have changed. Check the saved request.' } : unavailableLoopGate(), observedAt: display.observedAt } : current.decisions ?? { gate: unavailableLoopGate(), observedAt: display.observedAt }), engine: { revision: current.revision, state: current.state,
      draft: current.description, requestSha256: loopByteHashV1(current.description), settingsSha256: current.settingsSha256,
      inputVersion: current.inputVersion, confirmation: current.confirmation ? { sha256: current.confirmation.sha256,
        at: current.confirmation.at, who: current.confirmation.who, inputVersion: current.confirmation.input_version } : null,
      progress: current.progress, approval: current.approval, question: current.question, identity: "unverified" } });
    if (current.monitoring && !recoveryTerminal) this.#monitoring.set(projected, current.monitoring);
    return { engine:current, view:projected };
  }
  async #finalizationTarget(target: LoopRecoveryTargetV1, supplied?: LoopEngineStatusV1): Promise<LoopFinalizationTargetV1> {
    const snapshot=await this.db.transaction(tx=>this.#recoverySnapshot(tx,target));
    const starts=snapshot.claims.filter(c=>c.operation==="start"),start=starts[0],local=snapshot.lineage;
    if(starts.length!==1||!start||snapshot.results.get(start.command_id)?.result?.state!=="accepted"||!local.link||!local.authorization)throw unavailable();
    const b=start.binding;
    if(b.authorizationId!==local.authorization.id||b.runLinkId!==local.link.id||b.localVersion!==Number(local.input.version)
      ||b.requestSha256!==local.input.request_sha256||b.settingsSha256!==local.input.settings_sha256
      ||!equal(b.inputVersion,local.authorization.a2_input_version)||b.loopRunId!==this.#run(local).loopRunId)throw unavailable();
    const current=supplied??await this.#adapter.status(b.loopRunId);
    this.#current(current,local,{expectedVersion:Number(local.input.version),expectedRevision:current.revision},true,true);
    if(snapshot.claims.some(c=>!snapshot.results.get(c.command_id)&&(c.operation!=="stop"||current.state!=="stopped")))throw unavailable();
    return loopFinalizationTargetSchemaV1.parse({schemaVersion:1,...this.scope,...target,runLinkId:local.link.id,localVersion:Number(local.input.version),
      authorizationId:local.authorization.id,startCommandId:start.command_id,startBindingDigest:sha256Digest(b),run:current.run,
      inputVersion:current.inputVersion,requestSha256:local.input.request_sha256,settingsSha256:local.input.settings_sha256,settingsDigest:current.settingsDigest,
      expectedRevision:current.revision,schemaDigest:this.#adapter.schemaDigest});
  }
  finalizationPort(): LoopFinalizationPortV1 {
    return Object.freeze({observe:async(raw,signal)=>{
      const target=loopRecoveryTargetSchemaV1.parse(raw),capability=this.#adapter.finalization;
      if(signal.aborted||!finalizationEnabledV1(capability)||!capability)return;
      const operationSignal=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
      const authorize=()=>this.#finalizationTarget(target);
      const binding=await authorize();
      try{
        await createImproveControlRoomLoopFinalizerV1({capability,authorize,signal:operationSignal,
          publishCompletion:(input,onStage)=>this.#publisher.publishCompletion(input,onStage)}).finalize(binding);
        rememberLoopFinalizationFailureV1(binding,null);
      }catch(error){
        const reason=loopFinalizationFailureReasonV1(error);
        rememberLoopFinalizationFailureV1(binding,reason);
        throw error instanceof LoopFinalizationFailureV1?error:new LoopFinalizationFailureV1(reason,error);
      }
    }});
  }
  async #lifecycleAttention(identity:VerifiedWebIdentity,projectId:string,requestId:string,current:LoopEngineStatusV1):Promise<LoopAttentionItemV1|null>{
    const c=this.#adapter.finalization;if(!c||!finalizationEnabledV1(c))return null;
    const authorize=async()=>{
      const target=await this.#desk.loopBridgeTransaction(identity,projectId,false,async({actor,lineage,tx})=>{
        await lineage.loopBridgeLineage(tx,projectId,requestId,actor.id);
        return {projectId,requestId,ownerIdentityId:actor.id};
      });
      return this.#finalizationTarget(target,current);
    };
    const binding=await authorize();
    const inspected=verifyFinalizationInspectionV1(await c.inspect(binding),binding);
    // Reauthorize signed creator/input/grants after both asynchronous ports. No
    // second status CLI or finalization mutation belongs to a browser read.
    if(!equal(binding,await authorize()))throw unavailable();
    const raw=await c.readRecord(binding);
    if(!equal(binding,await authorize()))throw unavailable();
    const record=raw===null?null:verifyFinalizationRecordV1(raw,binding),o=inspected.observation;
    if(o.outcome==="candidate_ready"&&current.state!=="finished"||o.outcome==="stopped"&&current.state!=="stopped")throw unavailable();
    if(record&&!equal(record.observation,o))throw unavailable();
    if(["running","owner_gate"].includes(o.outcome))return null;
    let kind:"finish"|"stall"|"failed"|"stopped"=o.outcome==="failed"?"failed":o.outcome==="stopped"?"stopped":"stall";
    let reasonCode=o.reasonCode;
    if(o.outcome==="uncertain"||["candidate_ready","failed"].includes(o.outcome)&&inspected.termination?.state!=="already-ended")reasonCode="TERMINATION_UNCERTAIN";
    else if(record?.cleanup?.state==="uncertain")reasonCode="CLEANUP_UNCERTAIN";
    else if(record?.cleanup?.state==="refused"&&o.outcome==="candidate_ready")reasonCode="CLEANUP_REFUSED";
    else if(o.outcome==="candidate_ready"&&o.reasonCode==="FINISHED"){
      if(record?.publication&&["announced","cleanup"].includes(record.phase)){kind="finish";reasonCode="FINISHED";}
      else reasonCode=record?.custody?"PUBLICATION_UNAVAILABLE":record?"RETENTION_FAILED":"UNAVAILABLE";
    }
    const failure=effectiveLoopFinalizationReasonV1(binding,record);
    if(failure)reasonCode=failure;
    if(["CLEANUP_REFUSED","CLEANUP_UNCERTAIN","RETENTION_FAILED","TERMINATION_UNCERTAIN","PUBLICATION_UNAVAILABLE","UNAVAILABLE","PUBLICATION_PREPARE_FAILED","PUBLICATION_VERIFY_FAILED","PUBLICATION_RECORD_FAILED","PUBLICATION_VERIFY_PUBLICATION_FAILED","PUBLICATION_PUBLISHED_APPEND_FAILED","PUBLICATION_ANNOUNCED_APPEND_FAILED"].includes(reasonCode))kind="stall";
    const labels:Record<typeof reasonCode,[string,string,string]>={
      FINISHED:["Finished candidate","A finished candidate and its retained evidence are available.","Review finished candidate"],
      FAILED:["Saved run failed","The saved run failed.","Inspect saved run"],
      STOPPED:["Saved run stopped","The saved run is stopped. Scratch is retained; cleanup is not complete.","Review stopped run"],
      CLEANUP_REFUSED:["Run cleanup refused","Evidence is retained. Scratch is retained because cleanup is refused in this phase.","Ask the lead to check retained evidence"],
      CLEANUP_UNCERTAIN:["Run cleanup could not be confirmed","Evidence is retained; check the trash.","Check the trash with the lead"],
      RETENTION_FAILED:["Evidence retention failed","Complete retained evidence could not be verified. Originals remain in place.","Ask the lead to check retained evidence"],
      PUBLICATION_UNAVAILABLE:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      PUBLICATION_PREPARE_FAILED:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      PUBLICATION_VERIFY_FAILED:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      PUBLICATION_RECORD_FAILED:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      PUBLICATION_VERIFY_PUBLICATION_FAILED:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      PUBLICATION_PUBLISHED_APPEND_FAILED:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      PUBLICATION_ANNOUNCED_APPEND_FAILED:["Candidate publication unavailable","Retained evidence is available but candidate publication could not be verified.","Ask the lead to check retained evidence"],
      TERMINATION_UNCERTAIN:["Run termination uncertain","Already-ended writers could not be verified. Originals remain in place.","Ask the lead to reconcile this run"],
      LAUNCH_UNCERTAIN:["Run launch uncertain","The saved run launch could not be verified.","Ask the lead to reconcile this run"],
      INPUT_CHANGED:["Saved inputs changed","Changed inputs require renewed confirmation and approvals through the lead.","Ask the lead to reconcile this run"],
      QUESTION_LIMIT:["Saved question limit reached","The saved question limit requires owner attention.","Ask the lead to reconcile this run"],
      LOGIN_REQUIRED:["Saved run needs login","The verified run reports that login is required.","Check saved run with the lead"],
      PROVIDER_UNAVAILABLE:["Saved provider unavailable","The verified run reports that its provider is unavailable.","Check saved run with the lead"],
      TOOL_MISSING:["Saved tool missing","The verified run reports that a required tool is missing.","Check saved run with the lead"],
      DEADLINE_EXCEEDED:["Saved deadline exceeded","The verified run reports that its deadline was exceeded.","Check saved run with the lead"],
      UNAVAILABLE:["Run evidence unavailable","The saved run evidence could not be verified.","Ask the lead to reconcile this run"],
    };
    const [title,message,nextAction]=labels[reasonCode];
    const terminalCleanup=record?.cleanup&&["failed","stopped"].includes(o.outcome)?record.cleanup.state:null;
    const summary=terminalCleanup==="complete"
      ? (o.outcome==="stopped"?"The saved run is stopped.":message)+" Scratch was moved to the seven-day trash; evidence is retained."
      : message+(terminalCleanup==="refused"?" Evidence is retained; scratch cleanup is refused.":"");
    return {projectId:binding.projectId,requestId:binding.requestId,runLinkId:binding.runLinkId,
      localVersion:binding.localVersion,engineRevision:binding.expectedRevision,observedAt:o.observedAt,kind,
      identity:kind==="finish"?{kind,completionDigest:o.completionDigest!}:{kind,evidenceDigest:o.evidenceDigest},
      title,summary,nextAction,reasonCode,retentionDigest:record?.custody?.retentionDigest??null,candidate:kind==="finish"?record!.publication!.candidate:null} as LoopAttentionItemV1;
  }
  async readAttention(identity: VerifiedWebIdentity) {
    const scan = await this.#desk.viewLoopAttentionRequests(identity);
    const items: (LoopAttentionItemV1 | null)[] = new Array(scan.requests.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < scan.requests.length) {
        const index = next++, request = scan.requests[index]!;
        const base = { projectId: request.projectId, requestId: request.requestId, runLinkId: request.runLink?.runLinkId ?? null,
          localVersion: request.currentVersion, engineRevision: null, observedAt: scan.observedAt };
        const blocked = (code: "UNAVAILABLE" | "QUESTION_LIMIT" | "INPUT_CHANGED", revision: number | null = null, latest?: LoopDecisionStatusV1): LoopAttentionItemV1 => ({ ...base,
          ...(latest ? {localVersion:latest.request.currentVersion,runLinkId:latest.display.runLinkId,observedAt:latest.display.observedAt} : {}),
          engineRevision: revision, kind: "blocked", identity: { kind: "blocked", code }, title: "Check saved request",
          summary: code === "QUESTION_LIMIT" ? "The saved question limit requires owner attention."
            : code === "INPUT_CHANGED" ? "Changed inputs require renewed confirmation and approvals through the lead."
            : "The saved decision is unavailable. Open the request to check it." });
        if (!request.runLink) { items[index] = blocked("UNAVAILABLE"); continue; }
        try {
          const observed = await this.#statusWithEngine(identity, request.projectId, request.requestId),status=observed.view, gate = currentLoopGate(status);
          const monitoring = this.#monitoring.get(status);
          const summary = monitoring ? loopMonitoringAttentionV1(monitoring) : null;
          if (!gate || gate.kind==="blocked"&&gate.code==="UNAVAILABLE") {
            const lifecycle=await this.#lifecycleAttention(identity,request.projectId,request.requestId,observed.engine);
            if(lifecycle){items[index]=lifecycle;continue;}
          }
          if (!gate) {
            if (summary && !["stopped", "finished"].includes(status.engine.state))
              items[index] = {...blocked("UNAVAILABLE", status.engine.revision, status), summary: `${summary.message} ${summary.nextAction}`};
            continue;
          }
          if (gate.kind === "blocked") {
            items[index] = blocked(gate.code, status.engine.revision, status);
            if (gate.code === "UNAVAILABLE" && summary) items[index]!.summary = `${summary.message} ${summary.nextAction}`;
            continue;
          }
          const bound = { ...base, localVersion: status.request.currentVersion, runLinkId: status.display.runLinkId, observedAt: status.display.observedAt, engineRevision: status.engine.revision };
          if (gate.kind === "confirm") items[index] = { ...bound, kind: "confirmation", identity: { kind: "confirmation",
            requestSha256: status.engine.requestSha256, settingsSha256: status.engine.settingsSha256 },
            title: "Confirm saved request", summary: "Review the complete exact draft before confirming it." };
          else if (status.display.confirmationCurrent && status.engine.state === "waiting") {
            if (gate.kind === "approve" && status.engine.approval) items[index] = { ...bound, kind: "approval",
              identity: { kind: "approval", ...status.engine.approval }, title: `Review saved ${status.engine.approval.step}`,
              summary: "Read the complete sealed document before explicitly approving this version." };
            else if (gate.kind === "question" && status.engine.question?.owner) items[index] = { ...bound, kind: "question", identity: { kind: "question",
                questionId: status.engine.question.questionId, inputVersion: status.engine.question.inputVersion,
                questionReportSha256: status.engine.question.reportSha256 }, title: status.engine.question.changesInput ? "Review input-changing question" : "Answer saved question",
                summary: status.engine.question.changesInput ? "This question changes inputs. Ask the lead to renew affected confirmation and approvals."
                  : "The saved run is waiting for an owner decision. Open the exact question." };
          } else items[index] = blocked("UNAVAILABLE", status.engine.revision, status);
        } catch (error) {
          if (error instanceof WebAccessError && ["authentication_required", "access_denied"].includes(error.code)) throw error;
          items[index] = blocked("UNAVAILABLE");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, scan.requests.length) }, worker));
    return loopAttentionSourceSchemaV1.parse({ schemaVersion: 1, state: "available", items: items.filter(item => item !== null), truncated: scan.truncated });
  }
  async readApprovalDocument(identity: VerifiedWebIdentity, projectId: string, requestId: string) {
    const before = await this.status(identity, projectId, requestId);
    const approval = before.engine.approval, gate = currentLoopGate(before);
    if (gate?.kind === "blocked" && gate.code === "UNAVAILABLE") throw unavailable();
    if (before.engine.state !== "waiting" || currentLoopGate(before)?.kind !== "approve" || !before.display.confirmationCurrent || !approval) throw conflict();
    if (!this.#adapter.readApprovalDocument || !before.request.runLink) throw unavailable();
    const text = await this.#adapter.readApprovalDocument(before.request.runLink.loopRunId, approval);
    // File reads and subprocess observations never hold a database transaction.
    const after = await this.status(identity, projectId, requestId);
    if (loopDocumentBinding(before) !== loopDocumentBinding(after) || currentLoopGate(after)?.kind !== "approve"
      || after.engine.state !== "waiting" || !after.display.confirmationCurrent) throw conflict();
    const document = loopApprovalDocumentSchemaV1.parse({ schemaVersion: 1, projectId, requestId,
      runLinkId: after.display.runLinkId, localVersion: after.request.currentVersion, engineRevision: after.engine.revision,
      approval, text, observedAt: after.display.observedAt });
    if (Buffer.byteLength(JSON.stringify(document), "utf8") > 1600000) throw unavailable();
    return document;
  }
  async mutate(identity: VerifiedWebIdentity, projectId: string, requestId: string | null,
    operation: LoopBridgeOperationV1, input: unknown, idempotencyKey: string) {
    try { return await this.#mutate(identity, projectId, requestId, operation, input, idempotencyKey); }
    catch (error) { rethrowLoopPolicyErrorV1(error); }
  }
  async #mutate(identity: VerifiedWebIdentity, projectId: string, requestId: string | null,
    operation: LoopBridgeOperationV1, input: unknown, idempotencyKey: string) {
    if (!id.safeParse(projectId).success || requestId !== null && !id.safeParse(requestId).success
      || !keySchema.safeParse(idempotencyKey).success || (operation === "intake") !== (requestId === null)) throw new WebAccessError("invalid_request");
    const parsed = loopBridgeBodiesV1[operation].safeParse(input);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    const body = parsed.data as Record<string, unknown>;
    let preflight: LoopEngineStatusV1 | undefined;
    let policyPreflight: LoopPolicySnapshotV1 | undefined;
    let startAdmission:LoopStartAdmissionV1 | undefined;
    let mappingPreflight:Awaited<ReturnType<LoopProviderServiceV1['preflightStartMappingV1']>> | undefined;
    if (requestId === null) {
      policyPreflight = await this.#desk.loopBridgeTransaction(identity, projectId, true, async ({ tx, actor, lineage }) => {
        const raw = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
          WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3 AND entry_kind='claim'`,
        [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
        if (raw) {
          const prior = this.#verify(raw);
          if (prior.project_id !== projectId || prior.operation !== operation || !equal(prior.binding.body, body)) throw conflict();
          await lineage.loopBridgeLineage(tx, projectId, prior.request_id, actor.id);
          this.#pins(prior.binding, prior.operation);
          return undefined;
        }
        if (!this.#adapter.available(operation)) throw unavailable();
        return this.#policy.snapshot(tx, projectId, body.settingsEdits as string | undefined, body.waiverId as string | undefined);
      });
      if (policyPreflight) await this.#policy.check(policyPreflight);
    }
    // Stop needs no observational preflight: its own decoded result verifies
    // the run and receipt. Admission below still locks current authority and
    // verifies the signed lineage, owned Start and exact run link.
    if (requestId !== null && operation !== "stop") {
      const snapshot = await this.#desk.loopBridgeTransaction(identity, projectId, true, async ({ tx, actor, lineage }) => {
        const local = await lineage.loopBridgeLineage(tx, projectId, requestId, actor.id);
        const prior = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
          WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3 AND entry_kind='claim'`,
        [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
        if (prior) { this.#verify(prior); return { local, replay: true }; }
        if (operation === "start" && !body.route) throw new WebAccessError("invalid_request");
        if (!this.#adapter.available(operation)) throw unavailable();
        if (body.expectedVersion !== Number(local.input.version)) throw conflict();
        if (operation === "start" && body.runLinkId !== local.link?.id) throw new WebAccessError("not_found");
        if (["start", "approve", "answer"].includes(operation) && !local.authorization) throw conflict();
        return { local, replay: false };
      });
      if (!snapshot.replay) {
        preflight = await this.#adapter.status(this.#run(snapshot.local).loopRunId);
        if (operation === "start") {
          if (!this.#adapter.providerRoutes || !this.#providers) throw unavailable();
          const text=snapshot.local.input.settings_text, hash=snapshot.local.input.settings_sha256;
          if (loopByteHashV1(text) !== hash) throw conflict();
          const saved=loopProviderRouteSchemaV1.safeParse(parseLoopSettingsV1(text).providerRoute);
          if (!saved.success || !equal(saved.data,body.route)) throw conflict();
          // F10c and presence run after authenticated preflight has closed, without locks.
          const routes=normalizeLoopProviderRoutesV1(await this.#adapter.providerRoutes.resolveStartRoute(text));
          if (routes.providerId !== saved.data.providerId || routes.model !== saved.data.model) throw conflict();
          startAdmission={settingsSha256:hash,routes};
          mappingPreflight=await this.#providers.preflightStartMappingV1(identity,saved.data);
        }
      }
    }
    const admitted = await this.#desk.loopBridgeTransaction(identity, projectId, true, async ({ tx, actor, lineage }) => {
      // Replays are authorized under the same current owner/session locks as new claims.
      const priorRaw = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3 AND entry_kind='claim'`,
      [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      if (priorRaw) {
        const prior = this.#verify(priorRaw);
        if (prior.project_id !== projectId || prior.operation !== operation || (requestId !== null && prior.request_id !== requestId)
          || !equal(prior.binding.body, body)) throw conflict();
        await lineage.loopBridgeLineage(tx, projectId, prior.request_id, actor.id);
        this.#pins(prior.binding, prior.operation);
        return { claim: prior, result: await this.#result(tx, prior), replayed: true };
      }
      if (!this.#adapter.available(operation)) throw unavailable();
      let paidPin:LoopBridgeBindingV1["paidPin"];
      let local: Lineage;
      let observed: LoopEngineStatusV1 | undefined;
      if (requestId === null) {
        if (!policyPreflight) throw conflict();
        const fresh = await this.#policy.snapshot(tx, projectId, body.settingsEdits as string | undefined, body.waiverId as string | undefined);
        this.#policy.assertSnapshot(policyPreflight, fresh);
        const draft = await lineage.saveLoopDraft(identity, projectId, { description: body.description,
          settingsText: fresh.text }, idempotencyKey);
        local = await lineage.loopBridgeLineage(tx, projectId, draft.request.requestId, actor.id);
        await this.#policy.consumeWaiver(tx, projectId, local.root.id, fresh);
        await this.#policy.recordInputSources(tx, { requestId: local.root.id, inputVersion: Number(local.input.version),
          defaultsSha256: fresh.defaultsSha256, layerVersions: fresh.layerVersions, waiverId: fresh.waiverId ?? null });
      } else {
        local = await lineage.loopBridgeLineage(tx, projectId, requestId, actor.id);
        const run = this.#run(local);
        // Preflight ran outside every transaction; admission rechecks the saved lineage.
        observed = preflight;
        if (operation === "stop") {
          if (body.runLinkId !== local.link!.id) throw new WebAccessError("not_found");
          const rawStart = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
            WHERE tenant_id=$1 AND request_id=$2 AND operation='start' AND entry_kind='claim' LIMIT 1`,
          [this.scope.tenantId, requestId])).rows[0];
          if (!rawStart) throw conflict();
          const start = this.#verify(rawStart);
          if (start.project_id !== projectId || start.owner_identity_id !== actor.id
            || start.binding.runLinkId !== local.link!.id || start.binding.loopRunId !== run.loopRunId) throw conflict();
        } else {
          if (!observed || observed.run.loopRunId !== run.loopRunId) throw conflict();
          this.#current(observed, local, body, operation !== "confirm");
          if (operation === "confirm") {
            if (body.requestSha256 !== loopByteHashV1(observed.description) || body.settingsSha256 !== observed.settingsSha256
              || observed.state === "stopped") throw conflict();
            if (local.input.description !== observed.description) {
              const fromVersion = Number(local.input.version);
              await lineage.reviseLoopDraft(identity, projectId, { requestId, expectedVersion: fromVersion,
                description: observed.description, settingsText: local.input.settings_text }, idempotencyKey);
              local = await lineage.loopBridgeLineage(tx, projectId, requestId, actor.id);
              await this.#policy.copyInputSources(tx, { requestId, fromVersion, toVersion: Number(local.input.version) });
            }
            const priorConfirmation = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
              WHERE tenant_id=$1 AND request_id=$2 AND operation='confirm' AND entry_kind='claim'
                AND binding->>'localVersion'=$3 LIMIT 1`, [this.scope.tenantId, requestId, String(local.input.version)])).rows[0];
            if (priorConfirmation) this.#verify(priorConfirmation);
            if (local.authorization || priorConfirmation) throw conflict();
          }
          if (operation === "start") {
            await this.#policy.validateStartWaiver(tx, projectId, requestId, Number(local.input.version));
            if (!body.route) throw new WebAccessError("invalid_request");
            if (!startAdmission || !mappingPreflight || !this.#providers || startAdmission.settingsSha256 !== local.input.settings_sha256
              || loopByteHashV1(local.input.settings_text) !== startAdmission.settingsSha256) throw conflict();
            const routes=startAdmission.routes;
            const mapping=await this.#providers.resolveStartMappingV1(tx,{providerId:routes.providerId,model:routes.model});
            if (!equal(mapping,mappingPreflight)) throw conflict();
            for (const route of routes.additionalRoutes) {
              const extra=await this.#providers.resolveStartMappingV1(tx,route);
              if (extra.billingKind === 'token') throw unavailable();
            }
            if (mapping.billingKind === 'token') {
              const paid=body.paid as {optIn:true;capNanoUsd:string}|undefined,price=mapping.price;
              if (!paid || !price || price.status !== 'known' || price.currency !== 'USD' || price.stale
                || Date.parse(price.checkedAt)>this.clock() || price.input === null || price.output === null) throw conflict();
              if (this.#adapter.providerRoutes?.paidExecutionReady !== true) throw unavailable();
              paidPin={providerId:routes.providerId,model:routes.model,servedModelId:mapping.servedModelId,
                providerVersion:mapping.version,priceRowDigest:price.digest,capNanoUsd:paid.capNanoUsd};
            } else if (body.paid) throw conflict();
            startAdmission={...startAdmission,...(paidPin?{paidPin}:{})};
          }
          if (operation === "start" && (body.runLinkId !== local.link!.id || observed.state !== "ready")) throw conflict();
          if (operation === "approve") {
            const a = observed.approval;
            if (!a || observed.state !== "waiting" || body.step !== a.step || body.head !== a.head
              || body.reportSha256 !== a.reportSha256 || !equal(body.inputVersion, a.inputVersion)) throw conflict();
          }
          if (operation === "answer") {
            const q = observed.question;
            if (!q || observed.state !== "waiting" || !q.owner || q.changesInput || body.questionId !== q.questionId
              || body.questionReportSha256 !== q.reportSha256 || !equal(body.inputVersion, q.inputVersion)) throw conflict();
          }
          if (operation === "answer" || operation === "approve") {
            const evidence = sha256Digest(operation === "answer" ? observed.question : observed.approval);
            const existing = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
              WHERE tenant_id=$1 AND request_id=$2 AND operation=$3 AND entry_kind='claim'
                AND binding->>'evidence'=$4 LIMIT 1`, [this.scope.tenantId, requestId, operation, evidence])).rows[0];
            if (existing) { this.#verify(existing); throw conflict(); }
          }
          // No key, version or stale confirmation can bypass an earlier Start/intake claim.
          if (operation === "start") {
            const existing = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
              WHERE tenant_id=$1 AND request_id=$2 AND operation='start' AND entry_kind='claim'`, [this.scope.tenantId, requestId])).rows[0];
            if (existing) { this.#verify(existing); throw conflict(); }
          }
        }
      }
      const parsedBinding = loopBridgeBindingSchemaV1.safeParse({ schemaVersion: 1, body, ...(paidPin?{paidPin}:{}),
        localVersion: Number(local.input.version), adapterId: this.#adapter.adapterId,
        loopRunId: local.link?.loop_run_id ?? this.#adapter.reserveRun(), toolingRevision: this.#adapter.toolingRevision,
        a2SchemaVersion: 1, schemaDigest: this.#adapter.schemaDigest, requestSha256: local.input.request_sha256,
        settingsSha256: local.input.settings_sha256, runLinkId: local.link?.id ?? null,
        authorizationId: local.authorization?.id ?? null, inputVersion: observed?.inputVersion ?? null,
        expectedRevision: observed?.revision ?? null,
        evidence: operation === "approve" ? sha256Digest(observed!.approval) : operation === "answer" ? sha256Digest(observed!.question) : null });
      if (!parsedBinding.success) throw new WebAccessError("invalid_request");
      const binding = parsedBinding.data;
      // PostgreSQL stores jsonb with separator whitespace; qualify that representation too.
      const stored = await tx.query<{ bytes: number }>("SELECT octet_length($1::jsonb::text) AS bytes", [JSON.stringify(binding)]);
      if (Number(stored.rows[0]!.bytes) > 65536) throw new WebAccessError("invalid_request");
      this.#pins(binding, operation); actor.assertTimeCurrent();
      const claim = await this.#insert(tx, { tenant_id: this.scope.tenantId, command_id: `loop-command:${randomBytes(16).toString("hex")}`,
        entry_kind: "claim", request_id: local.root.id, project_id: projectId, owner_identity_id: actor.id, operation,
        idempotency_key: idempotencyKey, binding, result: null, created_at: actor.now });
      return { claim, result: undefined, replayed: false, settingsText: local.input.settings_text, ...(startAdmission?{startAdmission}:{}) };
    });
    // The sweep runs only after this command's dispatch or result, never inside
    // the claim-to-spawn freshness window that a slow cleanup could exhaust.
    try { return await this.#dispatch(identity, projectId, operation, body, preflight, admitted); }
    finally { await this.#sweepCommandFiles(identity, projectId); }
  }
  async #dispatch(identity: VerifiedWebIdentity, projectId: string, operation: LoopBridgeOperationV1,
    body: Record<string, unknown>, preflight: LoopEngineStatusV1 | undefined, admitted: { claim: Row; result: Row | undefined; replayed: boolean; settingsText?: string; startAdmission?:LoopStartAdmissionV1 }) {
    if (admitted.result) {
      await this.#releaseCommandFiles(admitted.claim);
      return this.#receipt(admitted.claim, admitted.result, true);
    }
    if (admitted.replayed) {
      // A positive, exact command receipt can reconcile; run existence or a changed
      // revision cannot. Never execute a committed claim a second time.
      try {
        const status = await this.#adapter.status(admitted.claim.binding.loopRunId);
        return await this.#complete(identity, projectId, admitted.claim, status, true);
      } catch { return this.#receipt(admitted.claim, undefined, true); }
    }
    if (operation === "stop" && preflight?.state === "stopped")
      return this.#complete(identity, projectId, admitted.claim, preflight, false);
    const age = this.clock() - Date.parse(admitted.claim.created_at);
    if (age < 0 || age >= this.#freshness) return this.#receipt(admitted.claim, undefined, false);
    const beforeSpawn = () => {
      const elapsed = this.clock() - Date.parse(admitted.claim.created_at);
      if (elapsed < 0 || elapsed >= this.#freshness) throw unavailable();
    };
    try {
      const { claim } = admitted, b = claim.binding;
      let status: LoopEngineStatusV1;
      switch (operation) {
        case "intake": status = await this.#adapter.intake(claim.command_id, this.#adapter.intakeDriver ? this.#intakeEngineBinding(claim) : b, body.description as string, beforeSpawn, admitted.settingsText!); break;
        case "confirm": status = await this.#adapter.confirmRequest(claim.command_id, b, beforeSpawn, admitted.settingsText!); break;
        case "start": status = await this.#adapter.start(claim.command_id, b, beforeSpawn, admitted.settingsText!, admitted.startAdmission); break;
        case "stop": status = await this.#adapter.stop(claim.command_id, b, beforeSpawn); break;
        case "approve": status = await this.#adapter.approve(claim.command_id, b, beforeSpawn, admitted.settingsText!); break;
        case "answer": status = await this.#adapter.answer(claim.command_id, b, body.text as string, beforeSpawn, admitted.settingsText!); break;
      }
      return await this.#complete(identity, projectId, claim, status, false);
    } catch (error) {
      if (databaseSqlStateIsAnyV1(error, ["40P01", "40001"])) throw error;
      const claim = admitted.claim;
      if (operation === "intake" && error instanceof LoopIntakeRefusalV1 && error.commandId === claim.command_id
        && error.bindingDigest === sha256Digest(this.#adapter.intakeDriver ? this.#intakeEngineBinding(claim) : claim.binding)
        && error.evidenceDigest === loopIntakeRefusalEvidenceV1(claim.command_id, this.#adapter.intakeDriver ? this.#intakeEngineBinding(claim) : claim.binding, error.code)) {
        try {
          this.#pins(claim.binding, "intake");
          const outcome = loopBridgeOutcomeSchemaV1.parse({ state: "refused", revision: 0,
            adapterId: claim.binding.adapterId, loopRunId: claim.binding.loopRunId, toolingRevision: claim.binding.toolingRevision,
            evidenceDigest: loopIntakeRefusalEvidenceV1(claim.command_id,claim.binding,error.code), error: "REFUSED" });
          const result = await this.#desk.loopBridgeTransaction(identity, projectId, true, async ({ tx, actor, lineage }) => {
            if (actor.id !== claim.owner_identity_id) throw new WebAccessError("not_found");
            const raw = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
              WHERE tenant_id=$1 AND command_id=$2 AND entry_kind='claim'`, [claim.tenant_id, claim.command_id])).rows[0];
            if (!raw || !equal(this.#verify(raw), claim)) throw new Error("loop_command_integrity_failed");
            const local = await lineage.loopBridgeLineage(tx, projectId, claim.request_id, actor.id);
            if (local.link || local.authorization) throw conflict();
            return await this.#result(tx, claim) ?? this.#insert(tx, { ...this.#material(claim), entry_kind: "result", result: outcome, created_at: actor.now });
          });
          await this.#releaseCommandFiles(claim);
          return this.#receipt(claim, result, false);
        } catch { /* A lost durable result remains uncertain and keeps its files. */ }
      }
      return this.#receipt(claim, undefined, false);
    }
  }
  async #complete(identity: VerifiedWebIdentity, projectId: string, claim: Row, status: LoopEngineStatusV1, replayed: boolean) {
    const b = claim.binding;
    this.#pins(b, claim.operation);
    if (status.run.loopRunId !== b.loopRunId || status.run.adapterId !== b.adapterId || status.run.toolingRevision !== b.toolingRevision)
      throw unavailable();
    const receipt = status.receipts.find(receipt => receipt.commandId === claim.command_id && (receipt.bindingDigest === sha256Digest(b) || claim.operation === "intake" && this.#adapter.intakeDriver
        && receipt.bindingDigest === sha256Digest(this.#intakeEngineBinding(claim))))
      ?? (claim.operation === "stop" && status.state === "stopped" ? { state: "accepted" as const,
        evidenceDigest: sha256Digest({ run: status.run, state: "stopped", revision: status.revision }), error: null } : undefined);
    if (!receipt) return this.#receipt(claim, undefined, replayed);
    const outcome: LoopBridgeOutcomeV1 = loopBridgeOutcomeSchemaV1.parse({ state: receipt.state, revision: status.revision,
      adapterId: b.adapterId, loopRunId: b.loopRunId, toolingRevision: b.toolingRevision,
      evidenceDigest: receipt.evidenceDigest, error: receipt.error });
    const result = await this.#desk.loopBridgeTransaction(identity, projectId, true, async ({ tx, actor, lineage }) => {
      if (actor.id !== claim.owner_identity_id) throw new WebAccessError("not_found");
      const raw = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
        WHERE tenant_id=$1 AND command_id=$2 AND entry_kind='claim'`, [claim.tenant_id, claim.command_id])).rows[0];
      if (!raw || !equal(this.#verify(raw), claim)) throw new Error("loop_command_integrity_failed");
      const local = await lineage.loopBridgeLineage(tx, projectId, claim.request_id, actor.id);
      const prior = await this.#result(tx, claim); if (prior) return prior;
      if (outcome.state !== "refused") {
        if (claim.operation === "intake") {
          // Admission comes from the exact durable receipt above; progress is display data.
          // A saved admission can precede a failed first planning launch. Keep
          // its run link so reopening the desk can show the blocked-step reason.
          const blockedLaunch = status.state === "refused" && status.progress.attention === "blocked"
            && status.decisions?.gate?.kind === "blocked";
          if (status.settingsSha256 !== b.settingsSha256 || !["draft", "waiting"].includes(status.state) && !blockedLaunch) throw conflict();
          await lineage.recordLoopRunLink({ projectId, requestId: claim.request_id, initialInputVersion: b.localVersion, run: status.run });
        }
        if (claim.operation === "confirm") {
          if (!status.confirmation || status.confirmation.who !== "owner" || status.confirmation.sha256 !== b.requestSha256
            || status.settingsSha256 !== b.settingsSha256 || loopByteHashV1(status.description) !== b.requestSha256
            || !equal(status.inputVersion, b.inputVersion) || Number(local.input.version) !== b.localVersion) throw conflict();
          await lineage.authorizeLoopStart(identity, projectId, { requestId: claim.request_id, expectedVersion: b.localVersion,
            runLinkId: b.runLinkId, requestSha256: b.requestSha256, settingsSha256: b.settingsSha256 },
          `start:${claim.command_id.slice(13)}`, { inputVersion: status.inputVersion, settingsDigest: status.settingsDigest,
            revision: status.revision, confirmation: status.confirmation });
        }
      }
      return this.#insert(tx, { ...this.#material(claim), entry_kind: "result", result: outcome, created_at: actor.now });
    });
    await this.#releaseCommandFiles(claim);
    return this.#receipt(claim, result, replayed);
  }
  async #sweepCommandFiles(identity: VerifiedWebIdentity, projectId: string) {
    // Authorized mutations per owner/project recover the commit-to-cleanup crash
    // window, a bounded page per call until history is exhausted. No result is
    // reconciled and no command is dispatched here. Every non-stop operation writes
    // an expectation file; intake and Start also write their signed settings copy.
    try {
      const finished = await this.#desk.loopBridgeTransaction(identity, projectId, false, async ({ tx, actor }) => {
        const key = canonicalJson([projectId, actor.id]);
        if (this.#swept.has(key)) return undefined;
        const rows = (await tx.query<Row>(`SELECT c.* FROM control_loop_improvement_commands c
          WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.owner_identity_id=$3 AND c.entry_kind='claim'
            AND c.operation IN ('intake','confirm','start','approve','answer') AND c.command_id>$4
            AND EXISTS (SELECT 1 FROM control_loop_improvement_commands r
              WHERE r.tenant_id=c.tenant_id AND r.command_id=c.command_id AND r.entry_kind='result')
          ORDER BY c.command_id LIMIT ${sweepLimit}`,
        [this.scope.tenantId, projectId, actor.id, this.#sweepCursor.get(key) ?? ""])).rows;
        const verified: Row[] = [];
        for (const raw of rows) {
          let claim: Row | undefined;
          try {
            const candidate = this.#verify(raw);
            this.#pins(candidate.binding, candidate.operation);
            claim = candidate;
          } catch { /* Keep unverified or stale commands; continue with other finished rows. */ }
          if (!claim) {
            console.warn("loop_command_sweep_verification_failed");
            continue;
          }
          // A database failure must abort this transaction, not become a skipped row.
          const result = await this.#readResult(tx, claim);
          try {
            if (this.#verifyResult(result, claim)) verified.push(claim);
          } catch {
            console.warn("loop_command_sweep_verification_failed");
          }
        }
        return { key, verified, last: rows.at(-1)?.command_id, done: rows.length < sweepLimit };
      });
      if (!finished) return;
      for (const claim of finished.verified) await this.#releaseCommandFiles(claim);
      if (finished.done) this.#swept.add(finished.key);
      else if (finished.last) this.#sweepCursor.set(finished.key, finished.last);
    } catch { /* Best-effort cleanup cannot change the admitted command's result. */ }
  }
  async #releaseCommandFiles(claim: Row) {
    // Cleanup cannot undo the committed receipt; an exact replay retries a failed cleanup.
    try { await this.#adapter.releaseCommandFiles?.(claim.command_id); } catch { /* Retain for an authorized retry. */ }
  }
  close() { return this.#adapter.close(); }
}
