# Mac local build progress

Codex appends one short entry per work package (see `CODEX_MAC_BUILD_EXECUTION.md`).

- REAL 2026-09-25 — VPS route evidence accepted by Claude: check 1 passed (PostgreSQL loopback-only), check 2 passed (TCP Serve forwards to loopback and the HTTPS route is unchanged), and check 6 passed (plaintext role access is rejected). The certificate renewal job also ran unchanged, but check 9 is incomplete until the Mac database check passes after renewal. Website status codes were unchanged before/after; the SSH portion of check 10 is not verified. The exact repoint invocation, including pnpm's `--` separator, now reaches the safe Mac-tag check and refuses because current Tailscale status shows `tag:general` but not `tag:control-room-client`. Protected config remains on loopback port 15432 with no v2 endpoint policy; PostgreSQL was not contacted. Check 3's policy diff and checks 4–5, 7–8, and full check 10 remain unverified. Check 7 requires the owner to try port 5432 from the phone or PC.
- REAL 2026-09-25 — after removing tunnel support from `mac:up`/`mac:down`, a read-only Mac check found no old tunnel configuration, PID/log files, matching SSH tunnel process, or tunnel LaunchAgent. No SSH tunnel was restored or changed.

- REAL 2026-09-24 — the loopback-only SSH database tunnel accepted a local connection, but the first protected-configuration run stopped before writing its JSON files because Hermes reports a multi-line version banner and the generic version reader wrongly required one line. Seven protected password files exist; no database map, owner code, website, queue, or agent was created or started.

- SOURCE 2026-09-24 — read-only VPS verification confirmed the database is ready but the raw private database route is absent; the Tailscale admin console is signed out, so the required Mac-only access rule cannot be inspected or safely changed yet. One sign-in-only owner step is recorded in OWNER_ACTIONS.md.

- SOURCE 2026-09-24 — repaired the Mac provisioner's remote success detector so harmless SSH wrapper output cannot turn a completed VPS database setup into a false failure; syntax, marker cases, dry run, type-check, and whitespace verification pass. The secure Mac-to-VPS route remains the next real W1 proof.

- REAL 2026-09-24 — the existing VPS `control_room` database now has the full 85-entry migration ledger and all four fixed Mac-local login roles. The Mac-to-VPS TLS route and its four-role connection check are still pending, so no website, queue, or agent is represented as running.

- 2026-09-24 — Codex local-runner cancellation fence: the managed, read-only
  Codex command runner now checks cancellation again after its asynchronous
  empty-work-folder inspection and before it can spawn a process. A focused
  test cancels at exactly that boundary and proves no process starts. The
  matching Claude runner already had the same protection. Seventeen focused
  Claude/Codex runner and shared-delivery checks plus TypeScript pass. This is
  source-only safety work: no Control Room site, database, queue, or agent was
  started.

- 2026-09-24 — current Hermes three-agent host assembly: the protected local
  task-host validator now accepts the update-aware Hermes route alongside the
  already existing Claude and Codex routes. A new inert composition joins all
  three to the same controller lifecycle and existing queue; it refuses a
  caller-provided Hermes callback and starts neither a queue nor an agent.
  This avoids treating ordinary Hermes updates as a failure of the retired
  0.21 installer proof. Five focused current-Hermes/composition checks and
  TypeScript pass. The remaining work is protected runtime configuration and
  the real local website journey; no database, website, service, or live task
  was started.

- 2026-09-24 — current Hermes protected-startup admission: the protected task
  startup validator recognizes the update-aware local Hermes delivery route
  and requires the existing approved queue and approval store. It remains
  separate from historical Hermes 0.21 proof records, so a normal Hermes
  update requires a new qualification rather than a source change. Four
  focused current-Hermes/startup checks and TypeScript pass. No worker,
  website, database, or service was started.

- 2026-09-24 — current Hermes runner handoff: the shared queue can now turn
  one verified current-Hermes locator into the existing controller delivery
  packet, recheck it immediately before launch, and accept queue success only
  after the existing result publisher reports a saved result. A replay receipt
  is not treated as a new successful run. The protected host still owns the
  executable, chosen model/provider, authority recheck, and result publisher;
  none are task input. Four focused queue/runner tests, TypeScript, and
  whitespace checks pass. This is source integration only: no service, site,
  database, or live task ran.

- 2026-09-24 — current Hermes queue route: the update-aware Hermes plan now
  uses the existing approved work queue and its existing protected receipt
  store. It is a separate, tagged route from the historical 0.21 evidence,
  so an old receipt cannot start the current installed build. A focused
  disposable-data journey proves plan, assignment, queueing, pickup, and
  refusal of a changed queue proof. The queue callback is now available for
  the protected current-Hermes runner; its final host composition remains the
  next package. Two focused queue/planning tests, TypeScript, and whitespace
  checks pass. No database, website, worker, or service was started.

- 2026-09-24 — current Hermes website-planning route: a task selected for the
  update-aware `hermes` worker now receives its own current-Hermes plan and
  correction-plan records, rather than being represented as the historical
  Hermes 0.21 worker. The saved records retain a digest of the qualified
  installed build, not a source-pinned version, and use the same existing
  proposal, review, and correction lifecycle as Claude and Codex. A focused
  disposable-data test proves the website planner offers it only when the
  local installation admits it and labels the prepared worker as Hermes.
  Ten focused tests, TypeScript, and the whitespace check pass. Queue pickup
  is the next package; no website, database, worker, or service ran here.

- 2026-09-24 — version-independent local worker identity: the active Mac
  product now identifies Marvin's worker as `hermes`, rather than embedding a
  Hermes release number in its host configuration or readiness panel. Older
  `hermes-021` source remains only for historical compatibility evidence. The
  current update-aware qualification record controls whether the `hermes`
  worker is available after an update. Fourteen focused local-host checks and
  TypeScript pass. No worker, database, or website was started by this source
  change.

- 2026-09-24 — real local Hermes runner proof: after the stream parser was
  corrected for the current Hermes Agent's documented progress frames, Marvin
  completed one harmless text-only task through the new Control Room runner
  and returned the exact requested result. The run used the protected `cr`
  profile with model `space-bunny-free` and provider `opencode-go`, in an
  empty temporary folder with tools disabled. It returned measured token use
  and did not contact the Control Room database, website, or a background
  service. The next integration step is to have the protected host supply the
  already-existing receipt/current-authority/publisher closures for this
  runner.

- 2026-09-24 — current Hermes shared-delivery bridge: the new update-aware
  Hermes runner is now available through the same durable Control Room receipt
  and publication bridge as the local Claude and Codex runners. It does not
  introduce another queue, scheduler, database, or task lifecycle. Sixteen
  focused checks and TypeScript pass; they prove a task stopped before launch
  does not run, a replay does not run twice, and a cancelled or revoked task
  cannot save a result. This remains source proof only: the protected host
  configuration still needs to bind the worker to the real database and
  website before a live owner task can be run.

- 2026-09-24 — local Hermes reusable text runner: a current Hermes build can
  now run one bounded, text-only task through the same local delivery shape
  already used by Control Room's Claude and Codex routes. Its protected worker
  configuration supplies the profile, model, and provider; none are hardcoded
  in source. It starts in an empty task folder with tools disabled, a minimal
  environment, a time limit, and process-group cleanup. The existing shared
  receipt, authority recheck, and result-publication bridge remain responsible
  for task lifecycle. Twelve focused checks and TypeScript pass. Fake-process
  tests prove malformed output, cancellation, a timeout, and a leaked child
  cannot become a successful result. No live Control Room task, database, or
  background service was started. Next: bind this adapter to the protected
  local host configuration and existing canonical publisher.

- 2026-09-24 — current local Hermes compatibility foundation: Control Room
  now captures the version and full local source revision reported by whatever
  Hermes build is installed on this Mac. Normal updates are not refused or
  hardcoded: each becomes a new recorded build that must pass the ordinary
  short qualification before it may receive tasks. Malformed output or a
  source mismatch is refused. The existing Hermes 0.21 connector remains
  historical evidence and is neither broadened nor relabeled. Three focused
  checks and TypeScript pass. This package did not start Hermes through
  Control Room, connect to the database, open a website, or change Hermes
  itself. Next: compose the captured build identity with the existing shared
  queue and result path.

- 2026-09-24 — W3/W4 queue reuse correction: the protected task provider no
  longer accepts or starts a queue-worker callback. The Mac task host now
  starts only the release-owned, existing PostgreSQL queue factory after the
  website and canonical task composition are ready. This removes the last
  provider-level path to a second scheduler or queue. Sixteen focused checks,
  TypeScript, and the whitespace check pass. No queue, database, website, or
  agent was started by this source package.

- 2026-09-24 — W4 three-agent activation gate: the protected task-host command
  now requires exactly the three intended local worker kinds—Hermes, Claude,
  and Codex—and checks that each passed the host generation's pinned
  executable verification before the shared task composition can be created.
  A website-only host may still start for setup without workers, but task mode
  cannot silently degrade into a partial installation. Sixteen focused host
  and provider checks, TypeScript, and the whitespace check pass. This is
  source evidence only; it did not start a queue, database, website, or agent.

- 2026-09-24 — W3/W4 protected task-host handoff: the release now has a
  separate, owner-attended task-host command that loads only one fixed,
  owner-only `runtime/task-provider.mjs` below the protected directory. That
  provider supplies the existing shared task lifecycle and existing queue
  worker to the same Mac host; the ordinary website command cannot activate
  them. Loose file permissions, links, substituted modules, missing lifecycle
  callbacks, and caller-provided worker callbacks are refused. Twenty-one
  focused host/provider/release checks, TypeScript, the release build, and an
  import of the compiled entries pass. The real owner-held provider has not
  been written or run, and no database, listener, queue, or agent was started.
  Next: use the existing three-agent composition to define that provider's
  narrow configuration contract and exercise it against disposable services.

- 2026-09-24 — P0 local source scan: the 683 commits ahead of `origin/main`
  were checked for common cloud-key, private-key, GitHub-token, generic secret,
  and private-tailnet-address patterns without printing source or values. No
  matches were found. This is a narrow hygiene scan, not a claim that a public
  release is ready; the branch is still local-only and has not been pushed or
  merged.

- 2026-09-24 — W3 real local website launcher: the compiled release now
  contains the Mac-local host, protected configuration reader, PostgreSQL
  adapter, and private-app assets required to start the real loopback website
  through one owner-attended command. The command accepts only the fixed
  protected-root location, validates every owner-pinned executable before it
  opens the one authority database, and starts no queue or agent. It is
  intentionally the website-only step: the later task composition remains the
  sole route for Hermes, Claude, and Codex. TypeScript, eleven focused
  launcher/configuration/release checks, the release build, and an import of
  the compiled host entry pass. No protected configuration was read, database
  connection opened, listener started, or agent run. Next: put the existing
  protected task composition behind this same launcher rather than creating a
  separate local product path.

- 2026-09-24 — W3 release-owned protected configuration loader: the fixed
  owner-only Mac configuration and four-role database-map reader is now part
  of the compiled Control Room release, rather than existing only in a source
  script. It still reads no environment values, opens no database, and starts
  no listener or worker. The release build configuration now type-checks every
  declared server entry; that exposed and corrected a strict typing gap in the
  existing local-worker record parser. Three protected-loader checks, six
  release-profile checks, TypeScript, and the whitespace check pass. Next:
  reuse this release entry in the protected Mac host launcher, then supply the
  existing canonical task lifecycle from the single protected configuration.

- 2026-09-24 — W5 real local product-route foundation: after loopback owner
  sign-in, the Mac-local server now reaches the installed project catalogue,
  one authorized project, its task list, and one authorized task-detail page.
  It checks the existing project/task permissions before rendering, rejects
  malformed or cross-project route identifiers, and redirects the local home
  route to the real project catalogue. The old repository-fake `/local-preview`
  route remains unavailable in this host mode. Four focused Mac-local web
  checks, TypeScript, and the whitespace check pass. This is still source-only:
  it does not start a listener, use the VPS database, or run an agent. Next:
  make the existing installed private-app renderer and assets available to this
  already-verified route boundary, then wire the shared task composition into
  the protected startup path.

- 2026-09-24 — W4 local Codex queue-to-runner bridge: the verified queue
  locator now reaches only a freshly reconstructed Codex delivery and the
  protected host-owned fixed CLI/result bridge. It refuses unexpected model
  fields, a changed locator, cancellation, and any outcome that did not reach
  the existing canonical result publisher. It still starts no real Codex
  process in tests. Focused executor, queue, and TypeScript checks pass. Next:
  the protected host must supply the real fixed CLI policy, authority fence,
  receipt port, and publisher closures.

- 2026-09-24 — W4 local Codex current-delivery reconstruction: after the
  shared queue returns its small Codex locator, the local host can now rebuild
  the exact current project, task, lease, worker binding, deadline, and review
  profile from the authority database before execution. This is a read-only
  safety fence: it cannot queue, run Codex, or publish a result. The focused
  Codex queue/reconstruction test and the TypeScript check pass. Next: join
  this reconstructed delivery to the already-tested fixed Codex CLI runner and
  existing canonical result publisher from the protected Mac host.

- 2026-09-24 — W4 three-agent lifecycle composition: the existing restricted
  Mac task lifecycle can now carry the independently fenced Hermes, Claude,
  and managed Codex local routes together. They retain one authority database,
  one existing task/review/correction lifecycle, and one existing queue path;
  no process, queue, or worker starts merely because all three are configured.
  Focused three-agent composition and Codex queue checks plus the TypeScript
  check pass. The next missing assembly is the protected host's fixed real
  Codex delivery configuration and publisher closure.

- 2026-09-24 — W4 managed local Codex queue path: a saved owner-trusted local
  Codex text-review plan can now use the same existing canonical assignment,
  signed approval record, native submission queue, and pickup recheck as the
  local Hermes and Claude routes. Codex has its own authenticated queue-record
  type, so an approval recorded for Hermes or Claude cannot be reused for
  Codex. The pickup returns only task identity to the protected host; it does
  not contain a command, prompt, model selection, account, workspace, or
  permission to execute. Focused Codex queue/planning checks and the TypeScript
  check pass. This remains source-only: the final protected host composition
  still needs to connect this verified pickup to the already-tested Codex CLI
  execution and canonical result-publication bridge.

- 2026-09-24 — W4 Hermes final-authority correction: independent source review found a narrow timing gap between Hermes's executable re-check and process launch. The runner now repeats the existing canonical authority check after that final file check and immediately before launch. A deterministic test simulates revoked work at that exact point and proves it is refused; the focused Hermes suite and TypeScript check pass. This is a source-only safety fix—no real Hermes task or service ran.

- 2026-09-24 — W4 shared Hermes-and-Claude local lifecycle: the protected Mac path now has one source-only composition that attaches the existing owner-authorized Hermes queue bridge and the already-qualified, text-only Claude capability to the same existing restricted task lifecycle. It refuses a mismatched tenant or a caller-supplied replacement worker callback, and construction starts neither the queue nor either agent. Two focused disposable-role checks and the TypeScript check pass. Marvin was asked for a bounded independent design check but returned no usable verdict, so this entry records Codex's tested source evidence only. Next: give this combined lifecycle a fixed protected runtime configuration and the existing queue worker from the Mac launcher.

- 2026-09-24 — W4 local Codex planning contract: the owner-trusted Mac Codex CLI now has its own task identifier, capability, and text-review plan versions. A task can be offered only after that local adapter is explicitly enabled; its saved plan records the same existing project, approval, result-review, and correction lifecycle used by local Hermes and Claude. It cannot fall back to the older Codex App Server route, and it does not start Codex, change model selection, or expose a command path. One focused durable-plan/replay test and the TypeScript check pass. Next: connect this selected plan to the existing approved queue and canonical result publisher.

- 2026-09-24 — Execution handoff: the superseded five-phase prototype, including its uncommitted source and documentation, was preserved unchanged on the separate `codex/archive-five-phase-2026-09-24` branch and was not merged. All further Mac-local work now proceeds only on `claude/mac-local-integration` under `CODEX_MAC_BUILD_EXECUTION.md`. The archive remains reference-only; it does not change the current product path or claim any live installation.
- 2026-09-24 — W3 protected host composition: the Mac-local path now reads only `Protected/config/mac-local.json` beneath owner-only real directories, verifies pinned local executable versions before opening the authority database, and then constructs the dedicated loopback website composition. Eight focused configuration/startup/service checks and the TypeScript check pass. Claude review was requested twice but the CLI returned no verdict, so this integration records Codex's source review and test evidence only; it is not a claim of Claude approval. No protected file, VPS database, listener, worker, or persistent service was used by these tests. Next: connect the queue's existing delivery authority to the three text-only adapters, then complete the missing website journey routes.
- 2026-09-24 — W4 Claude text-adapter foundation: a separate owner-trusted local adapter now uses the verified installed Claude CLI options, leaves model selection at the CLI default, disables tools, MCP settings, slash commands, and session persistence, and confines every task to an empty directory with a small environment allowlist. It refuses a cancellation before launch, terminates and confirms cleanup of its detached process group on cancel/deadline, and refuses malformed output. Six fake-executable checks and the TypeScript check pass. Claude's first review found three cleanup defects; all three were fixed. Its requested short re-review returned no verdict, so the merge records Codex verification, not a Claude acceptance. It remains unconnected to the canonical queue and cannot run a live task.
- 2026-09-24 — W5 local-route wiring: the existing canonical assignment, approval, submission, result review, verification, and correction operations can now be supplied to the dedicated Mac-local wrapper and retain its loopback owner-session checks. The wrapper creates none of those operations itself. A signed-in local route test proves an existing assignment operation is reached through the Mac path; all four local web checks and the TypeScript check pass. The host still needs to compose the real canonical operations, so this is route compatibility—not yet a live queue or worker.
- 2026-09-24 — W4 exact local-adapter registry: the Mac-local path can now bind each owner-pinned Codex, Hermes, or Claude worker to its already-composed delivery boundary. Before any callback, it requires the one matching local worker ID, adapter ID, and adapter revision from the canonical packet; it refuses redirects, remote routes, stale revisions, unknown workers, and cancelled work. It adds no queue, scheduler, receipt store, retry rule, or process authority. Three focused registry checks, the existing source-only adapter checks, and the TypeScript check pass. Claude review was requested with the focused diff, but returned no verdict; this entry records Codex verification only. Next: compose the registry with the existing canonical queue worker and per-worker result publication, including revision and cancellation proof paths.
- 2026-09-24 — W4 Hermes revocation proof: an independent route review identified a missing direct test for the final canonical recheck. The current branch now proves that a task revoked after its durable delivery receipt but before Hermes launch invokes no Hermes process, and a replay remains fenced rather than trying again. Three focused Hermes delivery checks and the TypeScript check pass. This is a test-only safety correction; no local agent or real task was run.
- 2026-09-24 — W5 protected-host operation wiring: the protected Mac host now accepts only already-built canonical task operations and passes them into the loopback website. It does not build a local planner, queue, review system, result store, or worker. Seven focused host, serving, and local-route checks plus the TypeScript check pass. This makes the existing assignment/review/correction routes reachable once the shared application composition supplies them; it is not yet a live task service.
- 2026-09-24 — W4/W5 truthful worker status: startup now derives a per-host worker status only after every pinned executable version has been verified. A worker becomes “proven” only after the canonical result publisher records a result, and a failed readiness check remains unavailable until a fresh restart re-verifies it. The signed-in loopback site exposes this safe status without executable paths, versions, secrets, or worker IDs. Eleven focused startup, host, website, and readiness checks plus the TypeScript check pass. No real worker was started.
- 2026-09-24 — W4 readiness-to-delivery fence: the exact Mac-local adapter registry now checks that same live worker status immediately before it can call a selected adapter. A failed worker therefore cannot receive new local work while the website calls it unavailable. Four adapter-registry checks, three readiness checks, and the TypeScript check pass. This is still source-level integration; the canonical queue-to-executor composition remains the next live-path package.
- 2026-09-24 — Independent Hermes route report reconciled: Marvin reviewed the archived temporary checkout, not this integration branch. Its source findings confirmed the existing Hermes route saves a receipt before launch, performs a final authority recheck, prevents replayed launches, and returns results through the shared review/correction lifecycle. The one directly relevant missing case—revocation after the saved receipt but before launch—is now covered on this branch by the W4 Hermes revocation proof. Marvin's broad TypeScript command was not this repository's supported check; the current branch records `pnpm check` rather than claiming a different command covers every test file. The report is evidence for the route design, not approval of the current branch or a live worker proof.
- 2026-09-24 — W3/W5 canonical local task composition: the Mac-local path can now construct the existing planning, assignment, approval, result-review, correction, and optional manual-verification operations for its loopback website. It uses separate restricted web and controller connections to the same authority database, and verifies the shared task/review keys match before composition. It deliberately starts neither a queue poller nor a worker. Focused disposable PostgreSQL-role tests prove the operations are present, the connections cannot be collapsed into one privileged role, no queue starts on construction, and each owner closes only its own connection. The focused test and TypeScript check pass. Next: bind this composition into the protected Mac host and then attach the existing queue delivery to the Hermes adapter.
- 2026-09-24 — W3/W5 composed-host ownership: the loopback Mac host can now own one complete canonical task composition rather than receiving unrelated operation callbacks. It refuses a mixture of bare operations and a separate controller lifecycle, becomes unavailable whenever that lifecycle does, and shuts down both the local website and controller composition without double ownership of the restricted web connection. Six focused host/composition checks and the TypeScript check pass. This remains assembly only: it does not start the queue worker or any agent. Next: supply this composition from the protected Mac startup path, then bind its existing queue delivery to Hermes.
- 2026-09-24 — W3 protected lifecycle factory: after the pinned local executables are verified and the restricted web connection opens, protected Mac startup can now create and own one canonical task composition. It refuses ambiguous mixes of old callback operations and a lifecycle factory, and closes the website and controller resources together if startup or shutdown fails. Ten focused host/startup/composition checks and the TypeScript check pass. It has no live controller-role connection yet, so it cannot deliver a task; the next package builds the protected role-to-composition factory and reuses the existing queue submission.
- 2026-09-24 — W4 Hermes canonical runner bridge: the existing local Hermes delivery path now supports an owner-authorized runner that mints its one-use process port only after the durable queue receipt and last authority recheck. The bridge uses the existing queue executor, result-publication path, and task binding; it adds no queue, scheduler, database, or browser route. Focused checks prove a replay cannot mint or invoke another port, a revoked task invokes none, and the owner-runner admission remains one use per exact task. Nine focused Hermes checks and the TypeScript check pass. It is source-ready but still awaits protected controller-role configuration and one owner-attended real task before it can be called live.
- 2026-09-24 — W3 restricted database-role foundation: the Mac-local protected directory can now hold one owner-only role map for the existing single Control Room database: separate web, coordinator, result, and queue-worker logins. The loader refuses loose permissions, symlinks, reused roles, different databases, or a web configuration mismatch before any database connection opens. Fifteen focused protected-configuration and host checks plus the TypeScript check pass. This remains source-only: no credentials were read from a real protected directory and no database connection, worker, or website was started. Next: compose those existing restricted roles into the canonical task services and queue without recreating their lifecycle.
- 2026-09-24 — W3 independent review: Claude reviewed the restricted-role package at `a84a7461` against the current Mac-local plan and Packet B. Verdict: APPROVE. It confirmed that the four role logins share only one database endpoint, role-file validation and the web-role match occur before any connection opens, and the superseded Claude admission code was not changed. Claude could not run the checks in its read-only environment; Codex's recorded focused checks and TypeScript check remain the execution evidence.
- 2026-09-24 — W1 protected-role database check: a new read-only `pnpm mac:check-database` command loads only the fixed owner-only role map, checks the four restricted logins one at a time, confirms their connected identity and the recorded migration ledger, then closes each connection. It never accepts arbitrary connection strings, changes the database, retries, or prints protected values. Seven focused checks and the TypeScript check pass. A Marvin review request reached its local environment but returned no verdict, so this package records Codex's test evidence only and remains available for a later independent review. No real database connection was attempted by this build package.
- 2026-09-24 — W4 Codex process-group correction: the text-only Codex adapter now confirms that its complete detached process group has disappeared after it sends KILL, and refuses to call a task completed when the direct CLI process exits but a descendant remains. The matching Claude and Codex fake-executable suites (13 checks total) plus the TypeScript check pass. This is a source-level safety correction only; no real Codex or Claude task was run.
- 2026-09-24 — W4 shared local CLI delivery bridge: Codex and Claude now have one small Mac-local bridge that reuses the authoritative controller receipt before any text-only CLI can run. The host supplies the existing authority recheck and canonical result publisher; the bridge creates no queue, scheduler, database, retry policy, or result store. Disposable checks prove one publication, restart replay fencing, post-receipt revocation refusal, failed-CLI truthfulness, cancellation before launch, and cancellation or revocation while a CLI runs. The focused bridge and Hermes-route checks plus the TypeScript check pass. Claude's first review found the missing post-execution authority fence; this correction adds it. It is source-ready only: the next package composes this bridge with each adapter's already verified process runner and the existing canonical result publisher.
- 2026-09-24 — W4 Codex/Claude process-adapter composition: the shared local-CLI bridge can now call either already-verified direct CLI adapter through one fixed plain-text envelope, owner-pinned executable, empty task directory, and bounded deadline. Provider-specific successes map to bounded text; malformed, canceled, timed-out, or cleanup-uncertain outcomes remain non-publishable failures. Four focused adapter checks, the bridge checks, and the TypeScript check pass. This changes no model selection, queue, database, scheduler, or result lifecycle. The remaining W4 assembly is deliberately narrow: inject the existing canonical authority and durable result publisher into these source-ready adapters from the protected Mac host.
- 2026-09-24 — W4 local Codex/Claude delivery composition: each direct local CLI adapter can now be composed with the one shared receipt bridge, an installation-owned canonical authority check, and the existing publisher closure. Focused disposable checks prove a Codex result reaches that publisher once and a restart cannot execute it again; a Claude timeout reaches no publisher. This is still a composition seam, not a running worker: the protected host must supply real canonical authority and result-publication closures before any owner-attended task can run.
- 2026-09-24 — W4 independent composition review: Claude reviewed the local Codex/Claude delivery composition and approved it. Its non-blocking hardening note was applied: each composition snapshots its host-owned fixed binding at construction, rather than observing later changes to the caller's object. The added snapshot check, focused composition/bridge checks, and TypeScript check pass. Claude's review was read-only; Codex retains the execution evidence.
- 2026-09-24 — Plan adopted. Integration branch pushed. Nothing operational yet.
- 2026-09-24 — W3 host-mode foundation: the launcher now recognizes the `mac-local` choice and accepts only the existing shared planning, approval, queue, result, and review components plus at least one local worker. It rejects the remote-only listener, session, evidence, HTTPS, and remote-worker components. Five launcher tests and the full TypeScript check pass. This is a configuration guard only: it does not load protected configuration, contact the database, start the website, or start a worker. Next in W3: the protected local configuration loader and the owner-trusted worker enablement record.
- 2026-09-24 — W3 enablement foundation: a protected, data-only record now defines the local node as `mac-1` and pins each enabled Codex, Hermes, or Claude executable to its recorded version. Startup can verify that record through a narrow injected version reader; a missing executable, changed version, malformed path, duplicate worker, or non-Mac node is refused. It grants no task execution, does not read a real executable, and does not start a worker. Three focused tests and the TypeScript check pass. Next: wire this record through the protected configuration loader and the existing task-host admission path.
- 2026-09-24 — W3 architecture decision, reviewed by Claude: the existing agent-task startup validator must remain unchanged because it protects the remote installation path. The Mac build will instead add a separate `mac-local` bootstrap that first verifies the owner-trusted local-worker record, then reuses the existing database, queue, task, result, and review services. The first attempt to extract the existing database checks showed that the legacy fixture has an unrelated failing startup baseline, so no refactor was retained. Next: implement the new Mac-only bootstrap against focused tests, without weakening the legacy host.
- 2026-09-24 — W2 sign-in foundation: a loopback-only owner-session component now checks an owner code hash, rejects forwarded or foreign-origin requests, rate-limits bad codes, and issues only short-lived HTTP-only SameSite-Strict local cookies. Its focused checks and TypeScript check pass. It is intentionally not attached to the shared hosted web handler yet: an attempted generic authentication injection would have weakened that handler, so the next package is a dedicated Mac-only web wrapper with its own fixed authentication seam.
- 2026-09-24 — W2 Mac-local wrapper: a dedicated local web composition now uses that fixed loopback sign-in path and the existing project service/session/grant checks. It does not alter the Cloudflare web process. Disposable checks prove a correct local sign-in reaches the existing project route, while no session, forwarded requests, foreign origins, and a hosted origin are refused. This is the first real local website slice; task, review, correction, and worker routes still need to be added before it is an operational Control Room website.
- 2026-09-24 — W2 local listener foundation: the Mac-local composition can now be assembled into an inert loopback-only listener that is explicitly started later. It permits local cookies only on `127.0.0.1`, rejects a hosted origin at construction, and has no automatic listener, credential, database, or environment effect. Eight focused local-sign-in/service checks and the TypeScript check pass. It still is not connected to the protected configuration loader or the full project/task website journey.
- 2026-09-24 — W2 project/task journey: the dedicated Mac-local wrapper now routes a signed-in local owner through the existing project and task HTTP services. The focused journey proves sign-in, project creation, task listing, and task proposal; it also retains refusal of forwarded or foreign requests. The broader local and hosted-route regression set (25 checks) and TypeScript check pass. No local listener, database connection, worker, credential, or service was started. The required external Claude review could not be dispatched by this environment because it would send source code to an outside service without a separate data-sharing authorization; that pending review is recorded in `OWNER_ACTIONS.md`. Next: W3's protected local configuration loader and host composition.
- 2026-09-24 — W1 read-only database check: a Mac-side checker now accepts only a protected JSON configuration and protected per-role password files, validates every connection setting, checks the connected login, performs a harmless read, and compares the recorded migration ledger. It never writes a password or database value to output. Four focused checks and the full TypeScript check pass. The web result is explicitly labelled as generic: its full website-permission check remains part of W3. It does not contact a real database during tests or create any database state.
- 2026-09-24 — W4 Codex text adapter foundation: the local Codex adapter reuses the installed CLI with fixed read-only, ephemeral arguments; an empty task directory; a small environment allowlist; bounded input/output; and a detached process group. It returns only a completed text message and bounded usage, or an explicit failed/canceled/timed-out result. Six focused checks prove fixed arguments, no environment leak, refusal before spawn, malformed-output refusal, prompt cancellation, and TERM-to-KILL cleanup. It is not connected to the canonical queue yet and cannot start real Control Room work.
- 2026-09-24 — W3 protected configuration foundation: one exact, data-only Mac-local configuration now binds the loopback website port, owner session profile, VPS database profile, workspace, and pinned local-worker enablement record. It refuses a foreign origin, changed port, unpinned worker, and extra fields before any database, listener, or worker effect can occur. Two focused checks and the full TypeScript check pass. The next W3 piece is a fixed file loader and startup composition; this package alone does not read protected files or launch Control Room.
- 2026-09-24 — W3 protected file loader: the Mac-local configuration can now be loaded only from one absolute, non-symlinked, owner-only JSON file. Relative paths, loose permissions, malformed JSON, and invalid fields are refused. Four focused configuration checks and the full TypeScript check pass. The loader is inert: it does not use environment fallback, open PostgreSQL, start a listener, or launch a worker.
- 2026-09-24 — W3 startup bridge: a Mac-only startup seam now verifies every pinned local worker before opening the shared authority database, then starts the assembled application once. Focused checks prove that a changed worker version prevents database use and that shutdown is safe before or after startup. It is still an injected composition test, not a live database or website launch.
- 2026-09-24 — W2 security correction and Claude review: Claude found that write requests from another local port were not explicitly refused. The three local HTTP handlers now require the exact selected loopback origin for every write, reject mixed local-plus-hosted authentication configuration, and retain the hosted HTTPS path unchanged. The focused route suite has 25 passing checks, TypeScript passes, and Claude's tool-free review approved the correction. Nothing was started or exposed.
- 2026-09-24 — W4 Hermes local-lifecycle assembly: the protected Mac host now has one narrow composition seam that attaches the existing owner-runner Hermes queue bridge to the existing Mac-local task lifecycle. It does not open a database, start the queue, or invoke Hermes on construction; the existing queue executor remains responsible for the durable receipt, immediate authority recheck, staged result, and review publication. Focused composition checks prove the callback is attached only through that bridge and a caller cannot substitute a second Hermes callback. Next: supply the protected controller/results/queue-worker role composition and invoke this seam from the real Mac-local launcher.
- 2026-09-24 — W3 restricted lifecycle composition: the Mac-local startup path now has a source-only factory that opens only the existing restricted coordinator and result roles, while leaving the loopback website's web role with its host. It validates that all roles remain on the one authority database and cannot share a client, then constructs the existing planning/review/correction lifecycle. It starts neither the pg-boss worker nor Hermes. Focused disposable-role checks prove role ownership and shutdown behavior. Next: supply the task configuration and existing queue-worker creation from the protected launcher; that is the final source assembly before an owner-attended real task.
- 2026-09-24 — W3/W4 protected queue-host handoff: once the protected Mac host has verified pinned executables, opened the owner-separated role connections, and made the loopback website ready, it can now start the existing pg-boss worker with the task lifecycle's existing queue-delivery and recovery operations. It uses the fixed queue-worker role and closes the worker before the website and its owned controller resources. It adds no scheduler, message broker, database, or delivery protocol. Fourteen focused host, role, and Hermes-composition checks plus the TypeScript check pass. The remaining live-path work is the protected launcher that supplies real task configuration and the already-reviewed Hermes runner to this host; no service or agent was started here.
- 2026-09-24 — W3/W4 local Hermes launcher seam: the protected launcher can now request one existing composition that combines the separate coordinator/results roles with the owner-runner Hermes queue bridge. It reuses the shared task lifecycle and queue-delivery slot, and construction starts neither the queue nor Hermes. A disposable-role composition check proves the returned lifecycle has the existing queue delivery handle and retains no second execution mechanism. Next: give this seam the protected real task configuration in the Mac launcher, then run the first owner-attended harmless Hermes task.
- 2026-09-24 — W4 local Claude lifecycle seam: the protected launcher can now attach an already-qualified, bounded text-only Claude delivery capability to the same restricted Mac task lifecycle and shared queue path as Hermes. It creates no Claude process, tools, permission, queue, or separate result authority. Focused disposable-role tests prove the callback is attached without starting a queue or Claude. Next: supply the real protected Claude capability from the launcher alongside Hermes.
- 2026-09-24 — W4 current local Hermes runner composition: the three-agent
  Mac task lifecycle now uses the existing fixed local Hermes subprocess
  executor, rather than the superseded owner-admission/runner handoff. The
  executor retains the established durable queue receipt, final authority
  recheck, result publication, and restart-recovery path. The composition
  explicitly refuses the old runner/admission fields, so it cannot accidentally
  create a second execution-custody route. Three focused composition checks and
  the TypeScript check pass. This is source-only: it does not start Hermes,
  contact the database, or deliver a real task. Next: assemble the protected
  runtime provider that supplies the fixed Hermes, Claude, and Codex inputs.
- 2026-09-24 — W4 Hermes text-only policy correction: a live read-only check
  against the updated installed Hermes CLI confirmed that `--toolsets` is an
  enable list. The local Control Room runner now passes an explicit empty
  toolset, rather than naming `bot_room`; it also skips injected rules. This
  prevents inherited Hermes tools from becoming part of the first text-only
  Control Room capability. The installed CLI accepted the fixed no-tools form,
  and 18 focused Hermes/three-agent checks plus the TypeScript check pass. No
  Control Room task, database operation, or service was started.
  Marvin independently reviewed the sanitized correction diff through the
  updated Hermes route and returned `VERDICT: APPROVE`.
