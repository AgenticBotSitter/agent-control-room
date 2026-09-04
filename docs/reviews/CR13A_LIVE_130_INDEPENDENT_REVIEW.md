# CR13A-LIVE-130 independent review report

**Disposition:** `rejected/invalid`
**Date:** 2026-09-03
**Reviewer:** Codex independent reviewer `/root/cr13a_live130_independent_review`
**Mode:** different-agent, report-only, zero-repair review
**Independence:** I did not produce the target, modify it, repair it, merge it, or write this report into the repository.

## Immutable identity

| Item | Observed value | Status |
|---|---|---|
| Product commit | `339c2e8a61e7c2ac0a40fc6f51711a512badbf6c` | Exact match |
| Product tree | `06b57cdcec6f139a407d1475e3171ce3798ad64d` | Exact match |
| Design parent | `aa5284ba1bba34d1d24ece90cedfd1160c45b0b7` | Exact match |
| Checkout state | Detached HEAD | Confirmed |
| Initial checkout status | Empty `git status --short` | Clean |
| Controlling packet SHA-256 | `ab8a46c8b34fb4a3ca6cb1908fc5d8d8ac93fcc0016b417a1a944853e1324b0e` | Exact match |

The target contained exactly the four declared changed paths:

- `package.json`
- `src/connection-registry/v1/index.ts`
- `src/connection-registry/v1/private-loopback-physical-qualification-readiness.ts`
- `tests/connection-enrollment-private-loopback-physical-qualification-readiness.test.ts`

`git diff --check` against the design parent exited 0.

## Invalidating incident

Before the hostile matrix, a reviewer-side dependency check mistakenly invoked:

```text
./node_modules/.bin/tsx --version
```

The CLI attempted to create its temporary Unix-domain IPC listener. The sandbox denied the call with `EPERM` before
binding, and the command exited 1.

This was not a product/native-driver action and produced no successful listener, network I/O, external contact, or
repository mutation. It nevertheless constitutes one forbidden listener attempt under the review boundary. The run
therefore cannot truthfully assert the required zero-attempt condition and cannot yield acceptance evidence.

The controlling reviewer stopped the review immediately after this was reported. No further tests, probes, build,
migration, or product-inspection commands ran after that stop, apart from exact cleanup and absence/status checks.

## Packet-control finding

| Severity | Stable ID | Scope | Evidence | Impact | Required remediation |
|---|---|---|---|---|---|
| Medium | `CR13A-LIVE-130-PACKET-M-001` | Controlling review packet | The packet forbids importing or running the LIVE-120 physical driver. However, `test:cr13a-physical-qualification-readiness`, `test:cr13a-connections`, `test:cr13a`, and the `npm test` posttest registration include `tests/connection-enrollment-private-loopback-physical-native-driver.test.ts`. That test directly imports `private-loopback-physical-native-driver.ts`. | A reviewer cannot simultaneously obey the no-import boundary and execute all mandatory reproduction commands. The procedure is internally inconsistent and cannot support an unambiguous zero-effect acceptance claim. | Freeze a corrected immutable packet with readiness-only test commands that do not import the physical driver, then appoint a fresh independent reviewer. No target repair is authorized or implied. |

Finding counts:

- High: **0**
- Medium: **1**
- Low: **0**

No product-code finding was concluded before the mandatory stop. That absence is not a product pass because the review
was incomplete.

## Commands and gates

| Gate | Result |
|---|---|
| Fresh local-only clone under `/private/tmp` | Pass |
| Detached checkout of exact target | Pass |
| Clean initial `git status --short` | Pass |
| Exact HEAD | Pass |
| Exact tree | Pass |
| Design-parent diff check | Pass, exit 0 |
| macOS stage zero | Pass, exit 0; `ready_for_runtime_check` |
| TypeScript `--noEmit` | Pass, exit 0 |
| Full ESLint gate | Pass, exit 0 |
| Dedicated readiness test command | Not run—unsafe contradiction and stop order |
| Connection gate | Not run—unsafe contradiction and stop order |
| Combined CR13A gate | Not run—unsafe contradiction and stop order |
| Complete `npm test` lifecycle | Not run—unsafe contradiction and stop order |
| Production build/render gate | Not run—stop order |
| Listener-free migration verifier | Not run—stop order |

An earlier non-conforming stage-zero invocation using `darwin` instead of the repository's required `macos` enum
exited 1 with `invalid_arguments`; it performed no readiness or native work. The correctly parameterized stage-zero
command subsequently passed.

Packet-gate totals:

- Passed: **7**
- Failed packet gates: **0**
- Not run: **6**
- Test cases executed: **0 passed, 0 failed, 0 skipped**

Prepared dependencies were copied locally from the authoritative checkout into the disposable clone. No install or
download occurred.

## Hostile attack coverage

| Group | Coverage |
|---|---|
| 1. Exact LIVE-120 identity binding | Partial static inspection only |
| 2. Singleton/digest provenance attacks | Partial static inspection only |
| 3. Twelve blockers and eight-stage immutability/order | Partial static inspection only |
| 4. Ambient intrinsic replacement | Partial static inspection only |
| 5. Callable decoration/prototype/subclass attacks | Partial static inspection only |
| 6. Missing-prerequisite, authority, retry, and count truth | Partial static inspection only |
| 7. Future-ceiling relabeling | Partial static inspection only |
| 8. Public/error sanitation | Partial static inspection only |
| 9. Hidden imports and initialization behavior | Partial static inspection; packet contradiction found |
| 10. Runtime/UI/worker/service consumer search | Partial source search only |
| 11. Provider/proof/capability/candidate/activation issuer search | Partial target-diff inspection only |
| 12. Exact zero observations | Failed at review-process level because of one denied IPC-listener attempt |

No out-of-tree hostile probe was created. None required removal.

## Effect and authority counts

| Observation | Count |
|---|---:|
| Hostile replacement executions | 0 |
| Protected-byte exposures | 0 |
| Native backend constructions | 0 |
| Physical-driver imports or executions by this review | 0 |
| Qualification candidates assembled | 0 |
| Bind capabilities issued | 0 |
| Connection admissions issued | 0 |
| Owner authorizations spent | 0 |
| Physical listener/socket/port attempts | 0 |
| Reviewer-side IPC listener attempts | **1 denied** |
| Successful listener bindings | 0 |
| Successful socket/port operations | 0 |
| Network I/O observations | 0 |
| External contacts | 0 |
| External effects completed | 0 |
| Installs | 0 |
| Downloads | 0 |
| Target repairs or mutations | 0 |

## Cleanup

Disposable review root:

```text
/private/tmp/cr13a-live130-review.1kkOav
```

It was removed completely. The explicit absence check exited 0. The authoritative checkout remained clean on
`codex/cr13a-live-130-qualification-candidate`.

## Final disposition

**`rejected/invalid`**

The target is not independently accepted by this run. The result is invalidated by the one denied reviewer-side IPC
listener attempt, the Medium packet-control contradiction, and incomplete mandatory command and hostile-attack
coverage. A fresh reviewer must start from a corrected immutable packet and a new disposable detached checkout.

This disposition grants no integration acceptance, clears none of the twelve blockers, and authorizes no candidate
assembly, owner window, physical attempt, runtime activation, network, SSH, credential, provider, production,
deployment, DNS, or hosting effect.
