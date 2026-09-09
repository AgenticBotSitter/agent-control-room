import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../../idea-lab/v1/coordinator-store";
import { IdeaLabBotCoordinatorV1, buildIdeaLabBotRunV1, parseIdeaLabProviderSessionEvidenceV1,
  type IdeaLabBotPanelDriverV1, type IdeaLabProviderEvidenceAuthorityV1, type IdeaLabBotRunV1 } from "../../idea-lab/v1/coordinator";
import { parseIdeaLabLivePanelAdmissionV1, type IdeaLabLivePanelAdmissionAuthorityV1 } from "../../idea-lab/v1/live-panel-admission";
import { buildIdeaLabOwnerPromptV1 } from "../../idea-lab/v1/discussion-prompt";
import { ideaDigestSchemaV1, ideaIdSchemaV1 } from "../../idea-lab/v1/schemas";
import type { IdeaLabSessionV1 } from "../../idea-lab/v1/types";
import { IdeaLabErrorV1 } from "../../idea-lab/v1/errors";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

export const ideaStartInputSchema = z.object({ sessionDigest: ideaDigestSchemaV1 }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
export interface IdeaStartRuntime {
  /** Server-held, read-only lookup of separately accepted evidence/window. Never mint authority here. */
  resolve(session: IdeaLabSessionV1, ownerId: string, runId: string): Promise<{ evidence: unknown[]; admission: unknown }>;
  driver: IdeaLabBotPanelDriverV1;
  evidenceAuthority: IdeaLabProviderEvidenceAuthorityV1;
  admissionAuthority: IdeaLabLivePanelAdmissionAuthorityV1;
}
const receipt = (run: IdeaLabBotRunV1, replayed: boolean) => ({ sessionId: run.sessionId, sessionDigest: run.sessionDigest,
  runId: run.runId, state: run.state, replayed, providerContacted: run.providerContacted, retryPermitted: false as const });

/** One persisted run claim per Idea. Execution stays outside the owner transaction.
 * Not mounted by default; requires separately verified command/runtime resources. */
export class WebIdeaStartOperation {
  private readonly authority: WebSessionAuthority;
  private readonly ledger: IdeaLabBotRunStoreV1;
  private readonly coordinator: IdeaLabBotCoordinatorV1;
  private readonly key: Uint8Array;
  constructor(commandDb: DatabaseClient, runtimeDb: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    key: Uint8Array, private readonly runtime: IdeaStartRuntime, private readonly clock: () => number = Date.now) {
    if (commandDb === runtimeDb || !(key instanceof Uint8Array) || key.length !== 32
      || runtime.driver.mode !== "hermes_bot_mode_filtered") throw new Error("idea_start_config_invalid");
    this.key = Uint8Array.from(key); this.authority = new WebSessionAuthority(commandDb, scope, clock, "idea_lab_session");
    this.ledger = new IdeaLabBotRunStoreV1(runtimeDb, this.key);
    this.coordinator = new IdeaLabBotCoordinatorV1(this.ledger, new IdeaLabProjectRegistryStoreV1(runtimeDb, this.key),
      runtime.driver, () => new Date(this.clock()).toISOString(), runtime.evidenceAuthority, runtime.admissionAuthority);
  }
  async start(identity: VerifiedWebIdentity, sessionId: string, value: unknown) {
    const input = ideaStartInputSchema.safeParse(value);
    if (!input.success || !ideaIdSchemaV1.safeParse(sessionId).success) throw new WebAccessError("invalid_request");
    identity = { ...identity };
    const select = async (tx: DatabaseSession) => {
      const db = joined(tx), store = new IdeaLabProjectRegistryStoreV1(db, this.key);
      const session = await store.getSession(this.scope.tenantId, sessionId);
      if (!session || session.workspaceId !== this.scope.workspaceId) throw new WebAccessError("not_found");
      if (session.sessionDigest !== input.data.sessionDigest) throw new WebAccessError("conflict");
      const run = await new IdeaLabBotRunStoreV1(db, this.key).getForSession(session);
      if (!run && (await store.getSynthesis(this.scope.tenantId, sessionId) || await store.getDecision(this.scope.tenantId, sessionId)
        || (await store.listContributions(this.scope.tenantId, sessionId)).length)) throw new WebAccessError("conflict");
      return { session, run };
    };
    const selected = await this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.session_read", undefined, true); actor.require("idea_lab.panel_start", undefined, true);
      return { ...await select(tx), ownerId: actor.id };
    });
    // This includes prepared/ambiguous runs after process loss: never resubmit them.
    if (selected.run) return receipt(selected.run, true);
    const runId = `idea-run:${selected.session.sessionDigest.slice(7, 31)}`;
    const safePrompt = buildIdeaLabOwnerPromptV1(selected.session);
    const material = await this.runtime.resolve(selected.session, selected.ownerId, runId);
    const evidence = material.evidence.map(item => parseIdeaLabProviderSessionEvidenceV1(item, selected.session));
    if (evidence.some(e => e.mode !== "hermes_bot_mode_filtered")) throw new WebAccessError("conflict");
    const admission = parseIdeaLabLivePanelAdmissionV1(material.admission, selected.session, evidence, runId, new Date(this.clock()).toISOString());
    const claimed = await this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.session_read", undefined, true); actor.require("idea_lab.panel_start", undefined, true);
      await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, this.scope.workspaceId]);
      const current = await select(tx);
      if (current.run) return { run: current.run, owned: false };
      const run = await new IdeaLabBotRunStoreV1(joined(tx), this.key).prepare(buildIdeaLabBotRunV1({ ...this.scope,
        sessionId, sessionDigest: current.session.sessionDigest, runId, evidenceDigests: evidence.map(e => e.evidenceDigest).sort(),
        state: "prepared", attempts: [], messagesUsed: 0, costUsd: 0, safeCode: "prepared", providerContacted: false,
        startedAt: actor.now, updatedAt: actor.now }));
      await appendAuditWith(tx, { id: `audit:idea-start:${runId}`, ...this.scope, actorId: actor.id, actorType: "human",
        action: "idea_lab.panel_start", targetType: "idea_lab_session", targetId: sessionId, idempotencyKey: runId,
        occurredAt: actor.now, safeMetadata: { sessionDigest: current.session.sessionDigest, runDigest: run.runDigest, state: "start_requested" } });
      return { run, owned: true };
    });
    if (!claimed.owned) return receipt(claimed.run, true);
    try {
      return receipt(await this.coordinator.execute({ runId, session: selected.session, evidence, liveAdmission: admission, safePrompt }), false);
    } catch (error) {
      // An authority refusal before any marker can be recorded without guessing a
      // provider outcome. Other failures remain unresolved, never automatically retried.
      if (error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied") {
        const current = await this.ledger.get(runId);
        if (current?.state === "prepared") return receipt(await this.ledger.failDefinite(runId, "start_authority_denied", new Date(this.clock()).toISOString()), false);
      }
      throw error;
    }
  }
}
