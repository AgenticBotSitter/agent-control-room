# Deployment-only owner bootstrap bridge

The release supplies `dist-vps/server/ownerBootstrap.js`, exporting
`createPrivateOwnerBootstrap`. It joins the existing Access verifier and
`SecurityStore.bootstrapOwner`; it is not a new login server, HTTP endpoint,
credential collector, account-recovery route or automatic startup step.

## Required trusted inputs — still operator-gated

- A separately approved bounded provisioning database connection with transaction
  and precommit support. The caller owns its close/reconciliation. Never put this
  connection or its credentials into the restricted running website profile.
- The reviewed database name and already-existing tenant/workspace. This operation
  does not create databases, tenants, workspaces, schema or database roles.
- Reviewed owner identity/grant identifiers and display name.
- Operator-selected issuer, exact Access application audience, current public
  verification keys and validity bounds, using the existing AccessTrust contract.
- The owner's independently confirmed subject digest, computed with the existing
  `sha256Digest({ provider, subject })` representation. The provider is the exact
  verified issuer. Do not use an email address as a subject, choose a subject from
  the first received token, or let that same unconfirmed token set its expected pin.
- A genuine current Access assertion delivered through separately reviewed private
  intake. Do not paste it into chat, Git, command arguments or logs.

Actual subject confirmation, protected assertion intake, provisioning connection
acquisition and execution authority remain missing operational inputs. This file
does not approve their acquisition. The bridge does not fetch keys, prove owner
attendance, inspect Access policy or establish MFA enforcement. Verify the real
owner-only application and MFA separately. Login setup is not owner effect-signing
key setup or permission to launch an agent.

## Execution semantics

Trusted configuration includes `databaseName`, `tenantId`, `workspaceId`,
`identityId`, `grantId`, `displayName` and `expectedOwnerSubjectDigest`. Construct
one bridge with that configuration, AccessTrust and the borrowed database/clock;
its explicit `bootstrap(assertion, signal)` call is the first possible write.
No launcher loads or calls it automatically.

It verifies the assertion and confirmed subject before database access, checks the
database name and tenant/workspace in the transaction, and uses the existing
tenant-locked single-use owner primitive. Authentication, cancellation and clock
monotonicity are rechecked before commit. It does not rewrite an existing owner.
Name matching is not independent proof of host identity: the supplied connection
must already be tied to the approved target.

Each instance permits one attempt. A failure may mean the commit response was
lost; do not recreate the bridge and automatically retry. The operator must inspect
the exact target through separately authorized read-only reconciliation first.
Do not delete an existing identity to make bootstrap succeed. Keep the application
stopped until ordinary database preflight and remaining deployment gates pass.

The receipt includes no subject, assertion, identities or private connection
details. It explicitly leaves application installation and production readiness
false and states that connection cleanup belongs to the caller. A successful
receipt is not proof of connection closure, backup restoration or usable login.

## Local verification

`pnpm test:owner-bootstrap:build` builds the compiled entry and exercises supplied
synthetic assertions and disposable SQL. Tests cover wrong/unconfirmed subjects,
scope refusal, captured configuration, single-use behavior, grant-write rollback,
expiry/cancellation/clock rollback and uncertain commit responses. The compiled
test proves the release entry works without touching another existing tenant.
These tests do not consume a real owner login or provision anything on the VPS.
