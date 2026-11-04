import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial } from "../../security/redaction";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { LoopPolicyServiceV1, rethrowLoopPolicyErrorV1 } from "./loop-policy-service";
import { parseLoopSettingsV1 } from "./loop-policy-compose";
import { encodeSelectionEditsV1, loopSelectionPreviewBodySchemaV1, loopSelectionPreviewSchemaV1,
  loopSelectionCheckSchemaV1, loopSelectionProjectionSchemaV1,
  type LoopSelectionPreviewV1, type LoopSelectionV1, type LoopSelectionProjectionV1, type LoopSelectionSlotV1 } from "./loop-selection-wire";

export type SelectionSnapshotV1 = Readonly<{ rosterDigest: string; availabilityDigest: string; revision: string }>;
export interface LoopSelectionSnapshotGuardV1 {
  capture(): Promise<SelectionSnapshotV1>;
  assertCurrent(tx: DatabaseSession, checked: SelectionSnapshotV1): Promise<void>;
}
export type LoopSelectionDispatchV1 = Readonly<{ commandId: string; bindingDigest: string;
  snapshot: SelectionSnapshotV1; lineupDigest: string }>;
const unavailable = (code: string, explanation: string): LoopSelectionPreviewV1 => ({ available: false, reason: { code, explanation } });
const sameSnapshot = (a: SelectionSnapshotV1, b: SelectionSnapshotV1) => a.revision === b.revision
  && a.rosterDigest === b.rosterDigest && a.availabilityDigest === b.availabilityDigest;
const validSnapshot = (value: SelectionSnapshotV1) => value && /^[a-f0-9]{64}$/.test(value.rosterDigest)
  && /^[a-f0-9]{64}$/.test(value.availabilityDigest) && typeof value.revision === "string" && value.revision.length > 0;

export class LoopSelectionServiceV1 {
  readonly #authority: WebSessionAuthority;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly policy: LoopPolicyServiceV1, private readonly guard?: LoopSelectionSnapshotGuardV1,
    clock: () => number = Date.now) { this.#authority = new WebSessionAuthority(db, scope, clock, "loop_selection"); }

  /** Sequential selection extensions share this owner/action/project boundary. */
  protected async withSelectionAuthorityV1<T>(identity: VerifiedWebIdentity, projectId: string, mode: "read" | "manage",
    operation: (tx: DatabaseSession, actor: WebActor) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(projectId)) throw new WebAccessError("invalid_request");
    try {
      return await this.#authority.authenticated(identity, async (tx, actor) => {
        actor.require(`loop_selection.${mode}`, projectId, true, mode === "read" ? "low" : "high");
        if (mode === "manage") await tx.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
          [this.scope.tenantId, this.scope.workspaceId, projectId]);
        const row = (await tx.query<{ lifecycle: string; template_id: string }>(`SELECT h.lifecycle,
          p.payload->'presentation'->>'templateId' AS template_id FROM projects p JOIN control_manual_project_heads h
          ON h.tenant_id=p.tenant_id AND h.project_id=p.id WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
        [this.scope.tenantId, this.scope.workspaceId, projectId])).rows[0];
        if (!row || row.template_id !== "control-room") throw new WebAccessError("not_found");
        if (row.lifecycle !== "active") throw new WebAccessError("conflict");
        return operation(tx, actor);
      }, mode === "read" ? { readOnly: true, repeatableReadSnapshot: true } : undefined);
    } catch (error) { rethrowLoopPolicyErrorV1(error); }
  }

  async preview(identity: VerifiedWebIdentity, projectId: string, input: unknown): Promise<LoopSelectionPreviewV1> {
    // Authorize before parsing/reading settings or touching the checker/snapshot port.
    const before = await this.withSelectionAuthorityV1(identity, projectId, "read", async tx => {
      const parsed = loopSelectionPreviewBodySchemaV1.safeParse(input);
      if (!parsed.success) throw new WebAccessError("invalid_request");
      const body = parsed.data;
      const snapshot = await this.policy.snapshotRead(tx, projectId, encodeSelectionEditsV1(body.selection, body.overrides));
      return { body, snapshot };
    });
    // Configured-provider validation is a separate U83a hook; launcher routes need no such hook.
    if (Object.hasOwn(parseLoopSettingsV1(before.snapshot.text), "providerRoute"))
      return unavailable("configured_provider_validation_unavailable", "Configured provider validation is unavailable.");
    if (!this.guard) return unavailable("selection_snapshot_unavailable", "The selection snapshot is unavailable.");
    let result: LoopSelectionPreviewV1;
    try {
      const checked = { ...await this.guard.capture() };
      if (!validSnapshot(checked)) throw new Error("snapshot_unavailable");
      const raw = await this.policy.checkWith(before.snapshot.text, { mode: "preview", sameFamilyIntent: before.body.overrides.reviewFamily });
      const { projection: rawProjection, ...rawCheck } = raw;
      const check = loopSelectionCheckSchemaV1.safeParse(rawCheck), projection = loopSelectionProjectionSchemaV1.safeParse(rawProjection);
      if (!check.success || !projection.success) throw new Error("selection_projection_unavailable");
      assertNoSecretMaterial(projection.data); assertNoSecretMaterial(check.data);
      const strings = JSON.stringify({ check: check.data, projection: projection.data });
      if (/(?:^|[\s"'])(?:\/(?:Users|home|private|tmp|var|Volumes)\/|[A-Za-z]:\\)/.test(strings)) throw new Error("unsafe_projection");
      if (!this.#matchesRequested(before.body.selection, projection.data.lineup)) throw new Error("selection_projection_mismatch");
      const current = await this.guard.capture();
      if (!validSnapshot(current) || !sameSnapshot(checked, current) || projection.data.rosterDigest !== checked.rosterDigest
        || projection.data.availabilityDigest !== checked.availabilityDigest)
        result = unavailable("selection_snapshot_changed", "The selection snapshot changed. Preview again.");
      else {
        const blockers = projection.data.lineup.some(value => value.requested.cost === "paid" || value.effective?.cost === "paid")
          || projection.data.reservedFinal?.cost === "paid"
          ? [{ code: "paid_execution_unavailable", explanation: "Paid execution is unavailable." }] : [];
        result = loopSelectionPreviewSchemaV1.parse({ available: true, check: check.data, blockers,
          settingsSha256: before.snapshot.sha256, defaultsSha256: before.snapshot.defaultsSha256,
          layerVersions: before.snapshot.layerVersions, projection: projection.data, paidExecutionReady: false });
      }
    } catch {
      result = unavailable("selection_check_unavailable", "The selection checker or projection is unavailable.");
    }
    // The external checker runs outside all transactions; authorize afresh after it returns.
    await this.withSelectionAuthorityV1(identity, projectId, "read", async tx => {
      this.policy.assertSnapshot(before.snapshot, await this.policy.snapshotRead(tx, projectId,
        encodeSelectionEditsV1(before.body.selection, before.body.overrides)));
    });
    return result;
  }

  #matchesRequested(selection: LoopSelectionV1, lineup: LoopSelectionProjectionV1["lineup"]): boolean {
    const expected = new Map<string, LoopSelectionSlotV1>();
    for (const [role, value] of Object.entries(selection.roles)) {
      for (const [index, item] of (Array.isArray(value) ? value : [value]).entries()) expected.set(`${role}:${index}`, item);
    }
    for (const entry of lineup) {
      const key = `${entry.role}:${entry.index}`, requested = expected.get(key);
      if (!requested || requested.model !== entry.requested.model || requested.route !== entry.requested.route
        || requested.effort !== entry.requested.effort) return false;
      expected.delete(key);
    }
    return expected.size === 0;
  }
}
