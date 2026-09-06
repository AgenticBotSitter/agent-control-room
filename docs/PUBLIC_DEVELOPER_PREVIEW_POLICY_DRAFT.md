# Agent Control Room developer-preview policy — draft

2026-09-06. Proposed against private baseline `46bbbd6`. Requires review before an
application source export is assembled. This document grants no publication, account,
license, installation, live-agent or deployment authority.

## Why a separate policy

The requested public product is a runnable, project-neutral application that other
people can help build. The accepted `control-room-public-package/v1` contract concerns
an effect-free SDK candidate with eight restricted roots. It remains unchanged and
continues to govern packages claiming that contract. Its publisher stays disabled.

The proposed developer preview is a separate source distribution. It must not reuse an
old SDK acceptance record, certification label or passing verifier result to describe
the application. No new publisher, signer, release service or policy engine is needed:
use reviewed files, ordinary Git history and a small release checklist.

## Three different deliverables

| Deliverable | What a recipient should actually get | What it does not establish |
|---|---|---|
| Project announcement | Public vision, architecture, honest status and contribution plan | Source availability or a working installation |
| Runnable developer preview | Reviewed source, pinned preparation/build/test instructions and an explicitly synthetic local demo | Qualified real agents, a production database, production security acceptance or supported unattended deployment |
| Supported operational release | Specified supported platforms/runtimes plus demonstrated real task/review/recovery and reviewed installation/update procedures | Permission to access another person's resources or inherit our credentials |

Publishing only the announcement is possible, but it must not be described as the
runnable preview. Publishing source that compiles but lacks a usable demo also does
not satisfy the preview target. Each deliverable needs its own exact approval.

## Source inclusion rules

Source implementing authentication, queues, connectors or bounded effects may be
included after review. Publishing that implementation does not authorize executing it
against any resource. The demo must use synthetic participants and disposable data,
with no automatic provider calls, credential discovery, enrollment or live dispatch.

Select the complete application and contributor verification inputs, not just the
files that happen to pass an import scanner. Include framework routes/middleware,
compiler/build configuration, required SQL and fixture inputs, reviewed assets and
third-party notices. Preserve regression coverage for the distributed functionality.
Keep one modular monolith, one global PostgreSQL write authority and optional workflow
modules over the same core services. PGlite is a development/test choice only.

Every candidate path needs an explicit decision based on its content:

- Include generic source or deliberately synthetic fixtures with adequate rights.
- Adapt mixed source/configuration, then inspect and test the resulting bytes again.
- Exclude private data, operator configuration, credentials, trust/enrollment records,
  actual host details, original project histories, internal reviews and artifacts.
- Leave unresolved material out of the candidate until resolved; if required for the
  promised demo, that blocks the preview rather than justifying a broken export.

Do not rename private records and call them synthetic. Preserve the private originals
and accepted historical identifiers. Generalize Content Blooms and other personal
branding in the public experience without deleting reusable workflow capabilities.

## Evidence before first publication

Use one checklist associated with the exact proposed public Git tree, not a new series
of approval services. Keep private source-to-candidate provenance outside that tree.

| Required evidence | Concrete completion condition |
|---|---|
| Exact content scope | Each included path and hash reviewed; no implicit copying of ignored/untracked files, private Git history, caches or runtime output |
| Privacy and credentials | Automated checks plus human/independent review of the exact candidate; inspect configuration, examples, screenshots and documentation as well as code; investigate findings without placing raw secrets in reports |
| Rights and attribution | Owner selects a license for code they can license; copied/adapted upstream material retains its own applicable notices; asset provenance and bundled/distributed dependency obligations resolved for this deliverable |
| Dependency scope | Frozen lockfile and exact direct/transitive inventory for the source setup; distinguish downloaded development tools, bundled browser code, server artifacts and native/WASM payloads; a local-store scan alone is insufficient |
| Clean contributor preparation | Documented Node/package-manager versions; fresh candidate installs without private registries, account credentials or maintainer absolute paths; installation/downloads separately authorized for the rehearsal |
| Build and regression | Standalone strict type check, build and relevant synthetic runtime tests pass in the isolated candidate, including SQL/assets/helpers; omitted private-only checks documented, not silently counted as passes |
| Usable synthetic demo | A contributor can open a project, submit a simulated task, see progress, inspect its result and request a revision; visibly synthetic, no real agent claimed; controlled shutdown leaves no continuing work |
| Independent candidate review | A reviewer other than the candidate preparer examines exact bytes, privacy findings and rehearsal evidence; findings resolved or the candidate stays unpublished |
| Owner publication decision | Approval names destination, tree/revision, license, attribution/contact and preview status; approve a new candidate if reviewed content changes materially |

Evidence of a synthetic demo is not evidence of real PostgreSQL, Hermes, Codex, fleet
reconnect, backup restoration or production key custody. Track these separately on the
public roadmap as unfinished. Do not remove runtime authorization checks to make the
demo easier; provide synthetic implementations through existing test/configuration seams.

Original-code license selection and public account/brand/contact decisions belong to
the owner. This draft neither selects Apache-2.0 nor grants rights based on placeholder
license identifiers. No private originals, downloaded libraries or useful components
should be deleted merely to simplify the checklist.

## Public repository and contribution boundary

Start a separate public repository with reviewed fresh history; leave the private
repository's visibility and history intact. Do not mirror branches automatically or
add a public push remote to the private checkout. After cutover, shared product changes
belong upstream in the public repository and private deployments consume reviewed pins.

Use ordinary issues and PRs. Contributors need neither our private worker queue nor
our running Control Room to contribute. Ready issues specify outcome, platform,
dependencies, exact base, allowed scope and completion tests. Contributors can submit
multiple independent PRs while reviews proceed. Blocked work needs a reproducible
handoff and release of assignment, not a permanent failure for needing another attempt.

An accountable maintainer reviews before merge; assistant reviews are evidence, not
additional GitHub identities. Changes to security boundaries, SQL authority, connectors,
dependency/install behavior or CI receive additional risk-appropriate review. Do not
run untrusted contributions on owner machines with their credentials. Future public CI
uses disposable runners, no private secrets and bounded execution; its configuration
and use remain unapproved during the current no-Actions pause.

## Transition from the existing contracts

Accept this distinct distribution scope through explicit review before assembly. Do
not edit the old v1 schema, eight-root registry, evidence expiry, certification tests
or disabled publisher to make application paths pass. No existing SDK signing or
certification status transfers. If a future supported release claims one of those
contracts, it must satisfy that contract or undergo its own explicit revision review.

The first source preview uses honest pre-alpha labeling, not production certification.
It still requires the exact privacy, rights and clean-setup evidence above. A future
operational release requires its own security, native compatibility, real database,
restore/update and support decisions. Public availability does not close those tasks.

## Current evidence and next action

Local strict standalone checking and compiled synthetic tests exist. The tracked-path
inventory is still a proposal, the exact-content review is partial, dependency/asset
rights review is incomplete, and no clean exported demo rehearsal has passed. There is
no approved destination, original-code license or public candidate.

Next: review this scope, complete the candidate file/rights decisions, then assemble
and rehearse an isolated local candidate under approved authority. Do not publish this
private draft verbatim: its private baseline and internal planning references are not
part of the public contribution guide.
