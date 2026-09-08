// Evaluation-only bridge to Herdr v0.9.0's existing CLI. Not imported by the app.
// No start, input, resume, stop, install, pane-read or arbitrary-method interface.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = value => {
  if (typeof value !== 'string' || !value.length || value.length > 512
      || [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127))
    throw new Error('invalid_monitor_field');
  return value;
};
const flags = { executionAuthority: false, completionVerified: false, cleanupVerified: false };

export function projectAgentList(response, { machine, session, generation }) {
  if (response?.id !== 'cli:pane:list' || response.error || response.result?.type !== 'pane_list'
      || !Array.isArray(response.result.panes) || response.result.panes.length > 1024)
    throw new Error('invalid_pane_list');
  const identities = new Set(), sessions = new Map();
  // agent.list omits session-bearing panes without detected agent status. Use
  // existing pane metadata, not screen capture, to retain those observations.
  const rows = response.result.panes.map(agent => {
    const workspace = label(agent.workspace_id), tab = label(agent.tab_id), pane = label(agent.pane_id);
    const key = digest([machine, session, generation, workspace, tab, pane]);
    if (identities.has(key)) throw new Error('duplicate_pane_identity');
    identities.add(key);
    const status = ['idle', 'working', 'blocked', 'done', 'unknown'].includes(agent.agent_status)
      ? agent.agent_status : 'unknown';
    let sessionKey = null;
    if (agent.agent_session != null) {
      const ref = agent.agent_session;
      if (ref.kind !== 'id' && ref.kind !== 'path') throw new Error('invalid_session_kind');
      sessionKey = digest([machine, session, label(ref.source), label(ref.agent), ref.kind, label(ref.value)]);
      sessions.set(sessionKey, (sessions.get(sessionKey) ?? 0) + 1);
    }
    // Drop cwd, terminal text/titles, names and arbitrary metadata. IDs are local
    // correlation hints only; none may be used to issue work or infer ownership.
    if (agent.agent == null && sessionKey === null) return null;
    return { key, workspaceKey: digest([machine, session, workspace]), sessionKey,
      status, stateSource: 'advisory', ...flags };
  }).filter(row => row !== null);
  return rows.map(row => ({ ...row, duplicateSession: row.sessionKey !== null && sessions.get(row.sessionKey) > 1 }));
}

export function createHerdrMonitor(input, ports = {}) {
  const config = structuredClone(input);
  for (const field of ['binary', 'socket', 'configPath', 'configRoot', 'stateRoot'])
    if (!isAbsolute(config[field])) throw new Error('absolute_monitor_path_required');
  label(config.machine); label(config.session);
  const run = ports.run ?? (async () => (await execute(config.binary, ['pane', 'list'], {
    env: { PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: config.socket,
      HERDR_CONFIG_PATH: config.configPath, XDG_CONFIG_HOME: config.configRoot,
      XDG_STATE_HOME: config.stateRoot },
    cwd: dirname(config.configPath), timeout: 2000, maxBuffer: 256 * 1024,
    encoding: 'utf8', killSignal: 'SIGKILL',
  })).stdout);
  const identity = ports.identity ?? (async () => {
    const parent = dirname(config.socket);
    if (await realpath(parent) !== parent) throw new Error('socket_parent_alias');
    const [socket, directory] = await Promise.all([lstat(config.socket), lstat(parent)]);
    if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077)
        || !directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077))
      throw new Error('socket_permissions');
    return `${socket.dev}:${socket.ino}:${socket.birthtimeMs}`;
  });
  const now = ports.now ?? (() => performance.now());
  let epoch = 0, busy = false, priorIdentity, generation = 0;
  let state = { status: 'offline', generation, rows: [], observedAt: null, ...flags };
  const stale = () => { state = { ...state, status: 'offline' }; };
  const view = () => {
    if (state.observedAt !== null && now() - state.observedAt >= 5000) stale();
    return structuredClone(state);
  };
  return Object.freeze({
    view,
    disconnect() { epoch++; stale(); },
    async poll() {
      if (busy) throw new Error('monitor_poll_in_progress');
      busy = true; const ownEpoch = epoch;
      try {
        const before = await identity();
        const raw = await run();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024) throw new Error('monitor_response_bound');
        const after = await identity();
        if (ownEpoch !== epoch || before !== after) throw new Error('monitor_observation_changed');
        const nextGeneration = priorIdentity === before ? generation : generation + 1;
        const rows = projectAgentList(JSON.parse(raw), { ...config, generation: nextGeneration });
        generation = nextGeneration; priorIdentity = before;
        state = { status: 'online', generation, rows, observedAt: now(), ...flags };
      } catch { stale(); } finally { busy = false; }
      return view();
    },
  });
}
