import{readFileSync,writeFileSync}from'node:fs';import{createRequire}from'node:module';import{createHash}from'node:crypto';import{dirname,join}from'node:path';import assert from'node:assert/strict';
const require=createRequire(import.meta.url),boss=dirname(require.resolve('pg-boss/package.json'));
const parser=dirname(dirname(createRequire(join(boss,'package.json')).resolve('cron-parser'))),luxon=dirname(dirname(dirname(createRequire(join(parser,'package.json')).resolve('luxon'))));
const roots={boss,parser,luxon};const pins=JSON.parse(readFileSync('docs/research/reuse-comparisons/f1-calendar-pins.json'));
for(const file of pins.files.filter(x=>x.root in roots))assert.equal(createHash('sha256').update(readFileSync(join(roots[file.root],file.path))).digest('hex'),file.sha256);
const{CronExpressionParser}=require(join(parser,'dist/index.js'));
const cases=[
 ['spring-shift-candidate-window','30 2 * * *','America/Denver','2026-03-08T09:30:30.000Z'],
 ['fall-first-window','30 1 * * *','America/Denver','2026-11-01T07:30:30.000Z'],
 ['fall-second-window','30 1 * * *','America/Denver','2026-11-01T08:30:30.000Z'],
 ['missed-three-minute-window','*/5 * * * *','UTC','2026-09-07T00:18:00.000Z'],
 ['near-thirty-second-window','*/5 * * * *','UTC','2026-09-07T00:15:30.000Z']
];
const rows=cases.map(([name,cron,tz,now])=>{const previous=CronExpressionParser.parse(cron,{tz,strict:false,currentDate:new Date(now)}).prev();return{name,cron,tz,now,actualPrevious:previous.toISOString(),differenceSeconds:(Date.parse(now)-previous.getTime())/1000};});
console.log(JSON.stringify({scope:'Actual calendar prev used by pg-boss; no shouldSendIt or scheduler execution. Difference is measurement, not delivery.',rows},null,2));
