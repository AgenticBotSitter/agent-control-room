import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import { sha256Digest, type AuthenticatedPrincipal } from "../../security";

export const WORK_INTAKE_SERVER_CONFIGURATION_V1 = "control-room.work-intake-server/v1" as const;
export const WORK_INTAKE_CLIENT_CONFIGURATION_V1 = "control-room.work-intake-client/v1" as const;
export type WorkIntakeCredentialMappingV1 = Readonly<{ workerId:string; workerKind:string;
  credentialDigest: string; principal: AuthenticatedPrincipal }>;
export type WorkIntakeServerConfigurationV1 = Readonly<{ schema: typeof WORK_INTAKE_SERVER_CONFIGURATION_V1;
  port: number; database: PrivatePostgresConfiguration; integrityKey: string; queueDepthLimit: number;
  credentials: readonly WorkIntakeCredentialMappingV1[] }>;
export type WorkIntakeClientConfigurationV1 = Readonly<{ schema: typeof WORK_INTAKE_CLIENT_CONFIGURATION_V1;
  origin: string; bearerSecret: string }>;
export function workIntakeIdentityIdV1(tenantId:string,workerId:string){
  return `identity:work-intake:${sha256Digest({tenantId,workerId}).slice(7,31)}`;
}
export function workIntakeAuthSubjectDigestV1(workerId:string,workerKind:string){
  return sha256Digest({workerId,kind:workerKind});
}
export function workIntakeClientFileNameV1(workerId:string){
  return `${sha256Digest({workerId}).slice(7,31)}.json`;
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const token = /^[A-Za-z0-9_-]{43}$/u, digest = /^sha256:[a-f0-9]{64}$/u;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
function capturePrincipal(value: unknown): AuthenticatedPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const p = value as Record<string, unknown>;
  if (!exact(p,["tenantId","identityId","actorType","authenticatedAt","expiresAt"])
    || !id.test(String(p.tenantId)) || !id.test(String(p.identityId)) || p.actorType!=="agent"
    || !Number.isFinite(Date.parse(String(p.authenticatedAt))) || !Number.isFinite(Date.parse(String(p.expiresAt)))) throw new Error();
  return Object.freeze({ tenantId:String(p.tenantId), identityId:String(p.identityId), actorType:"agent",
    authenticatedAt:String(p.authenticatedAt), expiresAt:String(p.expiresAt) });
}
export function captureWorkIntakeServerConfigurationV1(value: unknown): WorkIntakeServerConfigurationV1 {
  try {
    if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error();
    const input=value as Record<string,unknown>;
    if (!exact(input,["schema","port","database","integrityKey","queueDepthLimit","credentials"])
      || input.schema!==WORK_INTAKE_SERVER_CONFIGURATION_V1 || !Number.isSafeInteger(input.port)
      || (input.port as number)<1 || (input.port as number)>65535 || !token.test(String(input.integrityKey))
      || !Number.isSafeInteger(input.queueDepthLimit) || (input.queueDepthLimit as number)<1
      || (input.queueDepthLimit as number)>20 || !Array.isArray(input.credentials) || input.credentials.length>20) throw new Error();
    const database=validatePrivatePostgresConfiguration(input.database as PrivatePostgresConfiguration);
    if (database.username!=="control_room_work_intake_agent") throw new Error();
    const credentials=input.credentials.map(value=>{ if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error();
      const entry=value as Record<string,unknown>; if(!exact(entry,["workerId","workerKind","credentialDigest","principal"])
        || !id.test(String(entry.workerId)) || !/^(codex|claude-code|hermes)$/u.test(String(entry.workerKind))
        || !digest.test(String(entry.credentialDigest))) throw new Error();
      return Object.freeze({workerId:String(entry.workerId),workerKind:String(entry.workerKind),
        credentialDigest:String(entry.credentialDigest),principal:capturePrincipal(entry.principal)}); });
    if(new Set(credentials.map(x=>x.credentialDigest)).size!==credentials.length
      || new Set(credentials.map(x=>x.principal.identityId)).size!==credentials.length) throw new Error();
    return Object.freeze({schema:WORK_INTAKE_SERVER_CONFIGURATION_V1,port:input.port as number,database,
      integrityKey:String(input.integrityKey),queueDepthLimit:input.queueDepthLimit as number,credentials:Object.freeze(credentials)});
  } catch { throw new Error("work_intake_server_configuration_refused"); }
}
export function renewWorkIntakeServerCredentialsV1(value:WorkIntakeServerConfigurationV1,now:string,days=30){
  const captured=captureWorkIntakeServerConfigurationV1(value),at=new Date(now);
  if(!Number.isFinite(at.getTime())||!Number.isSafeInteger(days)||days<1||days>365) throw new Error("work_intake_renewal_refused");
  const expiresAt=new Date(at.getTime()+days*86400000).toISOString();
  return captureWorkIntakeServerConfigurationV1({...captured,credentials:captured.credentials.map(mapping=>({...mapping,
    principal:{...mapping.principal,authenticatedAt:at.toISOString(),expiresAt}}))});
}
export function captureWorkIntakeClientConfigurationV1(value: unknown): WorkIntakeClientConfigurationV1 {
  if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error("work_intake_client_configuration_refused");
  const input=value as Record<string,unknown>;
  if(!exact(input,["schema","origin","bearerSecret"])||input.schema!==WORK_INTAKE_CLIENT_CONFIGURATION_V1
    ||typeof input.origin!=="string"||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(input.origin)
    ||!token.test(String(input.bearerSecret))) throw new Error("work_intake_client_configuration_refused");
  return Object.freeze({schema:WORK_INTAKE_CLIENT_CONFIGURATION_V1,origin:input.origin,bearerSecret:String(input.bearerSecret)});
}
