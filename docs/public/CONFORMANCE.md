# Run synthetic conformance

## Inputs

Each case binds one adapter, explicit compatibility evidence, and fabricated frames with tenant, run, sequence, and time context.

The kit executes the adapter's compatibility and normalization functions in the caller's JavaScript process. It is a contract validator, not a code sandbox. Use only adapter code you already trust, and run third-party adapters in a separately isolated process with no credentials, private files, provider access, or network authority.

## Result

The kit validates the exact adapter shape, manifest, compatibility decision, event schema, ordering, uniqueness, context binding, and sensitive-value exclusion. It returns only an in-memory report.

## Meaning of pass

A pass proves that the supplied fabricated cases meet the local observation contract. It does not prove that adapter code is harmless, installation, native availability, access, provider behavior, production safety, or release readiness.

## Failure handling

Treat any invalid fixture, rejected compatibility decision, or normalization failure as blocked. Correct the source or fixture and rerun the full deterministic case set. Never convert a failed case into a pass by deleting it or weakening the public boundary.
