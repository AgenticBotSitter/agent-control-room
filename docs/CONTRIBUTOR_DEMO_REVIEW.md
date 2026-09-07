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
The remediation was synchronized into the candidate and its strict type check,
28 demo tests and two compiled-demo tests pass. The same independent reviewer
rechecked the changed candidate code and confirmed this specific P2 addressed:
missing-child detection precedes clearing intent, preserves feedback, explains the
outcome and unlocks explicit resubmission. The test exercises the recovery helper,
not mounted React interactions. This closes only this finding, not browser
acceptance or a complete independent release review.
