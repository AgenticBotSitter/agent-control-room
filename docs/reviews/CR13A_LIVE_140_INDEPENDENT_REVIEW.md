# CR13A-LIVE-140 Independent Review Report

**Disposition: `rejected` — review protocol incomplete**

The product was not rejected for a confirmed High, Medium, or Low defect. The review is rejected because the first
out-of-tree hostile-matrix invocation was unavailable and exited before loading the product. The packet requires
immediate stop, cleanup, and rejection without retry or substitution in that circumstance.

## Reviewer and immutable identity

- Reviewer: Codex task `/root/cr13a_live140_independent_review`
- Role: different independent, report-only, zero-repair reviewer
- Model/effort: `gpt-5.6-sol`, `xhigh`
- Product target: `6e716bd77c26ad7f70343ddd687dff990f5db12f`
- Product tree: `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
- Design parent: `154231858828603d167c12371863bc0562f2e795`
- Stacked LIVE-130 base: `e620b7bc24760a8f8f0034db6cda3d60e74763a8`
- Packet SHA-256 expected: `755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`
- Packet SHA-256 observed: `755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`
- Clone state: fresh local-only clone, explicitly checked out with `--detach`
- Initial tracked status: clean
- Final tracked status: not collected after the mandatory stop; therefore the final-status acceptance requirement is unmet
- Product repairs or mutations: none
- Authoritative-checkout writes: none

The design-parent diff contained exactly the four packet-declared paths:

- `package.json`
- `src/connection-registry/v1/index.ts`
- `src/connection-registry/v1/private-loopback-target-runtime-attestation.ts`
- `tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts`

## Fixed command results

All eleven fixed commands ran once, in the prescribed order, before the hostile-probe stop.

| # | Exact command | Exit | Result |
|---:|---|---:|---|
| 1 | `git status --short` | 0 | Clean; no output |
| 2 | `git rev-parse HEAD` | 0 | Exact target `6e716bd77c26ad7f70343ddd687dff990f5db12f` |
| 3 | `git rev-parse HEAD^{tree}` | 0 | Exact tree `4010bdaa5fd90f486d7ccad6185a2116dd9345af` |
| 4 | `git diff --check 154231858828603d167c12371863bc0562f2e795..6e716bd77c26ad7f70343ddd687dff990f5db12f` | 0 | Pass; no whitespace errors |
| 5 | `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; `tsx` and `zod` resolved |
| 6 | `npm run check` | 0 | TypeScript pass |
| 7 | `npm run lint` | 0 | ESLint pass |
| 8 | `node --import tsx --test tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts` | 0 | 9 passed, 0 failed, 0 skipped |
| 9 | `npm run build` | 0 | All 5 build phases passed |
| 10 | `node --test tests/rendered-html.test.mjs` | 0 | 4 passed, 0 failed, 0 skipped |
| 11 | `node --import tsx scripts/verify-migrations.ts` | 0 | Migrations `0001`–`0036` applied; 119 PostgreSQL tables verified |

No connection suite, CR13A suite, `test`, `pretest`, `posttest`, dynamic test list, `pnpm`, `npx`, `tsx` executable,
or executable/version probe was run.

## Mandatory-stop evidence

The single planned out-of-tree matrix invocation was:

```text
node --import tsx /private/tmp/cr13a-live-140-review.3IIfOs/hostile-matrix.ts
```

It exited `1` before evaluating the probe or importing either repository module:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /private/tmp/cr13a-live-140-review.3IIfOs/
```

Consequences:

- Product hostile cases executed: `0`
- Replacement functions executed: `0`
- Product modules imported by this failed probe: `0`
- Listener or IPC attempt from the failure: `0`
- Retry: none
- Substitution: none
- Repair: none

Under the packet's stop rule, no corrected invocation or alternate launcher was attempted.

## Findings

| Severity | Count | Stable IDs | Evidence | Impact | Remediation |
|---|---:|---|---|---|---|
| High | 0 | — | No High product defect confirmed before the mandatory stop | — | — |
| Medium | 0 | — | No Medium product defect confirmed before the mandatory stop | — | — |
| Low | 0 | — | No Low product defect confirmed before the mandatory stop | — | — |

Separate unscored review blocker:

| ID | Evidence | Impact | Required resolution |
|---|---|---|---|
| `CR13A-LIVE-140-REVIEW-P-001` | Out-of-tree hostile launcher exited with `ERR_MODULE_NOT_FOUND` before product import | All twelve hostile groups lack complete independent execution evidence; acceptance is forbidden despite green fixed gates | Freeze a fresh review protocol with an explicitly authorized, prevalidated out-of-tree probe invocation and appoint a fresh different reviewer. Do not change this immutable product based solely on this protocol failure. |

## Twelve hostile groups

| Group | Evidence completed | Status |
|---:|---|---|
| 1 | Static implementation and dedicated tests confirmed exact LIVE-130 commit/tree and accepted LIVE-120 driver commit | Partial; independent substitution matrix did not execute |
| 2 | Dedicated tests rejected copies, accessors, symbols, and Proxies with zero hostile behavior | Partial; alternate-prototype, re-digest, thenable, and borrowed-value matrix did not execute |
| 3 | Dedicated tests confirmed exact two-architecture policy, fourteen ordered claims, and frozen collections | Partial; duplicate/removal/relabel matrix did not execute |
| 4 | Dedicated tests replaced captured `Object.isFrozen`, `WeakSet.has`, `WeakMap.get`, and `Reflect.apply` with zero replacement calls | Partial; exhaustive ambient-replacement matrix did not execute |
| 5 | Static review and tests confirmed frozen callable/class/prototype surfaces | Partial; subclass, malicious-new-target, receiver, and `call`/`apply`/`bind` matrix did not execute |
| 6 | Dedicated tests confirmed all tested observation/effect truth false, blocker retained, and nine recorded counts zero | Partial; independent exhaustive truth matrix did not execute |
| 7 | Exact-provenance parsers and fake-only result were statically inspected | Partial; explicit fake-to-real, digest, lifetime, blocker, and authority relabel matrix did not execute |
| 8 | Dedicated sanitation test passed with fixed safe errors and no prohibited values in serialized public records | Partial; expanded host-value and stable-transform injection matrix did not execute |
| 9 | Targeted static inspection found no physical-driver import in the new module, dedicated test, safe barrel, render test, or migration verifier; the new module directly imports only shared security helpers | Partial; mandatory stop prevented completion of the full import/initialization review |
| 10 | Dedicated test scanned source consumers and found only the safe connection-registry barrel; build and all four render checks passed | Partial because the complete packet review was interrupted |
| 11 | The dedicated test's issuer/source patterns passed | Partial; the packet's complete issuer-term search was not finished after the stop |
| 12 | Fixed repository fake recorded zero observations/effects and dedicated hostile behavior remained zero | Incomplete; the independent hostile matrix executed zero cases |

Complete twelve-group coverage is therefore **not established**.

## Exact effect and replacement counts

| Measure | Count |
|---|---:|
| Planned hostile-matrix command invocations | 1 |
| Product hostile attempts executed by that matrix | 0 |
| Hostile behaviors executed | 0 |
| Ambient replacement attempts executed by that matrix | 0 |
| Ambient replacement functions executed | 0 |
| Protected-value exposures | 0 |
| Target-runtime host observations | 0 |
| Physical-driver imports | 0 |
| Native backend constructions | 0 |
| Capability objects issued | 0 |
| Admissions issued | 0 |
| Candidates assembled | 0 |
| Owner spends | 0 |
| Physical listener attempts | 0 |
| IPC listener attempts | 0 |
| Socket attempts | 0 |
| Port attempts/selections | 0 |
| Network-I/O events | 0 |
| External effects | 0 |

The repository fake's own exact counters were also observed as:

- `hostObservationAttempts: 0`
- `platformSignerCalls: 0`
- `nativeBackendConstructions: 0`
- `listenerAttemptsMade: 0`
- `ipcListenerAttemptsMade: 0`
- `socketAttemptsMade: 0`
- `portSelectionsMade: 0`
- `networkIoEventsObserved: 0`
- `protectedValuesRead: 0`
- `externalEffectOccurred: false`

## Protocol and cleanup

- Repairs: `0`
- Installs: `0`
- Downloads: `0`
- Network contacts: `0`
- Retries after failure: `0`
- Substitutions after failure: `0`
- Physical native-driver imports or runs: `0`
- Production, provider, Hermes, SSH, credential, DNS, deployment, or hosting effects: `0`
- Static inspection commands were bounded to the packet, changed paths, fixed dynamic files, import boundary, and
  consumer boundary; no dynamic package/version exploration occurred.

Disposable root:

```text
/private/tmp/cr13a-live-140-review.3IIfOs
```

Cleanup command exited `0`. The subsequent exact absence check
`test ! -e /private/tmp/cr13a-live-140-review.3IIfOs` also exited `0`. The disposable clone and hostile probe were
removed and are no longer present at that path.

## Final disposition

`rejected`

Reason: incomplete independent hostile coverage caused by the mandatory-stop condition
`CR13A-LIVE-140-REVIEW-P-001`. This report does not establish a product defect, perform or accept a real target-runtime
attestation, clear `target_runtime_attestation_missing`, or grant candidate, owner, native, network, SSH, credential,
provider, production, deployment, DNS, or hosting authority.
