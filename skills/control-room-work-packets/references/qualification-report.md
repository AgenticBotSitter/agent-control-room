# Qualification and worker report format

Use this structure when a packet requires a durable report. Adapt headings to the domain, but do not omit the authorization, evidence, side-effect, cleanup, and disposition sections.

## Header

- issue and CR/project block;
- worker, machine class, harness, model route, and reasoning effort;
- exact base commit and branch;
- task class and risk;
- allowed output paths;
- execution-contract digest and preflight acknowledgement;
- disposition: `met`, `partial/blocked`, `not met`, or `rejected — authorization deviation`.

## Authorization ledger

| Requirement | Exact authority | Result |
|---|---|---|
| Output paths | paths copied from issue | complied/deviated |
| Authorized effects | action, quantity, target | complied/deviated/blocked |
| Forbidden effects | copied or summarized without weakening | none observed/list deviation |
| Immutable inputs | contract/commit | unchanged/list deviation |

Do not mark a requirement complied merely because the effect was disclosed.

## Planned versus actual effects

List effects in chronological order. The first occurrence consumes the budget; later successes cannot replace earlier failures.

| Sequence | Effect ID | Authorized maximum | Actual count so far | Target | Result |
|---:|---|---:|---:|---|---|

Include the actual-ledger validator output. Any digest mismatch, unknown effect, unexpected effect, or over-budget count requires `rejected — authorization deviation`.

Show each disposable artifact's creation effect and distinct cleanup effect as separate chronological rows. `cleanup-then-stop` does not combine or hide those counts.

## Method and evidence

Describe the real adapter/path used, disposable material boundaries, and what was intentionally not exercised. Label each result `observed`, `documented`, `inference`, `blocked`, or `unsupported`.

For each packet step:

| Step | Required result | Evidence class | Actual result | Pass/fail/blocked |
|---|---|---|---|---|

Keep first failed attempts in the history. A correction may supersede a conclusion but must not erase its artifacts or side effects.

## Side-effect ledger

| Sequence | Effect | Authorized by | Exact target | Created/changed | Cleanup obligation | Final state |
|---|---|---|---|---|---|---|

Include helper binaries, stores, directories, clones, dependency trees, downloads, prompt choices, policy/ACL changes, service/task changes, and restarts. State `unauthorized` where applicable.

## Cleanup proof

List every created target separately. For each deletion, state that the exact absolute target, expected type, containment, ownership, and link/reparse status were checked first. Record the final absence check. If a persistent setting or residue remains, report it as retained; do not call cleanup complete.

## Validation

| Exact command | Exit code | Result | Notes |
|---|---|---|---|

Record wrapper failures as failures. If underlying commands pass, list them separately as diagnostic evidence. Record `git diff --check` and the scope-checker result.

## Disposition

- `met`: every must-pass requirement and authorization boundary was satisfied;
- `partial/blocked`: safe evidence exists but one or more required observations were not authorized or possible;
- `not met`: an acceptance requirement failed;
- `rejected — authorization deviation`: any unapproved effect occurred, even if the technical test succeeded.

List exact follow-up work without expanding the current packet. End with the stop boundary and confirmation that the PR remains unmerged.

Before handoff, compare the report, PR description, issue comment, and latest head. Remove or explicitly supersede stale conclusions; these four surfaces must agree on disposition, cleanup, blocked evidence, and current commit.

