# CR14A — first private-beta worker batch contract

**Scope:** Four settled, non-overlapping repository deliverables for the next integrated feature batches.
**State:** Architect-authored contract; capsules are draft/local, not dispatched. No runtime wiring or live authority.
**Wave:** CR14-PRIVATE-UI-1. **Integration target:** `integration/cr14-private-ui-1` (not created by this document).

## Shared rules

Use the existing React/TypeScript/Node dependencies and styles; no installs or new dependencies. Components consume
controlled parent props and issue callbacks only. They never fetch, read environment/storage, start a service,
resolve a credential, choose an authority policy, or write canonical state. The parent controller is implemented
by Codex with the actual authenticated API. No new sample-data page, hidden fake success, local second catalog or
placeholder route. JSX escapes all supplied text; do not render arbitrary HTML or expose raw errors/host details.

The exact types below belong to the named component module; export them with the component. They are presentation
contracts, not wire/auth contracts. Prefer readonly input records. Callback invocation is a request, not evidence of
acceptance. Incoming status and pending/error/result props are parent-controlled; never synthesize a success.
Render tests use `react-dom/server` and `node --import tsx --test`, as existing repository tests do. Add pure helper
tests for transitions/validation where static rendering cannot prove browser interaction; do not claim a browser
click was tested by server rendering. Codex performs mounted browser acceptance during integration.

## CR14B-PROJECT-UI-001 — project catalog and creation

**Retired draft as of CR14B B-WIRE:** Codex implemented the exact components/tests during application
integration before any worker claim. The contract below is retained for review; do not dispatch duplicate work.

Files: `app/components/project-catalog.tsx`, `app/components/project-create-form.tsx`,
`tests/project-catalog.test.tsx`, `tests/project-create-form.test.tsx`.

Export `ProjectCatalog` and `ProjectCreateForm`. Catalog props: `state` (`loading|ready|unavailable`),
`projects` (readonly records: `projectId`, `title`, `summary`, `lifecycle` (`active|paused|completed|archived`)),
and `selectedProjectId?`. Build internal project links from `encodeURIComponent(projectId)` only; no arbitrary
href input. Show lifecycle, explicit loading/unavailable/empty states, and `aria-current` for the selected project.
Keep archived entries discoverable in a separate section; completing/closing a view does not delete a record.

Form props: `pending: boolean`, `result: idle|created|invalid|unavailable` (a string union), and
`onCreate: (draft: { title: string; summary: string }) => void`. Maintain only unsaved form input locally;
trim and require a title of 1-120 characters and a summary of at most 1000. Export a pure `validateProjectDraft`
helper returning `{ ok: true; draft } | { ok: false }`. Semantic labels, pending submit protection and fixed
error messages are required. A valid click invokes the callback; only `result=created` may display success.
No tenant, actor, authority mode, job, project ID or approval is supplied by the form.

Tests: each catalog state/lifecycle and selection; encoded identifiers and safe text; valid/invalid draft
boundaries; pending/result rendering. No use of fixture projects as the production data source.
Integration owner: B-WIRE, after B-AUTH and B-PROJECT-API. Worker completion alone does not satisfy R01/R02.

## CR14B-CONNECTION-UI-001 — connection setup/readiness

Files: `app/components/connection-onboarding.tsx`, `tests/connection-onboarding.test.tsx`.

Export `ConnectionOnboarding`. Props: `state` (`loading|ready|unavailable`) and `connections`, readonly records
with `connectionId`, `displayName`, `platform` (`macos|windows|linux`), `harness` (`hermes|codex`), and `status`
(`not_configured|owner_setup_required|offline|ready|blocked`). No actual hostname, path, token or provider key.
Render explicit platform/harness and a fixed understandable next-step label: not configured -> setup not configured;
owner setup -> owner setup needed; offline -> reconnect pending; ready -> ready for eligible work;
blocked -> needs review. Global unavailable never becomes an empty healthy roster. Distinguish offline from busy.
No connect/SSH/install/update action, command-copy control or credential input is part of this component.

Tests: all statuses, empty/loading/unavailable, duplicate friendly names distinguished by platform/harness,
safe supplied labels, and absence of credential/command/action controls.
Integration owner: B-WIRE for the real protected roster, D-FLEET for live readiness evidence; no invented readiness.

## CR14C-REVIEW-UI-001 — result and revision presentation

Files: `app/components/work-result-review.tsx`, `tests/work-result-review.test.tsx`.

Export `WorkResultReview`. Props: `state` (`loading|ready|unavailable`); optional `result` record with `jobId`,
`projectTitle`, `taskTitle`, `version: number`, `summary`, `reviewState` (`awaiting_review|accepted|changes_requested`),
and readonly `artifacts` (`artifactId`, `label`); `pending: boolean`; `requestState`
(`idle|submitted|conflict|unavailable`); `onOpenArtifact: (artifactId: string) => void`; and
`onRequestReview: (request: { jobId: string; expectedVersion: number; decision: "accept_result" | "request_revision";
reason: string }) => void`.

Artifact buttons request opening by logical ID only. No raw locator/URL/iframe. Decision buttons are enabled only
with a ready awaiting-review record, a non-negative safe integer version and no pending request. A revision needs
a trimmed reason of 1-1000 characters; an acceptance may omit a reason but cannot exceed 1000. Export pure
`buildReviewRequest(result, decision, reason)` returning the request or `undefined` for invalid inputs/state/version.
Incoming accepted state means the result review was accepted, not permission to run/publish/deploy. Label actions
"Accept result" / "Request changes" and submission as awaiting server confirmation. Conflict tells the owner to
refresh the result; do not resubmit automatically. Never show local callback completion as accepted review.

Tests: all states, safe artifact display, pending/terminal disablement, version binding, revision validation,
conflict display, no raw locator and no approval/execution claim.
Integration owner: C-WORK using existing review/revision authority, followed by C-REHEARSE.

## CR14F-NEWS-CORE-001 — useful daily digest selection

Files: `src/project-adapters/abs-news/v1/digest-selection.ts`, `tests/abs-news-digest-selection.test.ts`.

Export `selectAbsNewsDigestV1(stories, options)` using existing `AbsNewsStoryV1` records. Inputs are readonly
normalized stories; options require explicit `nowMs`, `windowHours`, `limit`, `maxPerSource`, `minimumScore`.
No implicit clock, collector, storage, hash rewrite or upstream download. Validate finite time/score; windowHours
must be >0 and <=168, limit/maxPerSource integers 1-100, minimumScore 0-100. Invalid options throw a fixed
`invalid_digest_options` error. Never mutate input records or their content/story/evidence digests.

Selection policy: consider only `verified` non-archive stories meeting minimumScore with parseable
`publishedAt ?? discoveredAt`, no future timestamp and age <= windowHours. Sort descending priorityScore,
then descending chosen timestamp, then ascending storyId using deterministic code-point comparison. Keep at most
one story per clusterId; apply maxPerSource using canonicalHost, not a display label, and the overall limit.
Return `{ selectedStoryIds: string[]; deferredStoryIds: string[] }`, with selected IDs in ranked order and every
distinct unselected input ID once in deterministic storyId order. Identical duplicate IDs are coalesced; conflicting
records sharing a storyId (different storyDigest) throw fixed `conflicting_story_identity`. This is relevance
presentation, not verification, authorization, immutable story rebuilding or task dispatch.

Tests: exact time boundary, future/invalid dates, archived/unverified stories, score threshold, cluster duplicates,
source diversity, deterministic ties/permutations, duplicate identity behavior, caps and frozen-input nonmutation.
Use original code from this frozen contract; upstream curation is a design reference, not copied code in this capsule.
Integration owner: F-COLLECT/F-WORK; connect live authenticated store results without replacing existing archive/dedup.

## Publication and verification

The exact allowed paths above are disjoint. The capsule's result-manifest path is the only extra metadata path.
Each job allows two focused ordinary code repairs, no effects and three concurrent claims per route. Codex
reviews every result; these low-risk presentation/ranking modules do not require separate calibration or the
controlled-native qualification process. Shared controllers/styles/routes and all wire/security/schema decisions
remain Codex integration work. Final parent-phase acceptance exercises the mounted UI against the real backend.

Draft validation checks structure only. Publishing requires `ready` capsules, the committed shared contract,
reachable integration base, canonical issue generation and the serialized `CLAIM ACCEPTED` response. No agent may
claim by editing a draft or start directly from this document. Follow `skills/agent-build-worker/SKILL.md`.
