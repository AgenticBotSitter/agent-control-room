import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import * as c from '../scripts/fleet/connector.mjs';

assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, '1');
test('R6F-08 twenty native fetch body readers settle by the whole-operation deadline', {timeout: 39000}, async t => {
  const timers = new Set();
  const server = createServer((request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.write('{"ok":true,"result":[');
    const timer = setInterval(() => response.write(' '.repeat(1024)), 1000);
    timers.add(timer);
    response.on('close', () => {clearInterval(timer); timers.delete(timer);});
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections(); await new Promise(done => server.close(done));
  });
  const client = c.createClient({server: `http://127.0.0.1:${server.address().port}`,
    workerId: 'fleet-worker:' + 'a'.repeat(32), secret: c.newSecret()});
  const started = performance.now();
  let settled = 0;
  const calls = Array.from({length: 20}, () => client.work().finally(() => settled++));
  const outcomes = Promise.allSettled(calls);
  const gc = setInterval(() => global.gc?.(), 1000);
  t.after(() => clearInterval(gc));
  await new Promise(done => setTimeout(done, 33000));
  clearInterval(gc);
  const pendingAt33Seconds = 20 - settled;
  server.closeAllConnections();
  const completed = await outcomes;
  const elapsedMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({name: 'R6F-08', callers: 20, pendingAt33Seconds, explicitBodyDeadline: true, elapsedMs,
    codes: [...new Set(completed.map(v => v.reason?.code))]}));
  assert.ok(completed.every(v => v.status === 'rejected'));
  assert.equal(pendingAt33Seconds, 0);
});
