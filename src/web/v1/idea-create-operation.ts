import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { sha256Digest } from "../../security/digest";
import { buildIdeaLabSessionV1 } from "../../idea-lab/v1/contracts";
import { buildIdeaLabOwnerPromptV1 } from "../../idea-lab/v1/discussion-prompt";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { ideaLabelSchemaV1, ideaTextSchemaV1, ideaParticipantSchemaV1 } from "../../idea-lab/v1/schemas";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { IdeaLabBotRunStoreV1 } from "../../idea-lab/v1/coordinator-store";
import { ideaStopInputSchema, ideaCreationOptionsSchema, ideaParticipantSelectionSchema } from "./idea-wire";
import type { WebIdeaDecisionOperation } from "./idea-decision-operation";
import type { WebIdeaStartOperation } from "./idea-start-operation";
import type { WebIdeaSynthesisOperation } from "./idea-synthesis-operation";

export const ideaCreationInputSchema = z.object({ title: ideaLabelSchemaV1, ideaSummary: ideaTextSchemaV1,
  targetCustomer: z.string().min(1).max(300), maxRounds: z.number().int().min(1).max(3),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25),
  participantSelections: ideaParticipantSelectionSchema.optional(),
}).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
export type IdeaCreateOperation = { tenantId: string; workspaceId: string;
  options?: IdeaSessionCreationService["options"];
  create: IdeaSessionCreationService["create"]; stop?: IdeaSessionCreationService["stop"];
  decide?: WebIdeaDecisionOperation["decide"]; start?: WebIdeaStartOperation["start"];
  synthesize?: WebIdeaSynthesisOperation["synthesize"] };

export function captureIdeaParticipants(value: unknown) {
  const participants = z.array(ideaParticipantSchemaV1).min(3).max(6).parse(value);
  if (new Set(participants.map(p => p.participantId)).size !== participants.length
    || new Set(participants.map(p => p.identityDigest)).size !== participants.length
    || new Set(participants.map(p => p.perspective)).size !== participants.length
    || !participants.some(p => p.perspective === "skeptic")) throw new Error("idea_roster_invalid");
  return participants;
}

/** Non-executing coordinator operation. A separately provisioned pool is required;
 * the restricted web role is intentionally not granted session writes. */
export class IdeaSessionCreationService {
  private readonly authority: WebSessionAuthority;
  private readonly key: Uint8Array;
  private readonly participants: z.infer<typeof ideaParticipantSchemaV1>[];
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    key: Uint8Array, participants: unknown[], clock: () => number = Date.now) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("idea_key_invalid");
    this.key = Uint8Array.from(key);
    this.participants = captureIdeaParticipants(participants);
    this.authority = new WebSessionAuthority(db, scope, clock, "idea_lab_session");
  }
  async options(identity: VerifiedWebIdentity) {
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.session_create", undefined, true);
      actor.require("idea_lab.session_read", undefined, true);
      if (!(await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [this.scope.tenantId, this.scope.workspaceId])).rows.length) throw new WebAccessError("not_found");
      return ideaCreationOptionsSchema.parse({ startsWork: false, minParticipants: 3, maxParticipants: 6, requiredPerspectives: ["skeptic"],
        participants: this.participants.map(p => ({ participantId: p.participantId, participantDigest: sha256Digest(p),
          displayName: p.displayName, perspective: p.perspective, harness: p.harness })) });
    });
  }
  async create(identity: VerifiedWebIdentity, value: unknown, key: string) {
    const input = ideaCreationInputSchema.safeParse(value);
    if (!input.success || !/^[A-Za-z0-9:_-]{8,160}$/.test(key)) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.session_create", undefined, true);
      actor.require("idea_lab.session_read", undefined, true);
      const workspace = await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [this.scope.tenantId, this.scope.workspaceId]);
      if (!workspace.rows.length) throw new WebAccessError("not_found");
      const suffix = sha256Digest({ ...this.scope, actorId: actor.id, key, action: "idea_lab.session_create" }).slice(7);
      const sessionId = `idea:${suffix}`, store = new IdeaLabProjectRegistryStoreV1(joined(tx), this.key);
      const existing = await store.getSession(this.scope.tenantId, sessionId);
      const createdByIdentityDigest = sha256Digest({ tenantId: this.scope.tenantId, identityId: actor.id, purpose: "idea_lab_creator_v1" });
      let session;
      try {
        // A retry recovers its original saved roster, not today's deployment configuration.
        const { participantSelections, ...brief } = input.data;
        const available = existing?.participants ?? this.participants;
        const participants = participantSelections ? participantSelections.map(selection => {
          const participant = available.find(p => p.participantId === selection.participantId);
          if (!participant || sha256Digest(participant) !== selection.participantDigest) throw new Error("idea_roster_changed");
          return participant;
        }) : available;
        session = buildIdeaLabSessionV1({ ...this.scope, sessionId, ...brief, participants,
          createdByIdentityDigest, createdAt: existing?.createdAt ?? actor.now });
        if (!existing) buildIdeaLabOwnerPromptV1(session);
      } catch { throw new WebAccessError("invalid_request"); }
      if (existing && existing.sessionDigest !== session.sessionDigest) throw new WebAccessError("conflict");
      if (!existing) {
        await store.registerSession(session);
        await appendAuditWith(tx, { id: `audit:idea:${suffix}`, ...this.scope, actorId: actor.id, actorType: "human",
          action: "idea_lab.session_create", targetType: "idea_lab_session", targetId: sessionId,
          idempotencyKey: key, occurredAt: actor.now,
          safeMetadata: { sessionDigest: session.sessionDigest, state: "saved_not_started" } });
      }
      return { sessionId, sessionDigest: session.sessionDigest, createdAt: session.createdAt,
        replayed: !!existing, startsWork: false as const, execution: "not_requested" as const, idempotencyKey: key };
    });
  }
  /** Intrinsically idempotent stop for the exact retained run; never starts a provider. */
  async stop(identity: VerifiedWebIdentity, sessionId: string, value: unknown) {
    const input = ideaStopInputSchema.safeParse(value);
    if (!input.success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.panel_cancel", undefined, true); actor.require("idea_lab.session_read", undefined, true);
      const locked = await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, this.scope.workspaceId]);
      if (!locked.rows.length) throw new WebAccessError("not_found");
      const db = joined(tx), store = new IdeaLabProjectRegistryStoreV1(db, this.key), ledger = new IdeaLabBotRunStoreV1(db, this.key);
      const session = await store.getSession(this.scope.tenantId, sessionId);
      if (!session || session.workspaceId !== this.scope.workspaceId) throw new WebAccessError("not_found");
      if (session.sessionDigest !== input.data.sessionDigest) throw new WebAccessError("conflict");
      const before = await ledger.getForSession(session);
      if (!before) throw new WebAccessError("not_found");
      if (before.runId !== input.data.runId) throw new WebAccessError("conflict");
      let run = await ledger.requestCancel(before.runId, actor.now);
      if (["prepared", "running"].includes(run.state) && run.attempts.at(-1)?.state !== "provider_marked") run = await ledger.cancel(run.runId, actor.now);
      if (!before.cancellationRequestedAt && run.cancellationRequestedAt) {
        const suffix = sha256Digest({ ...this.scope, runId: run.runId, action: "idea_lab.panel_cancel" }).slice(7);
        await appendAuditWith(tx, { id: `audit:idea-stop:${suffix}`, ...this.scope, actorId: actor.id, actorType: "human",
          action: "idea_lab.panel_cancel", targetType: "idea_lab_session", targetId: sessionId,
          idempotencyKey: `idea-stop:${suffix}`, occurredAt: actor.now,
          safeMetadata: { sessionDigest: session.sessionDigest, runDigest: run.runDigest, state: "stop_requested" } });
      }
      return { sessionId, sessionDigest: session.sessionDigest, runId: run.runId, state: run.state,
        cancellationRequestedAt: run.cancellationRequestedAt ?? null, startsWork: false as const };
    });
  }
}
