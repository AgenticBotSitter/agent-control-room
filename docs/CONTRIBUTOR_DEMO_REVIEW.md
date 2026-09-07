# Contributor demo independent flow review

2026-09-06. Read-only independent review by `demo_flow_review`, limited to the
staged demo runtime, launcher, history/revision UI and related tests/setup. No
listener, browser, provider, installation or publication action. This is not a
complete privacy/security release review.

Finding P2: a failed revision POST before server acceptance could lose the user's
feedback. History recovery returned only the previous sample; the UI cleared the
pending intent and draft without saying the revision had never been recorded.
Existing tests covered lost replies after acceptance, not requests never delivered.

Maintainer remediation: history restoration now records which parents have accepted
children. When the pending parent has none, preserve its feedback, explain that the
revision was not recorded and permit explicit resubmission. Recovery itself remains
read-only. Added a transport failure before handler invocation and asserted draft
preservation, unchanged history and separate handling of an accepted revision.

The keyed parent was checked and rules out the reviewer's initial unkeyed scope
reuse concern. No other concrete issue was established in the bounded review.
Remediation still needs candidate synchronization and verification; code-level
tests are not browser interaction evidence or independent re-review.
