# Author an observation adapter

## Allowed interface

An adapter has exactly four fields: SDK version, manifest, compatibility evaluator, and observation normalizer. The SDK rejects additional own fields. The manifest must declare no effect authority and no access mode.

## Compatibility

Compatibility evidence must be explicit and bounded. Return a stable reason code when evidence is missing or incompatible. Do not discover an executable, read local configuration, or infer compatibility from host state.

## Normalization

Normalize only a supplied frame and supplied context. Output bounded structured observations. Never return native session identifiers, environment values, paths, raw output, sensitive material, or callable controls.

## Verification

Create fabricated fixtures for accepted and rejected input, run the public conformance kit, and verify the package import scan. Passing synthetic conformance is not evidence that a native integration works.

## Forbidden additions

Do not add operation, access, approval, scheduling, lease, dispatch, provider, registry, filesystem, process, or network methods to the public adapter.
