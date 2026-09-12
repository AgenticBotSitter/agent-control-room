# Source-content review for public refresh

Private receipt, 2026-09-08. User requested the latest sanitized public source.
This is per-file disclosure review, not whole-tree release approval or runtime
acceptance. The first attempted three-file preparation was rejected because it
lacked per-file review evidence; no workaround was attempted. The root then read
all three files completely before making the following determinations.

## UI batch 1 — reviewed for local candidate preparation

- private-app/app/idea-create-form.tsx
  SHA256 f9391cbdad4b462560d5062273592ba3b23f044b0a1688780aa549a666efc560
- private-app/app/idea-decision-form.tsx
  SHA256 186f31f4e91bb909e067ecfdf87229a4b20af0395c5112da49e067f935175ba8
- private-app/app/idea-start-control.tsx
  SHA256 9fb97bccdf7c9e152d58be2e37bbda4eae0a6d39ccd54345cdb10997fef55499

Each is generic React UI authored for the requested open-source Idea Lab feature.
Imports are repository-relative modules/React, not private services. Identifiers,
participant names and project content come from props or request results; no actual
owner/session/participant data is embedded. URLs are relative application routes.
No credentials, tokens, real hostnames, filesystem home paths, personal names,
private infrastructure addresses or customer branding appear. Static strings are
generic UI labels, limits and error explanations. Project ID construction uses
the supplied session digest, not a real saved project. No borrowed-code attribution
header is removed; no donor code is identified in these three original files.

Disposition: suitable for the local public-source candidate under the user's
sanitized publication request. The imports are not yet fully staged, so these
files alone are not a buildable or approved release. No remote publication until
complete source/dependency/schema/privacy review and verification pass.

## UI batch 2 — reviewed for local candidate preparation

Root read the complete idea-stop-control.tsx, idea-synthesis-control.tsx and
idea-workspace.tsx beneath private-app/app. Exact hashes are in the frozen
public-refresh-build-closure.json and checked before patch emission. These are
generic stop/recap controls and saved-discussion rendering. Actual participant
names, opinions, session IDs, costs and timestamps are supplied at runtime, not
embedded records. Paths are relative app routes; no private hostnames, credentials,
personal data or filesystem paths appear. Explicit synthetic/live distinctions
and uncertain-start warnings are preserved. Five-second bounded observation is
code, not an enabled service in this candidate. No donor attribution is removed.
Suitable for local candidate preparation only; runtime and whole-release review
remain outstanding.

## Schema supplement 0059–0064 — root content review

Read all six complete SQL files: 0059_abs_news_postgres,
0060_abs_source_observations, 0061_abs_feed_plans,
0062_abs_discovery_baselines, 0063_abs_source_settings and
0064_abs_story_archives. They contain generic table/index/trigger definitions,
not data inserts, populated identities, live URLs, credentials or grants.
The abs namespace denotes the openly discussed news adapter, not private customer
records. Retain existing generic public migrations 0025/0026 unchanged. Adding
these definitions to the local candidate does not apply them to any database or
authorize production provisioning. Their public fingerprint still needs generation
from the resulting public migration set and verification before publication.

## Database preflight — root-owned reconciliation

Read all 308 lines of the current private-database-preflight.ts in complete
chunks. It contains generic contract table/role names, parameterized runtime
identity/database inputs and read-only permission/catalog checks. No populated
identity, password, host, tenant or customer record is embedded. Preserve the
full policy implementation; adapt only the schema-digest constant/comment for
the public migration set. Do not weaken permissions or add alternate accepted
digests. Two sequential disposable PGlite runs reproduced the old public digest
after migration0058 and the new digest after0064; second complete output retained
in public-schema-refresh-evidence.json (first terminal output was truncated).
Both completed and closed their one in-memory database. New digest:
8a58c3e600c32b046af83274cdcd3ecf0fb7d517c3a133961b44680e568a2d96.
This is development schema evidence, not real PostgreSQL restore acceptance.
The private production fingerprint and historical migrations are not modified.

## Attribution supplement

Root read the complete Control Center NOTICE.md and MIT LICENSE, and rss-parser
NOTICE.md and MIT LICENSE. They identify public upstream repositories, revisions,
copyright holders and actual adaptation boundaries. No private credentials or
infrastructure appear. Preserve full original license text. Public notice may
omit the internal E03 receipt label and clarify that source-test comparisons
described in provenance are not necessarily shipped tests. No license entitlement
is inferred for article content or unrelated donor files.

## Independently read UI/ABS/vendor cohort — root disposition

Reviewed the independent findings in public-refresh-ui-content-review.md and its
57-path full-content/hash coverage. Scope excludes runtime private data; static
ABS names intentionally identify the user-approved public news feature. Root has
now reconciled the public Control Center notice to the full donor scope and
retained its MIT LICENSE; added rss-parser notice/license separately. Accept
these exact 57 source hashes for local candidate preparation, contingent on final
import/build/dependency/license tests. The patch emitter now permits only entries
matching this review inventory, not the whole compiler closure. This is not
permission to copy unreconciled configuration or publish an incomplete build.

## Web cohort — root disposition

Independent complete-content report now covers all 66 selected web modules with
exact manifest-matching hashes. Root reviewed its full findings/method/limits.
Reserved .invalid and loopback demo literals are generic, ABS naming is intended,
and secrets/identities remain parameters rather than populated private records.
Accept these exact reviewed hashes for local candidate preparation. Maintain
separate root-owned public schema reconciliation and donor notices. No runtime,
production, or whole-release approval follows from this content review.

## Native and supporting cohorts — root disposition

Read the full finding narratives from the completed 25-file native and 41-file
support reviews. Runtime credentials remain supplied data; test fixtures use
generated keys and explicit synthetic values. Accept exact reviewed hashes for
local candidate preparation, EXCEPT styles/control-room.css (SUPPORT-D1), held
for removal of unused consumer-specific selectors. Manifest-wide text inspection
finds no other Wayfarer reference except the already-held compiled handler test.
No current runtime source imports those style names. The three sanitizer test
merges and operator configuration remain separately held. No deployed data or
private Git history is included. This does not qualify the runtime or approve
publication before staged verification.

## Approval issuer copy rejection — additional root inspection

The copy of src/harness/v1/native-owner-approval-issuer.ts was stopped by review
as possible new native approval authority. Root read the entire 79-line source.
It is pre-existing generic source (introduced by private commit68e8af3), not a new
implementation in this task. Importing it only defines an exported factory.
Neither this export task nor patch emission calls that factory or issue(). It
contains no private key, credential-store API, filesystem access, native process,
transport or persistence. Signing and consent are required injected callbacks;
the factory supplies neither. The explicit consent guard is checked around the
caller-supplied signing operation; retries after an attempt are refused.

Current user authority is sanitized open-source publication, not the historical
single unwired-loopback qualification. Copying this exact reviewed definition to
an unpublished local source candidate is within that publication preparation;
executing a real signing/consent/custody operation is not requested or authorized
here. Root accepts local source preparation only. No guard is removed, no key
provided, no approval packet produced, no production wiring or deployment changed.

## SUPPORT-D1 stylesheet disposition

Use the already-installed PostCSS parser to remove only rules containing the
unused .wayfarer- selector namespace and its naming comment. Read-only manifest
check confirms no non-test source in the export closure refers to Wayfarer.
133 consumer selectors removed; no mixed consumer/generic selector rule exists.
Parsed-rule comparison proves every retained selector's declarations and enclosing
at-rules remain unchanged. Output parses successfully; hash
8e90f845cfeed670b834b36a4688ab99947f00cc3f9ce6a0d66ccd7ccade60e7.
This sanitizes the already fully reviewed stylesheet without removing a shipped
view or changing the private stylesheet. Explicitly accept this derivative for
local candidate preparation. The blocked signing-helper source remains held.

## Sanitizer test reconciliation

Compared full diffs of the three held tests/helpers against the current private
version. web-foundation.ts and vps-built-core-schema.test.mjs differ ONLY in the
intentional generic migration/table names; retain existing public bytes unchanged.
For vps-built-handler.test.mjs, apply only new generic Idea lifecycle/page/logout
expectations, preserving the public test's generic catalog non-disclosure check
instead of restoring the private consumer-name regex. These are assertions over
synthetic fixtures, not real owner data or changes to signing authority. Full
compiled test execution remains pending complete candidate preparation.

## Database setup source supplement

Root read complete SQL for idea_creation_roles, idea_runtime_roles,
news_coordinator_roles, news_ingestion_roles, news_queue_producer_roles,
private_web_roles and private_idea_adapter setup. All are generic, existing source
templates; there are no LOGIN passwords, actual tenant values or production
addresses. They explicitly require offline operator invocation. Idea adapter
registration uses a supplied session setting, not a real tenant constant.
The queue template checks an existing queue and does not start a worker. Accept
these exact source definitions for local candidate preparation only. Do not run
them, create roles, grant permissions or provision a database in this task. This
is independent of the denied signing-helper copy; that file remains held and
these SQL templates do not substitute for it or enable a build to bypass it.

## Owner approval received

The owner replied "I approve the exporting" to the explicit question about
including native-owner-approval-issuer.ts in sanitized public source without
execution, keys, signing approvals or deployment. This supplies the requested
export authority after the two rejections. Remove that file's preparation hold;
retain all runtime/provisioning restrictions. Previously recorded full-content
review and exact source hashes still apply. No signing operation is authorized.

## Server session source-copy review clarification

The export of src/node-control/server-node-session.ts was rejected as possible
runtime wiring. It is existing implementation from private commit19e8c12, already
fully reviewed in the native cohort, not new runtime wiring authored by this task.
Root additionally inspected its exported class, constructor and injected ports:
the source provides no listener, key loader or transport implementation. Signing,
authentication and send are supplied interfaces. Merely copying these definitions
does not instantiate the class or call any session method. The owner's new export
approval covers preparing existing sanitized source, not invoking it. No app
configuration, keys, listener, worker or native service is changed by this patch.
Proceed only as source publication preparation; retain the no-execution boundary.

## Generic operator template

Root reread deploy/operator-config.mjs completely. This tracked source defines
createConfiguration; it contains no actual settings, hostnames, audience, owner
subject, password or key. Only an explicitly invoked function reads the supplied
CONTROL_ROOM_SETTINGS_FILE path. It is a website-only factory, not a deployment,
daemon or populated configuration. Include this exact generic source for the
compiled synthetic startup tests; do not call it against owner environment or
include any settings file. Its imported build outputs must be built separately.
No connection or secret-store operation is authorized by this source preparation.
