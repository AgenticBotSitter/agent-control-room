# Durable first-owner setup transaction

This source package records the final outcome of Control Room's existing
first-owner ceremony in the existing installation-plan journal. It does not
replace or wrap the identity system, create another state machine, or perform
the ceremony.

## Reuse decision

The package deliberately reuses:

- `installation-action-preparation.ts` and
  `first-owner-setup-preparation.ts` for the exact running plan revision,
  passed database outcome, expected owner-subject digest, and independently
  observed empty-owner proof;
- `installation-plan-journal.ts` as the only durable receipt store;
- `installation-plan.ts` for the one `first_owner` stage transition; and
- the retained owner-bootstrap ceremony and private owner command as the only
  components allowed to accept a login assertion and create the owner.

No donor or new authentication framework is needed. The missing piece was a
small transaction adapter between the existing ceremony's terminal evidence
and the existing installation journal.

## Safety boundary

`confirmFirstOwnerActionTerminalV1` accepts only a private wrapper's exact
terminal confirmation. That confirmation must bind the prepared request, the
expected owner subject, an independently verified `existing` owner state, an
opaque owner proof, and the completed ceremony outcome. An armed ceremony,
preparation record, changed proof, stale revision, uncertain owner state, or
different subject cannot pass.

The adapter imports no owner-creation, database, listener, credential-store,
filesystem, or process implementation. It accepts no assertion, one-time code,
credential, path, connection, or effect port. Simultaneous exact confirmations
settle as one append and one exact replay; changed or uncertain outcomes remain
owner attention.

## Remaining owner boundary

A later private, owner-attended runner must conduct the already-reviewed
ceremony, independently verify that the expected owner exists, and construct
the terminal confirmation. That runner is where the login assertion, one-time
code, database connection, and ceremony lifecycle remain bounded. This source
transaction neither supplies nor simulates those effects.

Run the focused proof with:

```sh
node --import tsx --test tests/first-owner-action-transaction.test.ts
```
