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

Actual subject confirmation, preparation of protected assertion/settings material,
approved provisioning credentials and execution authority remain operational inputs. This file
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

## Explicit operator command

The separately invoked `scripts/bootstrap-private-vps-owner.mjs` now supplies
connection ownership around that bridge. It is a production **write** command,
not a readiness probe. Nothing in this document authorizes running it on the VPS.

After exact-target approval, use a pinned provisioning checkout owned and controlled
by the provisioning operator, not a checkout writable by the website account.
All imported code and parent directories must share that trust boundary. Do not
run privileged provisioning code from a worker/service-writable tree. Keep the
supplied `deploy/owner-bootstrap-config.mjs` canonical, operator-owned and 0600.

Prepare a separate operator-owned 0600 JSON file outside Git and the web root,
unreadable by the website account. Set `CONTROL_ROOM_OWNER_BOOTSTRAP_FILE` privately
to its absolute canonical path. Its exact top-level fields are:

- `configuration`: the seven reviewed fields described above.
- `trust`: the existing AccessTrust public-key/issuer/audience/validity structure.
- `database`: the explicit private PostgreSQL settings shape from README, using
  the approved provisioning login, not the runtime web or Idea login.
- `assertion`: the actual current, independently owner-confirmed Access assertion.

No credential discovery, identity guessing or key fetch is performed. The command
reuses the bounded loopback PostgreSQL adapter. It verifies the pinned assertion
before pool acquisition, repeats verification inside the bridge, and retains one
clock high-water check across acquisition and commit. Successful reporting requires
the owned pool to close; failed cleanup is uncertainty even if the owner was created.

Run only after authorization:

```text
node /APPROVED/PROVISIONING-RELEASE/scripts/bootstrap-private-vps-owner.mjs --configuration /APPROVED/PROVISIONING-RELEASE/deploy/owner-bootstrap-config.mjs
```

`--help` performs no database operation. Do not pass credentials or assertions as
arguments, wire this into a supervisor, or retry on failure. The fixed command
receipt reports database closure but still leaves application installation and
production readiness false. Its error output contains no private inputs. Retention
or removal of the exact provisioning input file needs the approved credential
handling procedure; it is never automatically copied into runtime configuration.

## Local verification

`pnpm test:owner-bootstrap:build` builds the compiled entry and exercises supplied
synthetic assertions and disposable SQL. Tests cover wrong/unconfirmed subjects,
scope refusal, captured configuration, single-use behavior, grant-write rollback,
expiry/cancellation/clock rollback and uncertain commit responses. The compiled
test proves the release entry works without touching another existing tenant.
These tests do not consume a real owner login or provision anything on the VPS.
