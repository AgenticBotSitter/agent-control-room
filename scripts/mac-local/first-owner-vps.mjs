/** One-time VPS-local first-owner setup. The CLI accepts only a reviewed,
 * shareable manifest, connects as postgres over a Unix socket, and never
 * retries an uncertain transaction. The exported function is injected with
 * a disposable PostgreSQL 17 client by the rehearsal; it has no network
 * fallback of its own. */
import { generateKeyPairSync } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { sha256Digest } from "../../src/security/canonical-digest";
import { publicKeyFingerprint } from "../../src/node-protocol/v1";
import { DOMAIN_CONTRACT_VERSION, nodeRecordSchema } from "../../src/domain/v1";
import { captureMacLocalFirstOwnerManifestV1 } from "./first-owner-manifest.mjs";

export const MAC_LOCAL_FIRST_OWNER_RECEIPT_V1 = "control-room.mac-local-first-owner-receipt/v1";
export const FIRST_OWNER_ROW_TOTAL_V1 = 14;

/** Every persisted column of every one-time table is classified. A new
 * migration column makes the rehearsal fail until this classification changes.
 * Mutable operational fields are not overwritten or treated as identity. */
export const FIRST_OWNER_COLUMN_POLICY_V1 = Object.freeze({
  tenants: { identity: ["id", "display_name", "created_at"], operational: ["coordinator_lock"] },
  workspaces: { identity: ["id", "tenant_id", "display_name", "created_at"], operational: ["web_lock"] },
  control_identities: { identity: ["id", "tenant_id", "actor_type", "display_name", "auth_provider", "auth_subject_digest", "created_at"],
    operational: ["state", "updated_at", "web_lock"] },
  control_role_grants: { identity: ["id", "tenant_id", "identity_id", "role_key", "allowed_actions", "project_ids",
    "risk_ceiling", "allow_external_effects", "require_strong_factor", "created_at"],
    operational: ["expires_at", "revoked_at", "updated_at", "web_lock"] },
  adapter_registry: { identity: ["id", "tenant_id", "source_system", "contract_version", "authority_mode", "project_types",
    "supported_read_operations", "supported_commands", "redaction_policy_version", "cursor_retention_days", "created_at"],
    operational: ["status", "last_seen_at", "updated_at"] },
  control_nodes: { identity: ["id", "tenant_id", "identity_key_id", "payload", "created_at"],
    operational: ["state", "version", "updated_at", "coordinator_lock"] },
  control_node_keys: { identity: ["id", "tenant_id", "node_id", "algorithm", "public_key_spki", "fingerprint", "valid_from", "created_at"],
    operational: ["state", "valid_until", "revoked_at", "coordinator_lock"] },
  control_completion_gate_integrity: { identity: ["tenant_id", "record_count", "state_digest", "state_auth_tag", "revision"],
    operational: ["web_lock"] },
});

const refused = code => { throw new Error(code); };
const iso = value => new Date(value).toISOString();
const equal = (a, b) => sha256Digest(a) === sha256Digest(b);

export async function verifyFirstOwnerColumnCoverageV1(client) {
  for (const [table, policy] of Object.entries(FIRST_OWNER_COLUMN_POLICY_V1)) {
    const classified = [...policy.identity, ...policy.operational];
    if (new Set(classified).size !== classified.length) refused("first_owner_column_policy_invalid");
    const observed = (await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`, [table])).rows.map(row => row.column_name);
    if (!equal([...classified].sort(), observed)) refused("first_owner_column_policy_drift");
  }
  // The first key pair is random and its private half is intentionally never
  // exported. Immutable database identity plus the Mac's independent pin are
  // the repeat-run anchors for its public half.
  const guardNames = ["control_node_keys_identity_immutable", "control_node_keys_delete_protected"];
  const guards = (await client.query(`SELECT tgname,tgenabled FROM pg_trigger
    WHERE tgrelid='control_node_keys'::regclass AND NOT tgisinternal
      AND tgname=ANY($1::text[])`, [guardNames])).rows;
  if (guards.length !== guardNames.length || guards.some(row => row.tgenabled !== "O")
    || guardNames.some(name => !guards.some(row => row.tgname === name))) refused("first_owner_key_immutability_missing");
}

function nodeIdentityPayload(payload) {
  const parsed = nodeRecordSchema.safeParse(payload);
  if (!parsed.success) refused("first_owner_row_conflict");
  const { contractVersion, kind, id, tenantId, displayName, platform, architecture, identityKeyId,
    hardwareFingerprint, softwareFingerprint, policyVersion, minimumProtocolVersion, enrolledAt, createdAt } = parsed.data;
  return { contractVersion, kind, id, tenantId, displayName, platform, architecture, identityKeyId,
    hardwareFingerprint, softwareFingerprint, policyVersion, minimumProtocolVersion, enrolledAt, createdAt };
}

async function createOrKeep(client, table, idColumn, id, expected, insertSql, params, compare = (actual, desired) =>
  equal(Object.fromEntries(Object.keys(desired).map(key => [key, key.endsWith("_at") && actual[key] !== null ? iso(actual[key]) : actual[key]])), desired)) {
  const result = await client.query(`SELECT * FROM ${table} WHERE ${idColumn}=$1`, [id]);
  if (result.rows.length > 1) refused("first_owner_row_conflict");
  if (result.rows.length === 1) {
    if (!compare(result.rows[0], expected)) refused("first_owner_row_conflict");
    return "kept";
  }
  await client.query(insertSql, params);
  return "created";
}

/** Applies exactly fourteen rows in one transaction. No retry, repair, grant,
 * migration, or role mutation is performed here. */
export async function applyMacLocalFirstOwnerV1(client, suppliedManifest) {
  const m = captureMacLocalFirstOwnerManifestV1(suppliedManifest);
  await verifyFirstOwnerColumnCoverageV1(client);
  const tenantId = m.tenant.id, at = m.createdAt;
  const fingerprints = Object.create(null);
  let created = 0, kept = 0;
  const count = state => { if (state === "created") created++; else kept++; };
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    count(await createOrKeep(client,"tenants","id",tenantId,
      {id:tenantId,display_name:m.tenant.displayName,created_at:at},
      "INSERT INTO tenants(id,display_name,created_at) VALUES($1,$2,$3)", [tenantId,m.tenant.displayName,at]));
    count(await createOrKeep(client,"workspaces","id",m.workspace.id,
      {id:m.workspace.id,tenant_id:tenantId,display_name:m.workspace.displayName,created_at:at},
      "INSERT INTO workspaces(id,tenant_id,display_name,created_at) VALUES($1,$2,$3,$4)",
      [m.workspace.id,tenantId,m.workspace.displayName,at]));
    count(await createOrKeep(client,"control_identities","id",m.identity.id,
      {id:m.identity.id,tenant_id:tenantId,actor_type:"human",display_name:m.identity.displayName,
        auth_provider:"local-owner",auth_subject_digest:m.identity.subjectDigest,created_at:at},
      `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
       VALUES($1,$2,'human',$3,'local-owner',$4,'active',$5,$5)`,
      [m.identity.id,tenantId,m.identity.displayName,m.identity.subjectDigest,at]));
    count(await createOrKeep(client,"control_role_grants","id",m.grant.id,
      {id:m.grant.id,tenant_id:tenantId,identity_id:m.identity.id,role_key:"owner",allowed_actions:["*"],project_ids:["*"],
        risk_ceiling:"critical",allow_external_effects:true,require_strong_factor:false,created_at:at},
      `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
        allow_external_effects,require_strong_factor,created_at,updated_at)
       VALUES($1,$2,$3,'owner','["*"]'::jsonb,'["*"]'::jsonb,'critical',true,false,$4,$4)`,
      [m.grant.id,tenantId,m.identity.id,at]));
    for (const adapter of m.adapters) count(await createOrKeep(client,"adapter_registry","id",adapter.id,
      {id:adapter.id,tenant_id:tenantId,source_system:"control-room-mac-local",contract_version:"1.0.0",
        authority_mode:"control_room_native",project_types:[],supported_read_operations:[],supported_commands:[],
        redaction_policy_version:"v1",cursor_retention_days:30,created_at:at},
      `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
       redaction_policy_version,cursor_retention_days,created_at,updated_at)
       VALUES($1,$2,'control-room-mac-local','1.0.0','control_room_native','online','v1',30,$3,$3)`,
      [adapter.id,tenantId,at]));
    for (const node of m.nodes) {
      const nodeId=node.nodeId,keyId=`local-owner:${nodeId}`,kind=nodeId.slice(nodeId.lastIndexOf(".")+1);
      const payload=nodeRecordSchema.parse({contractVersion:DOMAIN_CONTRACT_VERSION,kind:"node",id:nodeId,tenantId,
        displayName:`Mac local ${kind}`,state:"active",version:1,platform:"macos",architecture:"local",identityKeyId:keyId,
        hardwareFingerprint:sha256Digest({purpose:"mac-local-node",nodeId}),
        softwareFingerprint:sha256Digest({purpose:"mac-local-worker-node",nodeId,workerId:node.workerId,adapterId:node.adapterId}),
        policyVersion:"mac-local/v1",minimumProtocolVersion:"local-only",enrolledAt:at,createdAt:at,updatedAt:at});
      count(await createOrKeep(client,"control_nodes","id",nodeId,
        {id:nodeId,tenant_id:tenantId,identity_key_id:keyId,payload:nodeIdentityPayload(payload),created_at:at},
        `INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
         VALUES($1,$2,'active',1,$3,$4::jsonb,$5,$5)`, [nodeId,tenantId,keyId,JSON.stringify(payload),at],
        (actual,desired)=>equal({id:actual.id,tenant_id:actual.tenant_id,identity_key_id:actual.identity_key_id,
          payload:nodeIdentityPayload(actual.payload),created_at:iso(actual.created_at)},desired)));
      const keyRows=(await client.query("SELECT * FROM control_node_keys WHERE node_id=$1",[nodeId])).rows;
      if(keyRows.length>1) refused("first_owner_row_conflict");
      if(keyRows.length===1){
        const key=keyRows[0];
        if(key.id!==keyId||key.tenant_id!==tenantId||key.algorithm!=="ed25519"
          ||iso(key.valid_from)!==at||iso(key.created_at)!==at
          ||publicKeyFingerprint(key.public_key_spki)!==key.fingerprint) refused("first_owner_row_conflict");
        fingerprints[nodeId]=key.fingerprint; kept++;
      }else{
        const pair=generateKeyPairSync("ed25519");
        const publicSpki=pair.publicKey.export({format:"der",type:"spki"}).toString("base64url");
        const fingerprint=publicKeyFingerprint(publicSpki);
        // The private key remains a process-local KeyObject and is never exported.
        await client.query(`INSERT INTO control_node_keys(id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,
          state,valid_from,created_at) VALUES($1,$2,$3,'ed25519',$4,$5,'active',$6,$6)`,
          [keyId,tenantId,nodeId,publicSpki,fingerprint,at]);
        fingerprints[nodeId]=fingerprint; created++;
      }
    }
    const genesis=m.completionGateGenesis;
    const rows=(await client.query("SELECT * FROM control_completion_gate_integrity WHERE tenant_id=$1",[tenantId])).rows;
    if(rows.length>1) refused("first_owner_row_conflict");
    if(rows.length===1){
      const row=rows[0];
      if(Number(row.revision)!==1||Number(row.record_count)!==0) refused("completion_gate_state_advanced");
      if(row.state_digest!==genesis.stateDigest||row.state_auth_tag!==genesis.stateAuthTag) refused("first_owner_row_conflict");
      kept++;
    }else{
      await client.query(`INSERT INTO control_completion_gate_integrity
        (tenant_id,revision,record_count,state_digest,state_auth_tag) VALUES($1,$2,$3,$4,$5)`,
        [tenantId,genesis.revision,genesis.recordCount,genesis.stateDigest,genesis.stateAuthTag]);
      created++;
    }
    if(created+kept!==FIRST_OWNER_ROW_TOTAL_V1) refused("first_owner_row_count_invalid");
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  return Object.freeze({schema:MAC_LOCAL_FIRST_OWNER_RECEIPT_V1,manifestDigest:sha256Digest(m),tenantId,
    created,kept,fingerprints});
}

async function run() {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=="--manifest"||!isAbsolute(args[1])||resolve(args[1])!==args[1])
    refused("usage: node --import tsx scripts/mac-local/first-owner-vps.mjs --manifest ABSOLUTE_FILE");
  if(userInfo().username!=="postgres") refused("first_owner_postgres_peer_required");
  const stat=await lstat(args[1]);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024) refused("first_owner_manifest_file_refused");
  const manifest=captureMacLocalFirstOwnerManifestV1(JSON.parse(await readFile(args[1],"utf8")));
  const client=new Client({host:"/var/run/postgresql",port:5432,database:"control_room",user:"postgres",
    connectionTimeoutMillis:5000,statement_timeout:5000,query_timeout:30000});
  try{
    await client.connect();
    const peer=(await client.query("SELECT current_user,session_user,inet_client_addr() AS client_addr,current_database() AS database")).rows[0];
    if(peer?.current_user!=="postgres"||peer?.session_user!=="postgres"||peer?.client_addr!==null||peer?.database!=="control_room")
      refused("first_owner_postgres_peer_required");
    process.stdout.write(`${JSON.stringify(await applyMacLocalFirstOwnerV1(client,manifest))}\n`);
  }finally{await client.end().catch(()=>{});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await run();}
  catch{process.stderr.write("First-owner setup failed or its outcome is uncertain. Do not automatically retry. Review the database and manifest privately.\n");process.exitCode=1;}
}
