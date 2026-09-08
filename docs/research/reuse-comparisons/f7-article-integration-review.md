# Article integration boundary independent source review

2026-09-08; read proposed map and relevant current source. No execution, download,
application change, persistence decision or Git write. Root retains design authority.

## Disposition

No blocking contradiction in the map's stated boundaries. It correctly says no generic
article-input persistence interface has **been proven**, not that no reusable storage
exists or that a new service/database is necessary.

Actual native-result receipt/byte validation enforce 65,536 bytes, and capture binds
stored native observations to project/job/attempt/run and completed output. It must
not become a pre-task article upload by inventing a completed run. Actual in-memory
and disposable filesystem byte stores also enforce that per-object limit. Their
`ArtifactStoragePortV1`/`ArtifactReadPortV1` interfaces themselves do not encode a global
size limit or require native execution; the concrete implementations do. This distinction
leaves legitimate reuse without changing native-result policy.

The story builders hash complete unsigned schema content, ingestion uses the workspace
lock/stale observations, and news wire carries strict summary/source identity without
article body. The proposed separate enrichment must not mutate already bound story or
task inputs. Those source findings support the map, not a particular new schema.

## Other existing seams searched

- `src/node-executor/artifact-evidence.ts` provides generic text bundle/manifest/hash
  construction, but its input/lineage still require job and attempt IDs. It is reusable
  byte/digest machinery, not an authenticated pre-task article persistence operation.
- `src/persistence/canonical-store.ts` supports `artifact_manifest` independently of
  the NativeResultStore wrapper. Its domain type still requires project/job/attempt,
  and metadata storage is not raw-byte storage or source-story authorization. This
  alternative should remain visible if an actual approved collection/extraction task
  supplies a legitimate job/attempt; no fabricated run is needed merely to consider it.
- MCP job proposals carry `inputArtifactId`/`inputDigest`, but those fields alone do
  not implement article upload/read or validate a source-body attachment.
- Wayfarer's `source_input` artifact contracts describe consumer-specific roles and
  limits; its synthetic module expressly records zero observed bytes. They are not
  an implemented generic article upload route. `managed-native-input.ts` is command/
  transport routing, not source document storage despite the name.

No searched alternative establishes a ready-made source-bound article detail service.
That is a bounded search conclusion, not proof no useful helper exists anywhere in
the repository. The byte ports and canonical metadata remain stronger reuse candidates
than a new generic artifact engine. Evaluate them at the eventual task/source binding
chosen by root before selecting new persistence.

## Carry-forward qualifications

Do not generalize the 65,536-byte native/current-store limit to every possible domain
artifact or backend; do not raise that shared limit incidentally or mislabel truncated
content as complete. A bounded optional text projection/source-link fallback is a design
option, not an established requirement to create a new storage service.

The proposed E3 cases—project/story binding, stale reads, versioned changed bytes,
unchanged approved task lineage and failure fallback—are appropriate unrun acceptance
criteria. Their presence does not qualify a current implementation. Rich article
retrieval, sanitization, publication permission and provenance remain separate from
an extractor returning text. No existing production deletion is earned by this map.
