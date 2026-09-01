# CR13A-LIVE-010 identity-redaction remediation independent review

**Disposition:** accepted

**Accepted target:** `c32bb1908323d9acb2e891722c1fd4657334c741` only

**Rejected predecessor:** `e4cb8d69b4dbe17f560303a1edad08871fcc575b`

No High, Medium, or Low finding remained.

## Independent evidence

The reviewer reproduced the predecessor leak with an in-memory signed enrollment containing
`connectionId: "10.0.0.5:22"` and `nodeId: "johnny5.local:22"`. The accepted sanitized enrollment retained both source
values, and the rejected predecessor copied and rendered them in the browser projection.

The accepted remediation:

- replaces source connection identities with exact `connection:inventory:NNN` presentation references;
- replaces distinct source node identities with exact `node:inventory:NNN` presentation references;
- keeps source node identity only as a server-local map key;
- removes source connection identity, source node identity, tenant identity, source-result digest, and roster digest from
  the public type and strict schema;
- retains only the fixed non-tenant compatibility-source digest;
- authenticates before any roster read;
- rebuilds the signed roster and compares its digest, tenant, and evaluation time on the server before projection; and
- rejects malformed references, reintroduced source fields, extra response fields, and projection-digest drift in both
  server and browser parsing.

The reviewer confirmed the route remains protected GET-only and adds no connect, SSH, credential, provider,
qualification, approval, lease, dispatch, retry, command, write, or execution path. Empty-state behavior remains honest
and provider-disabled.

## Verification observed by reviewer

- macOS stage zero: `ready_for_runtime_check`;
- Connection Center tests: 10/10;
- combined CR13A tests: 26/26;
- typecheck and lint: passing;
- production build and rendered routes: 4/4 passing; and
- exact integration diff whitespace check: passing.

The reviewer changed no repository file and used no persistent service, external system, credential, native process,
SSH connection, provider, production database, or deployment.
