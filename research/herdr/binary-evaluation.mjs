// Explicit disposable evaluation, never part of application startup or CI.
// Usage: node research/herdr/binary-evaluation.mjs /ABS/LOGGED/DOWNLOAD/ROOT
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, mkdir, mkdtemp, writeFile, lstat, rm, rename, chmod } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createHerdrMonitor } from './monitor.mjs';

const acquisition = process.argv[2];
assert.match(acquisition ?? '', /^\/private\/tmp\/control-room-herdr-eval\.[A-Za-z0-9]+$/);
const binary = join(acquisition, 'herdr-macos-aarch64');
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),
  '32b53df09872628059c789a69f02a6b8e29e14ddf26711421f3463f70c1aef17');
const root = await mkdtemp(join(acquisition, 'run-'));
const configRoot = join(root, 'c'), stateRoot = join(root, 's'), configPath = join(root, 'config.toml');
await mkdir(join(configRoot, 'herdr'), { recursive: true, mode: 0o700 });
await mkdir(stateRoot, { mode: 0o700 });
await writeFile(configPath, `onboarding = false
[update]
version_check = false
manifest_check = false
[session]
resume_agents_on_restore = false
[terminal]
default_shell = "/bin/cat"
shell_mode = "non_login"
new_cwd = "${root}"
[experimental]
pane_history = false
`, { mode: 0o600 });
const socket = join(configRoot, 'herdr/herdr.sock');
const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/cat', TERM: 'xterm-256color',
  XDG_CONFIG_HOME: configRoot, XDG_STATE_HOME: stateRoot, HERDR_CONFIG_PATH: configPath };
let child, exited, logs = '', queries = 0;
const pids = new Set();

// Fixture control only. Deliberately not exported by the read-only adapter.
async function fixtureRequest(method, params = {}) {
  queries++;
  return new Promise((resolve, reject) => {
    const client = connect(socket); let buffer = '', done = false;
    const timer = setTimeout(() => finish(new Error('fixture_timeout')), 2500);
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); client.destroy();
      if (error) reject(error); else resolve(result);
    };
    const id = randomUUID();
    client.on('error', error => finish(error));
    client.on('end', () => finish(new Error('fixture_closed')));
    client.on('connect', () => client.write(JSON.stringify({ id, method, params }) + '\n'));
    client.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 262144) return finish(new Error('fixture_response_bound'));
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer.split('\n')[0]);
        assert.equal(response.id, id); assert.equal(response.error, undefined);
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}
async function start() {
  child = spawn(binary, ['server'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  child.stdout.on('data', data => { logs = (logs + data.toString()).slice(-16384); });
  child.stderr.on('data', data => { logs = (logs + data.toString()).slice(-16384); });
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error('fixture_server_exited');
    try { await fixtureRequest('ping'); return; } catch { await delay(100); }
  }
  throw new Error('fixture_server_not_ready');
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Only this exact test server and the handles captured from it are in scope.
  try { await fixtureRequest('server.stop'); } catch { child.kill('SIGTERM'); }
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_cleanup_timeout')), 8000); })]); }
  finally { clearTimeout(timer); }
}
const evidence = { release: 'v0.9.0', source: 'b99002ac99b09e00b4ca692436cb15a6b0d676f1', checks: [], limitations: [],
  nativeAgentCalls: 0, providers: 0, sshHosts: 0, fixtureOnly: true, cleanup: false };
let failure;
try {
  await start();
  const monitor = createHerdrMonitor({ binary, socket, configPath, configRoot, stateRoot, machine: 'test-mac', session: 'disposable' });
  for (const path of [socket, join(configRoot, 'herdr/herdr-client.sock')])
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  evidence.checks.push('actual Unix API and client sockets are mode 0600');
  const first = await monitor.poll(); assert.equal(first.status, 'online'); assert.deepEqual(first.rows, []);
  const panes = [];
  for (const label of ['project-one', 'project-two']) {
    const created = await fixtureRequest('workspace.create', { label, cwd: root, env: { HERDR_AGENT: 'hermes' } });
    const paneId = created.root_pane.pane_id; panes.push(paneId);
    const info = (await fixtureRequest('pane.process_info', { pane_id: paneId })).process_info;
    assert.ok(Number.isSafeInteger(info.shell_pid) && info.shell_pid > 0);
    pids.add(info.shell_pid);
    await fixtureRequest('pane.report_agent_session', { pane_id: paneId, source: 'herdr:hermes', agent: 'hermes',
      seq: 1, agent_session_id: 'same-synthetic-session', session_start_source: 'startup' });
  }
  let populated;
  const detectionDeadline = performance.now() + 5000;
  do { populated = await monitor.poll(); if (populated.rows.length === 2) break; await delay(100); }
  while (performance.now() < detectionDeadline);
  assert.equal(populated.status, 'online');
  if (populated.rows.length !== 2) {
    evidence.limitations.push('Hermes wrapper hints/session-only reports on cat panes did not produce two detected agents in this headless test. No real Hermes detection pass.');
    await writeFile(join(root, 'pane-diagnostic.json'), JSON.stringify(await fixtureRequest('pane.list'), null, 2), { mode: 0o600 });
    // Different scenario: exercise documented custom lifecycle reporting. Do not
    // count this as Hermes detection or native session-identity acceptance.
    for (const paneId of panes) await fixtureRequest('pane.report_agent', { pane_id: paneId,
      source: 'custom:evaluation', agent: 'evaluation-agent', state: 'working', seq: 1 });
    populated = await monitor.poll();
  }
  assert.equal(populated.rows.length, 2);
  if (!populated.rows.every(row => row.duplicateSession))
    evidence.limitations.push('Actual-binary duplicate native-session detection not established; duplicate projection covered only by contract fixtures.');
  else evidence.checks.push('actual pane metadata retains duplicate synthetic Hermes session IDs; adapter flags both');
  assert.notEqual(populated.rows[0].workspaceKey, populated.rows[1].workspaceKey);
  assert.ok(populated.rows.every(row => row.executionAuthority === false));
  evidence.checks.push('two actual panes monitored with distinct project identities and no execution authority');
  await chmod(socket, 0o660);
  try { assert.equal((await monitor.poll()).status, 'offline'); }
  finally { await chmod(socket, 0o600); }
  assert.equal((await monitor.poll()).status, 'online');
  evidence.checks.push('adapter refuses group-accessible test socket and recovers after owner-only mode restored');
  // Simulate endpoint unavailability without terminating the server or its panes.
  // This is local socket-path loss, not a live SSH/network qualification.
  const unavailableSocket = socket + '.disconnected';
  await rename(socket, unavailableSocket);
  try {
    assert.equal((await monitor.poll()).status, 'offline');
    assert.ok([...pids].every(alive));
  } finally { await rename(unavailableSocket, socket); }
  const endpointBack = await monitor.poll(); assert.equal(endpointBack.status, 'online');
  assert.equal(endpointBack.generation, populated.generation);
  evidence.checks.push('temporary socket-path loss leaves original pane processes alive; reconnection retains generation');
  const memory = await promisify(execFile)('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' });
  const rssKiB = Number(memory.stdout.trim()); assert.ok(Number.isSafeInteger(rssKiB) && rssKiB > 0);
  evidence.serverRssKiBWithTwoCatPanes = rssKiB;
  monitor.disconnect(); assert.equal(monitor.view().status, 'offline');
  const reconnected = await monitor.poll(); assert.equal(reconnected.status, 'online');
  assert.deepEqual(reconnected.rows, populated.rows); assert.equal(reconnected.generation, populated.generation);
  const secondClient = createHerdrMonitor({ binary, socket, configPath, configRoot, stateRoot, machine: 'test-mac', session: 'disposable' });
  assert.equal((await secondClient.poll()).rows.length, 2);
  assert.equal((await fixtureRequest('workspace.list')).workspaces.length, 2);
  evidence.checks.push('read-only disconnect/reconnect and second observer create no new panes');
  await stop();
  assert.equal((await monitor.poll()).status, 'offline');
  assert.equal(monitor.view().rows.length, 2);
  const beforeGeneration = populated.generation;
  await start();
  const restored = await monitor.poll(); assert.equal(restored.status, 'online');
  assert.ok(restored.generation > beforeGeneration);
  const workspaces = (await fixtureRequest('workspace.list')).workspaces;
  assert.equal(workspaces.length, 2);
  for (const pid of pids) assert.equal(alive(pid), false);
  const restoredPanes = (await fixtureRequest('pane.list')).panes;
  assert.equal(restoredPanes.length, 2);
  for (const pane of restoredPanes) {
    const info = (await fixtureRequest('pane.process_info', { pane_id: pane.pane_id })).process_info;
    assert.ok(Number.isSafeInteger(info.shell_pid) && info.shell_pid > 0);
    assert.equal(pids.has(info.shell_pid), false); pids.add(info.shell_pid);
    assert.ok(info.foreground_processes.length > 0);
    assert.ok(info.foreground_processes.every(item => item.name === 'cat'));
  }
  evidence.checks.push('server restart advances observation generation, restores layout but does not resume agents');
  assert.equal(restored.completionVerified, false);
  await stop();
  assert.equal((await monitor.poll()).status, 'offline');
  evidence.checks.push('stopped server remains offline without implicit restart');
} catch (error) { failure = error; }
finally {
  await stop();
  for (const pid of pids) assert.equal(alive(pid), false, 'owned cat process remains');
  const socketState = await lstat(socket).then(() => 'present', error => error.code);
  assert.equal(socketState, 'ENOENT', 'test_socket_remains');
  evidence.cleanup = true;
  await writeFile(join(acquisition, 'binary-evidence.json'), JSON.stringify({ ...evidence, fixtureQueries: queries,
    failure: failure ? String(failure.message) : null }, null, 2) + '\n', { mode: 0o600 });
  if (failure) await writeFile(join(root, 'private-debug.log'), logs, { mode: 0o600 });
  else await rm(root, { recursive: true }); // Exact mkdtemp child owned by this invocation.
}
if (failure) throw failure;
console.log(JSON.stringify(evidence, null, 2));
