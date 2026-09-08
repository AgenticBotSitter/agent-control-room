# Independent F4 pure-planner mapping review

2026-09-08. Source-only reviewer compare_operations, not author of experiment.
Read f4-planner-fit.md, acquisition/evidence/cleanup records and all three
f4-planner research files. No download, upstream execution, DB or provider call.

## Findings

### P2 reproducibility hardening: pin is recorded, not enforced before execution

The acquisition receipt records exact source URLs/hashes, but `f4-planner-peer.py`
imports `gateway.hosted_room_discussion` before verifying any of those hashes.
Its hashlib import is unused. Reproduction using a pre-existing permitted-named
root would execute modified/stale files while still printing `upstreamPurePlanner:true`.
`f4-planner-fetch.mjs` writes a fresh receipt from whatever it downloads, rather
than comparing downloaded bytes with retained expected identities. Add verification
of all four executable Python files against the committed acquisition receipt
before import/adaptation. Prefer reject mismatches, not rewriting expected hashes.
This does not prove recorded run used wrong code; it narrows reproducibility assurance.

### P3 measured contribution counts are not asserted

Harness asserts state/messagesUsed and records actual registry contribution count,
but doesn't assert expected stored contribution count per case. Retained evidence
shows matching3/6/9/12/18 counts and3/6 negative cases, so reported run's numbers are
supported by receipt. Add assertions to make future regressions fail rather than
merely print different counts. Preserve negative-case prefix counts explicitly.

## Boundaries and decision assessment

- Actual CR coordinator, session schema and DB-backed stores are invoked; real
  candidate pure planner/publication code is called via subprocess. Fake provider
  opinion/result is explicitly separated. Narrow E3 claim for selected mapping
  through synthetic driver/storage seam is reasonable; no full planner-driven
  coordinator or native qualification is claimed.
- Current coordinator drives iteration; candidate only gates whether its selection
  agrees. Report explicitly states candidate runs after marker and identifies this
  avoidable ambiguity as a harness placement mismatch. It does not fairly establish
  upstream provider uncertainty, and report correctly avoids that claim.
- Upstream prompt is measured but not delivered, an important honest limitation.
  Successful selection/receipt mapping cannot justify adopting prompt construction.
- Same canonical run replay in same DB proves that specific replay path, not crash
  recovery, multi-process deduplication or atomic two-log settlement. Report limits
  claims accordingly. Transient upstream events/taskIDs are not called durable.
- Strongest reuse variant is explicitly adapted planner, which passes all tested
  fixed-panel cases. Retain recommendation acknowledges this feasibility and weighs
  four changed semantics plus interpreter/import burden against tiny selection loop.
  This is a reasonable **conditional narrow exception**, not evidence against Hermes
  execution, general collaboration rooms or future dynamic discussion features.
- No production deletion justified, full327-line coordinator not replaced by planner,
  and future mention-driven mode remains viable. Counts are disclosed as physical
  lines, not apples-to-apples production adapter cost or benchmark superiority.

No source-only basis to overturn narrow retain-fixed-panel conclusion. Resolve
identity verification before future executions and strengthen contribution assertions;
neither fix substitutes for separately required cancel/cost/promotion/restart tests.
This review does not close whole F4 or compare every external teamwork candidate.

## Correction recheck

2026-09-08. Both findings resolved in source/retained receipt review. Peer now
loads expected identities from committed acquisition record, verifies all four
Python source hashes and checks count before adding source path/importing candidate.
Harness now asserts exact contribution count for completed and negative-prefix
cases. `f4-planner-recheck-evidence.json` contains12 cases, every contribution count
matches expected outcome and every replay records no calls. No runtime rerun by
this reviewer. These corrections strengthen pin/receipt reproducibility without
expanding the original E3 seam, recovery or whole-family acceptance scope.
