# CR14C optional human result verification

2026-09-05. Repository integration, not deployed operation.

## Delivered

The protected task-result page can show explicitly configured human checks for an exact returned
document. The owner reads the configured instructions and records passed, failed, blocked or
inconclusive with an observation note. Only the note fingerprint is retained server-side, not its text.
No human check is configured by default and this is not a required owner stop on every agent task.
It does not replace automated or independent-agent verification.

The authenticated route, startup configuration, browser controls and task-page memory are connected.
Saved evidence uses the existing immutable Completion Gate records and checkpoint protection, not a
parallel approval table. The server binds current actor/project/job/artifact/target/content/profile and
scenario; browser success requires the exact receipt, including the canonical note digest. A lost reply
retains the exact pending draft for explicit reconciliation. Reading, refreshing or reconnecting never
resubmits a write. Closing a result or temporarily losing read access does not discard pending input;
protected content is removed from display. Reloading/leaving the task page discards its memory.

Where a profile explicitly permits the configured human scenario, an accepted quality review plus a
passing check can make the existing Completion Gate ready. Tests verify the canonical job still stays
leased: this is quality evidence, not a fabricated completed job or permission for an external effect.

## Frozen product and independent review

Product `3e25462d729982b4c5f38cf80773630304eb1b3c`, tree
`0514215d26480dc83ebdbab5b369553e6ad2baf6`, was independently reviewed with no remaining actionable
findings. The reviewer ran67 checks plus disposable restricted-role and Unicode-size probes. Later
changes through `0c0d883bbabf7656922970282d846a6dbcdaa7b9` add only tests and suite registration;
production files are unchanged. Root retained architecture/service/SQL/integration ownership; separate
Sol High UI and Astra High test lanes worked in isolated local checkouts, with a separate reviewer.

Two real integration findings were corrected before acceptance:

- The first service used a job row lock unavailable to the restricted web role. An independent probe
  observed permission denial. The corrected evidence-only read follows the existing owner-review
  pattern without a job update grant. It cannot change canonical job state; a future completion
  transaction must independently validate its current state and authority.
- Valid50-scenario Unicode instructions exceeded the original131KiB browser reader limit. A
  schema-valid311KB response was rejected. The corrected1MiB cap admits all bounded descriptor
  configurations, and a regression proves immediate cancellation/refusal above that limit.

Root also found the existing private SQL trigger prohibited every verification record. Additive
migration0053 permits only the intended human evidence shape, retains review/finding restrictions,
and still denies agent claims, invalid outcomes, true authority flags, profiles/targets/revisions and
approval records. No SQL grants are added. The exact schema digest was regenerated from all53
migrations; there are still138 tables. Existing0052 rehearsal declarations are intentionally outdated
for this candidate, not silently accepted.

The test author initially hit the append-only trigger while constructing a privileged-corruption
fixture. The corrected test first proves that protection, then uses the existing disposable privileged
tamper pattern. This was a fixture correction, not a successful attempt to mutate real stored history.

## Evidence

- Stage zero: ready_for_runtime_check using the frozen lockfile and already installed dependencies.
- Independent service/browser/SQL/review/checkpoint suite:67 passed.
- Test lane:28 passed, including actual restricted-account HTTP201, exact replay200, history read,
  revocation401, cross-origin rejection and prohibited SQL writes.
- UI lane:12 passed, including exact matching, held uncertain input, Unicode limits and mounting.
- Both production builds passed; private compiled checks18, rendered checks4, migrations0053/138,
  whole-repository TypeScript and ESLint passed at the unchanged production product.
- Root final combined verification suite:40 passed. Final CR14C suite:591 passed at the full test
  revision `0c0d883`; preparation770 passed, main1135 passed with two existing platform skips,
  post-suite392 passed. The first broader CR14C run passed585 before the six test-only additions;
  the final rerun includes all additions. Final no-incremental TypeScript, scoped test lint and diff
  checks passed. Every observed test/build process completed; no pending run is counted as a pass.

All database evidence is disposable PGlite/injected SQL. No real PostgreSQL service, native/provider
call, credential access, host service, deployment, DNS change or fleet activation occurred.

## Next

Keep Astra Medium for lead integration; use bounded implementation/test lanes in parallel. Complete
the trusted automatic verification path, coordinated native job/attempt completion and bounded revision
submission without translating native results into incompatible legacy events. Runtime registration,
physical artifact transport, reconnect/recovery, owner signing, production resource composition and
first real-host acceptance remain separate unfinished work. The existing three-host setup guides are
preparation instructions, not evidence of installed or running agents.
