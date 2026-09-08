# Article extraction: actual integration boundary

2026-09-08, source checkpoint17bef80. Root source inspection; not an executed
extraction-to-application adapter and not an adoption decision.

## Important mismatch found in the existing artifact alternative

The current native-result store is **not a generic place to upload source articles**.
`src/artifacts/v1/native-results.ts::NativeResultStore.capture` requires a completed
native snapshot, durable harness observation, canonical job/attempt/run binding,
and hash-matched bytes. Its receipt and byte validator cap native text results at
65,536 bytes. Passing an article to it before a task runs would require fabricating
an agent result or weakening those bindings. Neither is an acceptable adapter.

Its underlying `ArtifactReadPortV1`/`ArtifactStoragePortV1` can be assessed for byte
storage reuse, but its native result receipt, state transition and identity must
not be reused for a different kind of evidence. No generic article-input persistence
interface has been proven by inspecting that class. This corrects the earlier broad
suggestion that extraction could simply use an existing result artifact.

The existing in-memory and disposable-filesystem implementations in
`src/node-executor/artifact-storage.ts` also enforce65,536-byte individual objects.
Reusing the interface does not remove that concrete limit. Do not silently truncate
an article and label it complete, or raise a shared native-result limit as an
incidental reader change. The reader comparison must explicitly choose bounded
partial text with disclosure, a source-link fallback, or a separately reviewed
storage policy if the desired reading experience needs larger content.

## Existing boundaries to preserve

| Actual source | Consequence for the implementation packet |
| --- | --- |
| `src/project-adapters/abs-news/v1/story.ts::buildAbsNewsStoryV1` and `parseAbsNewsStoryV1` hash the complete unsigned story | Do not replace its summary or add extraction metadata without explicit story-version/digest handling. |
| `src/project-adapters/abs-news/v1/discovery-ingestion.ts::saveAbsNewsDiscovery` uses a workspace lock and stale-observation fences | A later extraction must not replay discovery as a newer source observation merely to attach text. |
| `src/web/v1/news-wire.ts::newsPageSchema` returns strict story rows with summary max4,000 and no body | In-page full reading needs a separately versioned optional detail/read projection; it is not a parser-only change. |
| `newsResearchInputSchema` binds storyId/storyDigest and one of four actions | Extracted text cannot silently replace the source identity used by existing research/guide/comparison/draft actions. |
| `NativeResultStore.capture` requires completed native evidence | Source input and agent output must remain distinguishable; do not create a synthetic completed run to store an article. |

## Smallest honest integration comparison

The existing summary plus canonical source link remains the no-new-component
baseline. For richer reading, compare a source-bound optional text detail with the
selected extractor, preserving canonical source URL, story digest, extraction
version and content hash. Persistence, expiration and authority belong in the
implementation design; this source map does not introduce a new schema or grant
retrieval permission. Prefer existing storage primitives after proving their seam,
not another general artifact engine.

Initial plain-text presentation avoids importing an HTML renderer solely for this
feature. It does not remove the need for input/output limits, retrieval restrictions,
provenance, or a source-link fallback when extraction fails. If formatted HTML is
required, evaluate a maintained sanitizer and rendering boundary separately: both
tested extractors retained an event-handler attribute.

Required local acceptance before calling this E3: actual extracted output crosses
the selected detail/storage interface; wrong-project and stale-story reads are
refused; repeat extraction cannot change an already approved task's source binding;
failure preserves summary/source-link access; research/guide/draft preparation keeps
its existing canonical lineage; any changed bytes are versioned, not silently
overwritten. Native agent output remains a distinct reviewed result.

No application code was changed, no production deletion is earned, and no additional
storage service or migration is selected by this map. It provides exact existing
constraints for comparing integration effort rather than hiding that effort behind
the phrase 'use artifacts'.

[Independent source review](f7-article-integration-review.md) found no blocking
contradiction and identified additional reuse candidates: `artifact-evidence.ts`
bundle/hash helpers and canonical artifact manifests. They still need legitimate
job/attempt lineage, but an approved extraction/collection task could supply that
without inventing native completion. Keep that alternative in the integration cost
comparison. The byte-port interfaces themselves do not impose a universal64KiB
limit; the inspected native/result implementations do.
