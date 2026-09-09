import{readFileSync,readdirSync,writeFileSync,realpathSync}from'node:fs';
import{createRequire}from'node:module';import{createHash}from'node:crypto';import assert from'node:assert/strict';import{dirname,join,relative}from'node:path';
const require=createRequire(import.meta.url),boss=dirname(require.resolve('pg-boss/package.json'));
const parser=dirname(dirname(createRequire(join(boss,'package.json')).resolve('cron-parser')));
const luxon=dirname(dirname(dirname(createRequire(join(parser,'package.json')).resolve('luxon'))));
const dbos='/private/tmp/cr-compare-f1.9x5bSO/node_modules/@dbos-inc/dbos-sdk';
const roots={dbos,boss,parser,luxon,checkout:process.cwd()};
const versions={};for(const key of ['dbos','boss','parser','luxon'])versions[key]=JSON.parse(readFileSync(join(roots[key],'package.json'))).version;
assert.equal(versions.dbos,'4.27.6');assert.equal(versions.boss,'12.30.0');assert.equal(versions.parser,'5.10.0');
const files=[];function add(key,path){const bytes=readFileSync(join(roots[key],path));files.push({root:key,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
function tree(key,path){for(const item of readdirSync(join(roots[key],path),{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory())tree(key,child);else if(item.isFile())add(key,child);else throw Error('unexpected nonregular member');}}
for(const key of ['dbos','boss','parser','luxon'])add(key,'package.json');
add('dbos','dist/src/scheduler/crontab.js');add('dbos','dist/src/scheduler/scheduler.js');add('boss','dist/timekeeper.js');
tree('parser','dist');tree('luxon','build/node');
for(const path of ['src/services/v1/recurrence.ts','src/services/v1/occurrence-store.ts','tests/services-v1-recurrence.test.ts','tests/services-v1-occurrence-store.test.ts'])add('checkout',path);
writeFileSync('docs/research/reuse-comparisons/f1-calendar-pins.json',JSON.stringify({versions,files,acquisitions:'none; already installed package roots only',dbosRoot:realpathSync(dbos)},null,2)+'\n');console.log(JSON.stringify({versions,files:files.length}));
