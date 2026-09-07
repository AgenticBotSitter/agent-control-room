import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import {
  assertProjectLifecycleTransitionV1, buildProjectLifecycleEventV1, buildProjectRegistryProjectionV1,
  parseIdeaLabContributionV1, parseIdeaLabDecisionV1, parseIdeaLabSessionV1, parseIdeaLabSynthesisV1,
  parseProjectLifecycleEventV1, type ProjectSnapshotMaterialV1,
} from "./contracts";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { capturedIdeaTimeMillisecondsV1, capturedIdeaTimeStringV1, CONTROL_ROOM_IDEA_ADAPTER_V1,
  ideaCodeSchemaV1, ideaContributionSchemaV1, ideaDecisionSchemaV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaSynthesisSchemaV1, ideaTimeSchemaV1, projectLifecycleStatesV1 } from "./schemas";
import type { IdeaLabContributionV1, IdeaLabDecisionV1, IdeaLabSessionV1, IdeaLabSynthesisV1,
  ProjectLifecycleEventV1, ProjectRegistryProjectionV1 } from "./types";

type Query = DatabaseSession["query"];
type Transaction = DatabaseClient["transaction"];
interface ProjectRow { id: string; tenant_id: string; workspace_id: string; title: string; description: string;
  priority: number|string; normalized_state: string; domain_state: string; observed_at: string|Date; updated_at: string|Date;
  payload: unknown; }
interface LifecycleRow { payload: unknown; event_auth_tag: string; }

const projectPayloadSchema = z.object({ workspaceName: z.string().min(1).max(120), projectKind: ideaCodeSchemaV1,
  sourceIdeaSessionId: ideaIdSchemaV1, sourceDecisionDigest: ideaDigestSchemaV1, createdAt: ideaTimeSchemaV1,
  lifecycleVersion: z.number().int().min(1), latestEventDigest: ideaDigestSchemaV1 }).strict();
const transitionInputSchema = z.object({ tenantId: ideaIdSchemaV1, projectId: ideaIdSchemaV1,
  expectedVersion: z.number().int().min(1), toState: z.enum(projectLifecycleStatesV1),
  actorIdentityDigest: ideaDigestSchemaV1, safeReasonCode: ideaCodeSchemaV1, occurredAt: ideaTimeSchemaV1 }).strict();
const ownerAuthorizationPayloadSchema = z.object({ authorizationId: ideaIdSchemaV1, tenantId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1, ideaDecisionId: ideaIdSchemaV1, ideaDecisionDigest: ideaDigestSchemaV1,
  policyDecisionId: ideaIdSchemaV1, ownerIdentityId: ideaIdSchemaV1, ownerIdentityDigest: ideaDigestSchemaV1,
  requestDigest: ideaDigestSchemaV1, authorizedAt: ideaTimeSchemaV1, expiresAt: ideaTimeSchemaV1,
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), authorizationDigest: ideaDigestSchemaV1 }).strict();

function iso(value: string|Date): string {
  const formatted = capturedIdeaTimeStringV1(value);
  if (!formatted) throw new IdeaLabErrorV1("integrity_failed");
  return formatted;
}
function time(value: string): number {
  const milliseconds = capturedIdeaTimeMillisecondsV1(value);
  if (milliseconds === undefined) throw new IdeaLabErrorV1("integrity_failed");
  return milliseconds;
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}

export class IdeaLabProjectRegistryStoreV1 {
  readonly #query: Query;
  readonly #transaction: Transaction;
  readonly #key: Uint8Array;

  constructor(db: DatabaseClient, integrityKey: Uint8Array) {
    if (!db || typeof db !== "object" || isHostProxyV1(db)) throw new IdeaLabErrorV1("invalid_input");
    const query = dataMethodV1(db, "query") as Query|undefined, transaction = dataMethodV1(db, "transaction") as Transaction|undefined;
    const key = exactHostUint8ArrayV1(integrityKey, 32);
    if (!query || !transaction || !key || key.byteLength !== 32) throw new IdeaLabErrorV1("invalid_input");
    this.#query = ((statement, params) => query.call(db, statement, params)) as Query;
    this.#transaction = ((callback) => transaction.call(db, callback)) as Transaction;
    this.#key = key.copy(); Object.freeze(this);
  }

  #tag(kind: string, tenantId: string, id: string, digest: string): string {
    return hmacSha256Tag(this.#key, { kind, tenantId, id, digest });
  }
  #verifyTag(kind: string, tenantId: string, id: string, digest: string, supplied: string): void {
    if (!safeEqual(this.#tag(kind, tenantId, id, digest), supplied)) throw new IdeaLabErrorV1("integrity_failed");
  }

  async registerSession(value: unknown): Promise<{ session: IdeaLabSessionV1; replayed: boolean }> {
    const session = parseIdeaLabSessionV1(value), tag = this.#tag("session", session.tenantId, session.sessionId, session.sessionDigest);
    return this.#transaction(async (tx) => {
      const existing = await tx.query<{ payload: unknown; session_auth_tag: string }>(
        `SELECT payload,session_auth_tag FROM control_idea_sessions WHERE tenant_id=$1 AND session_id=$2`, [session.tenantId, session.sessionId]);
      if (existing.rows[0]) {
        const stored = parseIdeaLabSessionV1(existing.rows[0].payload);
        this.#verifyTag("session", stored.tenantId, stored.sessionId, stored.sessionDigest, existing.rows[0].session_auth_tag);
        if (stored.sessionDigest !== session.sessionDigest) throw new IdeaLabErrorV1("duplicate_record");
        return { session: stored, replayed: true };
      }
      await tx.query(`INSERT INTO control_idea_sessions(session_id,tenant_id,workspace_id,session_digest,session_auth_tag,
        participant_count,max_rounds,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [session.sessionId,session.tenantId,session.workspaceId,session.sessionDigest,tag,session.participants.length,
        session.maxRounds,JSON.stringify(session),session.createdAt]);
      return { session, replayed: false };
    });
  }

  async getSession(tenantId: string, sessionId: string): Promise<IdeaLabSessionV1|undefined> {
    const result = await this.#query<{ payload: unknown; session_auth_tag: string }>(
      `SELECT payload,session_auth_tag FROM control_idea_sessions WHERE tenant_id=$1 AND session_id=$2`, [tenantId,sessionId]);
    if (!result.rows[0]) return undefined;
    const session = parseIdeaLabSessionV1(result.rows[0].payload);
    if (session.tenantId !== tenantId || session.sessionId !== sessionId) throw new IdeaLabErrorV1("integrity_failed");
    this.#verifyTag("session",session.tenantId,session.sessionId,session.sessionDigest,result.rows[0].session_auth_tag); return session;
  }

  /** Complete, cursor-based catalog for the private workspace; immutable session IDs order pages. */
  async listSessionPage(tenantId: string, workspaceId: string, after?: string) {
    ideaIdSchemaV1.parse(tenantId); ideaIdSchemaV1.parse(workspaceId);
    if (after !== undefined) ideaIdSchemaV1.parse(after);
    const rows = await this.#query<{ session_id: string; payload: unknown; session_auth_tag: string }>(
      `SELECT session_id,payload,session_auth_tag FROM control_idea_sessions
       WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR session_id COLLATE "C" > $3 COLLATE "C")
       ORDER BY session_id COLLATE "C" LIMIT 51`, [tenantId, workspaceId, after ?? null]);
    const sessions = rows.rows.slice(0, 50).map(row => {
      const session = parseIdeaLabSessionV1(row.payload);
      if (session.tenantId !== tenantId || session.workspaceId !== workspaceId || session.sessionId !== row.session_id)
        throw new IdeaLabErrorV1("integrity_failed");
      this.#verifyTag("session", tenantId, session.sessionId, session.sessionDigest, row.session_auth_tag);
      return session;
    });
    return { sessions, nextCursor: rows.rows.length > 50 ? sessions.at(-1)!.sessionId : null };
  }

  async listSessions(tenantId:string,workspaceId:string,limit=25):Promise<IdeaLabSessionV1[]>{
    const safeTenant=ideaIdSchemaV1.parse(tenantId),safeWorkspace=ideaIdSchemaV1.parse(workspaceId);
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new IdeaLabErrorV1("invalid_input");
    const result=await this.#query<{payload:unknown;session_auth_tag:string}>(`SELECT payload,session_auth_tag FROM control_idea_sessions
      WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,session_id LIMIT $3`,[safeTenant,safeWorkspace,limit]);
    return result.rows.map(row=>{const session=parseIdeaLabSessionV1(row.payload);this.#verifyTag("session",safeTenant,
      session.sessionId,session.sessionDigest,row.session_auth_tag);return session;});
  }

  async recordContribution(value: unknown): Promise<{ contribution: IdeaLabContributionV1; replayed: boolean }> {
    const raw = parseExactIdeaLabV1(ideaContributionSchemaV1, value);
    const session = await this.getSession(raw.tenantId, raw.sessionId); if (!session) throw new IdeaLabErrorV1("not_found");
    const contribution = parseIdeaLabContributionV1(value,session);
    const tag = this.#tag("contribution",contribution.tenantId,contribution.contributionId,contribution.contributionDigest);
    return this.#transaction(async (tx) => {
      const existing = await tx.query<{ payload: unknown; contribution_auth_tag: string }>(
        `SELECT payload,contribution_auth_tag FROM control_idea_contributions WHERE tenant_id=$1 AND contribution_id=$2`,
        [contribution.tenantId,contribution.contributionId]);
      if (existing.rows[0]) {
        const stored = parseIdeaLabContributionV1(existing.rows[0].payload,session);
        this.#verifyTag("contribution",stored.tenantId,stored.contributionId,stored.contributionDigest,existing.rows[0].contribution_auth_tag);
        if (stored.contributionDigest !== contribution.contributionDigest) throw new IdeaLabErrorV1("duplicate_record");
        return { contribution: stored, replayed: true };
      }
      const decided = await tx.query(`SELECT 1 FROM control_idea_decisions WHERE tenant_id=$1 AND session_id=$2`,
        [contribution.tenantId,contribution.sessionId]);
      if (decided.rows.length) throw new IdeaLabErrorV1("state_conflict");
      await tx.query(`INSERT INTO control_idea_contributions(contribution_id,tenant_id,workspace_id,session_id,session_digest,
        participant_id,round,contribution_digest,contribution_auth_tag,payload,contributed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`, [contribution.contributionId,contribution.tenantId,
        contribution.workspaceId,contribution.sessionId,contribution.sessionDigest,contribution.participantId,contribution.round,
        contribution.contributionDigest,tag,JSON.stringify(contribution),contribution.contributedAt]);
      return { contribution, replayed:false };
    });
  }

  async listContributions(tenantId: string, sessionId: string): Promise<IdeaLabContributionV1[]> {
    const session = await this.getSession(tenantId,sessionId); if (!session) throw new IdeaLabErrorV1("not_found");
    const result = await this.#query<{ payload: unknown; contribution_auth_tag: string }>(
      `SELECT payload,contribution_auth_tag FROM control_idea_contributions WHERE tenant_id=$1 AND session_id=$2 ORDER BY round,participant_id`,
      [tenantId,sessionId]);
    return result.rows.map((row) => { const item = parseIdeaLabContributionV1(row.payload,session);
      this.#verifyTag("contribution",tenantId,item.contributionId,item.contributionDigest,row.contribution_auth_tag); return item; });
  }

  async recordSynthesis(value: unknown): Promise<{ synthesis: IdeaLabSynthesisV1; replayed: boolean }> {
    const raw = parseExactIdeaLabV1(ideaSynthesisSchemaV1,value);
    const session = await this.getSession(raw.tenantId,raw.sessionId); if (!session) throw new IdeaLabErrorV1("not_found");
    const contributions = await this.listContributions(raw.tenantId,raw.sessionId);
    const synthesis = parseIdeaLabSynthesisV1(value,session,contributions);
    const tag = this.#tag("synthesis",synthesis.tenantId,synthesis.synthesisId,synthesis.synthesisDigest);
    return this.#transaction(async (tx) => {
      const existing = await tx.query<{payload:unknown;synthesis_auth_tag:string}>(
        `SELECT payload,synthesis_auth_tag FROM control_idea_syntheses WHERE tenant_id=$1 AND session_id=$2`,
        [synthesis.tenantId,synthesis.sessionId]);
      if (existing.rows[0]) { const stored = parseIdeaLabSynthesisV1(existing.rows[0].payload,session,contributions);
        this.#verifyTag("synthesis",stored.tenantId,stored.synthesisId,stored.synthesisDigest,existing.rows[0].synthesis_auth_tag);
        if (stored.synthesisDigest !== synthesis.synthesisDigest) throw new IdeaLabErrorV1("duplicate_record");
        return { synthesis:stored,replayed:true }; }
      await tx.query(`INSERT INTO control_idea_syntheses(synthesis_id,tenant_id,workspace_id,session_id,session_digest,
        synthesis_digest,synthesis_auth_tag,recommendation,overall_score,payload,synthesized_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,[synthesis.synthesisId,synthesis.tenantId,synthesis.workspaceId,
        synthesis.sessionId,synthesis.sessionDigest,synthesis.synthesisDigest,tag,synthesis.recommendation,synthesis.overallScore,
        JSON.stringify(synthesis),synthesis.synthesizedAt]); return {synthesis,replayed:false};
    });
  }

  async getSynthesis(tenantId:string,sessionId:string):Promise<IdeaLabSynthesisV1|undefined>{
    const session=await this.getSession(tenantId,sessionId); if(!session)return undefined;
    const contributions=await this.listContributions(tenantId,sessionId), result=await this.#query<{payload:unknown;synthesis_auth_tag:string}>(
      `SELECT payload,synthesis_auth_tag FROM control_idea_syntheses WHERE tenant_id=$1 AND session_id=$2`,[tenantId,sessionId]);
    if(!result.rows[0])return undefined; const synthesis=parseIdeaLabSynthesisV1(result.rows[0].payload,session,contributions);
    this.#verifyTag("synthesis",tenantId,synthesis.synthesisId,synthesis.synthesisDigest,result.rows[0].synthesis_auth_tag); return synthesis;
  }

  async getDecision(tenantId:string,sessionId:string):Promise<IdeaLabDecisionV1|undefined>{
    const session=await this.getSession(tenantId,sessionId),synthesis=await this.getSynthesis(tenantId,sessionId);if(!session||!synthesis)return undefined;
    const result=await this.#query<{payload:unknown;decision_auth_tag:string}>(`SELECT payload,decision_auth_tag FROM control_idea_decisions WHERE tenant_id=$1 AND session_id=$2`,[tenantId,sessionId]);
    if(!result.rows[0])return undefined;const decision=parseIdeaLabDecisionV1(result.rows[0].payload,session,synthesis);
    this.#verifyTag("decision",tenantId,decision.decisionId,decision.decisionDigest,result.rows[0].decision_auth_tag);return decision;
  }

  /** Internal persistence seam. A protected service must authenticate and authorize the owner before calling it. */
  async recordDecision(value:unknown):Promise<{decision:IdeaLabDecisionV1;project?:ProjectRegistryProjectionV1;replayed:boolean}>{
    const raw=parseExactIdeaLabV1(ideaDecisionSchemaV1,value);
    const session=await this.getSession(raw.tenantId,raw.sessionId), synthesis=await this.getSynthesis(raw.tenantId,raw.sessionId);
    if(!session||!synthesis)throw new IdeaLabErrorV1("not_found");
    const decision=parseIdeaLabDecisionV1(value,session,synthesis), tag=this.#tag("decision",decision.tenantId,decision.decisionId,decision.decisionDigest);
    const result=await this.#transaction(async(tx)=>{
      const existing=await tx.query<{payload:unknown;decision_auth_tag:string}>(`SELECT payload,decision_auth_tag FROM control_idea_decisions WHERE tenant_id=$1 AND session_id=$2`,[decision.tenantId,decision.sessionId]);
      if(existing.rows[0]){const stored=parseIdeaLabDecisionV1(existing.rows[0].payload,session,synthesis);
        this.#verifyTag("decision",stored.tenantId,stored.decisionId,stored.decisionDigest,existing.rows[0].decision_auth_tag);
        if(stored.decisionDigest!==decision.decisionDigest)throw new IdeaLabErrorV1("duplicate_record"); return {decision:stored,replayed:true};}
      if(!decision.project){await tx.query(`INSERT INTO control_idea_decisions(decision_id,tenant_id,workspace_id,session_id,synthesis_digest,decision,project_id,decision_digest,decision_auth_tag,payload,decided_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9::jsonb,$10)`,[decision.decisionId,decision.tenantId,decision.workspaceId,decision.sessionId,decision.synthesisDigest,decision.decision,decision.decisionDigest,tag,JSON.stringify(decision),decision.decidedAt]);return {decision,replayed:false};}
      const projectExists=await tx.query(`SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2`,[decision.tenantId,decision.project.projectId]);
      if(projectExists.rows.length)throw new IdeaLabErrorV1("project_conflict");
      const snapshot:ProjectSnapshotMaterialV1={tenantId:decision.tenantId,workspaceId:decision.workspaceId,
        projectId:decision.project.projectId,sourceIdeaSessionId:decision.sessionId,sourceDecisionDigest:decision.decisionDigest,
        workspaceName:decision.project.workspaceName,title:decision.project.title,summary:decision.project.summary,
        projectKind:decision.project.projectKind,lifecycleState:"active",priority:decision.project.priority,version:1,
        createdAt:decision.decidedAt,updatedAt:decision.decidedAt};
      const event=buildProjectLifecycleEventV1({...snapshot,fromState:null,actorIdentityDigest:decision.ownerIdentityDigest,
        safeReasonCode:"idea_promoted_by_owner"}), payload={workspaceName:snapshot.workspaceName,projectKind:snapshot.projectKind,
        sourceIdeaSessionId:snapshot.sourceIdeaSessionId,sourceDecisionDigest:snapshot.sourceDecisionDigest,createdAt:snapshot.createdAt,
        lifecycleVersion:1,latestEventDigest:event.eventDigest};
      await tx.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
        normalized_state,domain_state,health,progress_percent,attention_count,blocker_count,priority,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running','idea_project_active','healthy',0,0,0,$9,'control_room_native',$10,$11::jsonb,$10)`,
        [snapshot.projectId,snapshot.tenantId,snapshot.workspaceId,CONTROL_ROOM_IDEA_ADAPTER_V1,snapshot.sourceIdeaSessionId,
          event.eventDigest,snapshot.title,snapshot.summary,snapshot.priority,snapshot.updatedAt,JSON.stringify(payload)]);
      await tx.query(`INSERT INTO control_idea_decisions(decision_id,tenant_id,workspace_id,session_id,synthesis_digest,decision,
        project_id,decision_digest,decision_auth_tag,payload,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [decision.decisionId,decision.tenantId,decision.workspaceId,decision.sessionId,decision.synthesisDigest,decision.decision,
          snapshot.projectId,decision.decisionDigest,tag,JSON.stringify(decision),decision.decidedAt]);
      await this.#insertLifecycle(tx,event); return {decision,replayed:false};
    });
    const project=result.decision.project?await this.getProject(result.decision.tenantId,result.decision.project.projectId):undefined;
    return {...result,...(project?{project}:{})};
  }

  /**
   * Converts one persisted, allowed policy decision into an immutable owner-only permit.
   * The permit is written before the project effect, so a crash can leave unused authority
   * but can never leave a project without pre-existing owner authorization evidence.
   */
  async authorizeOwnerDecision(input:{authorizationId:string;policyDecisionId:string;decision:unknown}):Promise<{authorizationDigest:string;replayed:boolean}>{
    const raw=parseExactIdeaLabV1(ideaDecisionSchemaV1,input.decision),session=await this.getSession(raw.tenantId,raw.sessionId),synthesis=await this.getSynthesis(raw.tenantId,raw.sessionId);
    if(!session||!synthesis)throw new IdeaLabErrorV1("not_found");const decision=parseIdeaLabDecisionV1(input.decision,session,synthesis);
    // The referenced policy is immutable; a read must not require UPDATE authority.
    return this.#transaction(async tx=>{const policy=await tx.query<{identity_id:string;action:string;resource_type:string;resource_id:string;allowed:boolean;request_digest:string;grant_ids:string[];decided_at:string|Date;expires_at:string|Date}>(
      `SELECT identity_id,action,resource_type,resource_id,allowed,request_digest,grant_ids,decided_at,expires_at FROM control_policy_decisions WHERE tenant_id=$1 AND id=$2`,[decision.tenantId,input.policyDecisionId]);
      const row=policy.rows[0];if(!row||!row.allowed||row.action!=="idea_lab.owner_decide"||row.resource_type!=="idea_lab_session"||row.resource_id!==decision.sessionId
        ||iso(row.decided_at)!==decision.decidedAt||time(iso(row.expires_at))<=time(decision.decidedAt))throw new IdeaLabErrorV1("authorization_denied");
      const grants=await tx.query<{id:string;role_key:string;revoked_at?:string;expires_at?:string}>(`SELECT id,role_key,revoked_at,expires_at FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2`,[decision.tenantId,row.identity_id]);
      const matched=new Set(row.grant_ids);let owner=false;
      for(const grant of grants.rows)if(matched.has(grant.id)&&grant.role_key==="owner"&&!grant.revoked_at
        &&(!grant.expires_at||time(grant.expires_at)>time(decision.decidedAt))){owner=true;break;}
      const ownerDigest=sha256Digest({tenantId:decision.tenantId,identityId:row.identity_id,purpose:"idea_lab_owner_v1"});
      if(!owner||decision.ownerIdentityDigest!==ownerDigest)throw new IdeaLabErrorV1("authorization_denied");
      const material={authorizationId:input.authorizationId,tenantId:decision.tenantId,sessionId:decision.sessionId,
        ideaDecisionId:decision.decisionId,ideaDecisionDigest:decision.decisionDigest,policyDecisionId:input.policyDecisionId,
        ownerIdentityId:row.identity_id,ownerIdentityDigest:ownerDigest,requestDigest:row.request_digest,
        authorizedAt:decision.decidedAt,expiresAt:iso(row.expires_at),grantsApproval:false as const,grantsExecutionAuthority:false as const};
      const payload=ownerAuthorizationPayloadSchema.parse({...material,authorizationDigest:sha256Digest(material)}),tag=this.#tag("owner_authorization",decision.tenantId,input.authorizationId,payload.authorizationDigest);
      const existing=await tx.query<{payload:unknown;authorization_auth_tag:string}>(`SELECT payload,authorization_auth_tag FROM control_idea_owner_authorizations WHERE tenant_id=$1 AND session_id=$2`,[decision.tenantId,decision.sessionId]);
      if(existing.rows[0]){const stored=parseExactIdeaLabV1(ownerAuthorizationPayloadSchema,existing.rows[0].payload);this.#verifyTag("owner_authorization",stored.tenantId,stored.authorizationId,stored.authorizationDigest,existing.rows[0].authorization_auth_tag);
        if(stored.authorizationDigest!==payload.authorizationDigest)throw new IdeaLabErrorV1("duplicate_record");return {authorizationDigest:stored.authorizationDigest,replayed:true};}
      await tx.query(`INSERT INTO control_idea_owner_authorizations(authorization_id,tenant_id,session_id,idea_decision_id,policy_decision_id,owner_identity_id,owner_identity_digest,request_digest,authorization_digest,authorization_auth_tag,payload,authorized_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,[payload.authorizationId,payload.tenantId,payload.sessionId,payload.ideaDecisionId,payload.policyDecisionId,payload.ownerIdentityId,payload.ownerIdentityDigest,payload.requestDigest,payload.authorizationDigest,tag,JSON.stringify(payload),payload.authorizedAt]);return {authorizationDigest:payload.authorizationDigest,replayed:false};});
  }

  async recordAuthorizedDecision(value:unknown,authorizationDigest:string):Promise<{decision:IdeaLabDecisionV1;project?:ProjectRegistryProjectionV1;replayed:boolean}>{
    const raw=parseExactIdeaLabV1(ideaDecisionSchemaV1,value),authorization=await this.#query<{payload:unknown;authorization_auth_tag:string}>(`SELECT payload,authorization_auth_tag FROM control_idea_owner_authorizations WHERE tenant_id=$1 AND session_id=$2`,[raw.tenantId,raw.sessionId]);
    if(!authorization.rows[0])throw new IdeaLabErrorV1("authorization_denied");const permit=parseExactIdeaLabV1(ownerAuthorizationPayloadSchema,authorization.rows[0].payload);
    this.#verifyTag("owner_authorization",permit.tenantId,permit.authorizationId,permit.authorizationDigest,authorization.rows[0].authorization_auth_tag);
    if(permit.authorizationDigest!==authorizationDigest||permit.ideaDecisionDigest!==raw.decisionDigest||permit.ideaDecisionId!==raw.decisionId
      ||time(permit.expiresAt)<=time(raw.decidedAt))throw new IdeaLabErrorV1("authorization_denied");
    return this.recordDecision(value);
  }

  async #insertLifecycle(tx:DatabaseSession,event:ReturnType<typeof buildProjectLifecycleEventV1>):Promise<void>{
    const tag=this.#tag("project_lifecycle",event.tenantId,event.eventId,event.eventDigest);
    await tx.query(`INSERT INTO control_project_lifecycle_events(event_id,tenant_id,workspace_id,project_id,source_idea_session_id,
      source_decision_digest,from_state,to_state,version,project_snapshot_digest,event_digest,event_auth_tag,payload,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,[event.eventId,event.tenantId,event.workspaceId,
      event.projectId,event.sourceIdeaSessionId,event.sourceDecisionDigest,event.fromState,event.toState,event.version,
      event.projectSnapshotDigest,event.eventDigest,tag,JSON.stringify(event),event.occurredAt]);
  }

  async #projectWith(query:Query,tenantId:string,projectId:string):Promise<ProjectRegistryProjectionV1|undefined>{
    const projects=await query<ProjectRow>(`SELECT id,tenant_id,workspace_id,title,description,priority,normalized_state,domain_state,
      observed_at,updated_at,payload FROM projects WHERE tenant_id=$1 AND id=$2 AND adapter_id=$3`,[tenantId,projectId,CONTROL_ROOM_IDEA_ADAPTER_V1]);
    if(!projects.rows[0])return undefined; const row=projects.rows[0], payload=parseExactIdeaLabV1(projectPayloadSchema,row.payload);
    const events=await query<LifecycleRow>(`SELECT payload,event_auth_tag FROM control_project_lifecycle_events WHERE tenant_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1`,[tenantId,projectId]);
    if(!events.rows[0])throw new IdeaLabErrorV1("integrity_failed"); const event=parseProjectLifecycleEventV1(events.rows[0].payload);
    this.#verifyTag("project_lifecycle",tenantId,event.eventId,event.eventDigest,events.rows[0].event_auth_tag);
    const expectedState=event.toState, expectedNormalized=expectedState==="active"?"running":expectedState==="paused"?"waiting":"complete";
    const expectedDomain=`idea_project_${expectedState}`;
    if(row.normalized_state!==expectedNormalized||row.domain_state!==expectedDomain||payload.lifecycleVersion!==event.version
      ||payload.latestEventDigest!==event.eventDigest||row.description===null)throw new IdeaLabErrorV1("integrity_failed");
    const snapshot:ProjectSnapshotMaterialV1={tenantId:row.tenant_id,workspaceId:row.workspace_id,projectId:row.id,
      sourceIdeaSessionId:payload.sourceIdeaSessionId,sourceDecisionDigest:payload.sourceDecisionDigest,
      workspaceName:payload.workspaceName,title:row.title,summary:row.description,projectKind:payload.projectKind,
      lifecycleState:event.toState,priority:Number(row.priority),version:event.version,createdAt:payload.createdAt,updatedAt:iso(row.updated_at)};
    return buildProjectRegistryProjectionV1(snapshot,event);
  }
  async getProject(tenantId:string,projectId:string):Promise<ProjectRegistryProjectionV1|undefined>{return this.#projectWith(this.#query,tenantId,projectId);}
  /** Read-only composition inside an already authorized transaction. No new transaction or policy bypass. */
  async getProjectInSession(session:DatabaseSession,tenantId:string,workspaceId:string,projectId:string):Promise<ProjectRegistryProjectionV1|undefined>{
    const selected=await session.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND adapter_id=$4 FOR SHARE`,
      [ideaIdSchemaV1.parse(tenantId),ideaIdSchemaV1.parse(workspaceId),ideaIdSchemaV1.parse(projectId),CONTROL_ROOM_IDEA_ADAPTER_V1]);
    if(!selected.rows.length)return undefined;
    const project=await this.#projectWith((statement,params)=>session.query(statement,params),tenantId,projectId);
    if(!project||project.tenantId!==tenantId||project.workspaceId!==workspaceId||project.projectId!==projectId)
      throw new IdeaLabErrorV1("integrity_failed");
    return project;
  }
  async getLatestProjectLifecycleEvent(tenantId:string,projectId:string):Promise<ProjectLifecycleEventV1|undefined>{
    const result=await this.#query<LifecycleRow>(`SELECT payload,event_auth_tag FROM control_project_lifecycle_events
      WHERE tenant_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1`,[ideaIdSchemaV1.parse(tenantId),ideaIdSchemaV1.parse(projectId)]);
    if(!result.rows[0])return undefined;const event=parseProjectLifecycleEventV1(result.rows[0].payload);
    this.#verifyTag("project_lifecycle",event.tenantId,event.eventId,event.eventDigest,result.rows[0].event_auth_tag);return event;
  }
  async listProjectLifecycleEvents(tenantIdValue:string,projectIdValue:string):Promise<ProjectLifecycleEventV1[]>{
    const tenantId=ideaIdSchemaV1.parse(tenantIdValue),projectId=ideaIdSchemaV1.parse(projectIdValue);
    const result=await this.#query<LifecycleRow>(`SELECT payload,event_auth_tag FROM control_project_lifecycle_events
      WHERE tenant_id=$1 AND project_id=$2 ORDER BY version ASC`,[tenantId,projectId]);
    const events=result.rows.map(row=>{const event=parseProjectLifecycleEventV1(row.payload);
      this.#verifyTag("project_lifecycle",event.tenantId,event.eventId,event.eventDigest,row.event_auth_tag);return event;});
    for(let index=0;index<events.length;index+=1){const event=events[index]!,prior=events[index-1];
      if(event.tenantId!==tenantId||event.projectId!==projectId||event.version!==index+1
        ||(prior?event.workspaceId!==prior.workspaceId||event.sourceIdeaSessionId!==prior.sourceIdeaSessionId
          ||event.sourceDecisionDigest!==prior.sourceDecisionDigest||event.fromState!==prior.toState:event.fromState!==null))
        throw new IdeaLabErrorV1("integrity_failed");}
    return events;
  }
  async listProjects(tenantId:string,options:{includeArchived?:boolean}={}):Promise<ProjectRegistryProjectionV1[]>{
    const rows=await this.#query<{id:string}>(`SELECT id FROM projects WHERE tenant_id=$1 AND adapter_id=$2 ORDER BY updated_at DESC,id`,[tenantId,CONTROL_ROOM_IDEA_ADAPTER_V1]);
    const projects=(await Promise.all(rows.rows.map((row)=>this.getProject(tenantId,row.id)))).filter((item):item is ProjectRegistryProjectionV1=>!!item);
    return options.includeArchived?projects:projects.filter((item)=>item.lifecycleState!=="archived");
  }

  async transitionProject(value:unknown):Promise<ProjectRegistryProjectionV1>{
    const input=parseExactIdeaLabV1(transitionInputSchema,value);
    await this.#transaction(async(tx)=>{const txQuery: Query = (statement,params=[])=>tx.query(statement,params);
      const current=await this.#projectWith(txQuery,input.tenantId,input.projectId);
      if(!current)throw new IdeaLabErrorV1("not_found"); if(current.version!==input.expectedVersion)throw new IdeaLabErrorV1("state_conflict");
      assertProjectLifecycleTransitionV1(current.lifecycleState,input.toState);
      if(time(input.occurredAt)<time(current.updatedAt))throw new IdeaLabErrorV1("state_conflict");
      const snapshot:ProjectSnapshotMaterialV1={tenantId:current.tenantId,workspaceId:current.workspaceId,projectId:current.projectId,
        sourceIdeaSessionId:current.sourceIdeaSessionId,sourceDecisionDigest:current.sourceDecisionDigest,
        workspaceName:current.workspaceName,title:current.title,summary:current.summary,projectKind:current.projectKind,
        lifecycleState:input.toState,priority:current.priority,version:current.version+1,createdAt:current.createdAt,updatedAt:input.occurredAt};
      const event=buildProjectLifecycleEventV1({...snapshot,fromState:current.lifecycleState,
        actorIdentityDigest:input.actorIdentityDigest,safeReasonCode:input.safeReasonCode});
      const normalized=input.toState==="active"?"running":input.toState==="paused"?"waiting":"complete";
      const payload={workspaceName:snapshot.workspaceName,projectKind:snapshot.projectKind,sourceIdeaSessionId:snapshot.sourceIdeaSessionId,
        sourceDecisionDigest:snapshot.sourceDecisionDigest,createdAt:snapshot.createdAt,lifecycleVersion:snapshot.version,latestEventDigest:event.eventDigest};
      const updated=await tx.query<{id:string}>(`UPDATE projects SET normalized_state=$1,domain_state=$2,source_version=$3,payload=$4::jsonb,
        observed_at=$5,updated_at=$5 WHERE tenant_id=$6 AND id=$7 AND source_version=$8 RETURNING id`,[normalized,`idea_project_${input.toState}`,
        event.eventDigest,JSON.stringify(payload),input.occurredAt,input.tenantId,input.projectId,current.latestEventDigest]);
      if(updated.rows.length!==1)throw new IdeaLabErrorV1("state_conflict");
      await this.#insertLifecycle(tx,event);});
    const result=await this.getProject(input.tenantId,input.projectId);if(!result)throw new IdeaLabErrorV1("integrity_failed");return result;
  }
}
