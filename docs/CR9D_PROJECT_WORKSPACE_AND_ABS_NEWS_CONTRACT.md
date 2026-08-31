# CR9D Project Workspace and ABS News contract

**Status:** Architect-frozen for effect-free implementation
**Decision date:** 2026-08-29
**Scope:** Reusable project workspace navigation, owner-facing project extensions, ABS AI/technology news records, story queues, and article-to-work-order proposals
**Authority:** This contract plus ADR-058 through ADR-062 control CR9D implementation. Live collectors, accounts, credentials, agent dispatch, installation, monitoring, publication, and deployment remain separately gated.

## Outcome

Control Room gains a reusable Project Workspace above its existing project, scheduler, worker, approval, review, evidence, and audit domains. The workspace is an owner-facing projection; it is not another scheduler or authority service.

ABS AI and Tech News is the first project extension. It may present verified discoveries and prepare exact work-order proposals such as research, setup guides, comparisons, evaluations, editorial drafts, and bounded monitoring plans. A proposal is not a work item, lease, approval, dispatch, fetch, installation, publication, or external effect.

The owner-facing information flow is:

```text
configured source -> bounded discovery -> canonical page verification
-> story identity/cluster -> important/earlier/archive queue
-> owner selects an action -> exact draft proposal
-> later policy/materialization/review -> canonical work item
-> worker evidence/review -> separately approved publication if any
```

The public [`mreflow/control-center`](https://github.com/mreflow/control-center) repository was used as a product-workflow reference for daily briefs, bounded reading queues, source status, deterministic fallback, and information-to-task interaction. No source code was copied. Its MIT license remains an input to the later CR10 license inventory if code reuse is ever proposed.

## 1. Shared Project Workspace

Every project workspace begins with the same nine ordered sections:

1. Overview
2. Inbox
3. Work
4. Agents
5. Automations
6. Files and artifacts
7. Reviews
8. Activity
9. Settings

A project adapter may append project-specific extension sections, but it cannot replace, reorder, rename, or duplicate a core section. Extension identifiers and kinds are strict bounded codes. Navigation entries are presentation records and carry explicit negative command and execution authority.

The workspace snapshot binds tenant, workspace, project, adapter, project type, authority mode, generation time, exact ordered sections, source-status records, summary counts, optional source high-water, and a canonical digest. Alteration or cross-project reuse fails closed.

## 2. Source status is evidence, not permission

Each source status separates:

- `mode`: `synthetic` or `configured`;
- `state`: `available`, `partial`, `stale`, `unavailable`, or `disabled`;
- bounded safe status code;
- checked and last-success timestamps when known; and
- an optional item count.

An available source must have a check time. A configured source can remain disabled while synthetic fixtures render. A source-status record never grants network authority. `last known` data must remain visibly distinct from a current successful check; missing or failed data never becomes a false zero.

## 3. ABS story boundary

An ABS story binds:

- exact tenant/workspace/project scope;
- stable story and cluster identifiers;
- `important_now`, `earlier`, or `archive` queue;
- bounded title and summary;
- canonical public HTTPS URL and exact host;
- published, discovered, and last-verified time when known;
- `verified` or `review_only` state;
- deterministic priority and coverage count;
- one to 32 exact source-evidence records;
- the verified content digest; and
- the complete story digest.

Canonical display URLs reject credentials, non-HTTPS schemes, explicit ports, queries, fragments, loopback, local/internal hosts, and IP literals. Upstream canonicalization must remove tracking parameters before a story reaches this boundary. A retained URL is evidence and a display link; it does not authorize a fetch. Fetch eligibility later requires a separate typed collector ceiling and SSRF/DNS/redirect policy.

Search snippets, newsletter extraction, AI summaries, and source counts are discovery evidence. They cannot make a story `verified`. Direct canonical-page evidence or another separately frozen verifier is required. A `review_only` story cannot create a work-order proposal.

Raw newsletter bodies, subscriber-specific links, credentials, tokens, prompts, and secret material do not enter the story projection. Newsletter processing later retains only minimized issue metadata, body digest, masked/canonical source evidence, and extracted story records.

## 4. Frozen ABS action catalog

| Action | Deliverable | Route profile | Platform | Risk | Reasoning |
|---|---|---|---|---|---|
| Research this | report | `route.abs.research.deep` | any | low | research deep/high |
| Write a setup guide | setup guide | `route.abs.guide.technical` | any until exact target selection | low | implementation balanced/high |
| Compare products | comparison | `route.abs.comparison.deep` | any | low | research deep/high |
| Evaluate this tool | evaluation | `route.abs.tool.evaluate` | macOS/Windows/Linux/cloud exact selection | medium | implementation balanced/high |
| Draft an ABS article | article draft | `route.abs.article.editorial` | any | low | editorial balanced/high |
| Draft a newsletter item | newsletter draft | `route.abs.newsletter.editorial` | any | low | editorial balanced/medium |
| Draft social posts | social draft | `route.abs.social.editorial` | any | low | editorial balanced/medium |
| Monitor for updates | monitor plan | `route.abs.monitor.bounded` | cloud | low | monitoring bounded/medium |

The catalog is digest-bound. Current model names are deliberately not persisted as authority. The route controller resolves a current eligible model from the reasoning profile and records that decision separately. Platform-neutral actions require `any`; tool evaluation and monitoring require one allowed concrete route.

## 5. Article-to-work-order proposal

Selecting an action prepares an exact draft proposal that binds:

- story identity and digest;
- action and action-catalog digest;
- requested title and bounded goal;
- deliverable, required capability, route profile, platform, risk, reasoning profile, and effort hint;
- sorted source evidence digests and canonical source URLs;
- requesting actor digest and time; and
- a stable idempotency key over all material intent.

The proposal is always `draft`, requires owner review, does not create a work item, and has `dispatchState: not_requested`. It explicitly grants no approval, network, command, lease, or execution authority. Exact replay preserves its idempotency key. A changed goal, story, action, catalog, platform, or other material intent creates a different key. A changed proposal record with an old digest fails closed.

The next block may persist proposals and present an editor. Converting an accepted proposal into a canonical workflow/job remains a separate materialization operation using expected prior state, policy, route eligibility, package selection, and ordinary Control Room audit. Tool installation, account creation, credential use, spending, native execution, monitoring, publication, and other effects still require their normal ceilings and approvals.

## 6. ABS project workspace sections

ABS appends:

1. Daily Brief
2. AI and Tech News
3. Newsletters
4. Companies and People
5. Saved Ideas
6. Research Queue
7. Drafts
8. Published
9. Audience

The daily brief is a projection of already-saved queue state. Opening it cannot recollect sources or spend model tokens. Queue filters and sorting cannot alter verification, priority evidence, or story identity. Archive is a local project classification and cannot delete source evidence or a completed work-order record.

## 7. Public ABS website boundary

Control Room owns private discovery, proposals, jobs, drafts, reviews, approvals, evidence, and publication preparation. The public ABS website consumes only an accepted publication package through a later typed adapter.

Publication requires stable destination idempotency, exact revision/content digest, destination identity, strong approval at the applicable risk, pre-effect marker, destination receipt, and terminal ambiguity handling. A story, draft, accepted review, or `Published` workspace tab cannot itself authorize publication.

## 8. Current implementation ceiling

CR9D-ABS-000 through CR9D-ABS-080 include:

- strict shared workspace and ABS record schemas;
- descriptor-safe and Proxy-rejecting input snapshots;
- deterministic digest binding;
- frozen action catalog;
- proposal-only builder;
- synthetic source/story fixtures;
- an authenticated private SQLite story/source/queue/proposal store with append-only history, restart, replay, and tamper detection;
- injected fake RSS, sitemap, and newsletter collectors with canonicalization, direct-verification containment, clustering, deduplication, and deterministic priority;
- a fake collector-to-store ingestion vertical; and
- a rendered interactive project workspace with filters, evidence detail, archive/restore, and local proposal editing for all eight actions.
- exact accepted/rejected owner review records and Action Inbox projections;
- atomic replay-safe materialization into a canonical draft request, proposed workflow, and proposed zero-effect job;
- an authenticated private control ledger for reviews, materializations, disabled schedules, and append-only synthetic run history; and
- bounded collector/monitor declarations plus terminal restart ambiguity and definite-failure-only synthetic retry rules.
- an exact public unauthenticated RSS/sitemap live-read request and strong-approval binding;
- an HMAC-authenticated at-most-once claim, marker, cleanup, and terminal-outcome ledger; and
- an injected simulation coordinator that has no network path and rejects owner-live authorization.
- an immutable digest-only article publication package with declared Completion Gate evidence;
- exact destination identity, revision-bound idempotency, and high-risk strong-approval binding;
- a protected publication claim/marker/cleanup/outcome ledger; and
- a fake destination that independently absorbs duplicate idempotency keys while recording no public mutation.
- a canonically ordered publication-readiness assessment with explicit current, missing, and expired evidence semantics;
- a repository-owned digest-bound disabled disposition for the nine unmet live-publication gates; and
- an authenticated append-only readiness ledger with exact replay, chronological rollback rejection, and tamper detection.

It does not include a native live transport, live publication adapter, live collector, mailbox, AI provider, network client, source account, credential, active schedule, background monitor, worker dispatch, public website change, or deployment. The owner-live records are frozen contracts, not implemented call paths. Browser drafts are local previews; accepted server-side materialization and publication preparation remain separate from readiness, leasing, execution, and effects.

## 9. Planned implementation blocks

| Block | Output | Model/effort | Effect ceiling |
|---|---|---|---|
| CR9D-ABS-010 | Durable story/source/cluster/queue/proposal store with append-only history and replay | Terra/high | local fake data only |
| CR9D-ABS-020 | Fake RSS/sitemap/newsletter collectors, canonicalization, direct-verification seam, dedupe, priority fallback | Terra/high | injected fakes only |
| CR9D-ABS-030 | Interactive project workspace, filters, story detail, proposal editor, accessibility/responsive QA | Terra/high | no dispatch or network |
| CR9D-ABS-040 | Reviewed proposal-to-canonical-work materialization and Action Inbox integration | Sol/high | proposal remains non-authoritative |
| CR9D-ABS-050 | Bounded schedule/collector/monitor contracts and failure/recovery semantics | Sol/high | no live source until owner packet |
| CR9D-ABS-060 | Exact owner-authorized live read rehearsal, cleanup, privacy and cost evidence | Sol/xhigh | one frozen source set |
| CR9D-ABS-070 | Publication preparation and destination-idempotency contract | Sol/high | no publication |
| CR9D-ABS-080 | Separately owner-authorized ABS publication rehearsal or disabled disposition | Complete: disabled | no rehearsal or publication occurred |

The owner-directed ABS offline lane is complete with publication disabled. Wayfarer returns to the active frontier at CR9B-WF-000. Actual ABS live reads and any later publication attempt remain separate owner-controlled gates.
