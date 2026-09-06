# E44 — task-specific historical delivery attention

2026-09-06. Local implementation, synthetic native peers and PGlite only.

The coordinator now supplies a narrow optional readDelivery operation. It reuses the
existing authenticated historical-evidence transaction, current owner tasks.approve
and task/project access, verified execution plan, and HMAC-checked queue/preparation/
envelope/transmission/receipt readers. It checks required predecessors and matching
queue, packet, body, frame and dispatch-message identities before projecting status.
No new database grants, transport, retry engine or effects are introduced.

States distinguish not queued, queued, prepared, staged, transmission unconfirmed,
authenticated receipt recorded and receipt rejected. A transmission intent is not a
claim that bytes were sent. Receipt is not execution or completion; rejection is not
permission to retry. Missing or corrupt predecessor evidence makes the read unavailable.
This is verified historical evidence, not renewed approval or an assertion of node health.

The existing submission GET includes optional delivery status, validated for exact
project/job and, when a queue receipt exists, attempt identity. The task's submission
panel shows status and observation time. Commands remain separate; checking never sends.
Older compositions without the reader do not claim delivery visibility.

Needs Me also scans leased/running native tasks and includes their exact input digest
for trusted scoped readback. After the web transaction releases its identity lock, the
coordinator reads each candidate under current authorization. The page maps verified
history to pending, unconfirmed, rejected or submission-needs-checking labels. A recorded
receipt removes the delivery warning, not an independently pending result/review item.
Missing reader configuration is explicitly shown. No raw node/connection identity or
signed packet is exposed; the private-web SQL role still cannot read these records.

Verification: 74 related queue/preparation/transmission/receipt/browser/inbox checks
pass; three additional focused prepared/corrupt-receipt/browser-scope checks pass.
All three source and compiled full-host journeys verify the warning before receipt,
its removal after receipt, and the result's continued pending review. VPS build and
35 compiled regressions pass. TypeScript, targeted ESLint and whitespace checks pass.
The final attempt-identity refinement is covered by direct browser parsing tests and
a rebuilt compiled-journey rerun. No downloads, native calls or deployment.

Remaining: this does not inspect pg-boss operational failure reasons or current owner
approval/lease eligibility, and it does not prescribe a safe retry. Some queued work
may be legitimately waiting. Exact triage/actions, interactive browser validation,
real PostgreSQL/agents, multi-host fleet, Idea Lab/ABS and daily-use acceptance remain.
