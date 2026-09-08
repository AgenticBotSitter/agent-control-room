# Node execution package: explicit attempt, not a continuous service

The platform supervisor templates here are **historical, non-installable design
references**. Their referenced `node-service.js` does not exist. Static conformance
checks do not prove executable service readiness. Never replace that filename with
the one-task command or enable automatic restarts. Continuous multi-job service,
its installation, and native platform acceptance remain unfinished.

The current executable is `scripts/run-private-node.mjs`, backed by the explicitly
compiled `dist-vps/server/nodeConnector.js`. Build using the existing `pnpm build:vps`
command after approved dependency preparation. Import and `--help` do not start it.

After separately approved operator setup only:

```sh
node scripts/run-private-node.mjs --configuration /absolute/protected/node-config.mjs --mode initial
```

`recover` must be an explicit operator decision against retained journals and the
same authorized task, not an automatic fallback. Never restart `initial` after an
uncertain attempt. This is a Hermes-native one-task composition, **not Codex support,
agent enrollment, a discovery daemon, an installer or a fleet scheduler**.

## Protected configuration contract

The `.mjs` file is trusted executable operator code, not ordinary JSON, uploaded
configuration or a plugin. It must be a canonical absolute non-symlink regular file,
owned by the current process UID with no group/other permissions (for example 0600).
Parent symlinks are rejected. These checks do not contain trusted code or defeat
same-user/admin changes. Keep the entire configuration directory protected and out
of Git. This permission gate currently supports Unix; Windows needs reviewed ACL
handling before this command can be used there. Do not relax it to bypass that gap.

Export `schema = 'control-room.private-node-configuration/v1'` and asynchronous
`createConfiguration({ signal, mode })`. The factory returns:

- `harness: 'hermes-native-v1'`;
- `node`: `NativeNodeRuntimeConfiguration` from the existing Hermes node runtime;
- `dependencies`: `NativeNodeRuntimeDependencies` including approved persistent
  bridge/run/admission/execution/effect journals, exact enrollment/profile/approval
  and current trust sources, frame signing, native transport and recovery authority;
- `https`: `NativeNodeHttpsConfiguration`, with exact destination, verified server
  CA/leaf pin, connector credential reference, and exact private-address pin if used;
- `settings`: existing connector cycle/interval/deadline bounds (maximum five-minute
  connector deadline);
- `sources`: current-authority guard and connector mTLS credential resolver, with
  optional existing monotonic clock/wait ports;
- asynchronous `close()`: once-only release of the resources opened by this factory.

Use the types in `src/harness/hermes-native-v1/node-runtime.ts`,
`src/node-bridge/native-https-client.ts` and `src/node-bridge/native-connector.ts`.
The factory must clean up partial acquisitions if it throws and honor its abort
signal. After return, ownership transfers to the launcher. Resource creation must
not itself run an agent. No example supplies invented production resources or
fixture credentials. Real custody, approved adapters and durable storage still
need host-specific implementation and qualification.

The launcher composes the existing node runtime and pinned mTLS connector. It does
not open an inbound listener or confer missing approval authority. Connector mTLS,
node-frame signing, owner approval signing, and Hermes authentication are distinct.

## Stop, result and cleanup

SIGINT/SIGTERM request cancellation; the five-minute outer timer is also a cooperative
cancellation request, not containment of an unresponsive operator factory. A reviewed
host supervisor/operator must own final process termination. No supervisor is installed.
The connector closes the runtime before factory-owned journals are released. Cleanup
observation is bounded; an uncertain runtime drain retains those resources for operator
attention. A timed-out resource close may still be running; timeout is not proof of stop.
Logs contain only fixed summaries, not raw configuration, paths, tokens or identities.

Exit zero means the connector reported `terminal/completed` and cleanup was observed.
It does not mean the research is correct or owner review passed. Bounded waiting,
uncertainty, terminal failure, configuration errors and cleanup uncertainty return
nonzero and do not retry. Consult authoritative server receipts and retained local
journals before deciding recovery. Do not erase journals to make an attempt pass.

## Evidence

`pnpm test:node-launcher` checks injected operator/release lifecycle behavior and
existing connector/TLS regressions with synthetic data. `pnpm test:node-launcher:build`
builds the fixed entry and checks actual compiled composition denied before any
network/native effects. That denial test is **not** successful end-to-end execution
or physical network/provider/platform qualification. Existing synthetic connector
integration separately covers dispatch through result registration and recovery.
