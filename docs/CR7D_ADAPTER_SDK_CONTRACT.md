# CR-7D public harness adapter SDK contract

**Status:** Effect-free repository contract implemented locally.
**SDK version:** `control-room-harness-adapter-sdk/v1`.

## Purpose

The SDK gives each harness one small, stable observation boundary. Hermes and Codex now implement that boundary; later adapters can use the included example as a starting point.

The SDK is deliberately not an execution framework. It does not start a harness, submit a prompt, create a worktree, obtain a credential, approve a request, claim a lease, dispatch a job, or perform an effect. Existing protected Hermes lifecycle and Codex planning/execution modules remain responsible for those separate controls.

## Required adapter shape

Every adapter exposes exactly four public members:

- `sdkVersion`;
- a validated pinned harness manifest;
- `evaluateCompatibility(evidence)`; and
- `normalizeEvent(frame, context)`.

The manifest remains the source of truth for declared lifecycle verbs, approval mode, isolation, credential resolution, and output forms. Declaring a verb does not grant permission to invoke it. The public adapter interface has no start, execute, approve, credential, dispatch, lease, or effect method. Adapters are created through the SDK factory as plain, exact, deeply frozen data/function objects; conformance rejects symbols, accessors, inherited or non-enumerable members, writable/configurable descriptors, and prototype or proxy-visible widening.

## Normalization boundary

Adapters accept node-local raw frames and a bounded context, then return only:

- canonical Control Room harness events;
- an optional digest of a native session key; and
- an optional digest of final text.

Raw native session and thread IDs are inputs only. They are transformed into tenant/node/adapter-bound SHA-256 digests before crossing this boundary. Adapter output uses an exact closed shape, passes secret scanning, and validates every event against the canonical harness event schema. The SDK rejects unknown output fields, malformed timestamps, wrong tenant/run bindings, duplicate or backward sequences, secret material, and oversized fixture output.

## Compatibility and conformance

Compatibility is adapter-specific, but every adapter returns the shared `{ compatible, reasons }` decision. A conformance run verifies the manifest, compatibility decision, fixture contexts, exact normalized output shape, safe event schema, tenant/run binding, increasing per-run sequences, native-digest format, final-text-digest format, and secret safety.

Conformance is observation-only. It evaluates supplied fixtures and does not launch a provider, read credentials, create a worktree, or contact a network service.

## Existing adapters

`hermesHarnessAdapterV1` wraps the existing safe Hermes gateway event normalizer and compatibility gate. `codexHarnessAdapterV1` wraps the existing safe Codex JSONL decoder and compatibility gate. Neither wrapper replaces or weakens the existing lifecycle, sandbox, broker, workspace, isolation, or native eligibility gates.

`exampleHarnessAdapterV1` is an intentionally tiny redistributable example. It maps only a bounded ready-status frame into one transport observation and declares only `discover` and `stream`.

## Explicit non-authority

Passing conformance does not qualify a harness for native use, credential use, deployment, network access, provider calls, or effects. It only proves that a supplied fixture can be safely normalized under a manifest whose declared capabilities remain visible for separate policy evaluation.
