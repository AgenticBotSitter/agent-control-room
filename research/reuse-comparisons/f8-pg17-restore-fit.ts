// Real whole-database logical restore; synthetic website profile, owned PG17 only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createPrivateDeploymentInventory } from '../../scripts/private-deployment-inventory.mjs';
import { boundPrivateDatabase } from '../../src/web/v1/bounded-database.ts';
import { verifyPrivateDatabase } from '../../src/web/v1/private-database-preflight.ts';
import { SecurityStore } from '../../src/security/security-store.ts';
import { WebProjectService } from '../../src/web/v1/project-service.ts';
import { checkedResultBytes, resultBytesHash } from '../../src/artifacts/v1/native-results.ts';
const root=process.argv[2]; assert.equal(root,'/private/tmp/cr-f8-pg17.2FlFtD');
assert.equal(JSON.parse(await readFile(join(root,'verification-ids.json'),'utf8')).prepared,true);
const repo=resolve('.'), bin=join(root,'Postgres.app/Contents/Versions/17/bin');
const run=await mkdtemp(join(root,'restore-run-')), data=join(run,'data'), socket=join(run,'socket');
await mkdir(socket,{mode:0o700});
const exec=promisify(execFile), env={PATH:'/usr/bin:/bin',LC_ALL:'C',TMPDIR:run};
const native=async(name:string,args:string[])=>exec(join(bin,name),args,{env,timeout:30000,maxBuffer:262144});
const {Client,Pool}=createRequire('/private/tmp/cr-compare-f1.9x5bSO/node_modules/@dbos-inc/dbos-sdk/package.json')('pg');
const options=(database:string,user='fixture_admin')=>({host:socket,port:65434,database,user,password:'',
  connectionTimeoutMillis:2000,statement_timeout:5000});
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const observations:object[]=[]; const emit=(v:object)=>{observations.push(v);console.log(JSON.stringify(v));};
const schemaManifests=new Map<string,any[]>();
const connections:InstanceType<typeof Client>[]=[];
const connect=async(database:string,user='fixture_admin')=>{const client=new Client(options(database,user));
  connections.push(client);await client.connect();return client;};
const simple=(sql:InstanceType<typeof Client>)=>({query:(q:string,p:unknown[]=[])=>sql.query(q,p),
  async transaction<T>(fn:(tx:any)=>Promise<T>){await sql.query('BEGIN');try{const result=await fn(this);await sql.query('COMMIT');return result;}
    catch(e){await sql.query('ROLLBACK');throw e;}},
  async transactionWithPreCommitCheck<T>(fn:(tx:any)=>Promise<T>,check:()=>Promise<void>|void){return this.transaction(async tx=>{const value=await fn(tx);await check();return value;});}});
const scope={tenantId:'tenant:restore',workspaceId:'workspace:restore',ownerIdentityId:'identity:restore',issuer:'https://fixture.example.invalid'};
const now=Date.parse('2026-09-08T12:00:00Z');
const identity={provider:scope.issuer,subject:'synthetic-owner',tokenDigest:'sha256:'+hash('synthetic assertion'),
  issuedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+300000).toISOString(),verificationExpiresAt:new Date(now+300000).toISOString()};
const snapshot=async(c:any)=>{
  const names=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const rows=[];
  for(const {tablename} of names){assert.match(tablename,/^[a-z0-9_]+$/);
    const result=(await c.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${tablename}" t`)).rows[0].rows;
    rows.push({table:tablename,count:result.length,digest:hash(JSON.stringify(result))});}
  // NULL ACL means PostgreSQL's default grants, not no permissions. Compare the
  // catalog-expanded effective default with an explicit equivalent ACL.
  const ownership=(await c.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,
    coalesce(c.relacl,CASE WHEN c.relkind='S' THEN acldefault('s',c.relowner)
      WHEN c.relkind IN ('r','p','v','m','f') THEN acldefault('r',c.relowner) END)::text AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`)).rows;
  const functions=(await c.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,
    pg_get_userbyid(p.proowner) AS owner,coalesce(p.proacl,acldefault('f',p.proowner))::text AS acl,p.prosecdef FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,args`)).rows;
  return {rows,ownership,functions};
};
let started=false,stopped=false;
try {
  const inventory=await createPrivateDeploymentInventory(repo,'website-only');
  emit({stage:'inventory',migrations:inventory.migrationCount,inventorySha256:inventory.inventorySha256});
  await native('initdb',['-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8']);
  started=true;
  await native('pg_ctl',['-D',data,'-l',join(run,'server.log'),'-w','-t','10','-o',
    `-k ${socket} -p 65434 -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c shared_preload_libraries='' -c session_preload_libraries='' -c local_preload_libraries=''`,'start']);
  const admin=await connect('postgres');
  assert.equal((await admin.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
  await admin.query('CREATE ROLE fixture_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  await admin.query('CREATE DATABASE fixture_source OWNER fixture_owner');
  await admin.query('CREATE DATABASE fixture_restore OWNER fixture_owner');
  const source=await connect('fixture_source'), restored=await connect('fixture_restore');
  assert.equal((await restored.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  await source.query('SET ROLE fixture_owner');
  for(const entry of inventory.migrations){const bytes=await readFile(join(repo,entry.path));assert.equal(hash(bytes),entry.sha256);await source.query(bytes.toString());}
  await source.query('RESET ROLE');
  for(const entry of inventory.roles){const bytes=await readFile(join(repo,entry.path));assert.equal(hash(bytes),entry.sha256);await source.query(bytes.toString());}
  await source.query('ALTER DEFAULT PRIVILEGES FOR ROLE fixture_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  await source.query('CREATE ROLE fixture_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  await source.query('GRANT control_room_private_web TO fixture_web');
  await source.query('SET ROLE fixture_owner');
  await source.query("INSERT INTO tenants(id,display_name) VALUES('tenant:restore','Synthetic restore tenant')");
  await source.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:restore','tenant:restore','Synthetic restore workspace')");
  await new SecurityStore(simple(source)).bootstrapOwner({tenantId:scope.tenantId,provider:scope.issuer,subject:identity.subject,
    identityId:scope.ownerIdentityId,grantId:'grant:restore',displayName:'Synthetic owner',verifiedAt:identity.issuedAt,
    expiresAt:identity.expiresAt,now:new Date(now).toISOString()});
  await source.query('RESET ROLE');
  const artifact=Buffer.from('Disposable backup pairing evidence. No native agent result.');
  const claim={contentHash:resultBytesHash(artifact),sizeBytes:artifact.length};
  await writeFile(join(run,'artifact-original.txt'),artifact,{flag:'wx',mode:0o600});
  const web=async(database:string)=>{
    const pool=new Pool({...options(database,'fixture_web'),max:1});
    const db=boundPrivateDatabase({async acquire(){const lease=await pool.connect();
      await lease.query("SET search_path = pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s'; SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'");
      return {async query(s:string,p:unknown[]=[]){
        const result=await lease.query(s,p);
        if(s.includes('AS database_temp') || s.includes('AS unsafe') || s.includes('AS valid'))
          emit({stage:'preflight-query',database,querySha256:hash(s),rows:result.rows});
        if(s.includes(') manifest')){
          schemaManifests.set(database,result.rows);
          emit({stage:'schema-fingerprint',database,digest:hash(JSON.stringify(result.rows))});
          const original=schemaManifests.get('fixture_source');
          if(database==='fixture_restore' && original){
            const baseline=new Map(original.map(r=>[r.kind+':'+r.name,r.definition]));
            const differences=result.rows.filter((r:any)=>baseline.get(r.kind+':'+r.name)!==r.definition)
              .map((r:any)=>({kind:r.kind,name:r.name,before:baseline.get(r.kind+':'+r.name),after:r.definition}));
            emit({stage:'schema-differences',count:differences.length,differences});
          }
        }
        return result;
      },release:()=>lease.release()};},terminate:()=>pool.end()});
    return {db,config:{host:'127.0.0.1' as const,port:65434,database,username:'fixture_web',password:'synthetic-unused-socket',majorVersion:17 as const}};
  };
  const first=await web('fixture_source');
  try {
    await verifyPrivateDatabase(first.db.client,first.config,scope,now);
    const project=await new WebProjectService(first.db.client,scope,()=>now).create(identity,
      {title:'Disposable restored project',summary:`Synthetic artifact ${claim.contentHash}`},'restore-project-request-001');
    assert.ok(project);emit({stage:'source-preflight-and-project',passed:true});
  } finally {await first.db.close();}
  const expected=await snapshot(source);
  const archive=join(run,'database.dump');
  await native('pg_dump',['--host',socket,'--port','65434','--username','fixture_admin','--dbname','fixture_source','--format=custom','--no-password','--file',archive]);
  const archiveBytes=await readFile(archive);assert.ok(archiveBytes.length>0);
  const list=await native('pg_restore',['--list',archive]);assert.ok(list.stdout.includes('TABLE DATA'));
  await native('pg_restore',['--host',socket,'--port','65434','--username','fixture_admin','--dbname','fixture_restore','--single-transaction','--exit-on-error','--no-password',archive]);
  await restored.query(await readFile(join(repo,'db/roles/private_web_database.sql'),'utf8'));
  assert.deepEqual(await snapshot(restored),expected);
  const second=await web('fixture_restore');
  let restoredPreflight=false;
  try {
    // Research only: retain a failed gate, then independently measure restored
    // service behavior. This never starts an app or converts rejection to a pass.
    try {await verifyPrivateDatabase(second.db.client,second.config,scope,now);restoredPreflight=true;}
    catch(error){emit({stage:'restored-preflight',passed:false,message:String((error as Error).message)});}
    const projects=await new WebProjectService(second.db.client,scope,()=>now).list(identity);assert.equal(projects.length,1);
    assert.equal(projects[0].summary,`Synthetic artifact ${claim.contentHash}`);
    for(const denied of ['CREATE TABLE forbidden(id int)','CREATE TEMP TABLE forbidden(id int)','ALTER ROLE fixture_web SUPERUSER','DELETE FROM projects'])
      await assert.rejects(second.db.client.query(denied));
  } finally {await second.db.close();}
  await copyFile(join(run,'artifact-original.txt'),join(run,'artifact-restored.txt'));
  checkedResultBytes(await readFile(join(run,'artifact-restored.txt')),claim);
  assert.throws(()=>checkedResultBytes(Buffer.from('tampered'),claim));
  await assert.rejects(readFile(join(run,'artifact-missing.txt')),{code:'ENOENT'});
  assert.deepEqual(await snapshot(source),expected);
  emit({stage:'whole-db-restore',passed:restoredPreflight,tables:expected.rows.length,populatedTables:expected.rows.filter(r=>r.count>0).length,
    rowsOwnershipRelationAclEqual:true,restrictedPreflight:restoredPreflight,projectReadable:true,forbiddenOperationsRefused:4,
    archiveBytes:archiveBytes.length,archiveSha256:hash(archiveBytes),artifactBytesVerified:true,missingTamperedRejected:true,
    scope:'website-only full schema with synthetic owner/project; artifact digest in project summary, not native-result manifest; no agent/task-authoring role qualification'});
  assert.equal(restoredPreflight,true,'restored safety gate remains an implementation blocker');
}catch(error){emit({failed:true,message:String((error as Error).message).slice(0,1200)});process.exitCode=1;}
finally {
  for(const connection of connections)await connection.end().catch(()=>{});
  if(started){try{await native('pg_ctl',['-D',data,'-m','fast','-w','-t','10','stop']);stopped=true;}catch{process.exitCode=1;}}
  if(!started||stopped){await assert.rejects(lstat(join(data,'postmaster.pid')),{code:'ENOENT'});
    await rm(run,{recursive:true});emit({cleanup:true,clusterStopped:stopped});}
  else emit({cleanup:false,retainedOwnedRun:run});
  await writeFile(join(root,`restore-evidence-${run.split('/').at(-1)}.json`),JSON.stringify(observations,null,2),{flag:'wx',mode:0o600});
}
