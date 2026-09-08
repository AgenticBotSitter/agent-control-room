# Independent F4 workspace source/receipt review

2026-09-08. Read-only review of closure report, preparation script, new local Go fixture and acquisition receipt. No download, compilation, Git operation or independent rerun. Original downloaded sources/toolchain have been cleaned, so this review cannot independently compare their bytes with the recorded hashes.

## Findings

1. **P2 — reproducible identity guard missing.** `f4-workspace-prepare.mjs` calculates hashes for whatever flattened Go files are present and copies them; it does not compare the exact file set and hashes against the pinned committed acquisition receipt before preparing executable source. This is an acquisition recorder, not a pre-execution pin verifier. Add an exact receipt/hash check before copying/compiling for future reproduction. The report's claim of unchanged source is recorded provenance, not independently revalidated by this script.
2. **P2 — retained run evidence is narrative only in this cohort.** The four retained F4 workspace files provide source identities and detailed result prose, but no direct Go stdout/exit receipt for the selected upstream tests or actual preservation fixture. Counts and durations are therefore operator-recorded observations, not independently inspectable raw execution evidence here. Preserve existing original tool output if available and label its capture method; do not manufacture a fresh run or imply reviewer execution. The source fixture supports the described intended assertions, but source alone cannot establish they executed successfully.
3. **P3 — environment isolation reproduction incomplete.** The fixture disables global/system configuration and supplies owned hooks/templates plus synthetic identities. It does not itself clear ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, alternates or `GIT_CONFIG_PARAMETERS`. The report says the runner used an isolated environment, but no complete executable launcher/environment allowlist is retained. Record that exact sanitized launch environment or make the research launcher explicit before re-running. This is a reproducibility limitation, not evidence the reported run touched another repository.

## Scope that is represented fairly

The new fixture calls AO methods directly rather than copying a look-alike preservation algorithm. It labels its changed no-remote fixture separately from unchanged upstream tests. It creates a new managed root before `New()` and waits for discard workers before temporary-directory cleanup. Dirty refusal, tracked/untracked preservation, ignored exclusion and reference deletion have concrete assertions. Private runner denial is correctly not advertised as a process sandbox: direct preservation/cherry-pick subprocesses lie outside it. Empty `git remote` proves fixture configuration, not an OS-wide network fence.

Prepare's root-prefix guard is not a general ownership/security boundary; the reported exact mktemp root and manual authorization are the intended safeguard. No evidence of targeting an existing project is present. Constructor sweep and ForceDestroy risks are correctly called out; ForceDestroy is not recommended as a UI-close action.

The cap overrun (317 MiB versus initial 300 MiB), stop/cache cleanup and subsequent revised 400 MiB bound are disclosed rather than rewritten as original compliance. Acquisition receipt records complete cleanup; this source-only review does not independently observe historical peak usage.

The reuse conclusion is proportionate: AO is a substantive preservation donor, but CR immutable revision/device/inode/attempt-lease checks remain. A helper versus selected algorithm adaptation is still a real comparison to perform; the report claims neither a 2,000-line current deletion nor complete F4 closure. Conflicts, stale registration, restart and true CR-to-Go integration remain explicitly open. The engineer-day estimates are estimates, not measured implementation cost.

Disposition: useful bounded source/recorded-execution comparison; retain the three evidence/reproduction qualifications above. No full lifecycle, cross-platform or production acceptance.

## Focused remediation disposition

Source/receipt recheck only; no reviewer download or rerun. The three findings are addressed for the newly captured **single actual preservation fixture**:

- Prepare validates the exact 72-file flattened set, lengths, hashes and regular-file status against the committed acquisition receipt before copying. Launcher revalidates exact prepared tree, bytes and module declaration before adding the separate fixture. Three retained negative verifier results show wrong hash, missing file and extra file rejected before module creation.
- Retained launcher captures actual child stdout/stderr/status; `f4-workspace-recheck-evidence.json` records status 0, null signal/error, 7,912ms and the actual named fixture PASS. Its fixture SHA256 matches the presently retained fixture (`32817c8246bb35cfc387db10ae5da560b3f4df365d613f8fc173b92dc0a84d65`). Earlier pure/fake tests remain explicitly narrative/transcribed observations, not upgraded by this result.
- Launcher supplies a literal sanitized environment allowlist rather than inheriting the parent; owned HOME/TMPDIR/cache and offline controls are explicit. Fixture additionally refuses the six identified ambient Git variables. This closes the reproduction gap without claiming an OS network sandbox.

Cleanup/root absence and storage are operator-recorded confirmations. Denied `ps` inspection is disclosed; timeout is not presented as process-tree containment. No remaining blocking finding for this limited recheck. Conflict/restart, cross-platform and actual CR-port integration remain open.
