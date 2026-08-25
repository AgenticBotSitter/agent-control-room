# CR5C9H macOS platform validation v3 — Hermes qualification report

## Header

| Field | Value |
|---|---|
| Issue / block | MarvinAi5/control-room #121 · CR-5C.9H |
| Worker | Hermes Agent (this session); host: macOS M4-class Mac mini, owner-attended |
| Harness | Control Room pinned qualification harnesses @ base `0480cc4`; Node ≥22.13 stock runtime; tsx module resolution; `/usr/bin/security` + Swift Security framework |
| Model route | unknown / not preserved: exact provider/model identity was not preserved for this report; this packet-required field is therefore **unmet**. Harness identity above is the load-bearing qualification record |
| Base commit | `0480cc4e4a54efd18a4152f2787b31b5a7da0de7` (verified ancestor of origin/main) |
| Branch | `worker/marvin/cr5c9h-macos-v3` (created from exact base after Phase 0+1) |
| Task class / risk | host qualification · owner-attended disposable Keychain effect |
| Allowed output path | `docs/hermes-reviews/CR5C9H_MACOS_PLATFORM_VALIDATION_V3.md` only |
| Disposable item | service `control-room.cr5c9h.macos.v3`, account `qualification.macos.v3` |
| Disposition | **partial/blocked** — preparation and readiness met; native qualification returned `unavailable_platform` (harness exit 1); exact disposable Keychain item owner-observed absent |

## Authorization ledger

| Requirement | Exact authority | Result |
|---|---|---|
| Output paths | one file: this report | complied |
| Authorized effects | stage zero ×1 (+1 rerun if setup); offline pnpm ×1; online pnpm fallback ×1 only on missing tarball; readiness ×1; branch creation; owner-only attended launch | complied — stage zero ran once (`ready_for_runtime_check`), no pnpm install of any kind was required or run, readiness ran once, branch created from exact base |
| Forbidden effects | no harness/source/policy edits, no Always Allow, no ACL change, no elevation/restart, no credential handling beyond approved git tooling, no worker-run attended launcher | none observed |
| Immutable inputs | base commit; SKILL.md; work-order/platform-validation references; checkout-prep + pinned-harness docs; five qualification scripts | unchanged |

Deviation note (disclosed, not self-cleared): two attended launches occurred instead of one. Launch 1 ended at the terminal confirmation stage with category `owner_confirmation_refused` — no native dialog, no Keychain effect. The issue then requested an owner/architect disposition. Later owner-posted evidence attests that one fresh attended launch was authorized before launch 2, but there is no separate pre-launch authorization comment in the GitHub timeline; this authorization is therefore labeled **owner-attested**, not independently recorded in sequence. It remains an ambiguity resolved by claimed owner authority, not proof of contemporaneous written authorization.

## Method and evidence

Adapter path: production macOS Keychain adapter invoked by `macos-attended-launcher.mjs` from an interactive attached Terminal by the owner; worker never ran the launcher, typed the confirmation phrase, or observed native dialogs directly.

| Step | Required result | Evidence class | Actual result | Status |
|---|---|---|---|---|
| Bootstrap fetch | exactly `git fetch --no-tags origin main` | observed | done; base reachable and ancestor of origin/main | pass |
| Duplicate sweep | no open claim/branch/PR for packet | observed | search: only issue #121 itself; branch 404 | pass |
| Stage zero | `ready_for_runtime_check` without running pnpm | observed | status `ready_for_runtime_check`, resolved tsx+zod, lockfile sha256 `48af0708…` | pass |
| Setup chain | skipped unless setup_required | inference | not triggered; online fallback never consumed | n/a (compliant) |
| Runtime readiness | `ready:true`, 8 checks | observed | all 8 pass (repo identity, node≥22.13, tsx policy v1, repo-owned harness, scratch parent rw, swiftc+Security present, single-JSON stdout); harness sha256 `0e3eef4c…`, helper sha256 `9c5a50a2…` | pass |
| Branch | created only after Phase 0+1 pass, from exact base | observed | `worker/marvin/cr5c9h-macos-v3` @ `0480cc4` | pass |
| Owner attendance | real owner at attached Mac | owner-observed | owner present at both launches | pass |
| Native key-store qualification | bounded JSON outcome | owner-observed | bounded JSON reports `harnessExitCode` 1 and category `unavailable_platform`; launcher shell process exited 0; committed launcher source intends to propagate 1. The shell-exit discrepancy is **unresolved** | blocked (native) |
| Prompt observation | matching live-item prompt, Allow/Allow Once only | owner-observed | matching prompt appeared twice; each required password entry plus Allow; owner chose Allow both times; Always Allow never selected. Timing relative to `CONTROL_ROOM_MACOS_ALLOW_ONCE_WINDOW` was not recorded, so strict prompt-window conformance is **unverified** | pass (attendance) / noted (behavior) |
| Item cleanup | exact disposable item absent afterward | owner-observed | `/usr/bin/security` read-only presence check: **absent**. Launcher JSON separately reports scratchCleanup `absent`, which is not evidence about the Keychain item | pass (item) |

### Native outcome detail

Launch 1 (superseded, kept in history): confirmation phrase mismatch →
`{"schema":"control-room.macos-attended-qualification-error/v1","category":"owner_confirmation_refused"}` — pre-dialog refusal, zero native effects.

Launch 2 (the one native attempt):
```json
{"schema":"control-room.macos-attended-qualification/v1","operatorBoundary":"interactive_attached_terminal","harnessExitCode":1,"harness":{"schema":"control-room.platform-key-store-qualification-error/v1","category":"unavailable_platform"},"scratchCleanup":"absent"}
```

Interpretation (inference): `unavailable_platform` indicates the qualification harness could not establish the platform key-store path it tests on this host — not that the owner declined or that the disposable item leaked. The double-prompt behavior (two password-gated dialogs for one item access) is reported as owner-observed behavior for architect review; whether it is expected for the fixture's ACL design is out of scope for this packet.

## Side-effect ledger

| Seq | Effect | Authorized by | Target | Created/changed | Cleanup | Final state |
|---|---|---|---|---|---|---|
| 1 | fetch origin main | issue bootstrap step | refs/remotes/origin/main | updated ref | none required | retained (normal git state) |
| 2 | stage-zero script run | Phase 0 | read-only checks + cache inspection | none persisted | none required | clean |
| 3 | readiness script run | Phase 1 | read-only checks | none persisted | none required | clean |
| 4 | branch creation | issue | `worker/marvin/cr5c9h-macos-v3` | branch ref | deleted post-PR per repo norms | retained until merge decision |
| 5 | native key-store attempt | Phase 2 (owner-run) | disposable generic-password item | transiently created by harness during launch 2 | item owner-observed absent via read-only check; scratch state launcher-reported only | item absent; scratch cleanup unverified independently |
| 6 | in-memory Ed25519 keypair | launcher design | memory only | never persisted | n/a | gone at process exit |
| 7 | scratch helper/directory | launcher design | launcher-owned scratch | compiled/created transiently | launcher JSON reports absent | absent |
| 8 | two issue comments (claim, OWNER ACTION REQUIRED) + owner evidence comments | issue workflow | issue #121 | posted | n/a | live |

No unauthorized effects observed. No package installs, no policy/ACL changes, no Always Allow selections, no elevation or restarts occurred.

## Cleanup proof

The single authorized disposable target (generic-password item, service/account as pinned) was checked after launch 2 via one read-only `/usr/bin/security find-generic-password` invocation scoped to the exact service+account: result **owner-observed absent**. No delete-generic-password was needed, so none was run. No broad globs used; no other Keychain items touched.

Separately, the launcher's bounded JSON reports `"scratchCleanup":"absent"` for its scratch state. That field is launcher-reported only; it is not evidence about the Keychain item, and the worker did not independently inspect the scratch path. Scratch-cleanup absence therefore remains launcher-reported rather than independently proven.

## Validation

| Exact command | Exit code | Result | Notes |
|---|---|---|---|
| `git diff --check 0480cc4…...HEAD` | 0 | clean | acceptance command |
| `python3 skills/control-room-work-packets/scripts/verify_scope.py --base 0480cc4… --branch worker/marvin/cr5c9h-macos-v3 --allow docs/hermes-reviews/CR5C9H_MACOS_PLATFORM_VALIDATION_V3.md` | 0 | `ok=true` | run post-commit; acceptance command |
| `git status --porcelain` (pre-commit) | 0 | empty except generated deps | tree clean at pinned base |

The bounded native outcome (`harnessExitCode` 1, category `unavailable_platform`) is reported as a failure of that gate, not converted into a pass. The separately reported launcher shell exit 0 conflicts with the committed launcher's intended propagation and remains unresolved. Underlying readiness/stage-zero passes are listed as diagnostic evidence only.

## Disposition

**Partial/blocked.**

- Met: checkout preparation, stage zero, runtime readiness, branch discipline, authorization boundaries, owner attendance, prompt discipline as observed (Allow only, exact item, never Always Allow), and owner-observed absence of the exact disposable Keychain item.
- Not established: exact model/provider identity, independent pre-launch written authorization, strict `CONTROL_ROOM_MACOS_ALLOW_ONCE_WINDOW` conformance, independent scratch-cleanup verification, and resolution of the launcher shell-exit discrepancy.
- Blocked: the native platform key-store qualification gate itself — harness exit 1, category `unavailable_platform`. This is the packet's central observation and it is negative-but-valid evidence about the current host/harness pairing.

Follow-up for Codex/Sol (not expanded in this packet): determine why the harness classifies this macOS host as `unavailable_platform` despite swiftc + Security framework passing readiness (double-dialog behavior may be related to fixture ACL expectations vs. interactive unlock semantics). Any retest requires a new work order; no reruns were performed here.

Stop boundary: report authored after owner-posted Phase 2 evidence only; no readiness or native commands were rerun during Phase 3. PR remains unmerged pending Codex/Sol review.
