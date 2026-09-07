import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PGlite as PGliteType } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../../persistence/database";
import { buildOperatorSurfaceSnapshotV1, OPERATOR_SURFACES_CONTRACT_V1 } from "../../operator-surfaces/v1";
import {
  buildIdeaLabFixtureV1,
  CONTROL_ROOM_IDEA_ADAPTER_V1,
  DeterministicIdeaLabFakeDriverV1,
  IdeaLabOwnerDecisionServiceV1,
  IdeaLabProjectLifecycleServiceV1,
  IdeaLabProjectRegistryStoreV1,
  IdeaLabProtectedOperatorServiceV1,
  type IdeaLabOwnerDecisionResultV1,
} from "../../idea-lab/v1";
import { AuthenticatedFleetTelemetryFreshnessSourceV1,
  type ConnectionCenterFreshnessSourceV1, type ConnectionCenterRosterSourceV1 } from "../../connection-center/v1";
import { ConnectionRegistryStoreV1 } from "../../connection-registry/v1/store";
import { ConnectionEnrollmentIntakeServiceV1, DisabledConnectionEnrollmentDeliverySourceV1 } from "../../connection-registry/v1/intake";
import { DisabledConnectionEnrollmentNodeIngressV1, type ConnectionEnrollmentNodeIngressPortV1 } from "../../connection-registry/v1/node-ingress";
import { DisabledConnectionEnrollmentPrivateLoopbackListenerV1,
  type ConnectionEnrollmentPrivateLoopbackListenerPortV1 } from "../../connection-registry/v1/private-loopback-framing";
import { DisabledConnectionEnrollmentTransportAdmissionV1,
  type ConnectionEnrollmentTransportAdmissionPortV1 } from "../../connection-registry/v1/transport-admission";
import {
  buildProjectWorkspaceVerifiedOwnerSessionV1,
  buildProtectedProjectCatalogHighWaterV1,
  buildProtectedProjectCatalogV1,
  parseProtectedProjectCatalogHighWaterV1,
  parseProtectedProjectCatalogV1,
  ProjectWorkspaceOwnerReadScopeAuthorityV1,
  ProjectWorkspaceProtectedCatalogAuthorityV1,
  type ProjectWorkspaceCatalogHighWaterStoreV1,
  type ProjectWorkspaceOperatorReadSourceV1,
  type ProjectWorkspaceProtectedCatalogSourceV1,
} from "../../project-workspace/v1";
import { IdeaLabProjectEventReconcilerV1,ProjectEventStoreV1,type ProjectEventReadSourceV1 } from "../../project-events/v1";
import { canonicalJson, hmacSha256Tag, SecurityStore, sha256Digest, type VerifiedAuthentication } from "../../security";
import { WebProjectService } from "../../web/v1/project-service";
import { WebTaskService } from "../../web/v1/task-service";
import { createLocalPilotProjectTasksV1, type LocalPilotProjectTasksV1 } from "./project-tasks";

export const LOCAL_PILOT_MODE_V1 = "repository_fake" as const;
export const LOCAL_PILOT_COOKIE_V1 = "control_room_local_pilot" as const;
export const LOCAL_PILOT_TENANT_ID_V1 = "tenant:local-owner" as const;
export const LOCAL_PILOT_WORKSPACE_ID_V1 = "workspace:control-room" as const;
const PROVIDER = "local_pilot";
const IDENTITY_ID = "identity:local-pilot-owner";
const GRANT_ID = "grant:local-pilot-owner";
const CATALOG_ID = "catalog:local-pilot-projects";
const SESSION_LIFETIME_MS = 15 * 60_000;

export class LocalPilotErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_local_pilot_configuration" | "local_request_required" |
    "invalid_owner_code" | "owner_code_consumed" | "authentication_required" | "local_pilot_unavailable") {
    super(safeCode); this.name = "LocalPilotErrorV1";
  }
}

export interface LocalPilotConfigurationV1 {
  mode: typeof LOCAL_PILOT_MODE_V1;
  origin: "http://127.0.0.1:3000";
  dataDir: string;
  repositoryRoot: string;
  masterKey: Uint8Array;
  ownerCodeDigest: string;
  clock?: () => string;
  syntheticResults?: Parameters<typeof createLocalPilotProjectTasksV1>[3];
}

interface SessionRow {
  session_id: string; tenant_id: string; identity_id: string; provider: string; subject: string;
  token_digest: string; session_digest: string; session_auth_tag: string;
  authenticated_at: string | Date; expires_at: string | Date;
}

function instant(value: string | Date): string { return typeof value === "string" ? new Date(value).toISOString() : value.toISOString(); }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
function derive(master: Uint8Array, domain: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", master).update(`control-room-local-pilot/v1\0${domain}`).digest());
}
function loopbackRequest(request: Request, origin: string, requireOrigin: boolean): void {
  const url = new URL(request.url), expected = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.host !== expected.host
    || request.headers.has("forwarded") || request.headers.has("x-forwarded-for")
    || request.headers.has("x-forwarded-host") || request.headers.has("x-forwarded-proto")) {
    throw new LocalPilotErrorV1("local_request_required");
  }
  const suppliedOrigin = request.headers.get("origin");
  if ((requireOrigin && suppliedOrigin !== origin) || (suppliedOrigin !== null && suppliedOrigin !== origin)) {
    throw new LocalPilotErrorV1("local_request_required");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new LocalPilotErrorV1("local_request_required");
}
function oneCookie(request: Request): string {
  const values = (request.headers.get("cookie") ?? "").split(";").map((item) => item.trim())
    .filter((item) => item.startsWith(`${LOCAL_PILOT_COOKIE_V1}=`)).map((item) => item.slice(LOCAL_PILOT_COOKIE_V1.length + 1));
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) throw new LocalPilotErrorV1("authentication_required");
  return values[0]!;
}

export class LocalPilotOwnerSessionServiceV1 {
  constructor(private readonly db: DatabaseClient, private readonly sessionKey: Uint8Array,
    private readonly ownerCodeDigest: string, private readonly origin: string,
    private readonly subject: string, private readonly clock: () => string) {}

  async issue(request: Request, code: unknown): Promise<{ cookie: string; expiresAt: string }> {
    loopbackRequest(request, this.origin, true);
    if (typeof code !== "string" || code.length < 24 || code.length > 200
      || !safeEqual(sha256Digest({ code }), this.ownerCodeDigest)) throw new LocalPilotErrorV1("invalid_owner_code");
    const authenticatedAt = this.clock(), expiresAt = new Date(Date.parse(authenticatedAt) + SESSION_LIFETIME_MS).toISOString();
    const token = randomBytes(32).toString("base64url"), tokenDigest = sha256Digest({ token });
    const sessionId = `local-session:${sha256Digest({ tokenDigest, authenticatedAt }).slice(7, 31)}`;
    const material = { sessionId, tenantId: LOCAL_PILOT_TENANT_ID_V1, identityId: IDENTITY_ID, provider: PROVIDER,
      subject: this.subject, tokenDigest, authenticatedAt, expiresAt };
    const sessionDigest = sha256Digest(material), sessionAuthTag = hmacSha256Tag(this.sessionKey, { ...material, sessionDigest });
    try {
      await this.db.transaction(async (tx) => {
        const used = await tx.query(`SELECT 1 FROM control_local_pilot_bootstrap_claims WHERE code_digest=$1 FOR UPDATE`, [this.ownerCodeDigest]);
        if (used.rows.length) throw new LocalPilotErrorV1("owner_code_consumed");
        await tx.query(`INSERT INTO control_local_pilot_owner_sessions(session_id,tenant_id,identity_id,provider,subject,
          token_digest,session_digest,session_auth_tag,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sessionId,LOCAL_PILOT_TENANT_ID_V1,IDENTITY_ID,PROVIDER,this.subject,tokenDigest,sessionDigest,sessionAuthTag,authenticatedAt,expiresAt]);
        const claimTag=hmacSha256Tag(this.sessionKey,{codeDigest:this.ownerCodeDigest,tenantId:LOCAL_PILOT_TENANT_ID_V1,sessionId,claimedAt:authenticatedAt});
        await tx.query(`INSERT INTO control_local_pilot_bootstrap_claims(code_digest,tenant_id,session_id,claim_auth_tag,claimed_at)
          VALUES($1,$2,$3,$4,$5)`,[this.ownerCodeDigest,LOCAL_PILOT_TENANT_ID_V1,sessionId,claimTag,authenticatedAt]);
      });
    } catch (error) {
      if (error instanceof LocalPilotErrorV1) throw error;
      throw new LocalPilotErrorV1("local_pilot_unavailable");
    }
    return { cookie: `${LOCAL_PILOT_COOKIE_V1}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`, expiresAt };
  }

  async verify(credential: unknown, nowValue: string): Promise<VerifiedAuthentication> {
    if (!(credential instanceof Request)) throw new LocalPilotErrorV1("authentication_required");
    loopbackRequest(credential, this.origin, false);
    const token = oneCookie(credential), tokenDigest = sha256Digest({ token }), now = new Date(nowValue).toISOString();
    let row: SessionRow | undefined;
    try { row = (await this.db.query<SessionRow>(`SELECT session_id,tenant_id,identity_id,provider,subject,token_digest,
      session_digest,session_auth_tag,authenticated_at,expires_at FROM control_local_pilot_owner_sessions WHERE token_digest=$1`,[tokenDigest])).rows[0]; }
    catch { throw new LocalPilotErrorV1("local_pilot_unavailable"); }
    if (!row) throw new LocalPilotErrorV1("authentication_required");
    const authenticatedAt=instant(row.authenticated_at),expiresAt=instant(row.expires_at),material={sessionId:row.session_id,
      tenantId:row.tenant_id,identityId:row.identity_id,provider:row.provider,subject:row.subject,tokenDigest:row.token_digest,
      authenticatedAt,expiresAt},expectedDigest=sha256Digest(material),expectedTag=hmacSha256Tag(this.sessionKey,{...material,sessionDigest:expectedDigest});
    if(row.tenant_id!==LOCAL_PILOT_TENANT_ID_V1||row.identity_id!==IDENTITY_ID||row.provider!==PROVIDER||row.subject!==this.subject
      ||row.token_digest!==tokenDigest||row.session_digest!==expectedDigest||!safeEqual(row.session_auth_tag,expectedTag)
      ||Date.parse(authenticatedAt)>Date.parse(now)+5_000||Date.parse(expiresAt)<=Date.parse(now)
      ||Date.parse(expiresAt)-Date.parse(authenticatedAt)>SESSION_LIFETIME_MS)throw new LocalPilotErrorV1("authentication_required");
    return { tenantId:row.tenant_id,provider:row.provider,subject:row.subject,verifiedAt:authenticatedAt,expiresAt };
  }

  async verifyProjectWorkspace(credential: unknown, now: string): Promise<unknown> {
    const auth=await this.verify(credential,now),token=oneCookie(credential as Request);
    return buildProjectWorkspaceVerifiedOwnerSessionV1({contractVersion:"control-room-project-workspace-owner-session/v1",
      tenantId:auth.tenantId,provider:auth.provider,subject:auth.subject,sessionIdDigest:sha256Digest({token}),
      authenticatedAt:auth.verifiedAt,expiresAt:auth.expiresAt,readOnly:true,grantsApproval:false,grantsNetworkAuthority:false,
      grantsCommandAuthority:false,grantsLeaseAuthority:false,grantsExecutionAuthority:false});
  }
}

class LocalPilotCatalogStoreV1 implements ProjectWorkspaceProtectedCatalogSourceV1,ProjectWorkspaceCatalogHighWaterStoreV1 {
  readonly sourceIdentityDigest:string;
  constructor(private readonly db:DatabaseClient,private readonly catalogKey:Uint8Array,private readonly highWaterKey:Uint8Array,
    private readonly registry:IdeaLabProjectRegistryStoreV1){this.sourceIdentityDigest=sha256Digest({source:"local-pilot-catalog",version:1});}
  async read():Promise<unknown>{return(await this.db.query<{payload:unknown}>(`SELECT payload FROM control_local_pilot_catalog_revisions
    WHERE catalog_id=$1 ORDER BY revision DESC LIMIT 1`,[CATALOG_ID])).rows[0]?.payload;}
  async readHighWater(catalogId:string):Promise<unknown>{if(catalogId!==CATALOG_ID)return undefined;return(await this.db.query<{payload:unknown}>(
    `SELECT payload FROM control_local_pilot_catalog_high_water WHERE catalog_id=$1 ORDER BY revision DESC LIMIT 1`,[CATALOG_ID])).rows[0]?.payload;}
  async sync(now:string):Promise<void>{const projects=await this.registry.listProjects(LOCAL_PILOT_TENANT_ID_V1,{includeArchived:true});if(!projects.length)return;
    await this.db.transaction(async tx=>{const priorCatalogRow=(await tx.query<{payload:unknown}>(`SELECT payload FROM control_local_pilot_catalog_revisions
      WHERE catalog_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,[CATALOG_ID])).rows[0],priorWaterRow=(await tx.query<{payload:unknown}>(
      `SELECT payload FROM control_local_pilot_catalog_high_water WHERE catalog_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,[CATALOG_ID])).rows[0];
      const priorCatalog=priorCatalogRow?parseProtectedProjectCatalogV1(priorCatalogRow.payload,this.catalogKey):undefined;
      const priorWater=priorWaterRow?parseProtectedProjectCatalogHighWaterV1(priorWaterRow.payload,this.highWaterKey):undefined;
      if(!!priorCatalog!==!!priorWater||priorCatalog?.revision!==priorWater?.revision)throw new LocalPilotErrorV1("local_pilot_unavailable");
      const entries=projects.map(project=>({tenantId:project.tenantId,workspaceId:project.workspaceId,projectId:project.projectId,
        projectType:project.projectKind,state:"active" as const,recordedAt:project.createdAt})).sort((a,b)=>a.projectId.localeCompare(b.projectId));
      if(priorCatalog&&canonicalJson(priorCatalog.entries)===canonicalJson(entries))return;
      const recordedAt=new Date(Math.max(Date.parse(now),...entries.map(item=>Date.parse(item.recordedAt)))).toISOString(),revision=(priorCatalog?.revision??0)+1;
      const catalog=buildProtectedProjectCatalogV1({contractVersion:"control-room-project-workspace-catalog/v1",catalogId:CATALOG_ID,
        tenantId:LOCAL_PILOT_TENANT_ID_V1,revision,previousCatalogDigest:priorCatalog?.catalogDigest??null,state:"active",
        sourceKind:"protected_server_catalog",sourceIdentityDigest:this.sourceIdentityDigest,recordedAt,entries,grantsApproval:false,
        grantsNetworkAuthority:false,grantsCommandAuthority:false,grantsLeaseAuthority:false,grantsExecutionAuthority:false},this.catalogKey);
      const water=buildProtectedProjectCatalogHighWaterV1({catalog,prior:priorWater,checkpointId:`checkpoint:local-pilot:${revision}`,
        recordedAt},this.catalogKey,this.highWaterKey);
      await tx.query(`INSERT INTO control_local_pilot_catalog_revisions(catalog_id,tenant_id,revision,catalog_digest,payload,recorded_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[CATALOG_ID,LOCAL_PILOT_TENANT_ID_V1,revision,catalog.catalogDigest,JSON.stringify(catalog),recordedAt]);
      await tx.query(`INSERT INTO control_local_pilot_catalog_high_water(catalog_id,tenant_id,revision,checkpoint_digest,payload,recorded_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[CATALOG_ID,LOCAL_PILOT_TENANT_ID_V1,revision,water.checkpointDigest,JSON.stringify(water),recordedAt]);});}
}

class LocalPilotProjectReadSourceV1 implements ProjectWorkspaceOperatorReadSourceV1{
  constructor(private readonly registry:IdeaLabProjectRegistryStoreV1){}
  async read(input:{tenantId:string;actorId:string;grantedAt:string;now:string}){void input.actorId;void input.grantedAt;
    const projects=await this.registry.listProjects(input.tenantId,{includeArchived:true});return buildOperatorSurfaceSnapshotV1({
      contractVersion:OPERATOR_SURFACES_CONTRACT_V1,tenantId:input.tenantId,generatedAt:input.now,fleet:[],bottlenecks:[],activeWork:[],
      portfolio:projects.map(project=>({projectId:project.projectId,workflowCount:0,activeJobCount:0,waitingApprovalJobCount:0,
        failedJobCount:0,lastActivityAt:project.updatedAt})),services:[],schedules:[],serviceIncidents:[],actionInbox:[],ownerFocus:[]});}
}

async function prepareDataDir(config:LocalPilotConfigurationV1):Promise<void>{if(!isAbsolute(config.dataDir)||resolve(config.dataDir)===resolve("/")
  ||!isAbsolute(config.repositoryRoot))throw new LocalPilotErrorV1("invalid_local_pilot_configuration");
  const inside=relative(resolve(config.repositoryRoot),resolve(config.dataDir));if(inside===""||(!inside.startsWith("..")&&!isAbsolute(inside)))
    throw new LocalPilotErrorV1("invalid_local_pilot_configuration");await mkdir(config.dataDir,{recursive:true,mode:0o700});
  const stat=await lstat(config.dataDir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new LocalPilotErrorV1("invalid_local_pilot_configuration");await chmod(config.dataDir,0o700);}
async function migrate(raw:PGliteType,root:string):Promise<void>{const migrationRoot=resolve(root,"db/migrations"),files=(await readdir(migrationRoot)).filter(name=>name.endsWith(".sql")).sort();
  await raw.exec(`CREATE TABLE IF NOT EXISTS control_local_pilot_schema_migrations(filename text PRIMARY KEY,digest text NOT NULL CHECK(digest ~ '^sha256:[a-f0-9]{64}$'),applied_at timestamptz NOT NULL)`);
  for(const file of files){const sql=await readFile(resolve(migrationRoot,file),"utf8"),digest=sha256Digest({file,sql}),existing=(await raw.query<{digest:string}>(`SELECT digest FROM control_local_pilot_schema_migrations WHERE filename=$1`,[file])).rows[0];
    if(existing){if(existing.digest!==digest)throw new LocalPilotErrorV1("local_pilot_unavailable");continue;}
    await raw.transaction(async tx=>{await tx.exec(sql);await tx.query(`INSERT INTO control_local_pilot_schema_migrations(filename,digest,applied_at) VALUES($1,$2,$3)`,[file,digest,new Date().toISOString()]);});}}
async function seed(db:DatabaseClient,subject:string,now:string):Promise<void>{await db.query(`INSERT INTO tenants(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,[LOCAL_PILOT_TENANT_ID_V1,"Local Pilot Owner"]);
  await db.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,[LOCAL_PILOT_WORKSPACE_ID_V1,LOCAL_PILOT_TENANT_ID_V1,"Control Room Local Pilot"]);
  await db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,project_types,
    supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control_room_native_ideas',
    'control-room-idea-lab-session/v1','control_room_native','fixture','["business_validation"]'::jsonb,'["read_project"]'::jsonb,
    '[]'::jsonb,'redaction-v1',30) ON CONFLICT(id) DO NOTHING`,[CONTROL_ROOM_IDEA_ADAPTER_V1,LOCAL_PILOT_TENANT_ID_V1]);
  const tenant=(await db.query<{display_name:string}>(`SELECT display_name FROM tenants WHERE id=$1`,[LOCAL_PILOT_TENANT_ID_V1])).rows[0],workspace=(await db.query<{tenant_id:string;display_name:string}>(`SELECT tenant_id,display_name FROM workspaces WHERE id=$1`,[LOCAL_PILOT_WORKSPACE_ID_V1])).rows[0],adapter=(await db.query<{tenant_id:string;source_system:string;contract_version:string;authority_mode:string;status:string}>(`SELECT tenant_id,source_system,contract_version,authority_mode,status FROM adapter_registry WHERE id=$1`,[CONTROL_ROOM_IDEA_ADAPTER_V1])).rows[0];
  if(tenant?.display_name!=="Local Pilot Owner"||workspace?.tenant_id!==LOCAL_PILOT_TENANT_ID_V1||workspace.display_name!=="Control Room Local Pilot"
    ||adapter?.tenant_id!==LOCAL_PILOT_TENANT_ID_V1||adapter.source_system!=="control_room_native_ideas"||adapter.contract_version!=="control-room-idea-lab-session/v1"
    ||adapter.authority_mode!=="control_room_native"||adapter.status!=="fixture")throw new LocalPilotErrorV1("local_pilot_unavailable");
  const identities=await db.query<{id:string;auth_provider:string;auth_subject_digest:string}>(`SELECT id,auth_provider,auth_subject_digest FROM control_identities WHERE tenant_id=$1`,[LOCAL_PILOT_TENANT_ID_V1]);
  if(!identities.rows.length)await new SecurityStore(db).bootstrapOwner({tenantId:LOCAL_PILOT_TENANT_ID_V1,provider:PROVIDER,subject,
    verifiedAt:now,expiresAt:new Date(Date.parse(now)+SESSION_LIFETIME_MS).toISOString(),identityId:IDENTITY_ID,grantId:GRANT_ID,
    displayName:"Local Pilot Owner",now});
  else if(identities.rows.length!==1||identities.rows[0]!.id!==IDENTITY_ID||identities.rows[0]!.auth_provider!==PROVIDER
    ||identities.rows[0]!.auth_subject_digest!==sha256Digest({provider:PROVIDER,subject}))throw new LocalPilotErrorV1("local_pilot_unavailable");
  const grant=(await db.query<{identity_id:string;role_key:string;allowed_actions:string[];project_ids:string[];risk_ceiling:string;allow_external_effects:boolean;require_strong_factor:boolean;revoked_at?:string}>(
    `SELECT identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,revoked_at FROM control_role_grants WHERE tenant_id=$1 AND id=$2`,[LOCAL_PILOT_TENANT_ID_V1,GRANT_ID])).rows[0];
  if(!grant||grant.identity_id!==IDENTITY_ID||grant.role_key!=="owner"||canonicalJson(grant.allowed_actions)!==canonicalJson(["*"])
    ||canonicalJson(grant.project_ids)!==canonicalJson(["*"])||grant.risk_ceiling!=="critical"||!grant.allow_external_effects||grant.require_strong_factor||grant.revoked_at)
    throw new LocalPilotErrorV1("local_pilot_unavailable");}

export interface ControlRoomLocalPilotRuntimeV1{
  mode:typeof LOCAL_PILOT_MODE_V1;ownerSession:LocalPilotOwnerSessionServiceV1;
  projectTasks:LocalPilotProjectTasksV1;
  operatorService:IdeaLabProtectedOperatorServiceV1;ownerDecisionService:Pick<IdeaLabOwnerDecisionServiceV1,"apply">;
  lifecycleService:Pick<IdeaLabProjectLifecycleServiceV1,"get"|"transition">;scopeAuthority:ProjectWorkspaceOwnerReadScopeAuthorityV1;
  readSource:ProjectWorkspaceOperatorReadSourceV1;projectEventSource:ProjectEventReadSourceV1;
  connectionRosterSource:ConnectionCenterRosterSourceV1;
  connectionFreshnessSource:ConnectionCenterFreshnessSourceV1;
  connectionEnrollmentIntakeService:Pick<ConnectionEnrollmentIntakeServiceV1,"ingest">;
  connectionEnrollmentNodeIngress:ConnectionEnrollmentNodeIngressPortV1;
  connectionEnrollmentTransportAdmission:ConnectionEnrollmentTransportAdmissionPortV1;
  connectionEnrollmentPrivateLoopbackListener:ConnectionEnrollmentPrivateLoopbackListenerPortV1;
  syncCatalog(now?:string):Promise<void>;close():Promise<void>;
}

export async function createControlRoomLocalPilotRuntimeV1(config:LocalPilotConfigurationV1):Promise<ControlRoomLocalPilotRuntimeV1>{
  if(config.mode!==LOCAL_PILOT_MODE_V1||config.origin!=="http://127.0.0.1:3000"||config.masterKey.byteLength!==32
    ||!/^sha256:[a-f0-9]{64}$/.test(config.ownerCodeDigest))throw new LocalPilotErrorV1("invalid_local_pilot_configuration");
  await prepareDataDir(config);const packageName=["@electric-sql","pglite"].join("/");const{PGlite}=await import(/* @vite-ignore */packageName)as{PGlite:typeof PGliteType};
  const raw=new PGlite(resolve(config.dataDir,"pglite"));try{await migrate(raw,config.repositoryRoot);const db=adaptPglite(raw),clock=config.clock??(()=>new Date().toISOString());
  const subject=`owner:${sha256Digest({master:Array.from(config.masterKey),purpose:"local-pilot-subject"}).slice(7,31)}`;await seed(db,subject,clock());
  const integrityKey=derive(config.masterKey,"idea-integrity"),sessionKey=derive(config.masterKey,"owner-session"),catalogKey=derive(config.masterKey,"project-catalog"),highWaterKey=derive(config.masterKey,"catalog-high-water"),projectEventKey=derive(config.masterKey,"project-events"),connectionRegistryKey=derive(config.masterKey,"connection-registry"),connectionFreshnessKey=derive(config.masterKey,"connection-freshness"),connectionEnrollmentAuditKey=derive(config.masterKey,"connection-enrollment-audit");
  const registry=new IdeaLabProjectRegistryStoreV1(db,integrityKey),catalog=new LocalPilotCatalogStoreV1(db,catalogKey,highWaterKey,registry),ownerSession=new LocalPilotOwnerSessionServiceV1(db,sessionKey,config.ownerCodeDigest,config.origin,subject,clock),fixture=buildIdeaLabFixtureV1();
  const webScope={tenantId:LOCAL_PILOT_TENANT_ID_V1,workspaceId:LOCAL_PILOT_WORKSPACE_ID_V1},webClock=()=>Date.parse(clock());
  const projectTasks=createLocalPilotProjectTasksV1(new WebProjectService(db,webScope,webClock,integrityKey),
    new WebTaskService(db,webScope,webClock,{ideaIntegrityKey:integrityKey}),async(request,method)=>{
      if(request.method!==method)throw new LocalPilotErrorV1("local_request_required");
      loopbackRequest(request,config.origin,method==="POST");
      const auth=await ownerSession.verify(request,clock());
      // Convert only the verified local cookie, never a request-supplied identity.
      // Canonical services still enforce current identity, grants and revocation.
      return{provider:auth.provider,subject:auth.subject,tokenDigest:sha256Digest({token:oneCookie(request)}),
        issuedAt:auth.verifiedAt,expiresAt:auth.expiresAt,verificationExpiresAt:auth.expiresAt};
    },config.syntheticResults);
  const projectEventSource=new ProjectEventStoreV1(db,projectEventKey,clock),projectEventReconciler=new IdeaLabProjectEventReconcilerV1(registry,projectEventSource);
  const operatorService=new IdeaLabProtectedOperatorServiceV1(db,integrityKey,{workspaceId:LOCAL_PILOT_WORKSPACE_ID_V1,
    participants:fixture.session.participants,driver:new DeterministicIdeaLabFakeDriverV1(),clock});
  const rawOwnerDecision=new IdeaLabOwnerDecisionServiceV1(db,integrityKey),ownerDecisionService={
    async apply(input:Parameters<IdeaLabOwnerDecisionServiceV1["apply"]>[0]):Promise<IdeaLabOwnerDecisionResultV1>{const result=await rawOwnerDecision.apply(input);if(result.project){await catalog.sync(input.now);
      await projectEventReconciler.reconcileProject(result.project.tenantId,result.project.projectId);}return result;}};
  const rawLifecycleService=new IdeaLabProjectLifecycleServiceV1(db,integrityKey,clock),lifecycleService={
    get:(projectId:unknown,authentication:VerifiedAuthentication)=>rawLifecycleService.get(projectId,authentication),
    async transition(value:unknown,authentication:VerifiedAuthentication){const result=await rawLifecycleService.transition(value,authentication);
      await projectEventReconciler.reconcileProject(result.tenantId,result.projectId);return result;}};
  const catalogAuthority=new ProjectWorkspaceProtectedCatalogAuthorityV1(catalog,{read:id=>catalog.readHighWater(id)},
    {catalogId:CATALOG_ID,tenantId:LOCAL_PILOT_TENANT_ID_V1,sourceIdentityDigest:catalog.sourceIdentityDigest},catalogKey,highWaterKey);
  const connectionRosterSource:ConnectionCenterRosterSourceV1=new ConnectionRegistryStoreV1(db,connectionRegistryKey);
  const connectionFreshnessSource:ConnectionCenterFreshnessSourceV1=new AuthenticatedFleetTelemetryFreshnessSourceV1(db,connectionFreshnessKey);
  const connectionEnrollmentIntakeService=new ConnectionEnrollmentIntakeServiceV1(db,connectionRegistryKey,
    connectionEnrollmentAuditKey,new DisabledConnectionEnrollmentDeliverySourceV1());
  const connectionEnrollmentNodeIngress=new DisabledConnectionEnrollmentNodeIngressV1();
  const connectionEnrollmentTransportAdmission=new DisabledConnectionEnrollmentTransportAdmissionV1();
  const connectionEnrollmentPrivateLoopbackListener=new DisabledConnectionEnrollmentPrivateLoopbackListenerV1();
  await catalog.sync(clock());await projectEventReconciler.reconcileAll(LOCAL_PILOT_TENANT_ID_V1);return Object.freeze({mode:LOCAL_PILOT_MODE_V1,ownerSession,projectTasks,operatorService,ownerDecisionService,lifecycleService,
    scopeAuthority:new ProjectWorkspaceOwnerReadScopeAuthorityV1({verify:(credential,now)=>ownerSession.verifyProjectWorkspace(credential,now)},catalogAuthority,new SecurityStore(db)),
    readSource:new LocalPilotProjectReadSourceV1(registry),projectEventSource,connectionRosterSource,connectionFreshnessSource,
    connectionEnrollmentIntakeService,connectionEnrollmentNodeIngress,connectionEnrollmentTransportAdmission,
    connectionEnrollmentPrivateLoopbackListener,
    syncCatalog:(now=clock())=>catalog.sync(now),close:()=>raw.close()});}
  catch(error){await raw.close().catch(()=>undefined);throw error;}}
