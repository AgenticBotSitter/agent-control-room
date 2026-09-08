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

## Standard persistent-resource assembly

The same compiled entry now exports `openPrivateNativeConfiguration(input, ports,
signal)`. An approved operator module can call this rather than hand-assemble the
runtime dependencies. Its exact TypeScript contract is in
`src/node-bridge/private-native-configuration.ts`.

Supply five distinct pre-created private files for bridge, run, admission, execution,
and effect journals. Their immediate directories must be canonical and private to
the current UID; existing SQLite sidecars must also be private, regular, non-linked
files. The factory will not create directories, repair permissions, remove history,
or accept memory databases. It **does initialize/migrate local journal schemas** and
may create SQLite sidecars; it is not a read-only readiness check. It must be run
only with approved state paths and exclusive operator-managed ownership. These
point-in-time checks do not defeat same-user edits or establish safe ownership of
every ancestor directory. Synchronous SQLite setup is not preemptible by AbortSignal.

The factory opens and owns the five journals plus an in-memory public approval-pin
reader. It reuses existing current-policy, owner-accepted profile, recovery, protected
frame signer, protocol authentication and HTTPS transport code. It does not implement
a second store or a new transport. Closing releases owned resources in reverse order;
partial setup closes previously opened databases without deleting retained files.

The following ports remain explicitly supplied and caller-owned: already provisioned
security state, selected node signing-key store, trusted server key resolver, trusted
local pause/recovery/profile sources, distinct Hermes bearer and connector mTLS
credential resolvers, and clock. No key is unlocked/disposed or credential retrieved
during assembly. The caller must release its borrowed resources after the returned
owner has closed and after runtime drain, including on partial setup failure.

The configuration also supplies exact task policy, enrollment, owner approval pins
and profile acceptance. Assembly does not certify current authority: missing signed
lease/control evidence is still rejected by the execution readers. It never seeds a
lease, activates a node, signs owner permission or substitutes a profile declaration
for accepted qualification. Two separate security-state files/high-water custody are
managed by the existing security repository outside this factory; sharing a directory
does not establish rollback independence.

The persistent acceptance test uses private temporary files and synthetic signed
evidence. The assembled real policy/start controller starts once over a fake transport,
then reopened journals retain the queued run, exact lease receipt and effect marker
and refuse another start. The compiled test repeats this through the built factory.
This is useful persistence/replay evidence, not native provider or disk-loss recovery
qualification. Windows persistent-file/ACL support and continuous service remain open.

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
