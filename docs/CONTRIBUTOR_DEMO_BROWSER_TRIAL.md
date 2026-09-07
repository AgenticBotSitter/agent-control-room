# Disposable contributor demo browser trial

2026-09-07 UTC. Owner explicitly approved a ten-minute local browser trial with
synthetic data, no real agent/provider credentials, downloads or publication, and
required shutdown/cleanup. Completed before 04:47:32 UTC, under five minutes after
the first startup check at 04:43:12 UTC.

Candidate source inventory: 518 files, recorded digest
`25ab1753eebb87bc85037faebfd03ea936cb6e046137a1b66597c3363ce03981`.
No candidate source was changed during the trial.

## Observed

- Initial restricted-shell launch exited 1 before readiness. No port-3000 listener
  or remaining demo temporary directory was observed. The generic launcher error
  does not establish an exact root cause.
- An explicitly escalated launch then succeeded. The owned process listened only
  on 127.0.0.1:3000. The exact preview URL returned HTTP 200 when checked with local
  network permission. No occupied process was stopped or alternate port selected.
- Browser login accepted the disposable one-time code and displayed an active
  session. No existing agent authentication or credential store was used.
- Created a synthetic project and proposed task through visible forms. Generated a
  labelled sample, submitted revision feedback and observed the separate revised
  sample. Literal script-like text appeared as text in the result.
- Reloaded the task page: the latest revision was restored and the previous sample
  expanded successfully. Opening that task in another tab preserved the same chain.
- Created a second project: it showed no tasks from the first. Archived it and
  observed archived status, a reopen control and removal of the proposal form.
- One desktop viewport was visually inspected. No error entries were returned by
  the inspected task tab's console log query. This is not a full console audit.
- Closed both trial-created tabs. Sent SIGTERM to the exact owned demo process;
  its command session exited 0. Its exact temporary directory was absent afterward
  and no listener remained for that process on port 3000.

Only sanitized evidence is retained here. No code, cookie, generated project IDs,
raw process identity or temporary host path belongs in public evidence.

## Limitations and follow-up

This proves the tested local synthetic journey, not real Hermes/Codex compatibility,
production PostgreSQL, fleet coordination, unattended operation, fresh installation
on another OS, or full accessibility/mobile behavior. Network-loss scenarios remain
automated-test evidence, not induced browser failures in this trial. SIGINT has fake
test coverage; this physical trial used SIGTERM.

The task page still shows operational sections saying execution/result storage is
not configured alongside the functioning simulation panel. This is honest about
production capability but visually noisy; the contributor UX package should separate
these explanations more clearly. Fine-grained simulated progress and keyboard/mobile
acceptance are not established by this short trial.

Final source privacy/rights review, private vulnerability-reporting setup and exact
publication approval remain separate release gates. No GitHub write or deployment
occurred.
