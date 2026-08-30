# CR9B Lo-Fi Wayfarer project pack and synthetic media contract

**Version:** `control-room-wayfarer-project-pack/v1` and `control-room-wayfarer-synthetic-workflow/v1`
**Blocks:** CR9B-WF-000/010/020/030
**Status:** Effect-free local implementation
**Controlling decision:** ADR-063

## Purpose

Lo-Fi Wayfarer is a Control Room-native media project. Its first implementation proves the complete shape of a media workflow without pretending to render, generate audio, run QC tools, store media, upload, or publish.

The project pack digest is `sha256:ae072b1033c5a29aaa84c543f15619d7261c5525a3aea1e075b2db7464a6874c`. It binds the shared Project Workspace, stage graph, artifact declarations, QC rules, Completion Gate profiles, retention classes, and independently reviewed procedure and knowledge packages.

## Frozen media graph

```text
model render ─┬─> QC ─> review ─> assembly ─> publication preparation
              └────────> review
audio candidate ┬─> QC
                └──────> review
```

The exact stages are:

1. `model_render_segment`
2. `audio_candidate`
3. `qc_media_probe`
4. `review_cut`
5. `assemble_episode`
6. `prepare_publication`

Render and audio may be prepared independently. Review requires both plus the QC report. Assembly requires simulation evidence for the review stage. Publication preparation requires simulation evidence for assembly. Simulation evidence explicitly says it is not authoritative Completion Gate resolution.

## Artifact boundary

| Role | Kind | Maximum | Retention |
|---|---|---:|---|
| source scene manifest | manifest | 1 MiB | source |
| source audio brief | document | 1 MiB | source |
| render segment | media | 4 GiB | intermediate |
| audio candidate | media | 1 GiB | intermediate |
| QC report | document | 16 MiB | evidence |
| review proxy | media | 1 GiB | review |
| review manifest | manifest | 16 MiB | review |
| episode master | media | 16 GiB | master |
| assembly manifest | manifest | 16 MiB | evidence |
| publication package | manifest | 16 MiB | master |

Control Room records immutable IDs, digests, content types, lineage, logical retention classes, and ceilings. The pack contains no artifact bytes, paths, signed URLs, object keys, credentials, or storage authority. Current synthetic envelopes record zero observed bytes and `mediaMaterialPresent: false`.

## QC and completion

Nine named verification scenarios cover render decode, frame continuity, audio decode, loudness, A/V synchronization, QC-report integrity, review-proxy integrity, assembly-manifest integrity, and publication-package integrity.

Each stage binds a strict CR-8 Completion Gate profile. Producer separation is mandatory. Review and assembly carry higher review requirements. Synthetic QC results are useful deterministic evidence but always say `qualifiesCompletion: false`; they cannot stand in for independent verification or human review.

## Retention and quarantine

Five retention classes cover source, intermediate, evidence, review, and master artifacts. Retention expiry can produce only an owner-reviewed deletion proposal. Automatic deletion is disabled, legal hold wins, and the project pack grants no deletion authority. Failed verification blocks completion and selects quarantine; it does not delete or retry the artifact.

## Routes, retries, and Unreal

The pack declares platform, memory, scratch, and GPU requirements without reserving a resource. Every current route is synthetic-only, zero-cost, and denies native execution, providers, and network use.

Unreal remains ineligible. A separately owner-controlled measured scene/render benchmark is required before an Unreal route can be considered. The current no-byte synthetic renderer is not that benchmark.

Only one future definite pre-start retry may be proposed. Any uncertainty after an effect marker is terminal ambiguity, cannot retry automatically, and requires authoritative reconciliation. The current executor never creates an effect marker because it has no effect path.

## Procedure and knowledge packages

The project procedure and authority knowledge are immutable CR-7E packages with an independent accepted review. They supply configuration and facts only. They contain no credentials and grant no policy, approval, lease, dispatch, execution, deletion, storage, upload, or publication authority.

## Current synthetic implementation

The compiler accepts two exact no-byte source envelopes and produces six proposed stage records. These are not canonical jobs, leases, or dispatches. The typed synthetic executor verifies scope, pack, plan, stage, role order, producer lineage, content type, prerequisite simulation evidence, and all nested digests before emitting no-byte artifact envelopes, synthetic QC results, and a negative-authority receipt.

Accessors, Proxies, secret-shaped values, graph changes, role changes, digest aliases, stage-plan drift, scope drift, incorrect producer lineage, missing prerequisite evidence, and reordered inputs fail closed.

## Explicitly outside this contract

Native media tools, Blender, Unreal, FFmpeg, audio or image providers, GPU execution, actual scratch space, filesystem or object-storage locators, R2, credentials, model calls, network access, media bytes, upload, YouTube, publication, deployment, canonical job creation, leasing, dispatch, and external effects are not implemented or authorized.

## Next contract

CR9B-WF-040 freezes local and R2 object identity, trusted locator custody, integrity checks, retention execution, quarantine transitions, capacity accounting, retry, cleanup, and ambiguity semantics. It does not connect to R2 or operate local files.
