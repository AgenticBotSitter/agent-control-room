import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { ImproveControlRoomDeskServiceV1 } from "../../improve-control-room/v1/service";
import { loopBridgeBindingSchemaV1, loopBridgeBodiesV1, loopBridgeOperationSchemaV1, loopBridgeOutcomeSchemaV1,
  loopBridgeReceiptSchemaV1, type LoopBridgeBindingV1, type LoopBridgeOperationV1, type LoopBridgeOutcomeV1 } from "../../improve-control-room/v1/schemas";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { loopByteHashV1, type LoopAdapterV1, type LoopEngineStatusV1 } from "./improve-control-room-loop-adapter";

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
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameTag = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const conflict = () => new WebAccessError("conflict");
const unavailable = () => new Error("loop_bridge_contract_unavailable");
export type LoopBridgeConfigurationV1 = { integrityKey: Uint8Array; adapter: LoopAdapterV1; admissionFreshnessMs?: number };
type Lineage = Awaited<ReturnType<ImproveControlRoomDeskServiceV1["loopBridgeLineage"]>>;

/** Owner authority and an append-only, signed one-attempt journal. A committed
 * claim is never retried as execution, even after a lost process or response. */
export class ImproveControlRoomLoopServiceV1 {
  readonly #desk: ImproveControlRoomDeskServiceV1;
  readonly #key: Uint8Array;
  readonly #adapter: LoopAdapterV1;
  readonly #freshness: number;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
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
  async #result(tx: DatabaseSession, claim: Row) {
    const raw = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
      WHERE tenant_id=$1 AND command_id=$2 AND entry_kind='result'`, [claim.tenant_id, claim.command_id])).rows[0];
    if (!raw) return undefined;
    const row = this.#verify(raw);
    for (const name of ["tenant_id", "command_id", "request_id", "project_id", "owner_identity_id", "operation", "idempotency_key", "binding"] as const)
      if (!equal(row[name], claim[name])) throw new Error("loop_command_integrity_failed");
    return row;
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
  #current(status: LoopEngineStatusV1, lineage: Lineage, body: Record<string, unknown>, confirmed: boolean) {
    if (body.expectedVersion !== Number(lineage.input.version) || body.expectedRevision !== status.revision
      || status.run.loopRunId !== this.#run(lineage).loopRunId || status.settingsSha256 !== lineage.input.settings_sha256
      || status.settingsSha256 !== loopByteHashV1(this.#adapter.settingsText)) throw conflict();
    if (confirmed) {
      const authorization = lineage.authorization;
      if (!authorization || !status.confirmation || status.confirmation.who !== "owner"
        || status.confirmation.sha256 !== lineage.input.request_sha256 || loopByteHashV1(status.description) !== lineage.input.request_sha256
        || !equal(status.inputVersion, status.confirmation.input_version)
        || !equal(authorization.a2_input_version, status.inputVersion) || !equal(authorization.confirmation, status.confirmation)
        || authorization.a2_settings_digest !== status.settingsDigest || status.state === "stopped"
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
  async status(identity: VerifiedWebIdentity, projectId: string, requestId: string) {
    if (!id.safeParse(projectId).success || !id.safeParse(requestId).success) throw new WebAccessError("invalid_request");
    // Authorization and signed lineage are checked before any external read. GET never adopts or reconciles.
    const lineage = await this.#desk.loopBridgeTransaction(identity, projectId, false, async ({ tx, actor, lineage }) =>
      lineage.loopBridgeLineage(tx, projectId, requestId, actor.id));
    const current = await this.#adapter.status(this.#run(lineage).loopRunId);
    return { schemaVersion: 1, request: lineage.view, engine: { revision: current.revision, state: current.state,
      draft: current.description, requestSha256: loopByteHashV1(current.description), settingsSha256: current.settingsSha256,
      inputVersion: current.inputVersion, confirmation: current.confirmation ? { sha256: current.confirmation.sha256,
        at: current.confirmation.at, who: current.confirmation.who, inputVersion: current.confirmation.input_version } : null,
      progress: current.progress, approval: current.approval, question: current.question, identity: "unverified" } };
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
    if (requestId !== null) {
      const snapshot = await this.#desk.loopBridgeTransaction(identity, projectId, true, async ({ tx, actor, lineage }) => {
        const local = await lineage.loopBridgeLineage(tx, projectId, requestId, actor.id);
        const prior = (await tx.query<Row>(`SELECT * FROM control_loop_improvement_commands
          WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3 AND entry_kind='claim'`,
        [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
        if (prior) { this.#verify(prior); return { local, replay: true }; }
        if (!this.#adapter.available(operation)) throw unavailable();
        if (operation !== "stop" && body.expectedVersion !== Number(local.input.version)) throw conflict();
        if ((operation === "stop" || operation === "start") && body.runLinkId !== local.link?.id) throw new WebAccessError("not_found");
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
        if (!observed || observed.run.loopRunId !== run.loopRunId) throw conflict();
        if (operation === "stop") {
          if (body.runLinkId !== local.link!.id) throw new WebAccessError("not_found");
        } else this.#current(observed, local, body, operation !== "confirm");
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
          if (status.settingsSha256 !== b.settingsSha256 || !["draft", "waiting"].includes(status.state)
            || status.progress.step !== null && status.progress.step !== "intake") throw conflict();
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
  async #releaseCommandFiles(claim: Row) {
    // Cleanup cannot undo the committed receipt; an exact replay retries a failed cleanup.
    try { await this.#adapter.releaseCommandFiles?.(claim.command_id); } catch { /* Retain for an authorized retry. */ }
  }
  close() { return this.#adapter.close(); }
}
