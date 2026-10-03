# Control Room Module Contract v1

Status: contract, parser, bundle verifier, and owner approval ledger. Schema id: `control-room.module-manifest/v1`.

This contract is the one boundary between a module and Control Room. A module
does not become trusted because it has a manifest, appears in a project pack,
or is enabled. Installation records what the owner approved; runtime checks
that record and the manifest before each protected operation.

## Non-negotiable safety line

**A DECLARATIVE module contains configuration, templates, prompts, and a
settings schema only. It contains no code and may be shared by anyone. A CODE
module contains executable material and may be installed only from a reviewed
or trusted signed source. Before installing one, Control Room must warn the
owner plainly that the module can run code and identify the source and exact
digest.**

Neither class receives a PostgreSQL login, database role, connection string,
credential, general scheduler client, or general execution capability. The
manifest is a request for bounded permissions, not a permission grant.

## Manifest

The canonical manifest is inert JSON. The v1 parser rejects unknown keys,
unknown schema versions, invalid ids or semantic versions, oversized or deeply
nested input, control characters, executable-content markers,
credential-shaped or authority-shaped text, and prototype-pollution keys at
any depth. Parsed manifests are isolated from caller mutation and deeply
frozen.

Required top-level fields:

- `schema`: exactly `control-room.module-manifest/v1`.
- `id`: stable module id. It is identity, not a display label.
- `version`: an exact SemVer version.
- `name`, `publisher`, `license`: bounded display name, descriptive publisher,
  and SPDX-shaped license identifier. `publisher` alone proves no identity.
- `controlRoomCompatibility`: the supported Control Room SemVer range.
- `class`: `declarative` or `code`.
- `permissions`, `ui`, and `events`: the complete declarations described
  below.
- `skills`: optional named, integer-versioned instruction blocks. Each block is
  inert text with a content digest; importing or referencing it cannot execute
  code or grant authority.
- `data`: optional only when the module owns no data. If present, it requires
  an isolated schema namespace, project and tenant scoping, and paired up/down
  migration files.

The owner sees the exact parsed manifest and bundle digest before install and
approves the declarations as one installation record. An upgrade is a new
approval when the manifest, version, class, permissions, bundle digest, or
signer changes. Runtime authorization is always the intersection of:

1. the installed exact module id and version;
2. the permissions declared by that version;
3. the owner's still-current approval;
4. the current tenant, project, user, and Control Room policy.

A manifest can narrow authority. It can never widen authority supplied by the
host.

## Shared skills

`skills` is available only when `class` is `declarative`; code-class modules
cannot carry shared skills. It is the portable path for reusable instructions. Each
entry contains an id, display name, positive version, bounded instruction text,
and a digest over those exact fields. A changed instruction is a new version;
an existing version is immutable. Task and pipeline-stage records cite exact
`id` plus `version` pairs and retain the resolved digest. A skill is text data,
not a command, hook, executable, credential, permission, approval, assignment,
or retry policy. Module parsing applies the same printable, credential,
authority, executable-marker, size, and prototype-pollution refusals to it as
to every other declarative manifest field.

## Declared permissions

`permissions.projectData` lists each table or logical collection by stable
resource name and its `read` and/or `write` access. No wildcard, schema-wide,
database-wide, cross-project, or cross-tenant scope exists. The runtime helper
returns a frozen receipt bound to module id, module version, tenant id, project
id, resource, and access. Storage adapters must require that receipt and must
still bind every query to the same tenant and project.

`taskTemplates` and `pipelineTemplates` list templates the module may propose.
They are not jobs and do not authorize creation, dispatch, approval, or
execution. `workerCapabilities` lists capabilities that a later approved task
may require; it does not select or impersonate a worker.

`notifications` declares named display slots and a per-hour ceiling.
`attention` declares named Needs-you slots and a maximum number open per
project. A zero ceiling means the channel is unavailable.

`scheduledJobs` declares named job kinds and finite limits for concurrency,
runs per day, and runtime. A module submits proposals only to the single
Control Room scheduler. It cannot create its own timer, recurrence store,
queue, lease, worker, or retry loop. Empty job declarations require all limits
to be zero. The canonical scheduler applies owner enablement, admission,
deduplication, cancellation, recovery, and narrower system limits.

## Module data and migrations

New owned data lives in the manifest's deterministic `module_<id>` schema
namespace (camel-case boundaries and `.`/`-` become `_`, then lowercase). Every
owned row is tenant-scoped and project-scoped; a module may not use a global
row as a shortcut. Each migration declaration has an exact SemVer version and
both an up file and a down file. Install and upgrade run through Control Room's
single reviewed migration mechanism as a schema owner, never as module code
and never with a module-supplied database login.

Migration rules:

- Migrations are ordered, digest-bound bundle files and run once.
- Up and down files must preserve tenant/project isolation, foreign keys, row
  bounds, and least privilege.
- An upgrade failure stops the upgrade. Control Room keeps the previous active
  version and records the failure; it does not retry effects blindly.
- Disable never drops data. Uninstall requires an explicit owner choice to
  keep data or run the reviewed down path and delete it.
- A stopped or crashed migration is reconciled from the canonical migration
  ledger before another attempt.

## UI extension points

A module may declare:

- project tabs;
- one navigation entry, visible only while the module is enabled;
- a settings form described by the contract's restricted JSON Schema subset;
- whether it can contribute Needs-you items.

Labels and settings descriptions are inert text. Module HTML, JavaScript,
event handlers, remote components, arbitrary JSON Schema keywords, and
unbounded settings are refused. Control Room renders its own components and
enforces its own accessibility, origin, authorization, and project-routing
rules. UI visibility is never authorization.

## Work creation

Modules create proposals only. A task template, pipeline template, schedule,
button, event subscription, or prompt can produce an inert proposed work
record. Nothing in a module manifest may approve, assign, dispatch, run,
publish, accept, or retry that proposal. Work moves only through the canonical
owner approval, task, pipeline, scheduler, worker, evidence, review, and
acceptance paths.

## Events and notifications

`events.subscribe` is an allowlist of project-event kinds. The event broker
delivers a tenant/project-filtered, minimized event projection; it does not
hand out a database cursor or replay authority. Delivery is bounded and
idempotent. Missing, duplicated, delayed, or reordered events must be safe.

`events.emitNotifications` allows the module to propose notifications, still
subject to its declared slots and ceiling and the canonical notification
policy. A module cannot emit a notification to obtain attention, approval, or
execution authority.

## Lifecycle

1. **Install:** verify canonical bundle bytes, digest, signature/source policy,
   manifest, compatibility, class, and migration plan; show the owner the
   declarations; record exact approval; then stage files and migrations.
2. **Enable:** enable per tenant/project. Enabling exposes declared UI and event
   subscriptions but grants only the approved runtime intersection.
3. **Disable:** stop new proposals, schedules, subscriptions, and UI exposure;
   let canonical in-flight work reach a safe terminal state; retain data.
4. **Upgrade:** verify and approve the new exact version and digest, reconcile
   old work, apply reviewed ordered migrations, then switch atomically. Failure
   leaves the old version active or the module disabled, never half-enabled.
5. **Uninstall:** disable first, prove no in-flight work, remove installed
   files and approvals, and ask the owner to keep data or delete it through the
   reviewed down migrations. Deletion is never the default.

Install, enable, disable, upgrade, and uninstall are idempotent owner-attended
operations. A second concurrent caller must observe the same installation
ledger and either replay the completed result or receive a conflict. A crash
or stop halfway must be reconciled before continuation.

## Packaging, digest, and trust

A distributable module is one canonical bundle containing the manifest and a
bounded file inventory. Paths are relative, normalized, unique, and cannot
escape the bundle. The bundle digest uses the same canonical digest machinery
as project packs: canonical JSON plus the shared domain-separated SHA-256
helper. The domain is `control-room.module-bundle/v1`, and the digest covers
the parsed manifest plus every file path, length, and content digest. The
signature signs that exact bundle digest, not a mutable archive filename or
catalog page.

Declarative bundles may be shared by anyone, but their digest and parser
checks still apply. Code bundles need a source allowed by owner policy: a
reviewed local source or a signature chaining to an owner-trusted publisher.
A valid signature proves which key signed exact bytes; it does not prove the
code is safe. Control Room shows the CODE warning and permission diff before
approval. Catalog status, popularity, publisher text, and project-pack
inclusion are not trust proofs.

## Project packs v2

Project pack v1 remains supported unchanged. Its `optionalModules` legacy
names resolve through the local registry so existing packs retain their
behavior.

Project pack v2 uses `modules: [{ "id": "news", "version": "1.0.0" }]`.
References are exact id-plus-version pairs in canonical id order. A pack may
portably reference a module not installed locally; preview reports it as
missing. A reference does not install, enable, download, approve, or trust a
module. The owner must complete the module lifecycle separately.

## Existing module mapping

### News

News is registered as CODE module `news@1.0.0`. Its manifest declares the
existing news collections individually, its research task and source-research
pipeline proposals, public-fetch and extraction worker requirements, the News
project tab and navigation entry, bounded notifications and Needs-you items,
and the `news.feed-collection` scheduled job with finite limits. Its existing
feed path must continue to use the single scheduler and proposal path.

News predates this contract, so its current tables live in `public` under
`control_news_*`. The registered manifest treats those tables as explicit
compatibility resources; it does not pretend they are a v1 module namespace.
Moving them into `module_news` needs a separately reviewed migration with down
files and role verification. Until then, News can be a built-in registered
module but is not a portable install/uninstall bundle.

### Idea Lab

Idea Lab is registered as CODE module `ideaLab@1.0.0`. Its manifest declares
the existing idea session, contribution, synthesis, decision, and canonical
task-link resources, the panel and synthesis proposals, reasoning capability,
Idea Lab project UI, notifications, Needs-you decision items, and project
event subscriptions. Its proposals still require normal owner approval and
never execute themselves.

Idea Lab also predates the contract. Its `control_idea_*` tables are explicit
compatibility resources in `public`, not compliant namespaced module data.
The same separately reviewed namespace/down-migration work is required before
it can be distributed as an installable bundle.

Session Observations is also registered so the prior product configuration
shape and ordering remain compatible. A later slice should complete its
detailed mapping before making it downloadable.

## Threats and mitigations

| Threat | Required mitigation |
| --- | --- |
| Manifest smuggles code or commands | Inert JSON schema; restricted settings schema; executable-shaped text refusal; no hooks or command fields |
| Secret or authority smuggling | Credential- and authority-shaped text refusal; unknown-key refusal; no database role or credential field |
| Prototype pollution or parser confusion | Forbidden keys at every depth, depth/byte ceilings, strict schemas, isolated frozen result, exact schema version |
| Permission inflation on upgrade | Exact version and digest, visible permission diff, fresh owner approval, runtime intersection |
| Cross-tenant/project access | Scope-bound permission receipt plus storage adapter tenant/project predicates and foreign keys |
| Confused deputy through UI or events | UI is presentation only; minimized scoped events; every protected operation reauthorizes |
| Project pack installs trusted code | Pack references only; separate bundle verification, CODE warning, and install approval |
| Scheduler bypass or retry storm | One scheduler, declared job allowlist, finite ceilings, canonical leases/idempotency/cancellation/recovery |
| Malicious migration | CODE-source trust, reviewed digest-bound up/down files, schema-owner runner, transaction/reconciliation, least-privilege verification |
| Signature or catalog substitution | Signature over canonical bundle digest; trusted-key policy; exact digest pinned in installation record |
| Disable/uninstall races | Canonical lifecycle ledger, stop new intake, drain/reconcile in-flight work, explicit keep/delete choice |
| Denial of service | Manifest, array, text, notification, attention, schedule, settings, migration, and runtime ceilings |

## Bundle verification and owner approval (second slice)

`src/modules/v1/bundle.ts` verifies a `control-room.module-bundle/v1` bundle:
`{ schema, manifest, files: [{ path, contentBase64 }] }`. Paths are lowercase,
relative, at most eight segments, and every segment starts with a letter or
digit, so `.`/`..`, absolute paths, and case collisions cannot occur. No
segment may end in a dot or be a Windows device name (`con`, `aux`, `nul`,
`prn`, `com0`–`com9`, `lpt0`–`lpt9`, with or without an extension), and no
file may also be a directory of another file. Content
must use canonical base64; each file is at most 1 MiB, the bundle at most
8 MiB and 256 files. The digest is order-independent and covers the parsed
manifest plus each file's path, length, and content digest.

A signature is `{ schema: "control-room.module-signature/v1", keyId,
bundleDigest, signature }`: Ed25519 over the canonical JSON of the purpose, key
id, bundle digest, module id, and version. The verifier recomputes the digest,
refuses an envelope naming any other digest, and checks the signature only
against the key the owner's trust policy holds for that key id, which must also
be allowed to vouch for that module id. A present signature is never ignored:
an untrusted or invalid signature fails even on a DECLARATIVE bundle.
DECLARATIVE bundles may carry only UTF-8 `.json`, `.md`, and `.txt` text and
may not declare migrations. Because anyone may share them, every file is also
checked as a reviewer would read it: no C0 or C1 control characters (tab, LF,
and CR aside), no invisible or direction-changing characters (bidi controls,
zero-width characters, a byte order mark, Unicode tag characters), and no
embedded script or shell (`<script>` and other active tags, `javascript:` or
`vbscript:` even with inner whitespace or character references, an HTML
`data:` URL, an `on*=` handler inside a tag or after a quote, `$(`). `.json`
files must be strict JSON with no duplicate or prototype keys, and their
decoded strings and keys get the same checks. Renderers must still escape this
text; the verifier is a second line. Credential- and authority-shaped wording
is not refused in file bodies, since prompt prose legitimately says
"role: reviewer". CODE bundles need a trusted signature or an exact
reviewed-digest pin, and every declared migration file must be present. The
host version must satisfy `controlRoomCompatibility`.

`control_module_install_approvals` (migration 0195) records each owner
approval: exact bundle digest, parsed manifest, authority-surface digest,
trust source and signer, acknowledged CODE warning, and the permission diff the
owner saw. Approvals for one module form an append-only chain (one root, at
most one successor per approval), so the chain head is the current approval,
two concurrent approvals of the same head cannot both land, and a superseded
approval never becomes current again. Among application logins, only the
private web login holds SELECT and INSERT; the backup login can read the table
through its blanket backup grant, and the migrator owns it (the append-only
triggers still refuse UPDATE, DELETE, and TRUNCATE). A trigger requires the active human owner with a
tenant-wide `modules.install` grant (critical for CODE) and a current
timestamp. Rows carry a record digest and HMAC tag and fail closed when read.

`ModuleInstallApprovalServiceV1` re-verifies the bundle on every call. Approval
requires the digest, trust source (`expectedSource: { kind, keyId }`, the
signer's key id or null), current approval, and permission-diff digest the
owner was shown, plus the CODE warning acknowledgement. A bundle that arrives
at approval with a different source kind or a different signer, even another
trusted one, is a conflict, so the row records the source the owner saw. `assertApproved` is the gate for
a later installer: a different version, byte, permission surface, trust
source, or signer, or a signer the owner no longer trusts, all need a new
approval. Nothing in this slice loads, stages, executes, or migrates a module.

## Code boundary

The implementation provides the strict parser, immutable registry, exact
lookup, project-data permission helper, project-pack v2 parser/builder, the
bundle verifier, and the approval ledger. It does not yet provide a
downloader, owner approval screen, installer, migration runner, event broker,
or module file loader. Existing module code remains built in. Those later
components must consume this contract and must not introduce a second
scheduler, database authority, task path, or trust decision.
