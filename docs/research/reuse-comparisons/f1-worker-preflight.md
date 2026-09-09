# DBOS4.27.6: smallest actual worker comparison preflight

2026-09-08. Read-only inspection of the existing pinned distribution beneath
`/private/tmp/cr-compare-f1.9x5bSO/node_modules/@dbos-inc/dbos-sdk/dist/src/`.
No import/execution, new acquisition, database/service operation or application edit.
Existing package provenance remains `f1-acquisitions.md` / `f1-package-lock.json`;
this is not a fresh whole-package integrity audit. Root approves the actual fixture.

## Feasibility result

The public SDK supports a real inert function registration, actual queued pickup,
durable message wait/result retrieval and bounded shutdown. There is no need to
rewrite dequeue SQL or build a continuous Control Room worker to exercise those
responsibilities. Use a fresh child process and the already approved owned PostgreSQL
socket. No native agent function, event receiver, application entrypoint or decorator
from the CR application should be imported into that child.

Important isolation detail: `dbos.js::launch` **always calls `readConfigFile()`**, even
after `DBOS.setConfig`. `config.js::readConfigFile` reads cwd `dbos-config.yaml` and,
if needed, `package.json`, with environment substitution. Therefore the child must
start in an owned empty fixture directory, not the CR checkout or a user's project.
Pass the harness script/SDK path absolutely. Explicit configuration is necessary
but does not prevent those reads by itself.

## Exact supported configuration surface

`dbos-executor.d.ts::DBOSConfig`, `config.js::translateDbosConfig` and
`dbos.js::launch` support the following proposed fixture settings:

- Explicit synthetic `name`, `applicationVersion`, `executorID` and fresh
  `systemDatabaseSchemaName`. Without `name`, launch warns that it can claim workflows
  for every application sharing its database. Do not rely on the executor ID alone.
- `systemDatabasePool`: the actual preconfigured `pg.Pool` using only the owned Unix
  socket/user/database. Keep its connection/statement limits explicit, attach its
  error handler and own its final close. The config translator still computes a URL;
  do not infer all setup paths ignore it without checking the selected migration mode.
  Existing successful `ensureSystemDatabase` can prepare this fresh schema first,
  then `runMigrations:false` avoids another implicit migration path on launch.
- `runAdminServer:false`, `enableOTLP:false`, `tracingEnabled:false`, empty trace/log
  exporter endpoint arrays, and a synthetic/no-op logger. `telemetry/exporters.js`
  returns before constructing exporters when OTLP is disabled. A global trace-context
  manager may still be installed by launch; process isolation contains that mutation.
- `listenQueues:[uniqueFixtureQueue]`, `maxConcurrentQueueDispatches:1`,
  `systemDatabasePollingConcurrency:1`, and `useListenNotify:false`. These are public
  settings; dispatch-cycle concurrency is not the workflow concurrency limit.
- Call `DBOS.launch()` with no conductor options. Use a sterile environment with no
  `DBOS__CLOUD`, conductor keys/URL/app, ambient exporter settings or credentials.
  Cloud mode overrides configuration and forces admin/conductor behavior. Do not
  toggle that mode on and assume local disable flags remain authoritative.

Even without admin/Conductor/OTLP, launch has real effects: system-schema reads/writes,
application-version registration, pending-workflow recovery, queue dispatch polling,
internal queue registration and global SDK lifecycle state. Those effects belong only
in the synthetic child/schema. No arbitrary lifecycle listeners or data sources should
be registered; launch initializes every registered listener/data source.

## Public APIs and smallest decision-changing fixture

1. Before launch, `DBOS.registerWorkflow(asyncFunction, {name, maxRecoveryAttempts})`
   returns a real registered wrapper; `dbos.d.ts` explicitly makes it available for
   recovery. Register only a synthetic function that returns fixed input-derived data,
   optionally calls an actual `DBOS.setEvent`/`DBOS.recv`, and cannot call agents,
   providers, files, shell or network. Do not invoke the original unregistered function
   and call that queue pickup.
2. Launch with the configuration above. Public `DBOS.registerQueue(name, options)`
   persists queue configuration. `wfqueue.d.ts` exposes `globalConcurrency`,
   `workerConcurrency`, partition limits and `minPollingIntervalMs`; the old
   `concurrency` alias is deprecated. Queue conflict behavior has explicit
   `update_if_latest_version`, `always_update` and `never_update` options. A fresh
   unique queue avoids silently inheriting a prior experiment's limits.
3. `DBOS.startWorkflow(registeredFunction, {workflowID, queueName})(input)` returns
   a real handle; `getResult` has timeout/deadline options. Alternatively retain the
   already-proved actual caller-transaction enqueue path, with exactly matching
   registered name/application/version, and observe that the actual worker picks it
   up. Confirm an execution acknowledgement and persisted result, not just an
   enqueued row or returned handle. This latter seam connects the transaction result
   to actual pickup without introducing canonical CR admission claims.
4. For meaningful review-wait comparison, let synthetic job A acknowledge arrival
   via `DBOS.setEvent` and block in `DBOS.recv('synthetic-review', {timeoutSeconds})`.
   Submit independent B on the same queue, positively observe its start/completion
   or its continued enqueued state, then release A with public `DBOS.send` and finish
   all handles. Use bounded deadlines and record queue/status observations. A local
   Promise alone would not exercise durable waiting.

Do **not** assume `recv` releases a queue slot. `dbos.js::recv` delegates to durable
database receive inside the workflow; the inspected queue dispatch implementation
in `system_database.js` counts running `PENDING` work when enforcing concurrency.
No explicit yield/release-on-recv API was identified in these selected public
declarations. First measure concurrency1; a documented concurrency2 variant can
show the cost/behavior distinction if needed. Returning an intermediate result and
making review an independent CR phase is another integration shape, not proof that
a waiting DBOS workflow natively frees capacity. Do not implement new scheduling
policy to make the test green.

## Recovery and shutdown boundaries

`DBOSExecutor.init()` calls `recoverPendingWorkflows([executorID])`. The recovery path
uses application version and recorded identities. A fresh child with the same
synthetic app/version/executor and registered function is therefore a plausible
actual process-recovery experiment, but success must be observed; merely replacing
client objects repeats the already-scoped recovery fixture.

`DBOS.registerStep` documents at-least-once execution until a checkpoint is recorded.
It can demonstrate replay of a completed inert step, but it cannot turn an uncertain
external provider start into exactly-once execution. Only synthetic effects are
appropriate here. Do not equate a workflow body being replayed with duplicate native
work, or hide potential replay behind an uninstrumented fake.

Public `DBOS.deactivateEventReceivers()` stops queue dispatch/listeners. Public
`DBOS.shutdown({workflowCompletionTimeoutMS, deregister:true})` first deactivates
receivers, then waits up to the configured workflow drain timeout, stops Conductor,
destroys executor/data sources and clears registry when requested. Default shutdown
does not wait indefinitely for workflows. This is SDK cleanup, not an OS guarantee
that an arbitrary user function has stopped. The outer approved child deadline and
owned-cluster stop/absence checks remain necessary. Register no signal-driven
recovery loop and no persistent service.

## What this packet would settle

Actual enqueue-to-pickup/result, waiting versus unrelated work, bounded drain and
possibly same-identity process recovery can discriminate DBOS's integration cost
against pg-boss. It would still not prove full CR claims/eligibility/review approval,
native uncertainty, supported schedules, production roles, long-running performance
or PG17 target acceptance. Avoid another calendar helper/marker test, and do not
expand this packet into building the production fleet manager.
