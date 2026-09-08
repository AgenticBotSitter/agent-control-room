# F6 supervisor and update fit comparison

2026-09-08; A1/B4/B6/D3. Source/configuration evidence, not an installer or
native service qualification. No service registered, started, stopped or killed.

## Current product reality

`scripts/run-private-node.mjs` runs **one explicit Hermes task**, initial or recover,
with 300-second lifetime, signal cancellation and bounded cleanup. It prints no
automatic retry after uncertainty; it is not a daemon. `native-connector.ts` permits
one run, bounded cycles and closes runtime/host before completion. A supervisor
restarting this command is not continuous productive fleet orchestration.

`src/node-bridge/journal.ts` retains bridge frames/attempt identity with SQLite WAL,
synchronous FULL and pending-frame ceilings. Native run journal stores complementary
execution evidence. Persistent state must be outside immutable release directories;
supervisor logs are not replacements. Never erase journals to make restart succeed.

`packages/control-room-node-service/{linux,macos,windows}` deliberately contains
NON-INSTALLABLE historical references to absent continuous `node-service.js`.
`src/node-service-packaging/v1/conformance.ts` rejects substitution of the one-task
launcher and restart policies. Its diagnostics say continuous_service_not_available.
This is honest negative readiness, not three ready installers.

`deploy/control-room-website.service.in` is separate: conditional website-only
systemd template, explicit immutable Node/release/settings, unprivileged user,
Restart=no, SIGTERM/control-group,45-second stop budget. `Type=exec` is not HTTP
readiness. `deploy/SUPERVISION.md` correctly demands actual container/supervisor
namespace, database/tunnel reachability and measured memory limit first.

## WinSW source, not README inference

Pinned [v2.12.0, eef5bade59fca0254e387ac73ed7625ba6aa7147](https://github.com/winsw/winsw/tree/eef5bade59fca0254e387ac73ed7625ba6aa7147).
Stable 2.x behavior baseline, not latest security certification. Do not mix v3
prerelease documentation into this pin. Root MIT license read; full distributed
.NET/native dependency notices remain unreviewed.

- `src/WinSW.Core/Configuration/XmlServiceConfig.cs` parses executable, arguments,
  workingdirectory, environment expansion, serviceaccount and stop timeout. The
  optional `<argument>` list overrides `<arguments>`. Quoting and environment
  expansion must be tested with Windows paths containing spaces; don't put secrets
  in arguments or service XML. Serviceaccount permits username/password config,
  which is not authority to acquire or store the owner's credentials here.
- FailureActions parses explicit `restart`, `none`, `reboot`; invalid actions throw.
  Our initial/recover one-shot must never get restart-on-failure merely because
  Windows supports it. Runtime recovery decision belongs to application journal
  reconciliation, not an OS exit-code policy.
- `WrapperService.cs::DoStop` normally calls `ProcessHelper.StopProcessTree`.
  Optional stop arguments launch another configured stop process; that path is
  not needed without an accepted native drain endpoint. On unexpected process
  completion wrapper passes exit code to SCM; zero reports stopped, otherwise
  SCM failure actions can restart. Thus scheduling/recovery policy must be explicit.
- `ProcessHelper.cs::StopProcessTree` recursively enumerates children, attempts
  Ctrl-C or CloseMainWindow, waits per process then kills. This inspected stop
  routine is **not proof of kill-on-close Job Object containment**, escaped-child
  control or bounded whole-tree shutdown; a per-process wait can multiply with
  number of descendants. Forced exit is not signed cleanup evidence.
- `ServiceDescriptorTests.cs` includes working-directory, arguments, stop timeout
  and failure-reset parser tests. Inspected, not run (.NET absent). Selected
  `ProcessHelperTest.cs` environment test calls Assert.Ignore; don't cite its
  presence as passing native stop coverage. No C# parser/module executed.

WinSW fits a true dedicated-account unattended service. It does not turn an
interactive owner desktop/profile into service context. Windows services cannot
directly interact with users and run in session0; see [Microsoft service model](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services).
Selected process-start code uses UseShellExecute=false; it does not establish
successful provider-profile loading. Test separately, don't assert every private
authentication mechanism must fail or would automatically work.

## Task Scheduler versus WinSW

Task Scheduler implementation is not open-source in this comparison. Its official
API/schema is available; no source-equivalence claim or Windows runtime claim.
[TASK_LOGON_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)
documents InteractiveToken requires an already logged-in user; S4U runs a
noninteractive desktop without network/encrypted-file access; password mode requires
credentials at registration. Therefore S4U is not a free substitute for the current
networked authenticated connector. InteractiveToken is a credible candidate for an
owner's existing desktop session, not an always-on logged-out service.

[MultipleInstancesPolicy](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element)
offers IgnoreNew/Queue/Parallel/StopExisting. IgnoreNew prevents overlapping instances
of that registered task, not native effect duplication or a second registration.
Avoid Parallel/StopExisting for current explicit attempt. OS schedule is startup
mechanism only, not Control Room job dispatch. No login password XML prepared.

| Deployment responsibility | Best current source fit | Why / remaining check |
| --- | --- | --- |
| VPS website | Existing supervisor; conditional systemd if actually present in right namespace | No added process manager; native namespace/config/stop/readiness acceptance pending |
| Linux future node service | systemd user/service as actual deployment requires | Native supervisor desirable; continuous runtime/journal restart first, no direct one-shot substitution |
| Mac personal agent | launchd LaunchAgent Aqua context | Matches historical desktop requirement; owner-attended credential/native gates still required, not a LaunchDaemon workaround |
| Windows personal logged-in agent | Task Scheduler InteractiveToken candidate | Matches user session, no service-account migration; logout/sleep/restart/stop behavior untested |
| Windows dedicated unattended agent | WinSW dedicated-account candidate | Appropriate SCM wrapper, but profile/custody and Job Object requirement not satisfied by XML/tree kill alone |

WinSW and Task Scheduler serve distinct contexts; don't declare one universally
better. No viable Windows finalist has E2/E3 native evidence yet. Native Task Scheduler
has zero new wrapper dependency; WinSW adds one executable/config plus .NET/runtime
compatibility and notices. Both retain our connector, approvals and journals.
No credible calendar/RSS comparison yet. Production lines removed:0. Replacing the
historical non-installable template with a qualified package is not deleting custom
execution infrastructure. Do not build a bespoke supervisor.

## Executed checks and limitations

`node --import tsx --test tests/node-service-packaging.test.ts`: **4/4 pass**,
no failures/skips; actual current diagnostic/conformance code executes. This proves
static refusal and package text requirements only, not source compatibility of a
new WinSW release or installation readiness.

`xmllint --noout --nonet` on existing Mac plist and Windows XML: exit0, both well-formed.
This does **not** execute WinSW parser, validate launchd policy or Task Scheduler
schema, resolve placeholders, create valid identity/config, or certify a service.
No external DTD fetch. No new native code or toolchain installed.

## Implementation and target qualification packet

1. First finish actual continuous connector lifecycle: eligible pickup, drain,
   cancel/uncertain settlement, reconnect without resubmission, schema/version
   compatibility and exclusive persistent journal ownership. Retain current explicit
   one-task launcher as manual acceptance/recovery path.
2. Build immutable release plus explicit reviewed runtime/config/state/log layout.
   Quote arguments separately and keep credentials outside wrapper XML/unit/plist.
   Persist journals outside release so changing version does not lose attempt state.
3. On authorized disposable Windows user profile compare Task Scheduler user-context
   and WinSW dedicated account using inert child trees and synthetic persistent
   journals. Verify startup identity/profile, duplicate trigger, logout/lock/sleep,
   stop while child spawns, forced kill, wrong journal owner, and reboot recovery.
   No real provider credential qualification follows from fixture success.
4. Prove required Windows Job Object containment separately; do not downgrade contract
   to tree enumeration. Need actual native build/host and independent review before
   a service wrapper can be accepted. Mac launchd and Linux systemd each need their
   own installed-platform validation, not claims extrapolated from this Mac XML check.
5. Updates: drain only Control Room, prevent new pickup, retain journal/leases and
   uncertain attempts, stop owned process, point supervisor at separate approved
   release, start once, observe protected readiness. First website handoff permits
   maintenance downtime, not two-writer rolling deployment. Rollback only to schema
   compatible release; never reset journal/DB or restart initial attempt automatically.

Local comparison still lacks continuous runtime/packaging parity and per-platform
native acceptance. These open items must remain visible in implementation plan.
