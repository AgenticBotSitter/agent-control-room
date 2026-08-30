# CR9B-WF-090/100 frozen executor and delivery-preparation contract

**Status:** Frozen and implemented locally in disabled, effect-free form
**Date:** 2026-08-29
**Authority:** ADR-063 through ADR-067, `CR9B_WF_080_OWNER_PACKET.md`, and the repository security contracts

## Outcome

WF-090 freezes an Unreal executor manifest against the exact WF-080 benchmark packet. The accepted executor is intentionally incapable of native execution. It can parse the packet, bind the current readiness assessment and disabled disposition, produce a deterministic pre-start admission refusal, and record a digest-bound negative receipt. It has no command, process launcher, filesystem reader, scene or tool locator resolver, credential resolver, network client, artifact writer, cancellation controller, job creator, reservation creator, lease creator, effect-claim creator, or approval consumer.

WF-100 freezes a metadata-only delivery-preparation package. It binds the Wayfarer pack, the `prepare_publication` stage, and exact declarations for `episode_master`, `assembly_manifest`, and `publication_package`. It contains no media byte, content identity, locator, destination identity, destination path, credential reference, credential, job, effect claim, marker, approval, or execution authority.

## Frozen Unreal executor

The manifest is fixed to:

- `executor:wayfarer:unreal:disabled:v1`;
- the exact WF-080 packet ID and digest;
- `model_render_segment` and `wayfarer.measure_unreal_scene_render`;
- macOS, Windows, and Linux contract compatibility without native qualification;
- one maximum attempt, a 900-second ceiling, zero provider cost, forbidden network, and no automatic retry; and
- `commandModel: none`, `nativeAdapterPresent: false`, and `canExecute: false`.

Admission requires the exact manifest, packet, readiness assessment, and disabled disposition. The present twelve readiness blockers and six executor blockers produce only `disabled_before_start`. This evaluation creates no job, reservation, lease, claim, marker, locator resolution, native call, attempt, or approval consumption.

The negative receipt reports zero processes, scene reads, GPU work, output, network, credentials, filesystem effects, external effects, and retries. It does not pretend that native cleanup ran because nothing started.

## Separate delivery boundaries

The package defines two separate future effects:

1. `private_upload` may later transfer the episode master, assembly manifest, and publication package to an exact owner-selected private object store.
2. `public_publication` may later publish the episode master and publication package to an exact owner-selected public video channel.

Neither boundary is configured. Each future boundary must independently prove:

- exact destination identity and path digests;
- a qualified destination adapter and protected credential reference;
- node execution authority and fresh strong owner approval;
- a stable destination idempotency key;
- a durable effect claim before work and a marker immediately before the possible effect;
- destination and cleanup receipts; and
- terminal ambiguity with no automatic retry after a marker.

The private upload can never stand in for publication approval. Publication acceptance can never authorize a private upload. A changed artifact, pack, destination, path, adapter, or approval requires a new exact package and authorization.

## Current blockers

The current package records twelve ordered blockers: authoritative render, authoritative audio, QC resolution, independent review, Completion Gate resolution, immutable media bytes, live storage adapter, exact destination identity, qualified destination adapter, credential reference, node authority, and fresh strong owner approval.

The accepted outcome is `disabled_before_effect`: zero upload attempts, publication attempts, destination contacts, credential resolutions, artifact reads, effect claims, markers, retries, or external effects.

## Explicitly absent

No install, download, Unreal tool, scene, media, GPU process, filesystem or R2 operation, storage locator, bucket, account, endpoint, public channel, credential, network call, upload, publication, deletion, deployment, provider, worker dispatch, or external effect was accessed or implemented.

WF-110/120 must add an exact destination/idempotency/approval readiness contract and either a separately owner-authorized rehearsal or an authenticated disabled disposition. This contract does not pre-authorize that work.
