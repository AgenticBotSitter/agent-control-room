import{readFileSync}from'node:fs';import{createRequire}from'node:module';import{createHash}from'node:crypto';import assert from'node:assert/strict';import{dirname,join}from'node:path';import{pathToFileURL}from'node:url';
const require=createRequire(import.meta.url),boss=dirname(require.resolve('pg-boss/package.json'));
const parser=dirname(dirname(createRequire(join(boss,'package.json')).resolve('cron-parser')));
const luxon=dirname(dirname(dirname(createRequire(join(parser,'package.json')).resolve('luxon'))));
const roots={dbos:'/private/tmp/cr-compare-f1.9x5bSO/node_modules/@dbos-inc/dbos-sdk',boss,parser,luxon,checkout:process.cwd()};
const pins=JSON.parse(readFileSync('docs/research/reuse-comparisons/f1-calendar-pins.json'));
for(const file of pins.files)assert.equal(createHash('sha256').update(readFileSync(join(roots[file.root],file.path))).digest('hex'),file.sha256,file.path);
assert.equal(process.env.TZ,'UTC');
const{TimeMatcher}=require(join(roots.dbos,'dist/src/scheduler/crontab.js'));
const{CronExpressionParser}=require(join(parser,'dist/index.js'));
const{calculateScheduleOccurrencesV1}=await import(pathToFileURL(join(process.cwd(),'src/services/v1/recurrence.ts')));
const corpus=[
 {name:'utc-quarter-hour',cron:'*/15 * * * *',zone:'UTC',start:'2026-09-07T00:00:00.000Z',end:'2026-09-07T01:00:00.000Z'},
 {name:'denver-spring-gap',cron:'30 2 * * *',zone:'America/Denver',start:'2026-03-08T08:00:00.000Z',end:'2026-03-08T11:00:00.000Z'},
 {name:'denver-fall-repeat',cron:'30 1 * * *',zone:'America/Denver',start:'2026-11-01T07:00:00.000Z',end:'2026-11-01T10:00:00.000Z'},
 {name:'missed-window',cron:'*/5 * * * *',zone:'UTC',start:'2026-09-07T00:00:00.000Z',end:'2026-09-07T00:18:00.000Z'},
 {name:'restricted-dom-or-dow',cron:'0 9 1 * 1',zone:'UTC',start:'2026-09-07T08:59:00.000Z',end:'2026-09-07T09:01:00.000Z'},
 {name:'offset-range-step',cron:'1-5/2 * * * *',zone:'UTC',start:'2026-09-07T00:00:00.000Z',end:'2026-09-07T00:06:00.000Z'}
];
const rows=[];const started=performance.now();
for(const c of corpus){
 const start=Date.parse(c.start),end=Date.parse(c.end),matcher=new TimeMatcher(c.cron,c.zone),dbos=[];
 let cursor=start-1000,wakeups=0;
 while(cursor<end){assert.ok(++wakeups<1000);const next=matcher.nextWakeupTime(cursor).getTime();assert.ok(next>cursor);cursor=next;if(cursor>=end)break;if(matcher.match(cursor))dbos.push(new Date(cursor).toISOString());}
 const interval=CronExpressionParser.parse(c.cron,{tz:c.zone,strict:false,currentDate:new Date(start-1)}),pg=[];
 for(let i=0;i<1000;i++){const next=interval.next().getTime();if(next>=end)break;pg.push(new Date(next).toISOString());if(i===999)throw Error('calendar output bound');}
 const current=calculateScheduleOccurrencesV1({id:'schedule.'+c.name,kind:'cron',state:'active',expression:c.cron,timezone:c.zone},{startsAt:c.start,endsAt:c.end});
 assert.equal(current.safeReason,undefined);
 const previous=CronExpressionParser.parse(c.cron,{tz:c.zone,strict:false,currentDate:new Date(end)}).prev().toISOString();
 rows.push({...c,dbosWakeupCalls:wakeups,dbos,pgBossCalendarNext:pg,pgBossCalendarPreviousAtEnd:previous,currentCR:current.occurrences});
}
assert.deepEqual(rows[0].dbos,rows[0].pgBossCalendarNext);
assert.deepEqual(rows[0].dbos,rows[0].currentCR.map(x=>x.scheduledFor));
assert.deepEqual(rows[1].dbos,[]);assert.deepEqual(rows[1].currentCR,[]);
assert.deepEqual(rows[2].dbos,['2026-11-01T07:30:00.000Z','2026-11-01T08:30:00.000Z']);
assert.equal(rows[2].currentCR.length,1);
assert.deepEqual(rows[3].dbos,rows[3].pgBossCalendarNext);
assert.deepEqual(rows[4].dbos,[]);assert.equal(rows[4].currentCR.length,1);
console.log(JSON.stringify({scope:'Actual calendar primitives only; no scheduler delivery/database/occurrence store execution',versions:pins.versions,caseCount:rows.length,rows,elapsedMs:performance.now()-started},null,2));
