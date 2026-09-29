# Private first-owner runner

## What this package is

This source-only runner is the private owner-attended bridge between the
accepted first-owner action transaction and Control Room's retained owner
bootstrap ceremony. It rebuilds the transaction request, captures one exact
installation binding, requires attached-owner confirmation, accepts only the
retained ceremony's exact completed response, independently verifies the
expected existing owner, and returns the terminal confirmation consumed by the
existing installation journal transaction.

It does not implement identity, authentication, tenancy, or another receipt
store. It accepts no login assertion, one-time code, credential, database
handle, listener, filesystem path, process, or native transport value.

## Reuse decision

The package **reuses**:

- `first-owner-action-transaction.ts` to rebuild the exact prepared request and
  define the terminal confirmation;
- `first-owner-setup-preparation.ts` through that request, preserving its exact
  release, running plan revision, passed database outcome, expected subject,
  and independently observed empty-owner proof; and
- `createOwnerBootstrapCeremonyV1` and the existing private owner bootstrap as
  the only production implementation allowed behind the injected ceremony
  port.

No donor or general authentication framework is adopted. The remaining code is
the Control Room-specific seam that binds an owner-attended ceremony result to
the existing installation transaction.

## Safety behavior

- The runtime's sanitized installation ID, plan digest and revision, release,
  passed database outcome, and expected owner-subject digest must exactly match
  the rebuilt transaction request.
- Owner attendance is confirmed before the ceremony port can be called and is
  bound to all of those values plus the exact request digest.
- The terminal confirmation itself carries the captured installation ID, so it
  cannot be detached and settled into an otherwise identical second journal.
- An arm response, browser preparation, incomplete response, changed subject,
  uncertain owner state, reused empty-owner proof, or mismatched ceremony
  outcome cannot create a terminal confirmation.
- The ceremony completion is hashed by the runner together with the exact
  installation and request. A separate injected observation must then prove
  that the expected subject exists and bind that same outcome digest.
- One total control deadline bounds attendance, ceremony, and final owner
  observation. Abort or timeout before the ceremony begins refuses without
  claiming an effect. Once the ceremony call may have started, every failure,
  malformed response, cancellation, timeout, or changed observation is
  `uncertain` and cannot be retried automatically.
- Cleanup has its own short deadline and may only close the retained ceremony
  and release its already-owned resources. Unconfirmed cleanup after a ceremony
  attempt is uncertainty. Errors have one fixed redacted message and no stack.

## Deliberate remaining production seams

This package includes no live adapters. A later separately reviewed private
composition must:

1. drive the already-retained `createOwnerBootstrapCeremonyV1` lifecycle
   without exposing its assertion or one-time code to this runner;
2. verify the exact expected subject from the authoritative database after the
   ceremony, returning only the bounded digest evidence contract; and
3. close that exact ceremony instance through the narrow cleanup port.

The source package and disposable injected tests do not open a listener,
database, credential store, filesystem path, browser, process, or native
transport and do not perform a real owner ceremony.

Run the focused proof with:

```sh
node --import tsx --test tests/private-first-owner-runner.test.ts
```
