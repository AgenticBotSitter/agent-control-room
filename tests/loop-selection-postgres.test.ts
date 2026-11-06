import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {Client} from 'pg';
import {randomBytes} from 'node:crypto';
import {privateWebSchemaDigest} from '../src/web/v1/private-database-preflight';
import {withRealPostgres,requiresRealPostgres} from './support/attack-kit/index';
import {readPrivateWebSchemaDigest} from '../src/web/v1/private-database-preflight';
import {digestReleaseSchemaRowsV1} from '../src/updater/v1/pg/release-schema-digest.mjs';

test('U81-B PG17 strict acknowledgement schema and production timestamp helper',async()=>{
  assert.ok(requiresRealPostgres(),'PG17 required');
  const count=Number(execFileSync('/bin/bash',['-o','pipefail','-c','ipcs -m | tail -n +4 | wc -l'],{encoding:'utf8',timeout:10000}).trim());
  assert.ok(Number.isSafeInteger(count)&&count<20);
  const port=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? '60520');assert.ok(port>=60520&&port<=60539);
  const result=await withRealPostgres(async pg=>{
    const admin=new Client(pg.admin()),web=new Client(pg.connection('web'));await admin.connect();await web.connect();
    try{
      const sourceColumns=(await admin.query(`SELECT attname,attnum FROM pg_attribute WHERE attrelid='control_loop_policy_input_sources'::regclass AND attnum>0 ORDER BY attnum`)).rows;
      assert.deepEqual(sourceColumns.map(r=>r.attname),['tenant_id','request_id','input_version','defaults_sha256','layer_versions','waiver_id']);
      assert.deepEqual(sourceColumns.map(r=>r.attnum),[1,2,3,4,5,6]);
      const reverse=(await admin.query(`SELECT condeferrable,condeferred FROM pg_constraint WHERE conname='control_loop_policy_input_sources_admission_fk'`)).rows;
      assert.deepEqual(reverse,[{condeferrable:true,condeferred:true}]);
      const measured=await readPrivateWebSchemaDigest(web);
      const updater=digestReleaseSchemaRowsV1((await web.query(await readFile('src/updater/v1/pg/release-schema-digest.sql','utf8'))).rows);
      assert.equal(updater,measured);
      console.log(`RESULT: measured U81-B schema=${measured} updater_equal=true`);
      assert.equal((await admin.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`)).rows[0].n,266);
      for(const value of ['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-11-01T24:00:00Z','2026-11-01T00:00:60Z','2026-11-01T00:00:00','2026-11-01T00:00:00+16:00','2026-11-01T00:00:00+01:60','0000-01-01T00:00:00Z'])
        assert.equal((await web.query('SELECT control_loop_selection_ack_timestamp_v1($1) at',[value])).rows[0].at,null,value);
      for(const value of ['2024-02-29T00:00:00Z','2026-11-01T03:00:00.123+03:00','2026-11-01T00:00:00-00:00'])
        assert.equal((await web.query('SELECT control_loop_selection_ack_timestamp_v1($1) at',[value])).rows[0].at.toISOString(),new Date(value).toISOString());
      assert.equal((await admin.query(`SELECT has_function_privilege('public','control_loop_selection_ack_timestamp_v1(text)','EXECUTE') allowed`)).rows[0].allowed,false);
      await writeFile('.test-tmp/u81b-r7-schema-pin.txt',measured+'\n');
      assert.equal(measured,privateWebSchemaDigest);
      const ledgerBefore=(await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows;
      const down=async()=>{
        await admin.query(await readFile('db/down/0317_control_loop_selection_acknowledgement_validate.sql','utf8'));
        await admin.query(await readFile('db/down/0316_control_loop_selection_acknowledgement.sql','utf8'));
      };
      const up=async()=>{
        for(const file of ['0316_control_loop_selection_acknowledgement.sql','0317_control_loop_selection_acknowledgement_validate.sql']){
          await admin.query('BEGIN');await admin.query('SET LOCAL ROLE control_room_schema_owner');
          await admin.query(await readFile('db/migrations/'+file,'utf8'));await admin.query('COMMIT');
        }
        await admin.query((await readFile('db/roles/private_web_roles.sql','utf8')).replace(/CREATE ROLE control_room_private_web[^;]+;/,''));
        assert.equal((await web.query("SELECT has_table_privilege(current_user,'control_loop_policy_input_admissions','INSERT') allowed")).rows[0].allowed,true);
      };
      await down();
      assert.equal((await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n,265);
      const previous=await readPrivateWebSchemaDigest(admin);
      assert.equal(previous,'4a6a7d6b379607ba88adff4798e0aa0fb267ca03894a13b9cf7c65c0db2aaf78');
      await admin.query('BEGIN');await admin.query('SET LOCAL ROLE control_room_schema_owner');
      await admin.query(await readFile('db/migrations/0316_control_loop_selection_acknowledgement.sql','utf8'));
      await assert.rejects(admin.query('SELECT 1/0'),{code:'22012'});await admin.query('ROLLBACK');
      assert.equal(await readPrivateWebSchemaDigest(admin),previous);
      assert.deepEqual((await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows,ledgerBefore);
      await up();assert.equal(await readPrivateWebSchemaDigest(web),measured);
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:selection','Selection fixture')");
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:selection','tenant:selection','Selection fixture')");
      await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
        VALUES('adapter:selection','tenant:selection','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`);
      await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES('project:selection','tenant:selection','workspace:selection','adapter:selection','fixture','1','Selection fixture','planned','manual_project_active','healthy','control_room_native',now(),
        '{"presentation":{"templateId":"control-room"}}',now())`);
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
        VALUES('identity:selection','tenant:selection','human','Selection fixture','test','sha256:'||repeat('a',64),'active',now(),now())`);
      const hash='a'.repeat(64),digest='sha256:'+hash;
      const pair = async (kind: string | null | undefined, finish: 'commit' | 'rollback' | 'immediate' = 'rollback', beforeFinish?:()=>Promise<void>) => {
        const request='request:'+randomBytes(16).toString('hex'),key='source-'+randomBytes(16).toString('hex');
        await web.query('BEGIN');
        try {
          await web.query(`INSERT INTO control_loop_improvement_requests(tenant_id,project_id,owner_identity_id,id,idempotency_key,record_digest,auth_tag,created_at)
            VALUES('tenant:selection','project:selection','identity:selection',$1,$2,$3,$4,now())`,[request,key,digest,'hmac-sha256:'+hash]);
          await web.query(`INSERT INTO control_loop_improvement_inputs(tenant_id,project_id,owner_identity_id,request_id,version,description,request_sha256,settings_text,settings_sha256,idempotency_key,record_digest,auth_tag,created_at)
            VALUES('tenant:selection','project:selection','identity:selection',$1,1,'Recorded input',$2,'{}',$2,$3,$4,$5,now())`,[request,hash,key,digest,'hmac-sha256:'+hash]);
          await web.query(`INSERT INTO control_loop_policy_input_sources(tenant_id,request_id,input_version,defaults_sha256,layer_versions,waiver_id)
            VALUES('tenant:selection',$1,1,$2,'{"project":0,"selection":0}',NULL)`,[request,hash]);
          if(kind!==undefined) await web.query(`INSERT INTO control_loop_policy_input_admissions(tenant_id,request_id,input_version,admission_kind)
            VALUES('tenant:selection',$1,1,$2)`,[request,kind]);
          await beforeFinish?.();
          if(finish==='immediate') await web.query('SET CONSTRAINTS ALL IMMEDIATE');
          if(finish==='commit') await web.query('COMMIT');
          return request;
        } finally { await web.query('ROLLBACK'); }
      };
      await pair('native-p71');await pair('product-b8');
      await assert.rejects(pair(undefined,'commit'),{code:'23503'},'source-only commit refuses');
      await assert.rejects(pair(null),{code:'23502'});await assert.rejects(pair('unknown'),{code:'23514'});
      await assert.rejects(web.query(`INSERT INTO control_loop_policy_input_admissions VALUES('tenant:selection','request:absent',1,'native-p71')`),{code:'23503'});
      const native=await pair('native-p71','commit');
      await assert.rejects(web.query(`INSERT INTO control_loop_policy_input_admissions SELECT * FROM control_loop_policy_input_admissions`),{code:'23505'});
      for(const sql of ["UPDATE control_loop_policy_input_admissions SET admission_kind='product-b8'",'DELETE FROM control_loop_policy_input_admissions','TRUNCATE control_loop_policy_input_admissions'])
        await assert.rejects(web.query(sql),{code:'42501'});
      for(const sql of ["UPDATE control_loop_policy_input_admissions SET admission_kind='product-b8'",'DELETE FROM control_loop_policy_input_admissions','TRUNCATE control_loop_policy_input_admissions'])
        await assert.rejects(admin.query(sql),{code:sql.startsWith('TRUNCATE')?'0A000':'P0001'},'privileged mutation is blocked by trigger or restrictive FK');
      await web.query('BEGIN');
      try {
        await web.query(`INSERT INTO control_loop_improvement_inputs SELECT tenant_id,project_id,owner_identity_id,request_id,2,description,request_sha256,settings_text,settings_sha256,'backfill-version-two-key-0001',record_digest,auth_tag,created_at FROM control_loop_improvement_inputs WHERE request_id=$1`,[native]);
        await web.query(`INSERT INTO control_loop_policy_input_sources SELECT tenant_id,request_id,2,defaults_sha256,layer_versions,waiver_id FROM control_loop_policy_input_sources WHERE request_id=$1`,[native]);
        await web.query(`INSERT INTO control_loop_policy_input_admissions VALUES('tenant:selection',$1,2,'native-p71')`,[native]);
        await web.query('COMMIT');
      } finally { await web.query('ROLLBACK'); }
      const signedBefore=(await admin.query('SELECT * FROM control_loop_improvement_inputs ORDER BY request_id,version')).rows;
      await down();await up();
      assert.deepEqual((await admin.query('SELECT * FROM control_loop_improvement_inputs ORDER BY request_id,version')).rows,signedBefore);
      assert.equal((await web.query('SELECT admission_kind FROM control_loop_policy_input_admissions WHERE request_id=$1 ORDER BY input_version',[native])).rows.map(row=>row.admission_kind).join(','),'native-p71,native-p71');
      assert.equal(await readPrivateWebSchemaDigest(web),measured);
      // Guard-off proof stays inside a rollback transaction: disabling the reverse FK admits an unpaired source.
      await admin.query('BEGIN');
      try {
        await admin.query('ALTER TABLE control_loop_policy_input_sources DROP CONSTRAINT control_loop_policy_input_sources_admission_fk');
        assert.equal((await admin.query(`SELECT count(*)::int n FROM pg_constraint WHERE conname='control_loop_policy_input_sources_admission_fk'`)).rows[0].n,0);
        await admin.query(`INSERT INTO control_loop_improvement_inputs SELECT tenant_id,project_id,owner_identity_id,request_id,3,description,request_sha256,settings_text,settings_sha256,'guard-off-source-key-0001',record_digest,auth_tag,created_at FROM control_loop_improvement_inputs WHERE request_id=$1 AND version=1`,[native]);
        await admin.query(`INSERT INTO control_loop_policy_input_sources SELECT tenant_id,request_id,3,defaults_sha256,layer_versions,waiver_id FROM control_loop_policy_input_sources WHERE request_id=$1 AND input_version=1`,[native]);
        await assert.rejects(assert.rejects(admin.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23503'}),{code:'ERR_ASSERTION'},'source-only refusal assertion fails with reverse FK removed');
      } finally { await admin.query('ROLLBACK'); }
      await assert.rejects(pair(undefined,'immediate'),{code:'23503'},'restored reverse FK catches the orphan');
      const alterAndRollback=async(work:()=>Promise<void>)=>{
        await admin.query('BEGIN');try{await work();}finally{await admin.query('ROLLBACK');}
      };
      await alterAndRollback(async()=>{
        await admin.query('ALTER TABLE control_loop_policy_input_admissions DROP CONSTRAINT control_loop_policy_input_admissions_source_fk');
        assert.equal((await admin.query(`SELECT count(*)::int n FROM pg_constraint WHERE conname='control_loop_policy_input_admissions_source_fk'`)).rows[0].n,0);
        await assert.rejects(assert.rejects(admin.query(`INSERT INTO control_loop_policy_input_admissions VALUES('tenant:selection','request:absent',1,'native-p71')`),{code:'23503'}),{code:'ERR_ASSERTION'});
      });
      await alterAndRollback(async()=>{
        await admin.query('ALTER TABLE control_loop_policy_input_admissions DROP CONSTRAINT control_loop_policy_input_admissions_kind_check');
        await admin.query(`UPDATE control_loop_policy_input_admissions SET admission_kind='unknown' WHERE false`);
        await admin.query(`INSERT INTO control_loop_improvement_inputs SELECT tenant_id,project_id,owner_identity_id,request_id,3,description,request_sha256,settings_text,settings_sha256,'guard-off-kind-key-0001',record_digest,auth_tag,created_at FROM control_loop_improvement_inputs WHERE request_id=$1 AND version=1`,[native]);
        await admin.query(`INSERT INTO control_loop_policy_input_sources SELECT tenant_id,request_id,3,defaults_sha256,layer_versions,waiver_id FROM control_loop_policy_input_sources WHERE request_id=$1 AND input_version=1`,[native]);
        await assert.rejects(assert.rejects(admin.query(`INSERT INTO control_loop_policy_input_admissions VALUES('tenant:selection',$1,3,'unknown')`,[native]),{code:'23514'}),{code:'ERR_ASSERTION'});
        await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      for(const operation of ['UPDATE','DELETE','TRUNCATE']) await alterAndRollback(async()=>{
        const trigger=operation==='TRUNCATE'?'control_loop_policy_input_admissions_no_truncate':'control_loop_policy_input_admissions_immutable';
        if(operation==='TRUNCATE')await admin.query('ALTER TABLE control_loop_policy_input_sources DROP CONSTRAINT control_loop_policy_input_sources_admission_fk');
        await admin.query(`ALTER TABLE control_loop_policy_input_admissions DISABLE TRIGGER ${trigger}`);
        assert.equal((await admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgname=$1`,[trigger])).rows[0].tgenabled,'D');
        await assert.rejects(assert.rejects(admin.query(operation==='UPDATE'?"UPDATE control_loop_policy_input_admissions SET admission_kind='product-b8'":operation==='DELETE'?'DELETE FROM control_loop_policy_input_admissions':'TRUNCATE control_loop_policy_input_admissions'),{code:'P0001'}),{code:'ERR_ASSERTION'});
      });
      await assert.rejects(pair('unknown'),{code:'23514'});
      await assert.rejects(web.query(`INSERT INTO control_loop_policy_input_admissions VALUES('tenant:selection','request:absent',1,'native-p71')`),{code:'23503'});
      assert.equal(await readPrivateWebSchemaDigest(web),measured,'all schema guards restored after rollback-only probes');
      console.log('RESULT: admission forward-FK/kind/UPDATE/DELETE/TRUNCATE guard-off=5 restored=5');
      console.log('RESULT: source/admission pair commit integrity, production grants, append-only, native backfill, signed bytes and reverse-FK guard-off restored');
      const binding=()=>({schemaVersion:1,body:{description:'Recorded selection',acceptSameFamilyRisk:true},localVersion:1,adapterId:'adapter:selection',
        loopRunId:'run:selection',toolingRevision:digest,a2SchemaVersion:1,schemaDigest:digest,requestSha256:hash,settingsSha256:hash,
        runLinkId:null,authorizationId:null,inputVersion:null,expectedRevision:null,evidence:null,
        sameFamilyAcknowledgement:{schema_version:1,rule:'R296',run:'run:selection',by:'owner',accepted_at:'2026-11-01T00:00:00.000Z',acknowledgement:'same-family-risk-accepted'}});
      const insert=async(b:unknown,operation='intake',kind='claim',at='2026-11-01T00:00:01Z',retain=false)=>{
        const command='loop-command:'+randomBytes(16).toString('hex'),request='request:'+randomBytes(16).toString('hex');
        await web.query('BEGIN');
        try{
          await web.query(`INSERT INTO control_loop_improvement_requests(tenant_id,project_id,owner_identity_id,id,idempotency_key,record_digest,auth_tag,created_at)
            VALUES('tenant:selection','project:selection','identity:selection',$1,$2,$3,$4,$5)`,[request,command,digest,'hmac-sha256:'+hash,at]);
          const bb=b as ReturnType<typeof binding>;
          const outcome=kind==='claim'?null:{state:'accepted',revision:1,adapterId:bb.adapterId,loopRunId:bb.loopRunId,toolingRevision:bb.toolingRevision,evidenceDigest:digest,error:null};
          await web.query(`INSERT INTO control_loop_improvement_commands(tenant_id,command_id,entry_kind,request_id,project_id,owner_identity_id,operation,idempotency_key,binding,result,record_digest,auth_tag,created_at)
            VALUES('tenant:selection',$1,$2,$3,'project:selection','identity:selection',$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
            [command,kind,request,operation,command,JSON.stringify(b),outcome?JSON.stringify(outcome):null,digest,'hmac-sha256:'+hash,at]);
          if(retain)await web.query('COMMIT');
        }finally{if(!retain)await web.query('ROLLBACK');}
      };
      await insert(binding());await insert(binding(),'intake','result','2026-11-01T00:00:08Z');
      for(const operation of ['confirm','start']){
        const b=binding();b.body={expectedVersion:1,expectedRevision:1,...(operation==='confirm'?{requestSha256:hash,settingsSha256:hash}:{runLinkId:'link:selection'})} as any;
        await insert(b,operation,'claim','2026-11-02T00:00:00Z');
        delete (b as any).sameFamilyAcknowledgement;await insert(b,operation);
      }
      const ordinary=binding();delete (ordinary as any).sameFamilyAcknowledgement;delete (ordinary.body as any).acceptSameFamilyRisk;await insert(ordinary);
      const bad:Array<[string,(b:any)=>void,string?]>=[
        ['null record',b=>b.sameFamilyAcknowledgement=null],['missing record',b=>delete b.sameFamilyAcknowledgement],
        ['extra key',b=>b.sameFamilyAcknowledgement.extra=true],['wrong run',b=>b.sameFamilyAcknowledgement.run='run:other'],
        ['wrong owner literal',b=>b.sameFamilyAcknowledgement.by='operator'],['false intent',b=>b.body.acceptSameFamilyRisk=false],
        ['string intent',b=>b.body.acceptSameFamilyRisk='true'],['null intent',b=>b.body.acceptSameFamilyRisk=null],
        ['omitted intake intent',b=>delete b.body.acceptSameFamilyRisk],['impossible date',b=>b.sameFamilyAcknowledgement.accepted_at='2026-02-29T00:00:00Z'],
        ['naive timestamp',b=>b.sameFamilyAcknowledgement.accepted_at='2026-11-01T00:00:00'],['future timestamp',b=>b.sameFamilyAcknowledgement.accepted_at='2026-11-01T00:00:02Z'],
        ['stale intent',()=>{},'2026-11-01T00:00:05Z'],['old intent',()=>{},'2026-11-02T00:00:00Z']];
      for(const [name,mutate,at] of bad){const b=binding();mutate(b);await assert.rejects(insert(b,'intake','claim',at),{code:'23514'},name);}
      for(const key of Object.keys(binding().sameFamilyAcknowledgement)){
        const b=binding();delete (b.sameFamilyAcknowledgement as any)[key];await assert.rejects(insert(b),{code:'23514'},'missing '+key);
      }
      for(const operation of ['stop','approve','answer']){
        const b=binding();b.body=(operation==='stop'?{runLinkId:'link:selection'}:operation==='approve'?{expectedVersion:1,expectedRevision:1,step:'plan',head:'a'.repeat(40),reportSha256:hash,inputVersion:1}:
          {expectedVersion:1,expectedRevision:1,questionId:'question:selection',inputVersion:1,questionReportSha256:hash,text:'Recorded answer'}) as any;
        await assert.rejects(insert(b,operation),{code:'23514'},operation+' record scope');
      }
      assert.equal((await web.query('SELECT count(*)::int n FROM control_loop_improvement_commands')).rows[0].n,0,'all SQL refusals and positives rolled back');
      // Guard-off each independently deciding acknowledgement fence in this disposable DB.
      const migration=await readFile('db/migrations/0316_control_loop_selection_acknowledgement.sql','utf8');
      const begin=migration.indexOf('ALTER TABLE control_loop_improvement_commands ADD CONSTRAINT control_loop_improvement_commands_binding_check');
      const end=migration.indexOf(') IS TRUE) NOT VALID;',begin)+') IS TRUE) NOT VALID;'.length;
      const originalCheck=migration.slice(begin,end);
      const timestamp="control_loop_selection_ack_timestamp_v1(binding->'sameFamilyAcknowledgement'->>'accepted_at')";
      const mutations:Array<{name:string;change:(sql:string)=>string;value:()=>any;operation?:string;at?:string}>=[
        {name:'closed record',change:sql=>sql.replace("AND ((binding->'sameFamilyAcknowledgement') - ARRAY['schema_version','rule','run','by','accepted_at','acknowledgement'])='{}'::jsonb",'AND TRUE'),value:()=>{const b=binding();(b.sameFamilyAcknowledgement as any).extra=true;return b;}},
        {name:'operation scope',change:sql=>sql.replace("operation IN ('intake','confirm','start')",'TRUE'),operation:'stop',value:()=>{const b=binding();b.body={runLinkId:'link:selection'} as any;return b;}},
        {name:'run binding',change:sql=>sql.replace("AND binding->'sameFamilyAcknowledgement'->'run'=binding->'loopRunId'",'AND TRUE'),value:()=>{const b=binding();b.sameFamilyAcknowledgement.run='run:other';return b;}},
        {name:'record required for intent',change:sql=>sql.replace("AND (binding ? 'sameFamilyAcknowledgement') IS TRUE",'AND TRUE'),value:()=>{const b=binding();delete (b as any).sameFamilyAcknowledgement;return b;}},
        {name:'intake intent required',change:sql=>sql.replace("AND (operation<>'intake' OR binding->'body'->'acceptSameFamilyRisk'='true'::jsonb)",'AND TRUE'),value:()=>{const b=binding();delete (b.body as any).acceptSameFamilyRisk;return b;}},
        {name:'future timestamp',change:sql=>sql.replace(timestamp+'<=created_at','TRUE'),value:()=>{const b=binding();b.sameFamilyAcknowledgement.accepted_at='2026-11-01T00:00:02Z';return b;}},
        {name:'claim freshness',change:sql=>sql.replace("<interval '5 seconds'",">=interval '0 seconds'"),value:binding,at:'2026-11-01T00:00:05Z'},
        {name:'intent true literal',change:sql=>sql.replace("AND binding->'body'->'acceptSameFamilyRisk'='true'::jsonb",'AND TRUE'),operation:'confirm',value:()=>{const b=binding();b.body={expectedVersion:1,expectedRevision:1,requestSha256:hash,settingsSha256:hash,acceptSameFamilyRisk:false} as any;return b;}},
      ];
      const load=async(sql:string)=>{await admin.query('ALTER TABLE control_loop_improvement_commands DROP CONSTRAINT control_loop_improvement_commands_binding_check');await admin.query(sql);};
      const originalCatalog=(await admin.query("SELECT pg_get_constraintdef(oid) text FROM pg_constraint WHERE conrelid='control_loop_improvement_commands'::regclass AND conname='control_loop_improvement_commands_binding_check'")).rows[0].text;
      let caught=0;
      for(const m of mutations){
        const b=m.value(),op=m.operation??'intake',at=m.at??'2026-11-01T00:00:01Z';
        await assert.rejects(insert(b,op,'claim',at),{code:'23514'},m.name+' baseline');
        const altered=m.change(originalCheck);assert.notEqual(altered,originalCheck,m.name+' anchor');
        try{
          await load(altered);
          const loaded=(await admin.query("SELECT pg_get_constraintdef(oid) text FROM pg_constraint WHERE conrelid='control_loop_improvement_commands'::regclass AND conname='control_loop_improvement_commands_binding_check'")).rows[0].text;
          assert.notEqual(loaded,originalCatalog,m.name+' altered predicate loaded');
          await assert.rejects(assert.rejects(insert(b,op,'claim',at),{code:'23514'}),{code:'ERR_ASSERTION'},m.name+' refusal assertion must fail with guard removed');
          caught++;
        }finally{await load(originalCheck);await admin.query('ALTER TABLE control_loop_improvement_commands VALIDATE CONSTRAINT control_loop_improvement_commands_binding_check');}
        await assert.rejects(insert(b,op,'claim',at),{code:'23514'},m.name+' restored');
      }
      assert.equal(caught,8);assert.equal(await readPrivateWebSchemaDigest(web),measured);
      console.log('RESULT: SQL guard-off expected=8 caught=8 restored=8 altered_catalog_verified=true');
      await pair('product-b8','commit',async()=>{
        await assert.rejects(admin.query(await readFile('db/down/0316_control_loop_selection_acknowledgement.sql','utf8')),{code:'55P03'},'concurrent insert holds the pair against rollback DDL');
        await admin.query('ROLLBACK');
      });
      await assert.rejects(admin.query(await readFile('db/down/0316_control_loop_selection_acknowledgement.sql','utf8')),{code:'23514'});await admin.query('ROLLBACK');
      assert.equal(await readPrivateWebSchemaDigest(web),measured,'unacknowledged B8 cannot be rolled down');
      await insert(binding(),'intake','claim','2026-11-01T00:00:01Z',true);
      await assert.rejects(admin.query(await readFile('db/down/0316_control_loop_selection_acknowledgement.sql','utf8')),{code:'23514'});await admin.query('ROLLBACK');
      assert.equal(await readPrivateWebSchemaDigest(web),measured);
      assert.deepEqual((await admin.query('SELECT * FROM control_room_schema_migrations ORDER BY ledger_order')).rows,ledgerBefore);
      console.log('RESULT: PASS native SQL optional/null/scope/calendar/future/claim-freshness/delayed/copied predicates; empty down/re-up, atomic rollback and retained-down refusal');

    }finally{await web.end();await admin.end();}
  },{port,allowedPorts:[port],boundMs:600000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);
});

test('U81-B PG17 twenty separate callers share frozen-key admission and one Start',async()=>{
  assert.ok(requiresRealPostgres());
  const count=Number(execFileSync('/bin/bash',['-o','pipefail','-c','ipcs -m | tail -n +4 | wc -l'],{encoding:'utf8'}).trim());assert.ok(count<20);
  const port=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? '60520');assert.ok(port>=60520&&port<=60539);
  const {Pool}=await import('pg'),{bindPrivatePgPool}=await import('../src/web/v1/private-pg-database');
  const {privatePgOptions}=await import('../src/web/v1/private-pg-options');
  const {ImproveControlRoomLoopServiceV1}=await import('../src/web/v1/improve-control-room-loop-service');
  const {LoopPolicyServiceV1}=await import('../src/web/v1/loop-policy-service');
  const {sha256Digest}=await import('../src/security');
  const {loopByteHashV1}=await import('../src/web/v1/improve-control-room-loop-adapter');
  const {loopImprovementRunIdentitySchemaV1,loopImprovementObservationSchemaV1}=await import('../src/improve-control-room/v1/schemas');
  const result=await withRealPostgres(async pg=>{
    const admin=new Client(pg.admin());await admin.connect();
    const pools:Array<ReturnType<typeof bindPrivatePgPool>>=[];
    try{
      const scope={tenantId:'tenant:u81',workspaceId:'workspace:u81'},projectId='project:u81',owner='identity:u81',now=Date.now();
      const at=new Date(now-1000).toISOString(),expires=new Date(now+600000).toISOString();
      const identity={provider:'test',subject:owner,tokenDigest:sha256Digest({fixture:'U81 concurrency'}),issuedAt:at,expiresAt:expires,verificationExpiresAt:expires};
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic concurrency')",[scope.tenantId]);
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Synthetic concurrency')",[scope.workspaceId,scope.tenantId]);
      await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
        VALUES('adapter:u81',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,[scope.tenantId]);
      await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,$3,'adapter:u81',$1,'1','Synthetic concurrency','planned','manual_project_active','healthy','control_room_native',now(),'{"presentation":{"templateId":"control-room"}}',now())`,[projectId,scope.tenantId,scope.workspaceId]);
      await admin.query("INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",[scope.tenantId,projectId]);
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'human','Synthetic concurrency','test',$3,'active',$4,$4)`,[owner,scope.tenantId,sha256Digest({provider:'test',subject:owner}),at]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:u81',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,[scope.tenantId,owner,at]);
      await admin.query('INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)',[scope.tenantId,identity.tokenDigest,owner,at,expires]);
      const slot={model:'fixture',route:'fixture',effort:'default' as const},selection={roles:{plan:slot,spec:slot,build:slot,final:slot,plan_reviews:[],spec_reviews:[],code_reviews:[slot]},plan_review_count:0,spec_review_count:0,code_review_count:1};
      const snapshot={rosterDigest:'a'.repeat(64),availabilityDigest:'b'.repeat(64),revision:'fixture-1'};
      const projection={family_policy:'review-only',...snapshot,lineupDigest:'c'.repeat(64),reservedFinal:{...slot,family:'final',class:'Frontier',cost:'subscription'},waivedReasons:[],
        lineup:['plan','spec','build','final','code_reviews'].map(role=>({role,index:0,requested:{...slot,family:'fixture',class:'Frontier',cost:'subscription'},effective:{...slot,family:'fixture',class:'Frontier',cost:'subscription'},refusals:[],fallback:false}))};
      delete (projection as any).revision;
      type Status=import('../src/web/v1/improve-control-room-loop-adapter').LoopEngineStatusV1;
      const states=new Map<string,Status>(),dispatched:string[]=[],contexts:any[]=[];
      let arrivals=0,release!:()=>void,barrier=Promise.resolve(),afterCheck:(()=>Promise<void>)|undefined;
      const reset=()=>{arrivals=0;barrier=new Promise<void>(resolve=>{release=resolve;});};
      const adapter:import('../src/web/v1/improve-control-room-loop-adapter').LoopAdapterV1={adapterId:'adapter:fixture',toolingRevision:'sha256:'+'a'.repeat(64),schemaDigest:'sha256:'+'b'.repeat(64),settingsText:'{}',
        reserveRun:()=> 'fixture-'+randomBytes(16).toString('hex'),available:()=>true,
        contract:{toolingRevision:'sha256:'+'a'.repeat(64),decodeRunIdentity:v=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:v=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:(_r,o,i)=>o.settingsDigest===i.settingsSha256&&o.confirmation.sha256===i.requestSha256},
        intake:async(id,b,text,fence,settings)=>{fence();dispatched.push(id);const hash=loopByteHashV1(settings!);const status:Status={run:{adapterId:b.adapterId,toolingRevision:b.toolingRevision,loopRunId:b.loopRunId,a2SchemaVersion:1},revision:1,inputVersion:1,state:'draft',description:text,settingsSha256:hash,settingsDigest:hash,confirmation:null,approval:null,question:null,progress:{step:'intake',completed:0,attention:'none'},receipts:[{commandId:id,bindingDigest:sha256Digest(b),state:'accepted',error:null,evidenceDigest:sha256Digest({id})}]};states.set(b.loopRunId,status);return structuredClone(status);},
        status:async run=>structuredClone(states.get(run)!),confirmRequest:async(id,b,fence)=>{fence();dispatched.push(id);const s=states.get(b.loopRunId)!;s.state='ready';s.revision++;s.confirmation={path:'request.md',sha256:b.requestSha256,who:'owner',at:new Date().toISOString(),input_version:1};s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:'accepted',error:null,evidenceDigest:sha256Digest({id})});return structuredClone(s);},
        start:async(id,b,fence)=>{fence();dispatched.push(id);const s=states.get(b.loopRunId)!;s.state='running';s.revision++;s.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:'accepted',error:null,evidenceDigest:sha256Digest({id})});return structuredClone(s);},
        stop:async()=>{throw Error('unused');},approve:async()=>{throw Error('unused');},answer:async()=>{throw Error('unused');},close:async()=>{}};
      const services=Array.from({length:20},()=>{
        const login=pg.connection('web');const config={host:'127.0.0.1',port:pg.port,database:pg.database,username:login.user,password:login.password,majorVersion:17 as const};
        const bound=bindPrivatePgPool(new Pool({...privatePgOptions(config),host:login.host,max:1}));pools.push(bound);
        const policy=new LoopPolicyServiceV1(bound.client,scope,{settingsText:'{}',checkSettings:async(_text,context)=>{
          contexts.push(context);arrivals++;if(arrivals===20)release();await barrier;await afterCheck?.();return{eligible:true,reasons:[],projection:projection as any,snapshot};
        }});
        return new ImproveControlRoomLoopServiceV1(bound.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter,policy,selectionReady:()=>true,selectionGuard:{capture:async()=>snapshot,assertCurrent:async()=>{}}});
      });
      const phase=async(op:'intake'|'confirm'|'start',requestId:string|null,body:unknown,sameKey=true)=>{
        reset();const pending=services.map((service,i)=>op==='intake'?service.intakeSelection(identity,projectId,body,`u81-concurrent-${op}-${sameKey?'shared':String(i).padStart(3,'0')}-0001`):service.mutate(identity,projectId,requestId,op,body,`u81-concurrent-${op}-${sameKey?'shared':String(i).padStart(3,'0')}-0001`));
        const timer=setTimeout(()=>release(),15000);
        try{const settled=await Promise.allSettled(pending);assert.equal(arrivals,20,'twenty independent sessions observed at checker barrier');return settled;}finally{clearTimeout(timer);}
      };
      const intake=await phase('intake',null,{description:'SYNTHETIC concurrent admission',settingsEdits:JSON.stringify({...selection,overrides:{reviewFamily:true,standardFinal:false}}),acceptSameFamilyRisk:true});
      const first=intake.find(v=>v.status==='fulfilled');assert.ok(first&&first.status==='fulfilled');const rid=first.value.requestId;
      assert.equal((await admin.query("SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='intake' AND entry_kind='claim'")).rows[0].n,1);
      const state=Array.from(states.values())[0]!;
      const confirms=await phase('confirm',rid,{expectedVersion:1,expectedRevision:1,requestSha256:loopByteHashV1(state.description),settingsSha256:state.settingsSha256});
      assert.ok(confirms.some(v=>v.status==='fulfilled'));
      const status=await services[0]!.status(identity,projectId,rid);
      const starts=await phase('start',rid,{expectedVersion:1,expectedRevision:2,runLinkId:status.request.runLink!.runLinkId},false);
      assert.equal(starts.filter(v=>v.status==='fulfilled').length,1);assert.equal(starts.filter(v=>v.status==='rejected').length,19,'real conflicting Start losers');
      const rows=(await admin.query("SELECT command_id,binding FROM control_loop_improvement_commands WHERE entry_kind='claim' ORDER BY operation")).rows;
      assert.equal(rows.length,3);assert.equal(dispatched.length,3);
      for(const row of rows){const checked=contexts.find(c=>c.commandId===row.command_id);assert.deepEqual(checked.binding,row.binding);}
      console.log('RESULT: PG17 callers=20 barriers=3 checker_candidates=60 claims=3 dispatches=3 start_conflicting_losers=19');
      afterCheck=async()=>{
        await admin.query('BEGIN');
        await admin.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
      };
      const beforeWait=(await admin.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
      const started=performance.now();
      try{
        await assert.rejects(services[0]!.intakeSelection(identity,projectId,{
          description:'SYNTHETIC deadline lock overrun',settingsEdits:JSON.stringify({...selection,overrides:{reviewFamily:false,standardFinal:false}})
        },'u81-lock-overrun-intake-0001'));
        assert.ok(performance.now()-started<6500,'remaining-to-D bounds the lock wait');
      }finally{await admin.query('ROLLBACK');afterCheck=undefined;}
      assert.deepEqual((await admin.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows,beforeWait);
      assert.equal((await admin.query('SELECT count(*)::int n FROM control_loop_improvement_requests')).rows[0].n,1);
      assert.equal(dispatched.length,3,'deadline rollback dispatches no additional command');
      console.log('RESULT: PG17 checker-then-project-lock overrun bounded=true new_draft_source_claim=0 new_dispatch=0');

    }finally{await Promise.all(pools.map(p=>p.close()));await admin.end();}
  },{port,allowedPorts:[port],boundMs:600000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);
});
