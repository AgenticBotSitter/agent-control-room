// Research only. Executes pinned upstream source; does not copy it or start Kuma.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('Supply extracted pinned Kuma absolute path');
const { ConditionExpressionGroup } = require(path.join(root, 'server/monitor-conditions/expression.js'));
const { evaluateExpressionGroup } = require(path.join(root, 'server/monitor-conditions/evaluator.js'));
const parse = (conditions) => ConditionExpressionGroup.fromMonitor({conditions: JSON.stringify(conditions)});
const conditions = [
  {type:'expression', variable:'response_code', operator:'num_equals', value:'200'},
  {type:'expression', variable:'ready', operator:'equals', value:'ready', andOr:'and'}
];
const group = parse(conditions);
assert.equal(evaluateExpressionGroup(group,{response_code:200,ready:'ready'}),true);
assert.equal(evaluateExpressionGroup(group,{response_code:503,ready:'ready'}),false);
assert.equal(evaluateExpressionGroup(group,{response_code:200,ready:'unknown'}),false);
assert.throws(() => evaluateExpressionGroup(group,{response_code:200}),/Variable missing/);
assert.equal(parse([]),null);
assert.throws(() => ConditionExpressionGroup.fromMonitor({conditions:'broken'}),SyntaxError);
assert.throws(() => evaluateExpressionGroup(parse([{type:'group',children:[]}]),{}),/at least one/);
console.log(JSON.stringify({candidate:'uptime-kuma',revision:'e4821321e559c887b14e37d9979e604b221a8945',checks:7,passed:7,scope:'E2 upstream condition evaluator only; synthetic context, no HTTP/DB/service/notification',productionChanges:false}));
