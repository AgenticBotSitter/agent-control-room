# Saved news collection progress

The source-refresh panel now discovers retained collection progress and follows
the exact job after a proposal or approval. It uses the existing signed feed plans,
canonical jobs/effects and coordinator role. No new database, migration, queue,
collector, provider or external service is introduced.

## What the owner sees

- Prepared: a saved plan, not an approved collection.
- Queued: retained authorized effect and assigned/ready job; no live connection claim.
- Running: retained running job and executing effect.
- Completed: succeeded job and confirmed effect with a recorded receipt digest.
- Failed/cancelled: matching terminal records.
- Uncertain: missing or incompatible settlement, including ambiguous/orphaned work.

Completion is saved execution evidence, not independent revalidation of the news.
A successful collection can find zero new articles. The completion link opens
saved news; collection jobs are not passed to the ordinary agent-task page.

## Reading and recovery

`GET /api/v1/projects/:projectId/news/sources/:sourceId/collection/status`
requires existing authenticated project read authority. An optional `jobId` selects
one exact retained plan. The reader verifies plan integrity, source scope and effect
binding, and holds the job lock while reading its settled state. Read requests may
register the normal web-session record; they do not approve, enqueue, collect or
mutate domain state. No remote error bodies are returned to the interface.

Without a job ID, discovery verifies the complete project plan inventory up to 100
plans before selecting this source's latest signed creation time/ID. Above that
bound it reports unavailable, never a partial oldest/newest or empty result. Exact
job reads still work. This is a known history-scale limitation, not protection
against database rollback or deleted records. A scalable authenticated history
index or paginated history experience remains future work; do not silently raise
the scan ceiling without measuring cost.

While visible, queued/running progress receives at most 180 non-overlapping
automatic checks per observation target. Authorization denial and terminal states
stop automatic reads. Explicit Refresh can check again. Cleanup aborts and fences
late responses. Status observations cannot clear an unresolved proposal/approval,
change its inputs or repeat it. Reload rediscovers evidence, not command authority.
After discovery, observations pin the returned job ID and use exact reads; they do
not rescan the full project inventory on every timer tick.

## Evidence and remaining acceptance

Source review identified an unsigned source-filter problem in initial discovery;
the implementation now verifies candidates before choosing their source/ranking.
Re-review found that issue resolved. A disposable PGlite corruption regression
changes an unretagged source identity and proves failure rather than hidden work.
The append-only trigger first prevented test corruption; explicit fixture-only
injection and restoration were then used. Production protections were not changed.

Tests cover scoped mounted HTTP reads, prepared/queued/running/completed/failed/
uncertain outcomes, actual injected collection settlement, restricted-role reads,
revoked access, and browser command preservation. UI rendering/controller evidence
is not mounted-browser lifecycle acceptance. No live website, PostgreSQL primary,
Cloudflare login or news fetch was exercised by this delivery.
