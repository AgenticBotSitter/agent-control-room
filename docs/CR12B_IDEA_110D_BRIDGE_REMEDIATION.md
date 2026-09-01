# CR12B-IDEA-110D — fixed Hermes bridge review remediation

**Status:** Implemented locally at immutable product commit
`bb1faf989486bb3b16226d9a4cbec2223ef4e5f2`; acceptance requires a different independent re-review.

## Why this block exists

The third independent review of IDEA-110B rejected implementation commit
`0a736ad16e1ea7ffef37e434eba5bd46f483f95d`. The unchanged report is retained on review integration commit
`d0875a7f80d887c6bcf7528346b1fe5aafc88c61` with SHA-256
`d5695fb5d52bbcf90cfa7440ae3ec46a3a46e8628ee7866ec90a291b4129b87f`. All four High findings were reproduced by
Codex and remain negative evidence; passing tests do not erase them.

## Repairs

1. **Concrete receiver preservation.** The filtered driver and enrolled gateway now invoke captured collaborator methods
   with their validated original receivers. Regression tests use ECMAScript-private fields so an unbound call fails
   exactly as the production classes did.
2. **Execution/cleanup serialization.** Both the gateway and fixed bridge maintain an explicit execution-settlement
   barrier. Cleanup marks cancellation, aborts the bridge's internal execution signal, waits for the in-flight call to
   settle, and cannot submit a completed cleanup receipt early. The execution path checks cancellation before and after
   every connector await, so a delayed open or operation cannot resume into later Hermes operations after cleanup starts.
   Gateway settlement records execution ambiguity before cleanup completion.
3. **Exact least-authority operation set.** Enrollment, permit digesting, and the fixed bridge share one seven-operation
   constant: `session.create`, `prompt.submit`, `session.events.since`, `session.status`, `session.usage`,
   `session.interrupt`, and `session.close`. `session.steer` and `session.resume` are not enrolled or signed.
4. **Post-claim expiry enforcement.** The gateway samples trusted time again after the awaited durable claim and
   immediately before bridge entry. Expiry, rollback, cancellation, or an already-aborted signal consumes the claim into
   terminal ambiguity and makes zero native-bridge calls.

## Verification completed before re-review

- macOS stage zero: `ready_for_runtime_check`;
- TypeScript: pass;
- full repository lint: pass;
- focused remediation and bridge tests: 40/40;
- combined CR12B suite: 138/138;
- complete lifecycle: 769/769 pretests, 414/416 core tests with two intentional platform skips, and 217/217
  posttests;
- production build and rendered routes: 3/3;
- migrations: all 32 applied and 110 PostgreSQL tables verified; and
- working-tree whitespace validation: pass.

No Hermes process, SSH connection, provider call, credential or protected-value access, native attempt, enrollment,
production database contact, deployment, or other product effect occurred. The repository remains provider-disabled.

## Acceptance gate

A reviewer different from the IDEA-110B REV-003 reviewer must attack the exact remediation commit and independently
close `CR12B-REV003-001` through `CR12B-REV003-004`. Any new finding preserves a negative disposition and returns the
work to Codex. Only an accepted immutable re-review may let Codex mark the abstract bridge accepted; it does not enroll a
machine, contact Hermes, reuse an old owner authorization, or make a native qualification eligible.
