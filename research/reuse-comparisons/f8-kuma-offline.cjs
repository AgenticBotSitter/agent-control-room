// Bounded offline DB preparation in an already reviewed owned package cohort.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root='/private/tmp/cr-f8-kuma-release-OiEJq7';
const setup=JSON.parse(fs.readFileSync(path.join(root,'dependencies.json')));
assert.equal(setup.terminal.code,0);assert.equal(setup.reason,undefined);
const inspection=JSON.parse(fs.readFileSync(path.join(root,'inspection.json')));
const source=setup.source,addon=path.join(inspection.run,'napi-v6-darwin-arm64/node_sqlite3.node');
const bytes=fs.readFileSync(addon);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),inspection.addonSha256);
const target=path.join(source,'node_modules/@louislam/sqlite3/lib/binding/napi-v6-darwin-arm64');
fs.mkdirSync(target,{recursive:true});fs.copyFileSync(addon,path.join(target,'node_sqlite3.node'),fs.constants.COPYFILE_EXCL);
const data=fs.mkdtempSync(path.join(root,'offline-data-'));
process.chdir(source);process.env.DATA_DIR=data+'/';
const {createRequire}=require('node:module'),req=createRequire(path.join(source,'package.json'));
let Database,Settings,connected=false,result={data,scope:'actual offline SQLite initialization/migrations/settings only; no daemon/listener/provider'};
const deadline=setTimeout(()=>{fs.writeFileSync(path.join(root,'offline-timeout.json'),JSON.stringify({data,failed:'30s deadline'}));process.exit(1);},30000);
(async()=>{try{
 Database=req('./server/database.js');Settings=req('./server/settings.js').Settings;
 Database.initDataDir({});Database.writeDBConfig({type:'sqlite'});
 await Database.connect(false,true,true);connected=true;
 await Database.patch();
 await Settings.set('checkUpdate',false,'general');assert.equal(await Settings.get('checkUpdate'),false);
 const {R}=req('redbean-node');assert.equal(await R.getCell('SELECT value FROM setting WHERE key = ?',['checkUpdate']),'false');
 Object.assign(result,{passed:true,sqliteVersion:await R.getCell('SELECT sqlite_version()'),tables:(await R.getAll("SELECT name FROM sqlite_master WHERE type='table'")).length,checkUpdate:false,rawSetting:'false'});
}catch(e){Object.assign(result,{passed:false,error:e.message});process.exitCode=1;}
finally{if(Settings?.cacheCleaner)clearInterval(Settings.cacheCleaner);
 if(connected){await Database.close();result.closed=true;}
 clearTimeout(deadline);fs.writeFileSync(path.join(root,'offline.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));}
})();
