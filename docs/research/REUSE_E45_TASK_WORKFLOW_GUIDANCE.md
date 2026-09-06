# E45 — task workflow guidance and assignment handoff

2026-09-06. Local UI changes; no live browser/agent or deployment evidence.

The task detail page now provides a navigation-only explanation of preparation,
assignment, signed approval, queuing and result review. It links the existing panels
rather than creating a parallel workflow. The signing limitation is stated directly;
no new approval or execution controls were added to the guide.

A confirmed assignment/expiry command requests a fresh parent task read immediately,
instead of waiting for the next 30-second interval before approval can see the updated
attempt. Uncertain or rejected commands do not trigger this success callback. Existing
pending command memory and server authority checks remain intact.

Read-busy state now belongs to each effect generation. Previously a refresh that
retired an in-flight read could have its initial load suppressed by the retired read's
shared busy flag. The new generation can read independently; prior responses remain
fenced by the effect's live flag and current generation. This can temporarily overlap
an old and new GET, not any command or native action. Same-generation polling remains
non-overlapping. A visible status-refresh button is available outside the error state.

Historical saved-plan text no longer claims that no agent has started. It says that
saving the plan did not start an agent and directs the owner to current task progress.
This matters after E43 restores a receipt for an older plan that may already have run.

Verification: 46 UI/client/workspace tests pass, including guide anchors, no guide
command controls, historical wording, reservation-versus-execution copy, and existing
pending review/verification behavior. TypeScript, targeted lint and whitespace checks
pass. Production build and all 35 compiled regressions pass.

An initial wording assertion expected the old misleading sentence; it was changed to
assert the historical statement and explicitly reject the old absolute claim.

Browser inventory was requested again through CUA and reported the Mac locked. No
unlock or alternate computer-control path was attempted. Owner unlock remains required
for interactive checks. Static rendering and client tests do not prove DOM event flow,
file selection, or keyboard navigation. In particular, periodic task refresh currently
clears unsigned approval review/file selection; preserving that editing experience
under fresh authorization remains a follow-up, not a claimed fix in this block.

No downloads, native credentials, service configuration, GitHub or production effects.
The broader real task/fleet/Idea Lab/ABS/daily-use outcomes remain open.
