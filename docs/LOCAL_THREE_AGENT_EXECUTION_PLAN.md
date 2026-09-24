# Local three-agent execution plan

## Product outcome

Agent Control Room runs on one Mac and uses one privately reached PostgreSQL
database as its authority.  The signed-in owner can create a project and task,
select a qualified local worker, inspect a saved result, accept it or request a
correction, and see truthful task status.  Hermes Agent, Claude Code, and a
managed Codex worker must use the same task, result, review, correction,
revocation, and recovery lifecycle.  A preview page or a standalone command
does not count as this outcome.

This plan is deliberately topology-neutral: completing it must not introduce a
second database, scheduler, queue, broker, authority service, or task
lifecycle.  The same records and contracts will later support additional
computers.

## Five phases and acceptance evidence

### 1. Hermes Agent — first real local worker

**Build:** retain the approved one-turn, text-only Hermes runner inside the
existing canonical queued delivery path.  The path must save a delivery receipt
before a runner can be acquired, recheck authority immediately before the
process boundary, stage a result into the existing review flow, and preserve
uncertainty instead of retrying a possibly started task.

**Prove:** from the installed website, send one harmless text task to Hermes;
review and accept its saved result; request one correction; prove an exact
replay does not execute again; prove revoked work does not start; and verify
restart recovery reads the saved record.

### 2. Claude Code — same bounded lifecycle

**Build:** keep Claude's first capability to an explicitly qualified,
text-only review route with no implicit editing or tool permission.  Use the
same controller receipt, result, review, correction, cancellation, and
recovery services as Hermes.

**Prove:** qualify the installed Claude process, complete one harmless task
through the website, demonstrate saved-result review and one correction, and
show that a restart or failed process does not create a duplicate task.

### 3. Managed local Codex worker

**Build:** connect a supported Codex App Server or CLI process—not the desktop
chat—to the existing Codex task, journal, result, and review contracts.  Its
process policy must have a supported protected private-state mechanism and a
bounded owner-approved execution policy.

**Prove:** one controller task yields one separate saved result; cancellation,
revocation, and restart behave like the shared lifecycle.

**Current safety gate:** a pathname-only local private-state folder is not
sufficient.  Until a supported protected-state mechanism is available and
reviewed, the product must show this worker as unavailable rather than claim
that a local command can safely enable it.

### 4. Real owner website journey

**Build:** assemble the protected installed configuration and existing local
website/controller against the selected private database.  The browser may see
only redacted setup, worker, task, result, review, correction, and attention
state.  It must never use preview data to imply a running worker.

**Prove:** sign in, create a project and task, choose an actually qualified
worker, observe saved status and evidence, accept its result, then request and
receive a correction.  Record failures and unavailable workers plainly.

### 5. Coexistence and recovery

**Build:** retain the shared controller packet and all existing cross-worker
isolation checks.  Do not add a local-only queue or result store.

**Prove:** each qualified worker completes a distinct task without seeing or
settling another worker's result.  Demonstrate cancellation or revocation,
one worker failure, controller/worker restart recovery, and no duplicate
execution.

## Delivery order

1. Finish and prove Hermes before broadening its capability.
2. Finish and prove the bounded Claude route.
3. Complete the real website journey using those workers.
4. Add Codex only when its protected-state requirement is genuinely met.
5. Run the three-worker coexistence journey once all three are eligible.

Source tests are useful but never substitute for the real proof listed above.
Keep `LOCAL_THREE_AGENT_PROGRESS.md` updated after meaningful source work,
tests, or a live attempt.  Keep protected configuration, credentials, private
network details, and owner-only paths out of this document.
