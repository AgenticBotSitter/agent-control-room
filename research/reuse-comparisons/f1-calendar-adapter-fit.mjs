import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const require=createRequire(import.meta.url),boss=dirname(require.resolve('pg-boss/package.json'));
const parser=dirname(dirname(createRequire(join(boss,'package.json')).resolve('cron-parser')));
const luxon=dirname(dirname(dirname(createRequire(join(parser,'package.json')).resolve('luxon'))));
const roots={boss,parser,luxon,checkout:process.cwd()};
const pins=JSON.parse(readFileSync('docs/research/reuse-comparisons/f1-calendar-pins.json'));
for(const f of pins.files.filter(f=>f.root in roots))assert.equal(createHash('sha256').update(readFileSync(join(roots[f.root],f.path))).digest('hex'),f.sha256,f.path);
const publicParser=require(join(parser,'dist/index.js'));
const {CronExpressionParser,CronExpression,CronFieldCollection,CronSecond,CronMinute,CronHour,CronDayOfMonth,CronMonth,CronDayOfWeek}=publicParser;

// Compatibility policy only: upstream owns expansion and date matching.
function compileCron(expression,timezone){
 const parts=expression.trim().split(/\s+/);if(parts.length!==5)return undefined;
 const spec=[['minute',0,59,CronMinute],['hour',0,23,CronHour],['dayOfMonth',1,31,CronDayOfMonth],['month',1,12,CronMonth],['dayOfWeek',0,7,CronDayOfWeek]];
 const fields={second:new CronSecond([0],{rawValue:'0'})};
 const number=s=>/^(0|[1-9][0-9]*)$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):NaN;
 try{
  for(let i=0;i<5;i++){
   const [name,min,max,Field]=spec[i],raw=parts[i],values=new Set();
   for(const segment of raw.split(',')){
    const pieces=segment.split('/');if(pieces.length>2) return undefined;
    const [range,stepText]=pieces,step=stepText===undefined?1:number(stepText);
    if(!range||!Number.isSafeInteger(step)||step<1||step>max-min+1)return undefined;
    let normalized=segment;
    if(range!=='*'){
     const bounds=range.split('-'),start=number(bounds[0]),end=bounds.length===1?start:number(bounds[1]);
     if(bounds.length>2||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<min||end>max||start>end)return undefined;
     if(bounds.length===1)normalized=range; // Legacy singleton /step remains singleton.
    }
    const one=['*','*','*','*','*'];one[i]=normalized;
    const expanded=CronExpressionParser.parse(one.join(' '),{strict:false}).fields[name].values;
    for(const value of expanded)values.add(name==='dayOfWeek'&&value===7?0:value);
   }
   fields[name]=new Field([...values].sort((a,b)=>a-b),{rawValue:raw,wildcard:raw==='*'});
  }
  let collection;
  try{collection=new CronFieldCollection(fields);}
  catch(error){
   // Upstream identifies an impossible DOM in the sole selected month, with
   // wildcard DOW. Legacy CR accepts this as an empty calendar, not bad syntax.
   if(error.message==='Invalid explicit day of month definition')return {includesDate:()=>false};
   throw error;
  }
  return CronExpression.fieldsToExpression(collection,{tz:timezone});
 }catch{return undefined;}
}

const original=readFileSync('src/services/v1/recurrence.ts','utf8');
const fieldStart=original.indexOf('function parseField('),fieldEnd=original.indexOf('function formatter(');
const matcherStart=original.indexOf('function cronMatches('),matcherEnd=original.indexOf('function occurrence(');
assert.ok(fieldStart>0&&fieldEnd>fieldStart&&matcherStart>fieldEnd&&matcherEnd>matcherStart);
let adapted=original.slice(0,fieldStart)+original.slice(fieldEnd,matcherStart)+original.slice(matcherEnd);
assert.equal(adapted.split('parseCron(definition.expression)').length,2);
adapted=adapted.replace('parseCron(definition.expression)','compileCron(definition.expression, definition.timezone)');
assert.equal(adapted.split('cronMatches(cron, local)').length,2);
adapted=adapted.replace('cronMatches(cron, local)','cron.includesDate(new Date(current))');
function load(source){const module={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,compileCron,Intl,Date,Set,Number,Object},{timeout:1000});return module.exports.calculateScheduleOccurrencesV1;}
const baseline=load(original),candidate=load(adapted);
const base={id:'schedule.fixture',kind:'cron',state:'active',expression:'*/15 * * * *',timezone:'UTC'};
const window={startsAt:'2026-09-07T00:00:00.000Z',endsAt:'2026-09-07T01:00:00.000Z'};
const cases=[];const add=(name,definition={},range=window)=>cases.push({name,definition:{...base,...definition},range});
add('utc-quarter-hour');
add('denver-spring-gap',{expression:'30 2 * * *',timezone:'America/Denver'},{startsAt:'2026-03-08T08:00:00.000Z',endsAt:'2026-03-08T11:00:00.000Z'});
add('denver-fall-repeat',{expression:'30 1 * * *',timezone:'America/Denver'},{startsAt:'2026-11-01T07:00:00.000Z',endsAt:'2026-11-01T10:00:00.000Z'});
add('missed-window',{expression:'*/5 * * * *'},{...window,endsAt:'2026-09-07T00:18:00.000Z'});
add('restricted-dom-or-dow',{expression:'0 9 1 * 1'},{startsAt:'2026-09-07T08:59:00.000Z',endsAt:'2026-09-07T09:01:00.000Z'});
add('offset-range-step',{expression:'1-5/2 * * * *'},{...window,endsAt:'2026-09-07T00:06:00.000Z'});
for(const expression of ['1/2 * * * *','1,1 * * * *','1-5,3-7 * * * *','*,1 * * * *','0 0 */1 * 2','0 0 1-31 * 2','0 0 *,1 * 2','0 0 * * 0,7','0 0 * * 5-7','0 0 * * 0-7/2','0 0 31 2 1','0 0 31 2 *'])add('valid:'+expression,{expression},{startsAt:'2026-02-01T00:00:00.000Z',endsAt:'2026-02-03T00:00:00.000Z'});
for(const expression of ['01 * * * *','1/61 * * * *','1/0 * * * *','1/ * * * *','1//2 * * * *','5-1 * * * *','1,,2 * * * *','60 * * * *','* * * * MON','@daily','0 * * * * *','* * * *','0 0 L * *','0 0 ? * *','0 0 * * 1#2','0 0 * JAN *'])add('invalid:'+expression,{expression});
add('paused-before-invalid-expression',{state:'paused',expression:'bad'});add('disabled',{state:'disabled'});add('invalid-zone',{timezone:'not/a-zone'});add('invalid-id',{id:'!bad'});
add('once',{kind:'once',expression:'2026-09-07T00:15:00.000Z'});add('interval',{kind:'interval',expression:'900',anchorAt:'2026-09-07T00:01:00.000Z'});
add('window-subminute',{expression:'* * * * *'},{startsAt:'2026-09-07T00:00:01.000Z',endsAt:'2026-09-07T00:02:00.000Z'});
add('oversized-window',{}, {startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2026-03-01T00:00:00.000Z'});
const rows=[],start=performance.now();
for(const c of cases){const expected=baseline(c.definition,c.range),actual=candidate(c.definition,c.range);const equal=JSON.stringify(expected)===JSON.stringify(actual);rows.push({name:c.name,equal,expectedCount:expected.occurrences.length,actualCount:actual.occurrences.length,expectedReason:expected.safeReason,actualReason:actual.safeReason,expectedHash:createHash('sha256').update(JSON.stringify(expected)).digest('hex'),actualHash:createHash('sha256').update(JSON.stringify(actual)).digest('hex'),...(!equal?{expectedSample:expected.occurrences.slice(0,3),actualSample:actual.occurrences.slice(0,3)}:{})});}
console.log(JSON.stringify({caseCount:rows.length,passed:rows.filter(x=>x.equal).length,rows,elapsedMs:performance.now()-start,removedSourceLines:original.slice(fieldStart,fieldEnd).trimEnd().split('\n').length+original.slice(matcherStart,matcherEnd).trimEnd().split('\n').length,adapterFunctionLines:compileCron.toString().split('\n').length,scope:'actual public parser expansion/fields/includesDate within unchanged in-memory CR calculator shell; no persistence/scheduler/services'},null,2));
assert.ok(rows.every(x=>x.equal),'calendar parity mismatches retained above');
