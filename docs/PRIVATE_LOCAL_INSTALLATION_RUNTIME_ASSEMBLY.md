# Private local installation runtime assembly

**Status:** source-only production-shaped composition with disposable test
evidence. It has not opened PostgreSQL or artifact storage, started a service,
scheduler, worker, or agent, or exposed a browser action.

## Outcome

`private-local-installation-runtime-assembly.ts` joins the accepted setup
dispatcher, settled installation journal, local Hermes startup
re-verification, protected operator assembly, and normal task bootstrap. It
does not replace any of them or add another state machine.

Construction captures only trusted inputs and is inert. Before normal startup
can reach any effect-capable port, the assembly verifies settled installation
history, reconstructs the saved Hermes admission and final review, rechecks
the exact current delivery, runner, worker, queue, topology and release,
supplies the opaque receipt to the existing operator assembly, and rereads the
journal before delegating to normal startup.

Missing private configuration or native service custody is an explicit inert
blocker. The setup browser remains a read-only projection and cannot call this
assembly.

## Port capture

Journal and startup dependency objects are validated through their own
property descriptors before any value is read. Accessors, inherited entries,
symbols, extra fields, non-enumerable entries, and non-callables refuse without
executing a getter. Accepted functions are captured once and immutably bound.
This prevents configuration parsing itself from becoming an effect path.

## Reuse decision

The decision is **retain existing Control Room and build one small composition
seam**. This file reuses the installation journal, setup dispatcher, startup
re-verifier, operator assembler, and bootstrap. An external installer,
scheduler, database, credential store, or agent runtime would duplicate
authority and is rejected. No third-party source is copied.

## Verification

`pnpm test:private-local-runtime-assembly` covers inert construction, exact
receipt injection, custody blockers, accessor/inheritance/symbol attacks,
incomplete and unsettled history, generic-readiness bypass, cancellation,
callback/runner/queue substitution, and concurrent journal movement. Every
refusal asserts zero database, artifact, scheduler, worker, service, and Hermes
effects.

Production configuration custody and the native protected-directory and macOS
service implementations remain separate reviewed packages. Their real use
remains owner-attended.
