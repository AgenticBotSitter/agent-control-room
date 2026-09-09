// Isolate actual driver parameter behavior; not target app/PG17 qualification.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
const [root,socket] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.equal(process.cwd(), join(dirname(socket), 'empty'));
const require = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'));
const { Client } = require('pg');
const options = { host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  connectionTimeoutMillis: 3000, statement_timeout: 5000 };
const statement = 'SELECT label FROM json_to_recordset($1::json) AS x(label text)';
const payload = JSON.stringify([{label:'synthetic'}]), outcomes=[];
for (const prepare of [true,false]) {
  const sql=postgres({host:socket,port:65433,username:'f1_owner',database:'postgres',password:'',max:1,
    connect_timeout:3,prepare,fetch_types:false,connection:{statement_timeout:5000}});
  try {
    for (const explicitOptions of [false,true]) {
      try {
        const rows=await sql.unsafe(statement,[payload],explicitOptions?{prepare:false,simple:false}:{});
        outcomes.push({driver:'postgres3.4.7',prepare,explicitOptions,rows:[...rows]});
      } catch(error) {outcomes.push({driver:'postgres3.4.7',prepare,explicitOptions,error:error.code,message:error.message});}
    }
  } finally {await sql.end({timeout:1});}
}
for (const fetchTypes of [false,true]) {
  const sql=postgres({host:socket,port:65433,username:'f1_owner',database:'postgres',password:'',max:1,
    connect_timeout:3,prepare:false,fetch_types:fetchTypes,connection:{statement_timeout:5000}});
  let lease,timer;
  try {
    lease=await Promise.race([sql.reserve(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('reserve-deadline')),3000);})]);
    outcomes.push({case:'cold-reserve',fetchTypes,acquired:true});
  } catch(error) {outcomes.push({case:'cold-reserve',fetchTypes,acquired:false,message:error.message});}
  finally {clearTimeout(timer);lease?.release();await sql.end({timeout:1});}
}
const pg=new Client(options);
try {await pg.connect();const result=await pg.query(statement,[payload]);assert.deepEqual(result.rows,[{label:'synthetic'}]);
  outcomes.push({driver:'node-postgres',rows:result.rows});}
finally {await pg.end();}
console.log(JSON.stringify({outcomes,scope:'actual serialized JSON bind on disposable PG18, no production role/config or app-preflight acceptance'},null,2));
