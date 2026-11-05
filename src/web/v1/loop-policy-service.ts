import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { databaseSqlStateIsAnyV1, type DatabaseClient, type DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority } from "./session-authority";
import { composeLoopSettingsV1, parseLoopSettingsV1, parseSuppliedLoopSettingsV1, normalizeLoopLockedPathsV1, validateLoopLockedPathsV1, differingLoopLockedPathsV1 } from "./loop-policy-compose";
import { normalizeSelectionRunEditsV1, type LoopSelectionProjectionV1 } from "./loop-selection-wire";
import type { LoopBridgeBindingV1 } from "../../improve-control-room/v1/schemas";

export type LoopPolicyCheckV1 = { eligible: boolean; reasons: { code: string; explanation: string }[] };
export type LoopSelectionCheckContextV1 = Readonly<{ mode: "preview"; sameFamilyIntent: boolean }>
  | Readonly<{ mode: "admission"; binding: LoopBridgeBindingV1; commandId: string }>;
export type LoopSelectionCheckExecutionV1 = Readonly<{ signal: AbortSignal; timeoutMs: number }>;
import type { SelectionSnapshotV1 } from "./loop-selection-service";
export type LoopPolicyCheckWithV1 = LoopPolicyCheckV1 & { projection?: LoopSelectionProjectionV1; snapshot?: SelectionSnapshotV1 };
export class LoopPolicyRefusedV1 extends Error {
  constructor(readonly reasons: LoopPolicyCheckV1["reasons"]) { super("loop_policy_refused"); }
}
const fields = { expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), settings: z.string() };
const projectBodySchema = z.object({ ...fields, lockedPaths: z.array(z.string()) }).strict();
const selectionBodySchema = z.object({ ...fields, waiverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/).optional() }).strict();
const waiverBodySchema = z.object({path:z.string(),reason:z.string().min(1).max(500).refine(v=>v.trim().length>0),expiresAt:z.string().datetime({offset:true})}).strict();
type WaiverRow = { id: string; project_id: string; path: string; reason: string; created_by: string;
  created_at: string | Date; expires_at: string | Date; revoked_at: string | Date | null; consumed_by_request_id: string | null; live: boolean };
const policyLocked = (path = '') => new LoopPolicyRefusedV1([{code:'POLICY_LOCKED',explanation:path}]);
const waiverInvalid = () => new LoopPolicyRefusedV1([{code:'WAIVER_INVALID',explanation:'Waiver is not valid for this request'}]);
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/;
const keySyntax = /^[A-Za-z0-9:_-]{16,100}$/;
type Layer = "project" | "selection";
type LayerRow = { layer: Layer; version: string | number; settings_text: string; settings_sha256: string;
  last_idempotency_key: string; last_request_digest: string; locked_paths: string[] };
export type LoopPolicySnapshotV1 = { defaultsSha256: string; layerVersions: { project: number; selection: number }; text: string; sha256: string; waiverId?: string; lockedPath?: string };
const conflict = () => new WebAccessError("conflict");
export function rethrowLoopPolicyErrorV1(error: unknown): never {
  if (databaseSqlStateIsAnyV1(error, ["40P01", "40001", "42501", "23514"])) throw conflict();
  throw error;
}

export class LoopPolicyServiceV1 {
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly tools: { readonly settingsText: string; checkSettings?(text: string, context?: LoopSelectionCheckContextV1, execution?: LoopSelectionCheckExecutionV1): Promise<LoopPolicyCheckWithV1> },
    clock: () => number = Date.now,
    private readonly providers?: { revalidateSettings(tx: DatabaseSession, text: string): Promise<void> }) { this.#authority = new WebSessionAuthority(db, scope, clock, "loop_policy"); }

  async #scope(tx: DatabaseSession, projectId: string, write: boolean) {
    if (write) await tx.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
      [this.scope.tenantId, this.scope.workspaceId, projectId]);
    const row = (await tx.query<{ lifecycle: string; template_id: string }>(`SELECT h.lifecycle,
      p.payload->'presentation'->>'templateId' AS template_id FROM projects p JOIN control_manual_project_heads h
      ON h.tenant_id=p.tenant_id AND h.project_id=p.id WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
    [this.scope.tenantId, this.scope.workspaceId, projectId])).rows[0];
    if (!row || row.template_id !== "control-room") throw new WebAccessError("not_found");
    if (row.lifecycle !== "active") throw conflict();
  }
  async #layers(tx: DatabaseSession, projectId: string, lock: boolean) {
    // Explicit order, including missing rows. The project mutex serializes first saves.
    const rows: Partial<Record<Layer, LayerRow>> = {};
    for (const layer of ["project", "selection"] as const) {
      const row = (await tx.query<LayerRow>(`SELECT * FROM control_loop_policy_layers
        WHERE tenant_id=$1 AND project_id=$2 AND layer=$3${lock ? " FOR UPDATE" : ""}`,
      [this.scope.tenantId, projectId, layer])).rows[0];
      if (row) {
        if (!Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1
          || createHash("sha256").update(row.settings_text).digest("hex") !== row.settings_sha256) throw new Error("loop_policy_integrity_failed");
        parseLoopSettingsV1(row.settings_text, true); normalizeLoopLockedPathsV1(row.locked_paths); rows[layer] = row;
      }
    }
    return rows;
  }
  #compose(rows: Partial<Record<Layer, LayerRow>>, runEdits?: string, replacement?: { layer: Layer; settings: string }): LoopPolicySnapshotV1 {
    if (runEdits !== undefined) runEdits = normalizeSelectionRunEditsV1(runEdits);
    const defaultsText = this.tools.settingsText;
    const composed = composeLoopSettingsV1({ defaultsText,
      storedLayers: { project: rows.project?.settings_text, selection: rows.selection?.settings_text },
      project: replacement?.layer === "project" ? replacement.settings : undefined,
      selection: replacement?.layer === "selection" ? replacement.settings : undefined, runEdits });
    return { ...composed, defaultsSha256: createHash("sha256").update(defaultsText).digest("hex"),
      layerVersions: { project: Number(rows.project?.version ?? 0), selection: Number(rows.selection?.version ?? 0) } };
  }
  /** The caller already holds authority, project and head locks in that order. */
  async snapshot(tx: DatabaseSession, projectId: string, runEdits?: string, waiverId?: string): Promise<LoopPolicySnapshotV1> {
    const rows = await this.#layers(tx, projectId, true);
    const snapshot = this.#compose(rows, runEdits);
    const lockedPath = await this.#locks(tx, projectId, rows, snapshot.text, waiverId);
    if (waiverId) { snapshot.waiverId = waiverId; snapshot.lockedPath = lockedPath; }
    await this.#revalidate(tx, snapshot.text);
    return snapshot;
  }
  async #revalidate(tx: DatabaseSession, text: string) {
    if (!Object.hasOwn(parseLoopSettingsV1(text), "providerRoute")) return;
    if (!this.providers) throw new LoopPolicyRefusedV1([{ code: "PROVIDER_UNAVAILABLE", explanation: "Provider validation unavailable" }]);
    await this.providers.revalidateSettings(tx, text);
  }
  /** Caller supplies a consistent read transaction; no layer write locks for preview. */
  async snapshotRead(tx: DatabaseSession, projectId: string, runEdits?: string): Promise<LoopPolicySnapshotV1> {
    return this.#compose(await this.#layers(tx, projectId, false), runEdits);
  }
  async checkWith(text: string, context: LoopSelectionCheckContextV1, execution?: LoopSelectionCheckExecutionV1): Promise<LoopPolicyCheckWithV1> {
    if (!this.tools.checkSettings) throw new Error("loop_policy_check_unavailable");
    return this.tools.checkSettings(text, context, execution);
  }
  assertSnapshot(before: LoopPolicySnapshotV1, after: LoopPolicySnapshotV1) {
    if (before.defaultsSha256 !== after.defaultsSha256 || before.layerVersions.project !== after.layerVersions.project
      || before.layerVersions.selection !== after.layerVersions.selection || before.text !== after.text || before.sha256 !== after.sha256) throw conflict();
  }
  async check(snapshot: Pick<LoopPolicySnapshotV1, "text">) {
    if (!this.tools.checkSettings) throw new Error("loop_policy_check_unavailable");
    const result = await this.tools.checkSettings(snapshot.text);
    if (!result.eligible) throw new LoopPolicyRefusedV1(result.reasons);
  }
  async view(identity: VerifiedWebIdentity, projectId: string) {
    if (!id.test(projectId)) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("loop_policy.read", projectId); await this.#scope(tx, projectId, false);
      const rows = await this.#layers(tx, projectId, false);
      const value = (layer: Layer) => ({ version: Number(rows[layer]?.version ?? 0), settingsText: rows[layer]?.settings_text ?? "{}" });
      return { project: { ...value("project"), lockedPaths: rows.project?.locked_paths ?? [] }, selection: value("selection") };
    }, { readOnly: true });
  }
  async put(identity: VerifiedWebIdentity, projectId: string, layer: string, input: unknown, key: string) {
    try { return await this.#put(identity, projectId, layer, input, key); } catch (error) { rethrowLoopPolicyErrorV1(error); }
  }
  async #put(identity: VerifiedWebIdentity, projectId: string, layerInput: string, input: unknown, key: string) {
    const parsed = (layerInput === "project" ? projectBodySchema : selectionBodySchema).safeParse(input);
    if (!id.test(projectId) || !["project", "selection"].includes(layerInput) || !keySyntax.test(key) || !parsed.success)
      throw new WebAccessError("invalid_request");
    const layer = layerInput as Layer, body = parsed.data;
    parseSuppliedLoopSettingsV1(body.settings, true);
    const lockedPaths = 'lockedPaths' in body ? normalizeLoopLockedPathsV1(body.lockedPaths) : [];
    if ('lockedPaths' in body) body.lockedPaths = lockedPaths;
    const waiverId = 'waiverId' in body ? body.waiverId : undefined;
    const validate = async (tx: DatabaseSession, rows: Partial<Record<Layer, LayerRow>>, snapshot: LoopPolicySnapshotV1) => {
      if (layer === 'project') validateLoopLockedPathsV1(composeLoopSettingsV1({defaultsText:this.tools.settingsText,project:body.settings}).text,lockedPaths);
      else await this.#locks(tx,projectId,rows,snapshot.text,waiverId);
    };
    const digest = sha256Digest({ projectId, layer, body });
    const replay = (rows: Partial<Record<Layer, LayerRow>>) => {
      const row = rows[layer];
      if (row?.last_idempotency_key !== key) return undefined;
      if (row.last_request_digest !== digest) throw conflict();
      return { replayed: true, version: Number(row.version) };
    };
    const read = () => this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("loop_policy.manage", projectId, true, "high"); await this.#scope(tx, projectId, true);
      const rows = await this.#layers(tx, projectId, true), again = replay(rows);
      if (again) return { replay: again };
      if (Number(rows[layer]?.version ?? 0) !== body.expectedVersion) throw conflict();
      const snapshot = this.#compose(rows, undefined, { layer, settings: body.settings });
      await validate(tx, rows, snapshot);
      await this.#revalidate(tx, snapshot.text);
      return { snapshot };
    });
    const before = await read(); if (before.replay) return before.replay;
    await this.check(before.snapshot!);
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("loop_policy.manage", projectId, true, "high"); await this.#scope(tx, projectId, true);
      const rows = await this.#layers(tx, projectId, true), again = replay(rows);
      if (again) return again;
      if (Number(rows[layer]?.version ?? 0) !== body.expectedVersion) throw conflict();
      const snapshot = this.#compose(rows, undefined, { layer, settings: body.settings });
      await validate(tx, rows, snapshot);
      this.assertSnapshot(before.snapshot!, snapshot);
      await this.#revalidate(tx, snapshot.text);
      const next = body.expectedVersion + 1, hash = createHash("sha256").update(body.settings).digest("hex");
      const params = [this.scope.tenantId, projectId, layer, next, body.settings, hash, actor.id, actor.now, key, digest];
      const saved = rows[layer] ? await tx.query(`UPDATE control_loop_policy_layers SET version=$4,settings_text=$5,settings_sha256=$6,
        updated_by=$7,updated_at=$8,last_idempotency_key=$9,last_request_digest=$10,locked_paths=$12::jsonb WHERE tenant_id=$1 AND project_id=$2 AND layer=$3
        AND version=$11 RETURNING version`, [...params, body.expectedVersion, JSON.stringify(lockedPaths)])
        : await tx.query(`INSERT INTO control_loop_policy_layers(tenant_id,project_id,layer,version,settings_text,settings_sha256,
          updated_by,updated_at,last_idempotency_key,last_request_digest,locked_paths) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          ON CONFLICT (tenant_id,project_id,layer) DO NOTHING RETURNING version`, [...params, JSON.stringify(lockedPaths)]);
      if (saved.rows.length !== 1) throw conflict();
      await tx.query(`INSERT INTO control_loop_policy_events(tenant_id,project_id,id,layer,version,before_sha256,after_sha256,actor_id,request_digest,at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [this.scope.tenantId, projectId, `policy-event:${randomBytes(16).toString("hex")}`,
        layer, next, rows[layer]?.settings_sha256 ?? null, hash, actor.id, digest, actor.now]);
      return { replayed: false, version: next };
    });
  }
  async #waiver(tx: DatabaseSession, projectId: string, waiverId: string) {
    return (await tx.query<WaiverRow>(`SELECT *, expires_at > statement_timestamp() AS live FROM control_loop_policy_waivers
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [this.scope.tenantId,projectId,waiverId])).rows[0];
  }
  async #locks(tx: DatabaseSession, projectId: string, rows: Partial<Record<Layer, LayerRow>>, text: string, waiverId?: string) {
    const base = composeLoopSettingsV1({defaultsText:this.tools.settingsText,storedLayers:{project:rows.project?.settings_text}}).text;
    const violations = differingLoopLockedPathsV1(base,text,rows.project?.locked_paths ?? []);
    if (!waiverId) { if (violations.length) throw policyLocked(violations[0]); return undefined; }
    const waiver = await this.#waiver(tx,projectId,waiverId);
    if (!waiver || !waiver.live || waiver.revoked_at || waiver.consumed_by_request_id || violations.length !== 1 || violations[0] !== waiver.path)
      throw policyLocked(violations[0]);
    return waiver.path;
  }
  async consumeWaiver(tx: DatabaseSession, projectId: string, requestId: string, snapshot: LoopPolicySnapshotV1) {
    if (!snapshot.waiverId) return;
    const result = await tx.query(`UPDATE control_loop_policy_waivers SET consumed_by_request_id=$3
      WHERE tenant_id=$1 AND project_id=$2 AND id=$4 AND path=$5 AND revoked_at IS NULL
      AND consumed_by_request_id IS NULL AND expires_at > statement_timestamp() RETURNING id`,
      [this.scope.tenantId,projectId,requestId,snapshot.waiverId,snapshot.lockedPath]);
    if (result.rows.length !== 1) throw policyLocked(snapshot.lockedPath);
  }
  async validateStartWaiver(tx: DatabaseSession, projectId: string, requestId: string, inputVersion: number) {
    const source = (await tx.query<{waiver_id:string|null}>(`SELECT waiver_id FROM control_loop_policy_input_sources
      WHERE tenant_id=$1 AND request_id=$2 AND input_version=$3`,[this.scope.tenantId,requestId,inputVersion])).rows[0];
    if (!source?.waiver_id) return;
    const waiver = await this.#waiver(tx,projectId,source.waiver_id);
    if (!waiver || !waiver.live || waiver.revoked_at || waiver.consumed_by_request_id !== requestId) throw waiverInvalid();
  }
  async createWaiver(identity: VerifiedWebIdentity, projectId: string, input: unknown, key: string) {
    const parsed = waiverBodySchema.safeParse(input);
    if (!id.test(projectId) || !keySyntax.test(key) || !parsed.success) throw new WebAccessError('invalid_request');
    const body = parsed.data; normalizeLoopLockedPathsV1([body.path]);
    try { assertNoSecretMaterial(body); } catch { throw new WebAccessError('invalid_request'); }
    try { return await this.#authority.authenticated(identity,async(tx,actor)=>{
      actor.require('loop_policy.manage',projectId,true,'high'); await this.#scope(tx,projectId,true);
      const waiverId = 'policy-waiver:'+sha256Digest({tenant:this.scope.tenantId,projectId,actor:actor.id,key}).slice(7);
      const before = await this.#waiver(tx,projectId,waiverId);
      const view = (row:WaiverRow) => ({id:row.id,path:row.path,reason:row.reason,createdBy:row.created_by,
        createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()});
      if (before) {
        if (before.path !== body.path || before.reason !== body.reason) throw conflict();
        // Compare at database precision: Date would erase a changed submillisecond expiry.
        const sameExpiry = (await tx.query<{ matches: boolean }>(`SELECT expires_at=$4::timestamptz AS matches
          FROM control_loop_policy_waivers WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
        [this.scope.tenantId,projectId,waiverId,body.expiresAt])).rows[0]?.matches;
        if (sameExpiry !== true) throw conflict();
        return {replayed:true,waiver:view(before)};
      }
      const duration = Date.parse(body.expiresAt)-Date.parse(actor.now);
      if (duration <= 0 || duration > 7*86400000) throw new WebAccessError('invalid_request');
      const row = (await tx.query<WaiverRow>(`INSERT INTO control_loop_policy_waivers(tenant_id,project_id,id,path,reason,created_by,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[this.scope.tenantId,projectId,waiverId,body.path,body.reason,actor.id,actor.now,body.expiresAt])).rows[0]!;
      return {replayed:false,waiver:view(row)};
    }); } catch(error) { rethrowLoopPolicyErrorV1(error); }
  }
  async revokeWaiver(identity: VerifiedWebIdentity, projectId: string, waiverId: string) {
    if (!id.test(projectId) || !id.test(waiverId)) throw new WebAccessError('invalid_request');
    try { await this.#authority.authenticated(identity,async(tx,actor)=>{
      actor.require('loop_policy.manage',projectId,true,'high'); await this.#scope(tx,projectId,true);
      if (!await this.#waiver(tx,projectId,waiverId)) throw new WebAccessError('not_found');
      await tx.query(`UPDATE control_loop_policy_waivers SET revoked_at=statement_timestamp()
        WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND revoked_at IS NULL`,[this.scope.tenantId,projectId,waiverId]);
    }); } catch(error) { rethrowLoopPolicyErrorV1(error); }
  }
  async recordInputSources(tx: DatabaseSession, value: { requestId: string; inputVersion: number; defaultsSha256: string;
    layerVersions: { project: number; selection: number }; waiverId: string | null }) {
    await tx.query(`INSERT INTO control_loop_policy_input_sources(tenant_id,request_id,input_version,defaults_sha256,layer_versions,waiver_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [this.scope.tenantId, value.requestId, value.inputVersion, value.defaultsSha256,
      JSON.stringify(value.layerVersions), value.waiverId]);
  }
  async copyInputSources(tx: DatabaseSession, value: { requestId: string; fromVersion: number; toVersion: number }) {
    await tx.query(`INSERT INTO control_loop_policy_input_sources(tenant_id,request_id,input_version,defaults_sha256,layer_versions,waiver_id)
      SELECT tenant_id,request_id,$4,defaults_sha256,layer_versions,waiver_id FROM control_loop_policy_input_sources
      WHERE tenant_id=$1 AND request_id=$2 AND input_version=$3`, [this.scope.tenantId, value.requestId, value.fromVersion, value.toVersion]);
  }
}
