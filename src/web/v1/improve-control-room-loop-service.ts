import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { ImproveControlRoomDeskServiceV1 } from "../../improve-control-room/v1/service";
import { loopBridgeBindingSchemaV1, loopBridgeBodiesV1, loopBridgeOperationSchemaV1, loopBridgeOutcomeSchemaV1,
  loopBridgeReceiptSchemaV1, loopImprovementStatusSchemaV1, type LoopBridgeBindingV1, type LoopBridgeOperationV1, type LoopBridgeOutcomeV1 } from "../../improve-control-room/v1/schemas";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { currentLoopGate, loopAttentionSourceSchemaV1, loopDecisionStatusSchemaV1, loopApprovalDocumentSchemaV1,
  loopImprovementDecisionsSchemaV1, unavailableLoopGate, loopDocumentBinding, type LoopDecisionStatusV1, type LoopAttentionItemV1 } from "./improve-control-room-loop-attention-wire";
import { loopRecoveryBindingSchemaV1, loopByteHashV1, type LoopAdapterV1, type LoopEngineStatusV1 } from "./improve-control-room-loop-adapter";

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
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameTag = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const conflict = () => new WebAccessError("conflict");
const unavailable = () => new Error("loop_bridge_contract_unavailable");
/** The loop desk verifies legacy pipeline templates and requests with the loop
 * key, so a composition with pipelines must use one key for both. */
export const loopKeyMatchesLegacyKeyV1 = (loopKey: Uint8Array, legacyKey: Uint8Array) =>
  loopKey.length === legacyKey.length && timingSafeEqual(loopKey, legacyKey);
export type LoopBridgeConfigurationV1 = { integrityKey: Uint8Array; adapter: LoopAdapterV1; admissionFreshnessMs?: number };
type Lineage = Awaited<ReturnType<ImproveControlRoomDeskServiceV1["loopBridgeLineage"]>>;

/** Owner authority and an append-only, signed one-attempt journal. A committed
 * claim is never retried as execution, even after a lost process or response. */
export class ImproveControlRoomLoopServiceV1 {
  readonly #desk: ImproveControlRoomDeskServiceV1;
  readonly #key: Uint8Array;
  readonly #adapter: LoopAdapterV1;
  readonly #freshness: number;
  readonly #swept = new Set<string>();
  readonly #sweepCursor = new Map<string, string>();
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    configuration: LoopBridgeConfigurationV1, private readonly clock: () => number = Date.now) {
    if (!(configuration.integrityKey instanceof Uint8Array) || configuration.integrityKey.length !== 32) throw unavailable();
    this.#key = Uint8Array.from(configuration.integrityKey); this.#adapter = configuration.adapter;
    this.#freshness = configuration.admissionFreshnessMs ?? 5000;
    if (!Number.isSafeInteger(this.#freshness) || this.#freshness < 1 || this.#freshness > 5000) throw unavailable();
    this.#desk = new ImproveControlRoomDeskServiceV1(db, scope, this.#key, undefined, clock, this.#adapter.contract);
  }
  #material(row: Row) { const { record_digest: _digest, auth_tag: _tag, ...material } = row; return material; }
  #verify(raw: Row) {
    let row: Row;
    try { row = rowSchema.parse({ ...raw, created_at: new Date(raw.created_at).toISOString() }); } catch { throw new Error("loop_command_integrity_failed"); }
    const material = this.#material(row);
    if (row.tenant_id !== this.scope.tenantId || sha256Digest(material) !== row.record_digest
      || !sameTag(hmacSha256Tag(this.#key, { purpose, record: material }), row.auth_tag)
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
  #pins(binding: LoopBridgeBindingV1, operation: LoopBridgeOperationV1) {
    if (binding.adapterId !== this.#adapter.adapterId || binding.toolingRevision !== this.#adapter.toolingRevision
      || binding.schemaDigest !== this.#adapter.schemaDigest
      || operation !== "stop" && binding.settingsSha256 !== loopByteHashV1(this.#adapter.settingsText)) throw unavailable();
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
      || status.run.loopRunId !== this.#run(lineage).loopRunId || status.settingsSha256 !== lineage.input.settings_sha256
      || status.settingsSha256 !== loopByteHashV1(this.#adapter.settingsText)) throw conflict();
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
              AND e.command_id=s.command_id AND e.entry_kind='result')))
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
    if (signal.aborted || !this.#adapter.inspectRecovery || !this.#adapter.recover) return blocked;
    let snapshot=await this.db.transaction(tx=>this.#recoverySnapshot(tx,target));
    for (const claim of snapshot.claims) {
      if (signal.aborted) return blocked;
      if (snapshot.results.get(claim.command_id)) continue;
      // Intake/confirm result commits also create lineage. Only authenticated
      // exact replay through #complete may perform that atomic transaction.
      if (claim.operation==='intake' || claim.operation==='confirm') return blocked;
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
  viewDesk(identity: VerifiedWebIdentity, projectId: string) {
    if (!id.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    return this.#desk.viewLoopDesk(identity, projectId);
  }
  async status(identity: VerifiedWebIdentity, projectId: string, requestId: string) {
    if (!id.safeParse(projectId).success || !id.safeParse(requestId).success) throw new WebAccessError("invalid_request");
    // Authorization and signed lineage are checked before any external read. GET never adopts or reconciles.
    const { lineage, startClaim, startResult, mayWrite, pending } = await this.#desk.loopBridgeTransaction(identity, projectId, false, async ({ tx, actor, lineage: reader }) => {
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
      const mayWrite = actor.can("tasks.propose", projectId, true, "high");
      return { lineage, pending, startClaim, startResult: startClaim ? await this.#result(tx, startClaim) : undefined, mayWrite };
    });
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
      : state === "blocked" ? { code: "BLOCKED", message: "The saved run is blocked.", nextAction: "Review the saved run before continuing." }
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
    const display = loopImprovementStatusSchemaV1.parse({ schemaVersion: 1, projectId, requestId,
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
    return loopDecisionStatusSchemaV1.parse({ schemaVersion: 1, request: lineage.view, display,
      decisions: loopImprovementDecisionsSchemaV1.parse(recoveryTerminal ? { gate: null, observedAt: display.observedAt } : recoveryUnavailable ? { gate: recoveryInputChanged ? { kind: 'blocked', code: 'INPUT_CHANGED', message: 'The saved run inputs have changed. Check the saved request.' } : unavailableLoopGate(), observedAt: display.observedAt } : current.decisions ?? { gate: unavailableLoopGate(), observedAt: display.observedAt }), engine: { revision: current.revision, state: current.state,
      draft: current.description, requestSha256: loopByteHashV1(current.description), settingsSha256: current.settingsSha256,
      inputVersion: current.inputVersion, confirmation: current.confirmation ? { sha256: current.confirmation.sha256,
        at: current.confirmation.at, who: current.confirmation.who, inputVersion: current.confirmation.input_version } : null,
      progress: current.progress, approval: current.approval, question: current.question, identity: "unverified" } });
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
          const status = await this.status(identity, request.projectId, request.requestId), gate = currentLoopGate(status);
          if (!gate) continue;
          if (gate.kind === "blocked") { items[index] = blocked(gate.code, status.engine.revision, status); continue; }
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
    if (!id.safeParse(projectId).success || requestId !== null && !id.safeParse(requestId).success
      || !keySchema.safeParse(idempotencyKey).success || (operation === "intake") !== (requestId === null)) throw new WebAccessError("invalid_request");
    const parsed = loopBridgeBodiesV1[operation].safeParse(input);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    const body = parsed.data as Record<string, unknown>;
    let preflight: LoopEngineStatusV1 | undefined;
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
        if (!this.#adapter.available(operation)) throw unavailable();
        if (body.expectedVersion !== Number(local.input.version)) throw conflict();
        if (operation === "start" && body.runLinkId !== local.link?.id) throw new WebAccessError("not_found");
        if (["start", "approve", "answer"].includes(operation) && !local.authorization) throw conflict();
        return { local, replay: false };
      });
      if (!snapshot.replay) preflight = await this.#adapter.status(this.#run(snapshot.local).loopRunId);
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
      let local: Lineage;
      let observed: LoopEngineStatusV1 | undefined;
      if (requestId === null) {
        const draft = await lineage.saveLoopDraft(identity, projectId, { description: body.description,
          settingsText: this.#adapter.settingsText }, idempotencyKey);
        local = await lineage.loopBridgeLineage(tx, projectId, draft.request.requestId, actor.id);
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
              await lineage.reviseLoopDraft(identity, projectId, { requestId, expectedVersion: Number(local.input.version),
                description: observed.description, settingsText: this.#adapter.settingsText }, idempotencyKey);
              local = await lineage.loopBridgeLineage(tx, projectId, requestId, actor.id);
            }
            const priorConfirmation = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
              WHERE tenant_id=$1 AND request_id=$2 AND operation='confirm' AND entry_kind='claim'
                AND binding->>'localVersion'=$3 LIMIT 1`, [this.scope.tenantId, requestId, String(local.input.version)])).rows[0];
            if (priorConfirmation) this.#verify(priorConfirmation);
            if (local.authorization || priorConfirmation) throw conflict();
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
      const binding = loopBridgeBindingSchemaV1.parse({ schemaVersion: 1, body,
        localVersion: Number(local.input.version), adapterId: this.#adapter.adapterId,
        loopRunId: local.link?.loop_run_id ?? this.#adapter.reserveRun(), toolingRevision: this.#adapter.toolingRevision,
        a2SchemaVersion: 1, schemaDigest: this.#adapter.schemaDigest, requestSha256: local.input.request_sha256,
        settingsSha256: local.input.settings_sha256, runLinkId: local.link?.id ?? null,
        authorizationId: local.authorization?.id ?? null, inputVersion: observed?.inputVersion ?? null,
        expectedRevision: observed?.revision ?? null,
        evidence: operation === "approve" ? sha256Digest(observed!.approval) : operation === "answer" ? sha256Digest(observed!.question) : null });
      this.#pins(binding, operation); actor.assertTimeCurrent();
      const claim = await this.#insert(tx, { tenant_id: this.scope.tenantId, command_id: `loop-command:${randomBytes(16).toString("hex")}`,
        entry_kind: "claim", request_id: local.root.id, project_id: projectId, owner_identity_id: actor.id, operation,
        idempotency_key: idempotencyKey, binding, result: null, created_at: actor.now });
      return { claim, result: undefined, replayed: false };
    });
    // The sweep runs only after this command's dispatch or result, never inside
    // the claim-to-spawn freshness window that a slow cleanup could exhaust.
    try { return await this.#dispatch(identity, projectId, operation, body, preflight, admitted); }
    finally { await this.#sweepCommandFiles(identity, projectId); }
  }
  async #dispatch(identity: VerifiedWebIdentity, projectId: string, operation: LoopBridgeOperationV1,
    body: Record<string, unknown>, preflight: LoopEngineStatusV1 | undefined, admitted: { claim: Row; result: Row | undefined; replayed: boolean }) {
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
        case "intake": status = await this.#adapter.intake(claim.command_id, b, body.description as string, beforeSpawn); break;
        case "confirm": status = await this.#adapter.confirmRequest(claim.command_id, b, beforeSpawn); break;
        case "start": status = await this.#adapter.start(claim.command_id, b, beforeSpawn); break;
        case "stop": status = await this.#adapter.stop(claim.command_id, b, beforeSpawn); break;
        case "approve": status = await this.#adapter.approve(claim.command_id, b, beforeSpawn); break;
        case "answer": status = await this.#adapter.answer(claim.command_id, b, body.text as string, beforeSpawn); break;
      }
      return await this.#complete(identity, projectId, claim, status, false);
    } catch { return this.#receipt(admitted.claim, undefined, false); }
  }
  async #complete(identity: VerifiedWebIdentity, projectId: string, claim: Row, status: LoopEngineStatusV1, replayed: boolean) {
    const b = claim.binding;
    this.#pins(b, claim.operation);
    if (status.run.loopRunId !== b.loopRunId || status.run.adapterId !== b.adapterId || status.run.toolingRevision !== b.toolingRevision)
      throw unavailable();
    const receipt = status.receipts.find(receipt => receipt.commandId === claim.command_id && receipt.bindingDigest === sha256Digest(b))
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
          if (status.settingsSha256 !== b.settingsSha256 || !["draft", "waiting"].includes(status.state)) throw conflict();
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
    // reconciled and no command is dispatched here. Only intake and answer write
    // command folders; other finished claims have nothing to release.
    try {
      const finished = await this.#desk.loopBridgeTransaction(identity, projectId, false, async ({ tx, actor }) => {
        const key = canonicalJson([projectId, actor.id]);
        if (this.#swept.has(key)) return undefined;
        const rows = (await tx.query<Row>(`SELECT c.* FROM control_loop_improvement_commands c
          WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.owner_identity_id=$3 AND c.entry_kind='claim'
            AND c.operation IN ('intake','answer') AND c.command_id>$4
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
