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

const inputSchema = z.object({ title: ideaLabelSchemaV1, ideaSummary: ideaTextSchemaV1,
  targetCustomer: z.string().min(1).max(300), maxRounds: z.number().int().min(1).max(3),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25),
}).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
export type IdeaCreateOperation = { tenantId: string; workspaceId: string;
  create: IdeaSessionCreationService["create"] };

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
    this.participants = z.array(ideaParticipantSchemaV1).min(3).max(6).parse(participants);
    this.authority = new WebSessionAuthority(db, scope, clock, "idea_lab_session");
  }
  async create(identity: VerifiedWebIdentity, value: unknown, key: string) {
    const input = inputSchema.safeParse(value);
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
        session = buildIdeaLabSessionV1({ ...this.scope, sessionId, ...input.data, participants: existing?.participants ?? this.participants,
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
}
