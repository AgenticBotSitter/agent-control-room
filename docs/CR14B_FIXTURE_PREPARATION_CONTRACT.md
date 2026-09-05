# CR14B disposable fixture preparation and private handoff

Date: 2026-09-05. Architect: Codex, Astra Xhigh. Repository implementation; no live setup authority.

## What this completes

The reviewed SQL rehearsal needs matching synthetic owner, Idea, enrollment and signal records. The separate
`src/web/v1/private-fixture-preparation.ts` entry creates those records together using the existing stores,
with fresh local test keys. The VPS build exports `dist-vps/server/preparation.js`; it is not mounted in the
website, startup, queue or agent interface. Importing it and constructing its preparer performs no I/O or key
generation. The internal fixture builder is not exported by that entry.

This removes manual fixture assembly from the operator handoff. It does **not** install PostgreSQL, create a
database/login, apply migrations, change grants, read a credential store, connect an agent, start a listener,
configure Access/MFA or deploy. Those remain separately approved operator actions in
`CR14B_SETUP_REHEARSAL_PACKET.md`. Do not run the native entry merely because its tests passed.

## Explicit preparation prerequisites

The owner/operator first approves and prepares one dedicated, disposable PG17 database on the same host as
the future app, reachable at `127.0.0.1` only. Database names must use the `cr14b_rehearsal_` prefix; the name
alone is not proof of isolation. No RDS, production data or shared database is suitable. The operator verifies
the actual host, executable artifact and isolation separately, rather than trusting a caller-supplied digest.

Apply reviewed migrations 0001–0043 as a separate restricted LOGIN that directly owns the public tables.
Apply the reviewed web role/database ACL profiles under their own administrative approval, and create the
distinct web LOGIN with only the reviewed web group permissions. Do not populate any table beforehand.
This is an empty-database seeder, not a migration, bootstrap of an existing installation, or repair tool.

`prepare(input)` requires exact commit/tree/compiled artifact, migrator and web scope digests, PG17 patch and
package digest, owner approval and cleanup-plan digests, explicit completed-setup flags and expiry/budgets.
The migrator credential is supplied privately in memory. Web coordinates contain no web password; the later
rehearsal receives its separate credential from the authorized operator. No credentials, assertion, integrity
keys, host/database/login locators or raw exceptions belong in retained evidence, command arguments or GitHub.
Packets/digests are checklists and target bindings, **not approval capabilities, signatures or host attestation**.

All prerequisites are parsed before opening the pool. Missing, expired, mismatched, non-loopback or same-login
inputs return `setup_incomplete` with no pool/SQL attempt. A preparer object is single-use even after invalid
input. A new object is not permission for a second native attempt after an uncertain result.

## One bounded seed transaction

The native pool allows one connection and uses the reviewed private driver's fixed session settings:
5-second statement, 2-second lock, 10-second transaction and 5-second idle-transaction limits. The outer
packet allows 10–60 seconds including a five-second owned-client shutdown reserve. No application retry or
repair is added. Driver primary-selection behavior is inherited; physical connection attempts are not observed.

Within one outer transaction, the tool:

1. Checks current/session login, exact DB/PG patch, primary/read-write status and fixed session settings.
   The migrator must be a non-elevated, inheriting LOGIN, not a web-group member, and own every public table.
2. Requires the current reviewed schema digest and exactly 130 validated public table names. It locks all
   of those tables, rechecks the fingerprint under the locks, and requires **every table to be empty** before
   the first insert. Validated catalog identifiers are quoted; no caller supplies SQL or a table list. These
   exclusive locks are appropriate only to the dedicated empty database and bounded by the lock timeout.
3. Generates a fresh local RSA test assertion/public key and three random 32-byte integrity keys. All accepted
   stores join the same transaction: tenant, workspace, active synthetic human owner/grant, historical injected
   Idea discussion/project, synthetic pending node/enrollment, and authenticated synthetic signal receipt.
4. Confirms one tenant/owner/workspace/Idea/enrollment/signal, checks cancellation/time immediately before commit,
   and awaits commit acknowledgement. At most 256 callback SQL statements are admitted, plus the bounded
   database wrapper's BEGIN and final COMMIT or ROLLBACK. No nested store transaction commits independently.
5. Closes the owned client before exposing the one-use private material handoff.

The Idea discussion is the existing deterministic historical fixture, not a new bot/provider conversation.
The connection is explicitly injected and unqualified: no command, approval, lease or execution grants;
`nativeQualified` and `livePanelEligible` stay false. Its `ssh_tunnel` field is metadata, not an SSH operation.
The synthetic grant is not a real owner account and may never be adopted as production authentication.

## Handoff without secret files

Only acknowledged commit **and** successful client shutdown produce `fixture_prepared` and a `takeMaterial()`
closure. Call it once in the authorized operator process and pass the returned material directly to the
reviewed rehearsal. The public result serializes to fixed evidence/digests; its function and private captured
material are omitted. The RSA signing private key is not returned. JavaScript memory disposal is not secure
zeroization; the operator must not inspect, log or persist the private handoff and must end the disposable
process afterward. There is no automatic disk/clipboard/environment credential transfer.

The synthetic signal is valid for five minutes. `handoffStartBy` is four minutes after generation, leaving at
least one minute for the early connection check; this is not a promise that a delayed rehearsal will pass.
An expired/backwards-clock handoff fails and is consumed. A stale signal during the rehearsal is negative
evidence, not permission to refresh it or repeat setup. The assertion remains valid for approximately one hour,
including the separately approved maximum 15-minute rehearsal window.

The owner uses the preparation result's `preparationDigest` in the rehearsal packet **after** preparation,
avoiding a circular prerequisite. Its matching migrator/web target binding is reviewed alongside the actual
private configuration; the digest does not independently authenticate setup. The rehearsal's production
preflight still checks the real restricted web role/schema and all ordinary acceptance conditions. No fixture
path, permission override or privileged setup login is introduced into the application.

## Failure, cleanup and evidence

Any unexpected role/schema/data/time/cancellation condition stops before later steps. Ordinary pre-commit
failure rolls back the joined transaction; uncertain driver outcomes quarantine/close the owned pool. A lost
commit acknowledgement may leave committed rows: no retry, rollback-after-commit attempt, handoff or claim
that zero records exist is permitted. The operator must reconcile and clean the exact disposable target.
`fixtureCounts` record only acknowledged seed checks, not proof of absence after failure. A failed close
reports `cleanup_uncertain` and never returns keys, even if the transaction was acknowledged.

Evidence retains only fixed status/labels, manifest/schema/scope hashes, callback statement counts, acknowledged
fixture counts and the handoff deadline. `poolClosed` means client shutdown completed, not independent proof
of every server backend's absence. `physicalConnectionAttempts` is `not_observed`. `databaseCleanup` remains
`operator_owned`; database/role/service deletion is not implemented. No table truncation, DROP, cleanup glob,
credential-store change or production action is hidden in this helper. Separately approved exact cleanup and
absence verification are still required. `realPostgresAccepted` always stays false, including native output.

## Verification and remaining live gates

Tests apply real SQL migrations/role grants to an in-memory PGlite database owned by a separate synthetic
migrator. They exercise joined commit, occupied/schema/login rejection, rollback/cancellation/deadline, lost
acknowledgement, failed close, one-use/expired handoff and fresh keys. The generated records and keys feed the
entire reviewed SQL application rehearsal with recorded probe timing. The compiled preparation entry imports
inertly and rejects incomplete inputs with zero pool creation.

PGlite uses one session, exposes `template1`, does not restore its original session identity on RESET, and
cannot revoke template1 TEMP. The test harness explicitly restores its synthetic `postgres` setup identity
and overrides **only test** database-name/TEMP metadata. No runtime override is present. Interrupted injected
sessions may be explicitly rolled back by the test harness for inspection; this is not proof of native driver
termination/rollback. Concurrency, native session absence, real roles/ACLs, actual PG17 service/host, listener,
browser/login and deployment remain unperformed. This block completes repository fixture handoff, not B-PILOT.
